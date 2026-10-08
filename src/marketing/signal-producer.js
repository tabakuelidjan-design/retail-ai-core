// Shared mechanics of the M1.5 signal producers. A producer is a PURE adapter of a closed, trusted, producer-specific input
// into the one canonical MarketSignal (M1). It never bypasses buildMarketSignal, so every signal inherits the M1 guarantees
// (deep freeze, deterministic id, tenant/brand isolation, timestamp normalization, provenance, non-causality, freshness).
//
// A producer: receives the resolved tenant (and optionally a resolved Brand Identity), validates its own required fields,
// maps its kind to a stable signal_class / signal_type, and returns the MarketSignal. It writes nothing, decides nothing,
// builds no Finding, and has no implicit clock: every timestamp is an explicit input.
//
// Trust boundary: the input must come from a trusted server-side adapter or a validated operator workflow. A producer does
// no authentication, identity proof, connector authorization or cryptographic evidence verification, and a raw client
// payload must never be handed to it on a real execution path.

import { buildMarketSignal } from './market-signal.js';
import { closedObject, fail, tenantMerchantId } from './understand-validation.js';

// Stable producer-specific error codes. Shape, scope, timestamp and causality errors keep the M1 codes (MKT_*) of the
// canonical constructor; these codes only express what a given producer additionally requires.
export const PRODUCER_ERROR = Object.freeze({
  LOST_DEMAND_INVALID_KIND: 'MKT_LOST_DEMAND_INVALID_KIND',
  LOST_DEMAND_SUBJECT_REQUIRED: 'MKT_LOST_DEMAND_SUBJECT_REQUIRED',
  LOST_DEMAND_EVIDENCE_REQUIRED: 'MKT_LOST_DEMAND_EVIDENCE_REQUIRED',

  CALENDAR_INVALID_KIND: 'MKT_CALENDAR_INVALID_KIND',
  CALENDAR_EFFECTIVE_WINDOW_REQUIRED: 'MKT_CALENDAR_EFFECTIVE_WINDOW_REQUIRED',
  CALENDAR_SUBJECT_REQUIRED: 'MKT_CALENDAR_SUBJECT_REQUIRED',
  CALENDAR_EVIDENCE_REQUIRED: 'MKT_CALENDAR_EVIDENCE_REQUIRED',

  MANUAL_OBSERVATION_TYPE_REQUIRED: 'MKT_MANUAL_OBSERVATION_TYPE_REQUIRED',
  MANUAL_OBSERVATION_INVALID_TYPE: 'MKT_MANUAL_OBSERVATION_INVALID_TYPE',
  MANUAL_OBSERVATION_OBSERVED_AT_REQUIRED: 'MKT_MANUAL_OBSERVATION_OBSERVED_AT_REQUIRED',
  MANUAL_OBSERVATION_SUBJECT_REQUIRED: 'MKT_MANUAL_OBSERVATION_SUBJECT_REQUIRED',
  MANUAL_OBSERVATION_EVIDENCE_REQUIRED: 'MKT_MANUAL_OBSERVATION_EVIDENCE_REQUIRED',
});

// The fields every producer input may carry. Anything else (merchant_id, brand_id, signal_id, signal_class, signal_type,
// campaign, budget, recommendation, notes, customer data...) is refused as an unknown key.
const COMMON_INPUT_KEYS = [
  'subject_refs', 'source_ref', 'evidence_refs', 'detected_at', 'observed_at', 'expires_at', 'effective_window',
  'locale', 'market', 'limitations', 'provenance',
];

/** true when a required field is absent or an empty list */
export const isMissing = (value) => value == null || (Array.isArray(value) && value.length === 0);

export function requireField(value, code, message) {
  if (isMissing(value)) fail(code, message);
}

/**
 * @param {object} p
 * @param {object} p.tenant   resolved tenant (src/tenant)
 * @param {object|null} p.brand resolved Brand Identity, or null for a merchant-wide signal (never inferred)
 * @param {object} p.input    the closed producer input
 * @param {string} p.label    name used in messages
 * @param {string[]} p.extraKeys producer-specific input keys (e.g. 'kind')
 * @param {string} p.signalClass fixed class of this producer
 * @param {(input: object) => { signalType: string, fields?: object }} p.resolve
 *        validates the producer-specific requirements, returns the stable signal_type and optional field overrides
 */
export function produceMarketSignal({ tenant, brand, input, label, extraKeys, signalClass, resolve }) {
  tenantMerchantId(tenant);
  closedObject(input, [...COMMON_INPUT_KEYS, ...extraKeys], label);
  const { signalType, fields = {} } = resolve(input);
  return buildMarketSignal({
    tenant,
    brand,
    signal_class: signalClass,
    signal_type: signalType,
    subject_refs: input.subject_refs,
    source_ref: input.source_ref,
    evidence_refs: input.evidence_refs,
    detected_at: input.detected_at,
    observed_at: input.observed_at,
    expires_at: input.expires_at,
    effective_window: input.effective_window,
    locale: input.locale,
    market: input.market,
    limitations: input.limitations,
    provenance: input.provenance,
    ...fields,
  });
}
