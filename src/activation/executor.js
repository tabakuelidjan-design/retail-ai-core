// The channel executor: enqueue an approved order, then execute and follow each job exactly once.
//
//   enqueueChannelExecutionOrder  : live preflight -> one durable job per READY delivery (idempotent)
//   executeJob                    : atomic claim -> live preflight AGAIN -> provider submit -> PROCESSING | PUBLISHED | failure
//   pollJob                       : atomic poll claim -> provider status -> PUBLISHED | still PROCESSING | failure
//   recoverStale                  : a worker died after claiming: never resubmitted blindly
//
// It executes what it is told, when it is told (publish_at): it chooses no content, no account, no time. Nothing is retried blindly:
// only transient errors, never after the deadline, never when the outcome of a creating call is unknown (that would risk a double post).
// Logs carry codes and ids only; every log line passes through the redaction guard.

import {
  JOB_STATE as J, MAX_ATTEMPTS, MAX_STATUS_POLLS, PREFLIGHT_STATUS as S, STATUS_POLL_INTERVAL_MS, SUBMISSION_LEASE_MS,
} from './constants.js';
import { selectChannelConnector } from './connection-view.js';
import { CredentialError, resolveChannelCredential } from './credential-provider.js';
import { decideRetry, planChannelExecutionJobs } from './execution-job.js';
import { evaluateChannelExecutionPreflight, evaluateDelivery, evaluateOrderGate } from './execution-preflight.js';
import { buildChannelPublicationReceipt, sanitizeSafeMetadata } from './publication-receipt.js';
import { assertNoSecrets, redact, toMs } from './validation.js';

const iso = (ms) => new Date(ms).toISOString();

export function createChannelExecutor({
  repository, loadContext, clock = () => Date.now(), logger = () => {},
}) {
  if (!repository || typeof loadContext !== 'function') throw new TypeError('createChannelExecutor needs a repository and a loadContext(job) function');

  const log = (event, job, extra = {}) => {
    const line = {
      event, job_id: job.id, merchant_id: job.merchant_id, provider: job.provider, connector_id: job.connector_id, state: job.state, attempt: job.attempt_count, ...extra,
    };
    logger(assertNoSecrets(redact(line), 'log'));
  };

  const fail = async (job, code, errorClass = 'FINAL') => {
    const updated = await repository.markFinalFailure(job.merchant_id, job.id, { errorCode: code, errorClass, nowIso: iso(clock()) });
    log('job.failed_final', updated ?? job, { code });
    return { outcome: 'FAILED_FINAL', code, job: updated };
  };

  const retryOrFail = async (job, code, retryAfterMs) => {
    const nowIso = iso(clock());
    const decision = decideRetry({ attemptCount: job.attempt_count, nowIso, retryAfterMs, deadlineAt: job.deadline_at });
    if (!decision.retry) return fail(job, decision.reason === 'RETRIES_EXHAUSTED' ? 'RETRIES_EXHAUSTED' : 'RETRY_AFTER_EXPIRY', 'FINAL');
    const updated = await repository.markRetryableFailure(job.merchant_id, job.id, { errorCode: code, nextAttemptAt: decision.next_attempt_at, nowIso });
    log('job.failed_retryable', updated ?? job, { code, next_attempt_at: decision.next_attempt_at });
    return { outcome: 'FAILED_RETRYABLE', code, job: updated };
  };

  /** Live preflight, then one durable job per READY delivery. Idempotent: re-running returns the existing jobs. */
  async function enqueueChannelExecutionOrder(input) {
    const asOf = iso(input.asOf instanceof Date ? input.asOf.getTime() : toMs(input.asOf));
    const gate = evaluateOrderGate({ ...input, asOf });
    if (!gate.ok) return { status: S.BLOCKED, reason_codes: gate.result.reason_codes, jobs: [] };
    const drafts = planChannelExecutionJobs({ order: gate.ctx.order, manifest: gate.ctx.manifest, candidates: gate.ctx.candidates });
    const jobs = [];
    for (let i = 0; i < gate.ctx.order.deliveries.length; i += 1) {
      const delivery = gate.ctx.order.deliveries[i];
      const { result } = await evaluateDelivery(gate.ctx, delivery);
      if (result.status === S.BLOCKED || result.status === S.UNAVAILABLE) {
        jobs.push({ delivery_ref: delivery.delivery_ref, status: result.status, reason_codes: result.reason_codes, job: null });
        continue;
      }
      const { job } = await repository.enqueue(drafts[i]);
      const ready = result.status === S.READY && job.state === J.PLANNED ? await repository.markReady(job.merchant_id, job.id, { nowIso: asOf }) : job;
      jobs.push({ delivery_ref: delivery.delivery_ref, status: result.status, reason_codes: result.reason_codes, job: ready ?? job });
    }
    return { status: jobs.every((j) => j.status === S.READY) ? S.READY : jobs.some((j) => j.job) ? S.REVIEW_REQUIRED : S.BLOCKED, reason_codes: [], jobs };
  }

  async function submitClaimed(claimed) {
    let input;
    try { input = await loadContext(claimed); } catch { return retryOrFail(claimed, 'CONTEXT_UNAVAILABLE', null); }
    const nowIso = iso(clock());
    const gate = evaluateOrderGate({ ...input, asOf: nowIso });
    if (!gate.ok) return fail(claimed, gate.result.reason_codes[0] ?? 'ORDER_BLOCKED', 'BLOCKED');
    const delivery = gate.ctx.order.deliveries.find((d) => d.delivery_ref === claimed.payload.delivery_ref && d.connector_id === claimed.connector_id);
    if (!delivery) return fail(claimed, 'DELIVERY_NOT_IN_ORDER', 'BLOCKED');

    const { result, materials } = await evaluateDelivery(gate.ctx, delivery); // the live gate runs again at execution time
    if (result.status === S.BLOCKED) return fail(claimed, result.reason_codes[0] ?? 'PREFLIGHT_BLOCKED', 'BLOCKED');
    if (result.status === S.UNAVAILABLE) return retryOrFail(claimed, result.reason_codes[0] ?? 'PREFLIGHT_UNAVAILABLE', null);
    if (result.status === S.REVIEW_REQUIRED) {
      const updated = await repository.release(claimed.merchant_id, claimed.id, {
        nowIso, nextAttemptAt: iso(toMs(nowIso) + STATUS_POLL_INTERVAL_MS), reasonCode: result.reason_codes[0] ?? 'REVIEW_REQUIRED',
      });
      log('job.released_for_review', updated ?? claimed, { code: result.reason_codes[0] });
      return { outcome: 'REVIEW_REQUIRED', code: result.reason_codes[0], job: updated };
    }

    const { adapter, connector, credential, content, options } = materials;
    const started = clock();
    let submitted;
    try {
      const submission = adapter.buildSubmission({ content, options, delivery, connector });
      submitted = await adapter.submit({ connector, credential, submission, delivery });
    } catch (error) {
      const normalized = adapter.normalizeProviderError(error);
      if (normalized.retryable && adapter.ambiguousSubmitCodes?.includes(normalized.code)) {
        return fail(claimed, 'SUBMISSION_OUTCOME_UNKNOWN', 'AMBIGUOUS'); // the post may exist: never resubmitted blindly
      }
      if (normalized.retryable) return retryOrFail(claimed, normalized.code, normalized.retry_after_ms);
      return fail(claimed, normalized.code, 'PROVIDER');
    }
    log('job.submitted', claimed, { duration_ms: clock() - started, outcome: submitted.outcome });
    if (submitted.outcome === 'PUBLISHED') return publish(claimed, submitted);
    const updated = await repository.markProcessing(claimed.merchant_id, claimed.id, { providerSubmissionId: submitted.provider_submission_id, nowIso: iso(clock()) });
    return { outcome: 'PROCESSING', job: updated };
  }

  async function publish(job, result) {
    const updated = await repository.markPublished(job.merchant_id, job.id, {
      providerPostId: result.provider_post_id, providerSubmissionId: result.provider_submission_id, publishedAt: result.published_at, nowIso: iso(clock()),
      safeMetadata: sanitizeSafeMetadata({ post_id_kind: result.post_id_kind, search_url: result.search_url }), // only a public https permalink without query
    });
    if (!updated) return { outcome: 'SKIPPED', job: null }; // another worker already settled it
    log('job.published', updated);
    return { outcome: 'PUBLISHED', job: updated, receipt: buildChannelPublicationReceipt(updated) };
  }

  /** Atomically claims then executes ONE due job. Never throws for a provider / preflight outcome; returns what happened. */
  async function executeJob(job) {
    const claimed = await repository.claim(job.merchant_id, job.id, { nowIso: iso(clock()) });
    if (!claimed) return { outcome: 'SKIPPED', job: null };
    return submitClaimed(claimed);
  }

  /** One bounded status poll of a PROCESSING job. */
  async function pollJob(job) {
    const nowIso = iso(clock());
    const claimed = await repository.claimPoll(job.merchant_id, job.id, { nowIso });
    if (!claimed) return { outcome: 'SKIPPED', job: null };
    if (claimed.status_poll_count > MAX_STATUS_POLLS || toMs(nowIso) >= toMs(claimed.deadline_at)) return fail(claimed, 'STATUS_POLL_EXHAUSTED', 'TIMEOUT');
    let input; let connector; let credential;
    try {
      input = await loadContext(claimed);
      connector = selectChannelConnector(input.connectors, { merchantId: claimed.merchant_id, connectorId: claimed.connector_id });
      credential = await resolveChannelCredential(input.services.credentialProvider, {
        merchantId: claimed.merchant_id, connectorId: claimed.connector_id, provider: claimed.provider, purpose: 'STATUS', asOf: nowIso,
      });
    } catch (error) {
      if (error instanceof CredentialError && error.code !== 'CREDENTIAL_UNAVAILABLE') return fail(claimed, error.code, 'AUTH');
      return { outcome: 'PROCESSING', job: claimed, note: 'CONTEXT_UNAVAILABLE' }; // transient: the next poll tries again
    }
    const adapter = input.services.adapters?.[claimed.provider];
    if (!adapter) return fail(claimed, 'ADAPTER_MISSING', 'BLOCKED');
    try {
      const status = await adapter.fetchStatus({ connector, credential, providerSubmissionId: claimed.provider_submission_id });
      if (status.outcome === 'PUBLISHED') return publish(claimed, status);
      return { outcome: 'PROCESSING', job: claimed };
    } catch (error) {
      const normalized = adapter.normalizeProviderError(error);
      if (normalized.retryable) return { outcome: 'PROCESSING', job: claimed, note: normalized.code }; // keep polling, bounded
      return fail(claimed, normalized.code, 'PROVIDER');
    }
  }

  /** A worker died after claiming (lease expired): resume the follow-up if a submission exists, else stop - never resubmit blindly. */
  async function recoverStale({ merchantId }) {
    const nowIso = iso(clock());
    const stale = await repository.listStale({ merchantId, nowIso, leaseMs: SUBMISSION_LEASE_MS });
    const out = [];
    for (const job of stale) {
      if (job.provider_submission_id) {
        out.push(await repository.markProcessing(merchantId, job.id, { providerSubmissionId: job.provider_submission_id, nowIso }));
      } else {
        out.push((await fail(job, 'SUBMISSION_STATE_UNKNOWN', 'AMBIGUOUS')).job);
      }
    }
    return out;
  }

  /** One worker pass: recover, then act on every due job (execute READY / FAILED_RETRYABLE, poll PROCESSING). */
  async function runDueJobs({ merchantId, limit = 50 }) {
    await recoverStale({ merchantId });
    const due = await repository.listDue({ merchantId, nowIso: iso(clock()), limit });
    const results = [];
    for (const job of due) results.push(job.state === J.PROCESSING ? await pollJob(job) : await executeJob(job));
    return results;
  }

  return {
    enqueueChannelExecutionOrder, executeJob, pollJob, recoverStale, runDueJobs,
  };
}

/**
 * Minimal internal scheduler: apply publish_at, never choose it. Clock and sleep are injected.
 * @param {{ executor, listMerchantIds: Function, sleep: Function, intervalMs?: number, maxRuns?: number }} deps
 */
export async function runChannelExecutionWorker({
  executor, listMerchantIds, sleep, intervalMs = 30_000, maxRuns = Infinity,
}) {
  const passes = [];
  for (let n = 0; n < maxRuns; n += 1) {
    for (const merchantId of await listMerchantIds()) passes.push(...await executor.runDueJobs({ merchantId }));
    if (n + 1 >= maxRuns) break;
    await sleep(intervalMs);
  }
  return passes;
}

export { evaluateChannelExecutionPreflight, MAX_ATTEMPTS };
