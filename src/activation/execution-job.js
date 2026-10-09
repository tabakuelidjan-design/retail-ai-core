// Durable execution jobs (outbox): pure rules. One job = one external action = one (merchant, manifest, delivery, connector).
// The persisted job holds refs and codes only: never a token, a signed URL, a raw provider payload or a caption.

import {
  ACT_ERROR as E, ACTIVATION_VERSION, JOB_STATE, JOB_TRANSITIONS, MAX_ATTEMPTS, RETRY_BACKOFF_MS, TERMINAL_JOB_STATES,
} from './constants.js';
import {
  assertNoSecrets, canonical, deepFreeze, deriveId, fail, toMs,
} from './validation.js';

/** Deterministic idempotency key of an intent: the same delivery on the same connector is the same job, forever. */
export const idempotencyKeyOf = ({
  merchantId, activationManifestRef, manifestDeliveryRef, connectorId,
}) => deriveId('acj', {
  merchant_id: merchantId, activation_manifest_ref: activationManifestRef, manifest_delivery_ref: manifestDeliveryRef, connector_id: connectorId,
});

/**
 * Hash of the LOGICAL, non-secret content of an intent (manifest delivery, candidate and asset refs, connector, provider, options,
 * mode and time). Never a token, never a transport URL. Same key + another fingerprint = IDEMPOTENCY_CONFLICT.
 */
export function requestFingerprintOf({ manifestDelivery, candidate, delivery }) {
  return deriveId('acf', {
    manifest_delivery: {
      deliverable_ref: manifestDelivery.deliverable_ref, candidate_ref: manifestDelivery.candidate_ref, channel: manifestDelivery.channel,
      placement: manifestDelivery.placement, format_ref: manifestDelivery.format_ref, locale: manifestDelivery.locale,
    },
    candidate: { candidate_id: candidate.candidate_id, content_kind: candidate.content_kind, asset_refs: candidate.asset_refs },
    connector_id: delivery.connector_id,
    provider: delivery.provider,
    publish_mode: delivery.publish_mode,
    publish_at: delivery.publish_at,
    provider_options: delivery.provider_options,
    approval_ref: delivery.approval_ref,
  });
}

/**
 * One PLANNED job draft per order delivery. Pure: no I/O.
 * @param {object} p { order, manifest, candidates: [{ candidate }] } - the verified order and manifest, and the manifest's candidates
 */
export function planChannelExecutionJobs({ order, manifest, candidates }) {
  return deepFreeze(order.deliveries.map((delivery) => {
    const manifestDelivery = manifest.deliveries.find((d) => d.deliverable_ref === delivery.manifest_delivery_ref);
    const candidate = candidates.find((e) => e.candidate.candidate_id === manifestDelivery?.candidate_ref)?.candidate;
    if (!manifestDelivery || !candidate) fail(E.ORDER_DELIVERY_UNKNOWN, 'the delivery has no candidate in the Activation Manifest');
    const draft = {
      merchant_id: order.merchant_id,
      brand_id: order.brand_id,
      activation_manifest_ref: order.activation_manifest_ref,
      manifest_delivery_ref: delivery.manifest_delivery_ref,
      connector_id: delivery.connector_id,
      provider: delivery.provider,
      idempotency_key: idempotencyKeyOf({
        merchantId: order.merchant_id, activationManifestRef: order.activation_manifest_ref, manifestDeliveryRef: delivery.manifest_delivery_ref, connectorId: delivery.connector_id,
      }),
      request_fingerprint: requestFingerprintOf({ manifestDelivery, candidate, delivery }),
      state: JOB_STATE.PLANNED,
      publish_mode: delivery.publish_mode,
      publish_at: delivery.publish_at,
      deadline_at: order.expires_at, // never retry or poll past it (it is bounded by the authorization, the manifest and the activation window)
      payload: {
        schema_version: ACTIVATION_VERSION, order_ref: order.order_id, delivery_ref: delivery.delivery_ref, candidate_ref: candidate.candidate_id,
        content_kind: candidate.content_kind, provider_options: delivery.provider_options, approval_ref: delivery.approval_ref,
      },
      attempt_count: 0,
      status_poll_count: 0,
    };
    assertNoSecrets(draft, 'job');
    return draft;
  }));
}

export const isTerminalState = (state) => TERMINAL_JOB_STATES.includes(state);

/** Closed state machine: throws on any transition the table does not list. */
export function assertTransition(from, to) {
  if (!Object.hasOwn(JOB_TRANSITIONS, from) || !JOB_TRANSITIONS[from].includes(to)) {
    fail(E.JOB_INVALID_TRANSITION, `a job cannot go from ${String(from).slice(0, 24)} to ${String(to).slice(0, 24)}`, { from, to });
  }
  return to;
}

/**
 * Deterministic retry decision after a RETRYABLE failure (the caller already classified it).
 * Backoff 1m -> 5m -> 15m -> 60m; a later Retry-After wins; never past the deadline (order / authorization / manifest / window expiry).
 * @returns {{retry:true, next_attempt_at:string}|{retry:false, reason:string}}
 */
export function decideRetry({
  attemptCount, nowIso, retryAfterMs = null, deadlineAt,
}) {
  if (toMs(nowIso) >= toMs(deadlineAt)) return { retry: false, reason: 'DEADLINE_PASSED' };
  if (attemptCount >= MAX_ATTEMPTS) return { retry: false, reason: 'RETRIES_EXHAUSTED' };
  const backoff = RETRY_BACKOFF_MS[Math.min(Math.max(attemptCount, 1) - 1, RETRY_BACKOFF_MS.length - 1)];
  const waitMs = Math.max(backoff, retryAfterMs ?? 0);
  const nextMs = toMs(nowIso) + waitMs;
  if (nextMs >= toMs(deadlineAt)) return { retry: false, reason: 'DEADLINE_PASSED' };
  return { retry: true, next_attempt_at: new Date(nextMs).toISOString() };
}

/** Same intent? (idempotency) - compares the stored fingerprint with the new one. */
export const sameIntent = (job, draft) => job.request_fingerprint === draft.request_fingerprint;

export { canonical };
