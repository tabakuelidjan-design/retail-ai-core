// channel_execution_jobs repository (durable outbox). Merchant-scoped on EVERY operation. Supabase REST only; no provider call.
//
// Atomicity: every state change is a compare-and-set (PATCH with the expected state / counter in the filter), so two workers can
// never both win the same job: the loser gets `null`. Enqueue relies on the UNIQUE (merchant, manifest, delivery, connector) constraint,
// with the fingerprint check that turns "same key, different content" into IDEMPOTENCY_CONFLICT.

import {
  ACT_ERROR as E, JOB_STATE as J, STATUS_POLL_INTERVAL_MS, SUBMISSION_LEASE_MS,
} from './constants.js';
import { assertTransition, sameIntent } from './execution-job.js';
import {
  assertNoSecrets, deepFreeze, fail, iso, toMs, uuid,
} from './validation.js';

const TABLE = 'channel_execution_jobs';
const isUniqueViolation = (e) => /HTTP 409|23505/.test(String(e?.message ?? ''));
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const safeCode = (value) => (typeof value === 'string' && SAFE_CODE.test(value) ? value : 'UNKNOWN');

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const fromRow = (r) => deepFreeze({
  id: r.id, merchant_id: r.merchant_id, brand_id: r.brand_id ?? null, activation_manifest_ref: r.activation_manifest_ref, manifest_delivery_ref: r.manifest_delivery_ref,
  connector_id: r.connector_id, provider: r.provider, idempotency_key: r.idempotency_key, request_fingerprint: r.request_fingerprint, state: r.state,
  publish_mode: r.publish_mode, publish_at: r.publish_at ?? null, deadline_at: r.deadline_at, payload: clone(r.payload) ?? {},
  provider_submission_id: r.provider_submission_id ?? null, provider_post_id: r.provider_post_id ?? null, attempt_count: r.attempt_count ?? 0,
  status_poll_count: r.status_poll_count ?? 0, last_error_code: r.last_error_code ?? null, last_error_class: r.last_error_class ?? null,
  next_attempt_at: r.next_attempt_at ?? null, created_at: r.created_at ?? null, updated_at: r.updated_at ?? null, published_at: r.published_at ?? null,
  safe_metadata: clone(r.safe_metadata) ?? {},
});

/**
 * @param {{ supabase: { select: Function, insert: Function, update: Function } }} deps
 */
export function createChannelExecutionRepository({ supabase }) {
  if (!supabase || typeof supabase.select !== 'function' || typeof supabase.update !== 'function') throw new TypeError('createChannelExecutionRepository needs a Supabase client');
  const read = async (params) => { try { return await supabase.select(TABLE, params); } catch (e) { return fail(E.STORE_FAILED, 'channel_execution_jobs could not be read', { cause: e?.name ?? 'Error' }); } };

  async function getById(merchantId, id) {
    const rows = await read({ select: '*', merchant_id: `eq.${uuid(merchantId, 'merchant_id')}`, id: `eq.${uuid(id, 'job_id')}`, limit: '1' });
    return rows.length ? fromRow(rows[0]) : null;
  }
  async function getByIdempotencyKey(merchantId, key) {
    const rows = await read({ select: '*', merchant_id: `eq.${uuid(merchantId, 'merchant_id')}`, idempotency_key: `eq.${key}`, limit: '1' });
    return rows.length ? fromRow(rows[0]) : null;
  }

  /** Idempotent: the same intent returns the existing job (created:false); the same key with another fingerprint is a conflict. */
  async function enqueue(draft) {
    assertNoSecrets(draft, 'job');
    const merchantId = uuid(draft.merchant_id, 'merchant_id');
    const settle = async () => {
      const existing = await getByIdempotencyKey(merchantId, draft.idempotency_key);
      if (!existing) return null;
      if (!sameIntent(existing, draft)) fail(E.IDEMPOTENCY_CONFLICT, 'this delivery was already enqueued with different content', { idempotency_key: draft.idempotency_key });
      return { job: existing, created: false };
    };
    const found = await settle();
    if (found) return found;
    let rows;
    try {
      rows = await supabase.insert(TABLE, [{ ...draft, merchant_id: merchantId, state: J.PLANNED }]);
    } catch (e) {
      if (!isUniqueViolation(e)) fail(E.STORE_FAILED, 'the job could not be stored', { cause: e?.name ?? 'Error' });
      const raced = await settle(); // enqueued concurrently: same rules
      if (raced) return raced;
      fail(E.STORE_FAILED, 'the job could not be stored');
    }
    return { job: fromRow(rows[0]), created: true };
  }

  /** Compare-and-set: validates the transition, then updates only if the row is STILL in the state it was read in. null = lost the race. */
  async function transition(merchantId, id, to, patch, { expected = null, requireFrom = null } = {}) {
    const current = await getById(merchantId, id);
    if (!current) fail(E.JOB_NOT_FOUND, 'no such job for this merchant');
    if (requireFrom && !requireFrom.includes(current.state)) fail(E.JOB_INVALID_TRANSITION, `a ${current.state} job cannot take this action`, { from: current.state, to });
    assertTransition(current.state, to);
    const filter = { id: `eq.${current.id}`, merchant_id: `eq.${current.merchant_id}`, state: `eq.${current.state}` };
    for (const [key, value] of Object.entries(expected ?? {})) filter[key] = `eq.${current[key] ?? value}`;
    const full = { ...patch, state: to };
    assertNoSecrets(full, 'job update');
    let rows;
    try { rows = await supabase.update(TABLE, filter, full); } catch (e) { fail(E.STORE_FAILED, 'the job could not be updated', { cause: e?.name ?? 'Error' }); }
    return rows && rows.length ? fromRow(rows[0]) : null;
  }

  const dueTime = (value, nowIso) => value == null || toMs(value) <= toMs(nowIso);

  return {
    enqueue,
    getById,
    getByIdempotencyKey,

    /** Jobs the worker may act on now. Selected by state (bounded), filtered by time in code. */
    async listDue({ merchantId, nowIso, limit = 50 }) {
      const id = uuid(merchantId, 'merchant_id');
      const now = iso(nowIso, 'now');
      const out = [];
      for (const state of [J.READY, J.FAILED_RETRYABLE, J.PROCESSING]) {
        const rows = await read({ select: '*', merchant_id: `eq.${id}`, state: `eq.${state}`, order: 'created_at.asc', limit: String(limit) });
        out.push(...rows.map(fromRow).filter((job) => dueTime(job.publish_at, now) && dueTime(job.next_attempt_at, now)));
      }
      return deepFreeze(out.slice(0, limit));
    },

    /** SUBMITTING jobs whose lease expired: a worker died after claiming. They are never resubmitted blindly. */
    async listStale({ merchantId, nowIso, leaseMs = SUBMISSION_LEASE_MS }) {
      const id = uuid(merchantId, 'merchant_id');
      const rows = await read({ select: '*', merchant_id: `eq.${id}`, state: `eq.${J.SUBMITTING}`, order: 'updated_at.asc', limit: '200' });
      return deepFreeze(rows.map(fromRow).filter((job) => toMs(job.updated_at ?? job.created_at) <= toMs(nowIso) - leaseMs));
    },

    markReady: (merchantId, id, { nowIso }) => transition(merchantId, id, J.READY, { updated_at: nowIso }),

    /** Atomic claim READY | FAILED_RETRYABLE -> SUBMITTING (attempt_count + 1). Returns the claimed job, or null when another worker won. */
    async claim(merchantId, id, { nowIso }) {
      const current = await getById(merchantId, id);
      if (!current) fail(E.JOB_NOT_FOUND, 'no such job for this merchant');
      if (![J.READY, J.FAILED_RETRYABLE].includes(current.state)) return null;
      if (!dueTime(current.publish_at, nowIso) || !dueTime(current.next_attempt_at, nowIso)) return null;
      return transition(merchantId, id, J.SUBMITTING, { attempt_count: current.attempt_count + 1, updated_at: nowIso, next_attempt_at: null }, { expected: { attempt_count: current.attempt_count } });
    },

    markProcessing: (merchantId, id, { providerSubmissionId, nowIso, pollIntervalMs = STATUS_POLL_INTERVAL_MS }) => transition(merchantId, id, J.PROCESSING, {
      provider_submission_id: providerSubmissionId, updated_at: nowIso, next_attempt_at: new Date(toMs(nowIso) + pollIntervalMs).toISOString(),
    }),

    /** Atomic claim of one status poll of a PROCESSING job (status_poll_count + 1, next poll pushed forward). null = another worker polls. */
    async claimPoll(merchantId, id, { nowIso, pollIntervalMs = STATUS_POLL_INTERVAL_MS }) {
      const current = await getById(merchantId, id);
      if (!current) fail(E.JOB_NOT_FOUND, 'no such job for this merchant');
      if (current.state !== J.PROCESSING || !dueTime(current.next_attempt_at, nowIso)) return null;
      const filter = {
        id: `eq.${current.id}`, merchant_id: `eq.${current.merchant_id}`, state: `eq.${J.PROCESSING}`, status_poll_count: `eq.${current.status_poll_count}`,
      };
      let rows;
      try {
        rows = await supabase.update(TABLE, filter, { status_poll_count: current.status_poll_count + 1, updated_at: nowIso, next_attempt_at: new Date(toMs(nowIso) + pollIntervalMs).toISOString() });
      } catch (e) { fail(E.STORE_FAILED, 'the job could not be updated', { cause: e?.name ?? 'Error' }); }
      return rows && rows.length ? fromRow(rows[0]) : null;
    },

    markPublished: (merchantId, id, {
      providerPostId, providerSubmissionId = null, publishedAt, nowIso, safeMetadata = {},
    }) => transition(merchantId, id, J.PUBLISHED, {
      provider_post_id: providerPostId, ...(providerSubmissionId ? { provider_submission_id: providerSubmissionId } : {}), published_at: iso(publishedAt, 'published_at'),
      updated_at: nowIso, next_attempt_at: null, last_error_code: null, last_error_class: null, safe_metadata: safeMetadata,
    }),

    markRetryableFailure: (merchantId, id, {
      errorCode, nextAttemptAt, nowIso,
    }) => transition(merchantId, id, J.FAILED_RETRYABLE, {
      last_error_code: safeCode(errorCode), last_error_class: 'RETRYABLE', next_attempt_at: iso(nextAttemptAt, 'next_attempt_at'), updated_at: nowIso,
    }),

    markFinalFailure: (merchantId, id, { errorCode, errorClass = 'FINAL', nowIso }) => transition(merchantId, id, J.FAILED_FINAL, {
      last_error_code: safeCode(errorCode), last_error_class: safeCode(errorClass), next_attempt_at: null, updated_at: nowIso,
    }),

    /** Hands a claimed job back (nothing was sent to the provider): SUBMITTING -> READY. */
    release: (merchantId, id, { nowIso, nextAttemptAt = null, reasonCode = null }) => transition(merchantId, id, J.READY, {
      updated_at: nowIso, next_attempt_at: nextAttemptAt, last_error_code: reasonCode ? safeCode(reasonCode) : null,
    }),

    /** Only before anything reached the provider: PLANNED | READY | FAILED_RETRYABLE. A PUBLISHED job can never be cancelled. */
    cancelBeforeSubmission: (merchantId, id, { nowIso }) => transition(merchantId, id, J.CANCELLED, { updated_at: nowIso, next_attempt_at: null }, { requireFrom: [J.PLANNED, J.READY, J.FAILED_RETRYABLE] }),
  };
}
