// MarketingContext - the read-only inputs UNDERSTAND may reason over. It is NOT a data warehouse: it embeds the existing
// measurement gates (via phase3Inputs, unchanged), opaque refs, and typed facts that the OWNING domains expose
// (available_units, unit_margin, coverage_days, capacity_window...). Marketing never recalculates them and is never
// their source of truth.
//
// Trust boundary: tenant, Brand Context, measurement facts, context facts and signals must be produced by trusted
// server-side adapters. This module checks shape, tenant/brand scope and freshness; it authenticates nobody.

import { BRAND_CONTEXT_STATUS } from '../branding/constants.js';
import { phase3Inputs } from './phase3-contract.js';
import { normalizeMarketSignal, marketSignalFreshness } from './market-signal.js';
import {
  CONTEXT_INPUT_CATEGORY, MKT_ERROR as E, UNDERSTAND_VERSION,
} from './understand-constants.js';
import {
  asOfValue, closedObject, deepFreeze, fail, isPlainObject, isoTimestamp, lowerToken, objectList, opaqueRef, optionalRef,
  optionalText, refList, tenantMerchantId, uuidValue,
} from './understand-validation.js';

export const CONTEXT_VERSION = `${UNDERSTAND_VERSION}/context`;

const INPUT_CATEGORY_KEYS = ['refs', 'facts'];
const FACT_KEYS = ['fact_key', 'subject_ref', 'value', 'unit', 'source_ref', 'observed_at'];

// A typed value exposed by an owning domain. It must say where it comes from; no source_ref, no fact.
function domainFact(input, field) {
  closedObject(input, FACT_KEYS, field);
  const { value } = input;
  const typed = typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() && value.length <= 120);
  if (!typed) fail(E.INVALID_FIELD, `${field}.value must be a finite number, a boolean or a short string`, { field });
  return {
    fact_key: lowerToken(input.fact_key, `${field}.fact_key`),
    subject_ref: optionalRef(input.subject_ref, `${field}.subject_ref`),
    value: typeof value === 'string' ? value.trim() : value,
    unit: optionalText(input.unit, `${field}.unit`, { max: 24 }),
    source_ref: opaqueRef(input.source_ref, `${field}.source_ref`),
    observed_at: isoTimestamp(input.observed_at, `${field}.observed_at`),
  };
}

function contextInputs(input) {
  closedObject(input ?? {}, Object.values(CONTEXT_INPUT_CATEGORY), 'context_inputs');
  return Object.fromEntries(Object.values(CONTEXT_INPUT_CATEGORY).map((category) => {
    const field = `context_inputs.${category}`;
    const entry = input?.[category] ?? {};
    closedObject(entry, INPUT_CATEGORY_KEYS, field);
    return [category, {
      refs: refList(entry.refs, `${field}.refs`),
      facts: objectList(entry.facts, `${field}.facts`, domainFact, { max: 100, keyOf: (f) => `${f.fact_key}|${f.subject_ref}` }),
    }];
  }));
}

// Existing Marketing Measurement is consumed through phase3Inputs, unchanged: a GATED conversion stays GATED
// (no traffic number appears) and search facts stay observations. The result is cloned, never aliased to the caller's facts.
function measurementOf(facts, merchantId) {
  if (facts == null) return null;
  if (!isPlainObject(facts)) fail(E.INVALID_FIELD, 'measurementFacts must be the marketing facts document', { field: 'measurementFacts' });
  if (facts.merchant_id != null && String(facts.merchant_id).toLowerCase() !== merchantId) {
    fail(E.CONTEXT_TENANT_MISMATCH, 'measurementFacts belong to another merchant');
  }
  let measurement;
  try {
    measurement = structuredClone(phase3Inputs(facts));
  } catch {
    fail(E.INVALID_FIELD, 'measurementFacts could not be consumed through phase3Inputs', { field: 'measurementFacts' });
  }
  if (measurement.causal_claims !== false) fail(E.CAUSAL_CLAIM_FORBIDDEN, 'measurement must keep causal_claims=false');
  return measurement;
}

// merchant_id always comes from the tenant. brand_id is explicit (never inferred); a brand-scoped context requires a
// READY Brand Context of that exact brand and merchant, a merchant-wide context carries none.
function brandScope({ brandId, brandContext, merchantId }) {
  if (brandId == null) {
    if (brandContext != null) fail(E.CONTEXT_BRAND_MISMATCH, 'a merchant-wide context cannot carry a Brand Context');
    return { brand_id: null, brand: null };
  }
  const id = uuidValue(brandId, 'brandId');
  if (!isPlainObject(brandContext) || brandContext.status !== BRAND_CONTEXT_STATUS.READY || !brandContext.brand || !brandContext.core || !brandContext.memory) {
    fail(E.CONTEXT_BRAND_NOT_READY, 'a brand-scoped context requires a READY Brand Context');
  }
  if (String(brandContext.brand.merchant_id).toLowerCase() !== merchantId) fail(E.CONTEXT_TENANT_MISMATCH, 'Brand Context belongs to another merchant');
  if (String(brandContext.brand.brand_id).toLowerCase() !== id) fail(E.CONTEXT_BRAND_MISMATCH, 'Brand Context is about another brand');
  return {
    brand_id: id,
    brand: {
      brand_id: id,
      core_ref: { id: brandContext.core.id, version: brandContext.core.version },
      memory_ref: { id: brandContext.memory.id, version: brandContext.memory.version },
      review_signals: [...(brandContext.review_signals ?? [])],
    },
  };
}

function signalsOf(rawSignals, { tenant, merchantId, brandId }) {
  const list = rawSignals ?? [];
  if (!Array.isArray(list) || list.length > 500) fail(E.INVALID_FIELD, 'marketSignals must be an array of at most 500 signals', { field: 'marketSignals' });
  const signals = list.map((raw) => {
    if (isPlainObject(raw) && raw.merchant_id != null && String(raw.merchant_id).toLowerCase() !== merchantId) {
      fail(E.CONTEXT_TENANT_MISMATCH, 'a market signal belongs to another merchant');
    }
    const signal = normalizeMarketSignal(raw, { tenant });
    // A brand-scoped signal only enters the context of its own brand; a merchant-wide signal (no brand_id) may enter any
    // brand's context of the same merchant.
    if (signal.brand_id !== null && signal.brand_id !== brandId) fail(E.CONTEXT_BRAND_MISMATCH, 'a market signal is scoped to another brand');
    return signal;
  });
  if (new Set(signals.map((s) => s.signal_id)).size !== signals.length) fail(E.CONTEXT_DUPLICATE_SIGNAL, 'marketSignals contains a duplicate signal_id');
  return signals;
}

export function buildMarketingContext({
  tenant,
  asOf,
  brandId = null,
  brandContext = null,
  measurementFacts = null,
  contextInputs: contextInputsArg = {},
  customerSegmentRefs = [],
  productRefs = [],
  offerRefs = [],
  calendarRefs = [],
  marketSignals = [],
} = {}) {
  const merchantId = tenantMerchantId(tenant);
  const asOfIso = asOfValue(asOf);
  const scope = brandScope({ brandId, brandContext, merchantId });
  const signals = signalsOf(marketSignals, { tenant, merchantId, brandId: scope.brand_id });

  return deepFreeze({
    context_version: CONTEXT_VERSION,
    merchant_id: merchantId,
    brand_id: scope.brand_id,
    as_of: asOfIso,
    brand: scope.brand,
    measurement: measurementOf(measurementFacts, merchantId),
    context_inputs: contextInputs(contextInputsArg),
    customer_segment_refs: refList(customerSegmentRefs, 'customerSegmentRefs'),
    product_refs: refList(productRefs, 'productRefs'),
    offer_refs: refList(offerRefs, 'offerRefs'),
    calendar_refs: refList(calendarRefs, 'calendarRefs'),
    market_signals: signals,
    // Expired signals stay in the context (auditable) but are labelled STALE relative to as_of.
    signal_freshness: signals.map((s) => ({ signal_id: s.signal_id, freshness: marketSignalFreshness(s, asOfIso) })),
  });
}
