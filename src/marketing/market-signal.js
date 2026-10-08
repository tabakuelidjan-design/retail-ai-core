// MarketSignal - the ONE common envelope for every present and future signal producer (M1 contract only: no producer
// is built here). Pure and deterministic; the clock is always an explicit argument.
//
// Trust boundary: a signal must be produced by a trusted server-side adapter. This module validates shape, tenant/brand
// scope, freshness and the causal boundary; it does not authenticate the producer or verify the evidence cryptographically.

import { EVIDENCE_KINDS, provenance, windowOf } from './provenance.js';
import {
  FRESHNESS, MKT_ERROR as E, SIGNAL_CLASS, SIGNAL_CLASS_LIMITATION,
} from './understand-constants.js';
import {
  asOfValue, closedObject, declaredBrandId, deepFreeze, deriveId, enumValue, fail, idValue, isPlainObject, isoTimestamp,
  brandIdentity, optionalLocale, optionalMarket, optionalText, optionalTimestamp, opaqueRef, refList, requiredText, tenantMerchantId,
  textList, toMs, upperToken, uuidValue,
} from './understand-validation.js';

const SIGNAL_KEYS = [
  'signal_id', 'merchant_id', 'brand_id', 'signal_class', 'signal_type', 'subject_refs', 'source_ref',
  'detected_at', 'observed_at', 'expires_at', 'locale', 'market', 'evidence_refs', 'limitations', 'provenance',
];
const PROVENANCE_KEYS = [
  'source_system', 'attribution_model', 'source_fields', 'window', 'filters', 'limitations', 'completeness', 'evidence_kind', 'causal_claim',
];
const WINDOW_KEYS = ['key', 'start', 'end', 'timeZone'];
const COMPLETENESS = Object.freeze({ COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', UNAVAILABLE: 'UNAVAILABLE' });
const EVIDENCE_KIND = Object.freeze(Object.fromEntries(EVIDENCE_KINDS.map((kind) => [kind, kind])));
const PENDING_ID = 'msig_pending';

function signalWindow(value, field) {
  if (value == null) return null;
  closedObject(value, WINDOW_KEYS, field);
  const start = isoTimestamp(value.start, `${field}.start`);
  const end = isoTimestamp(value.end, `${field}.end`);
  if (toMs(end) <= toMs(start)) fail(E.INVALID_FIELD, `${field}.end must be after ${field}.start`, { field });
  return windowOf({
    key: optionalText(value.key, `${field}.key`, { max: 64 }),
    start,
    end,
    timeZone: optionalText(value.timeZone, `${field}.timeZone`, { max: 64 }),
  });
}

// Only flat, JSON-primitive filters: they describe how the source data was pulled, never customer data.
function signalFilters(value, field) {
  if (value == null) return null;
  if (!isPlainObject(value) || Object.keys(value).length > 20) fail(E.INVALID_FIELD, `${field} must be a flat object of at most 20 entries`, { field });
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const ok = item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) || (typeof item === 'string' && item.length <= 120);
    if (!ok) fail(E.INVALID_FIELD, `${field}.${key} must be a short primitive`, { field });
    out[key] = item;
  }
  return out;
}

// Reuses the existing Marketing provenance contract (src/marketing/provenance.js): same evidence kinds, same
// ATTRIBUTION_IS_NOT_CAUSAL_PROOF limitation on attributed/inferred evidence, causal_claim always false.
function signalProvenance(input, field) {
  closedObject(input, PROVENANCE_KEYS, field);
  if (input.causal_claim !== undefined && input.causal_claim !== false) {
    fail(E.CAUSAL_CLAIM_FORBIDDEN, `${field}.causal_claim can only be false`, { field });
  }
  return provenance({
    source_system: requiredText(input.source_system, `${field}.source_system`, { max: 120 }),
    attribution_model: optionalText(input.attribution_model, `${field}.attribution_model`, { max: 120 }),
    fields: textList(input.source_fields, `${field}.source_fields`, { max: 100, maxLength: 120 }),
    window: signalWindow(input.window, `${field}.window`),
    filters: signalFilters(input.filters, `${field}.filters`),
    limitations: textList(input.limitations, `${field}.limitations`),
    completeness: enumValue(input.completeness, COMPLETENESS, `${field}.completeness`),
    evidence_kind: enumValue(input.evidence_kind, EVIDENCE_KIND, `${field}.evidence_kind`),
  });
}

function signalBody(input, { tenant, brand }) {
  const merchantId = tenantMerchantId(tenant);
  closedObject(input, SIGNAL_KEYS, 'signal');

  if (uuidValue(input.merchant_id, 'signal.merchant_id') !== merchantId) {
    fail(E.SIGNAL_TENANT_MISMATCH, 'signal.merchant_id does not match the resolved tenant');
  }
  const brandId = declaredBrandId(input.brand_id, brand, merchantId, 'signal', E.SIGNAL_BRAND_MISMATCH);

  const signalClass = enumValue(input.signal_class, SIGNAL_CLASS, 'signal.signal_class', E.SIGNAL_INVALID_CLASS);
  const signalType = upperToken(input.signal_type, 'signal.signal_type', { code: E.SIGNAL_INVALID_TYPE });
  if (input.source_ref == null || (typeof input.source_ref === 'string' && !input.source_ref.trim())) {
    fail(E.SIGNAL_SOURCE_REQUIRED, 'signal.source_ref is required');
  }

  const detectedAt = isoTimestamp(input.detected_at, 'signal.detected_at');
  const observedAt = optionalTimestamp(input.observed_at, 'signal.observed_at');
  const expiresAt = isoTimestamp(input.expires_at, 'signal.expires_at');
  if (toMs(expiresAt) <= toMs(detectedAt)) fail(E.SIGNAL_INVALID_EXPIRY, 'signal.expires_at must be after signal.detected_at');
  if (observedAt && toMs(observedAt) > toMs(detectedAt)) fail(E.SIGNAL_INVALID_OBSERVED_AT, 'signal.observed_at cannot be after signal.detected_at');

  // The class limitation always travels with the signal, first; re-normalizing is stable (dedupe keeps the first).
  const limitations = [...new Set([SIGNAL_CLASS_LIMITATION[signalClass], ...textList(input.limitations, 'signal.limitations')])];

  return {
    signal_id: idValue(input.signal_id, 'signal.signal_id'),
    merchant_id: merchantId,
    brand_id: brandId,
    signal_class: signalClass,
    signal_type: signalType,
    subject_refs: refList(input.subject_refs, 'signal.subject_refs', { max: 50 }),
    source_ref: opaqueRef(input.source_ref, 'signal.source_ref'),
    detected_at: detectedAt,
    observed_at: observedAt,
    expires_at: expiresAt,
    locale: optionalLocale(input.locale, 'signal.locale'),
    market: optionalMarket(input.market, 'signal.market'),
    evidence_refs: refList(input.evidence_refs, 'signal.evidence_refs'),
    limitations,
    provenance: signalProvenance(input.provenance, 'signal.provenance'),
  };
}

/** Validates an already-built signal against the resolved tenant (and, optionally, a resolved Brand Identity). */
export function normalizeMarketSignal(input, { tenant, brand = null } = {}) {
  return deepFreeze(signalBody(input, { tenant, brand }));
}

/**
 * Builds a signal for the resolved tenant. merchant_id and brand_id come from the tenant / Brand Identity - never from
 * the caller's fields (passing them is refused). signal_id is derived from the content when not supplied.
 */
export function buildMarketSignal({ tenant, brand = null, ...fields } = {}) {
  const merchantId = tenantMerchantId(tenant);
  for (const key of ['merchant_id', 'brand_id']) {
    if (Object.hasOwn(fields, key)) fail(E.UNKNOWN_KEY, `signal.${key} is derived from the tenant, not supplied`, { key });
  }
  const payload = {
    ...fields,
    merchant_id: merchantId,
    brand_id: brand == null ? null : brandIdentity(brand, merchantId, E.SIGNAL_BRAND_MISMATCH).brand_id,
    signal_id: fields.signal_id ?? PENDING_ID,
  };
  const body = signalBody(payload, { tenant, brand });
  if (fields.signal_id === undefined) body.signal_id = deriveId('msig', { ...body, signal_id: null });
  return deepFreeze(body);
}

/** True when expires_at <= asOf. An expired signal stays auditable; it is never treated as fresh evidence. */
export function isMarketSignalExpired(signal, asOf) {
  if (!isPlainObject(signal)) fail(E.INVALID_FIELD, 'signal must be an object', { field: 'signal' });
  return toMs(isoTimestamp(signal.expires_at, 'signal.expires_at')) <= toMs(asOfValue(asOf));
}

export const marketSignalFreshness = (signal, asOf) => (isMarketSignalExpired(signal, asOf) ? FRESHNESS.STALE : FRESHNESS.FRESH);
