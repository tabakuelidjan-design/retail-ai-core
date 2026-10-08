// MarketingFinding: an observable, bounded, traceable PROBLEM or OPPORTUNITY - never a cause, campaign, budget, channel,
// creative or price decision. CandidateHypothesis is a distinct typed contract EMBEDDED in a Finding: it has no public
// builder, so a hypothesis cannot exist outside a Finding.
//
// The engine never reads `statement`, `mechanism` or any free text to decide anything: decisions come from the
// structured fields and evidence refs. Free text is bounded, human-readable, and may be written by an LLM later (not in M1).

import { CONTEXT_VERSION } from './marketing-context.js';
import { normalizeMaterialityAssessment } from './materiality.js';
import { buildDomainFit } from './domain-fit.js';
import {
  CITED_SIGNAL_EXPIRED, DOMAIN_FIT_STATUS, FINDING_TYPE, FRESHNESS, MATERIALITY_OVERALL, MKT_ERROR as E, READINESS,
  TARGET_DOMAIN, TESTABILITY,
} from './understand-constants.js';
import {
  asOfValue, closedObject, declaredBrandId, deepFreeze, deriveId, enumValue, fail, idValue, isPlainObject, isoTimestamp,
  objectList, opaqueRef, optionalRef, refList, requiredText, tenantMerchantId, textList, toMs, upperToken, uuidValue,
} from './understand-validation.js';

const FINDING_KEYS = [
  'finding_id', 'merchant_id', 'brand_id', 'finding_type', 'subject_refs', 'statement', 'scope', 'window', 'baseline_ref',
  'evidence_refs', 'contradictory_evidence_refs', 'limitations', 'data_gaps', 'is', 'is_not', 'materiality', 'domain_fit',
  'created_at', 'expires_at', 'hypotheses',
];
const ENTRY_KEYS = ['dimension', 'value', 'evidence_refs'];
const GAP_KEYS = ['gap_code', 'owner_domain', 'description'];
const WINDOW_KEYS = ['start', 'end'];
const HYPOTHESIS_KEYS = [
  'hypothesis_id', 'statement', 'mechanism', 'supporting_evidence_refs', 'contradicting_evidence_refs', 'unknowns', 'testability',
];
const NEEDS_EVIDENCE = new Set([FINDING_TYPE.PROBLEM, FINDING_TYPE.OPPORTUNITY]);
const PENDING_ID = 'mfd_pending';

// scope / is / is_not share one bounded shape: dimension + opaque value + optional evidence. Values are opaque tokens
// (not free sentences) so a name or a contact detail cannot be smuggled in.
function entry(input, field) {
  closedObject(input, ENTRY_KEYS, field);
  return {
    dimension: upperToken(input.dimension, `${field}.dimension`),
    value: opaqueRef(input.value, `${field}.value`, { max: 120 }),
    evidence_refs: refList(input.evidence_refs, `${field}.evidence_refs`),
  };
}
const entryKey = (e) => `${e.dimension}|${e.value}`;

// A data gap is explicit and structured; it is never filled with an estimate.
function gap(input, field) {
  closedObject(input, GAP_KEYS, field);
  return {
    gap_code: upperToken(input.gap_code, `${field}.gap_code`),
    owner_domain: input.owner_domain == null ? null : enumValue(input.owner_domain, TARGET_DOMAIN, `${field}.owner_domain`),
    description: requiredText(input.description, `${field}.description`, { max: 200 }),
  };
}

function findingWindow(input) {
  closedObject(input, WINDOW_KEYS, 'finding.window');
  const start = isoTimestamp(input.start, 'finding.window.start', E.FINDING_INVALID_WINDOW);
  const end = isoTimestamp(input.end, 'finding.window.end', E.FINDING_INVALID_WINDOW);
  if (toMs(end) <= toMs(start)) fail(E.FINDING_INVALID_WINDOW, 'finding.window.end must be after finding.window.start');
  return { start, end };
}

// A hypothesis never carries a status or a confidence: it cannot be CONFIRMED/PROVEN/FACT in M1 (those would be refused
// as unknown keys). It can only be confirmed later by STEER, with its own evidence.
function hypothesis(input, field, requireId) {
  closedObject(input, HYPOTHESIS_KEYS, field);
  if (requireId && input.hypothesis_id === undefined) fail(E.INVALID_FIELD, `${field}.hypothesis_id is required`, { field });
  return {
    hypothesis_id: input.hypothesis_id === undefined ? null : idValue(input.hypothesis_id, `${field}.hypothesis_id`),
    statement: requiredText(input.statement, `${field}.statement`),
    mechanism: requiredText(input.mechanism, `${field}.mechanism`),
    supporting_evidence_refs: refList(input.supporting_evidence_refs, `${field}.supporting_evidence_refs`),
    contradicting_evidence_refs: refList(input.contradicting_evidence_refs, `${field}.contradicting_evidence_refs`),
    unknowns: textList(input.unknowns, `${field}.unknowns`, { maxLength: 200 }),
    testability: enumValue(input.testability, TESTABILITY, `${field}.testability`, E.HYPOTHESIS_INVALID_TESTABILITY),
  };
}

function withHypothesisIds(hypotheses) {
  const out = hypotheses.map((h) => (h.hypothesis_id ? h : { ...h, hypothesis_id: deriveId('mhy', h) }));
  if (new Set(out.map((h) => h.hypothesis_id)).size !== out.length) fail(E.DUPLICATE_ENTRY, 'finding.hypotheses contains a duplicate hypothesis');
  return out;
}

function findingBody(input, { tenant, brand, requireHypothesisIds }) {
  const merchantId = tenantMerchantId(tenant);
  closedObject(input, FINDING_KEYS, 'finding');
  if (uuidValue(input.merchant_id, 'finding.merchant_id') !== merchantId) fail(E.FINDING_TENANT_MISMATCH, 'finding.merchant_id does not match the resolved tenant');
  const brandId = declaredBrandId(input.brand_id, brand, merchantId, 'finding', E.FINDING_BRAND_MISMATCH);

  const findingType = enumValue(input.finding_type, FINDING_TYPE, 'finding.finding_type', E.FINDING_INVALID_TYPE);
  const subjectRefs = refList(input.subject_refs, 'finding.subject_refs', { max: 50 });
  const evidenceRefs = refList(input.evidence_refs, 'finding.evidence_refs');
  const gaps = objectList(input.data_gaps, 'finding.data_gaps', gap, { max: 20, keyOf: (g) => `${g.gap_code}|${g.owner_domain}` });

  if (NEEDS_EVIDENCE.has(findingType)) {
    if (!subjectRefs.length) fail(E.FINDING_SUBJECT_REQUIRED, `a ${findingType} finding needs at least one subject_ref`);
    if (!evidenceRefs.length) fail(E.FINDING_EVIDENCE_REQUIRED, `a ${findingType} finding needs at least one evidence_ref`);
  }
  if (findingType === FINDING_TYPE.NOT_MEASURABLE && !gaps.length) {
    fail(E.FINDING_DATA_GAP_REQUIRED, 'a NOT_MEASURABLE finding must name what is missing in data_gaps');
  }

  const isEntries = objectList(input.is, 'finding.is', entry, { keyOf: entryKey });
  const isNotEntries = objectList(input.is_not, 'finding.is_not', entry, { keyOf: entryKey });
  const isKeys = new Set(isEntries.map(entryKey));
  if (isNotEntries.some((e) => isKeys.has(entryKey(e)))) fail(E.FINDING_IS_IS_NOT_CONFLICT, 'the same dimension/value cannot be both IS and IS NOT');

  const createdAt = isoTimestamp(input.created_at, 'finding.created_at');
  const expiresAt = isoTimestamp(input.expires_at, 'finding.expires_at');
  if (toMs(expiresAt) <= toMs(createdAt)) fail(E.FINDING_INVALID_EXPIRY, 'finding.expires_at must be after finding.created_at');

  if (input.hypotheses != null && !Array.isArray(input.hypotheses)) fail(E.INVALID_FIELD, 'finding.hypotheses must be an array', { field: 'finding.hypotheses' });
  if ((input.hypotheses?.length ?? 0) > 10) fail(E.INVALID_FIELD, 'finding.hypotheses must contain at most 10 items', { field: 'finding.hypotheses' });

  return {
    finding_id: idValue(input.finding_id, 'finding.finding_id'),
    merchant_id: merchantId,
    brand_id: brandId,
    finding_type: findingType,
    subject_refs: subjectRefs,
    statement: requiredText(input.statement, 'finding.statement'),
    scope: objectList(input.scope, 'finding.scope', entry, { keyOf: entryKey }),
    window: findingWindow(input.window ?? {}),
    baseline_ref: optionalRef(input.baseline_ref, 'finding.baseline_ref'),
    evidence_refs: evidenceRefs,
    contradictory_evidence_refs: refList(input.contradictory_evidence_refs, 'finding.contradictory_evidence_refs'),
    limitations: textList(input.limitations, 'finding.limitations', { max: 100 }),
    data_gaps: gaps,
    is: isEntries,
    is_not: isNotEntries,
    materiality: normalizeMaterialityAssessment(input.materiality, 'finding.materiality'),
    domain_fit: buildDomainFit(input.domain_fit, 'finding.domain_fit'),
    created_at: createdAt,
    expires_at: expiresAt,
    hypotheses: withHypothesisIds(objectList(input.hypotheses, 'finding.hypotheses', (h, field) => hypothesis(h, field, requireHypothesisIds), { max: 10 })),
  };
}

/** Validates an already-built Finding against the resolved tenant (and, optionally, a resolved Brand Identity). */
export function normalizeMarketingFinding(input, { tenant, brand = null } = {}) {
  return deepFreeze(findingBody(input, { tenant, brand, requireHypothesisIds: true }));
}

// A MarketingContext scopes the Finding: merchant_id and brand_id are taken from it (explicit, never inferred).
function contextScope(context, merchantId) {
  if (!isPlainObject(context) || context.context_version !== CONTEXT_VERSION || !Array.isArray(context.market_signals)) {
    fail(E.FINDING_CONTEXT_INVALID, 'a Finding is built from a MarketingContext');
  }
  if (context.merchant_id !== merchantId) fail(E.FINDING_TENANT_MISMATCH, 'the context belongs to another merchant');
  return { merchant_id: merchantId, brand_id: context.brand_id ?? null };
}

// Limitations of every cited signal travel to the Finding (so caveats are never lost on the way). A signal that had already
// expired when the Finding was created can only be cited as contradictory evidence (see enforceEvidenceFreshness) and is flagged.
function carriedLimitations(context, citedRefs, createdAt) {
  const cited = new Set(citedRefs);
  const out = [];
  for (const signal of context.market_signals) {
    if (!cited.has(signal.signal_id)) continue;
    out.push(...signal.limitations, ...signal.provenance.limitations);
    if (toMs(signal.expires_at) <= toMs(createdAt)) out.push(CITED_SIGNAL_EXPIRED);
  }
  return out;
}

// Evidence freshness bound. The "active support" of a Finding is every ref that can make it material or relevant:
// evidence_refs plus the evidence of its materiality axes and of its domain fit. Among the signals of the context that are
// part of that support:
//   - none may already be expired at created_at (an expired signal stays usable as contradictory evidence or in the
//     limitations, for audit, but never as active proof);
//   - the Finding cannot outlive the earliest of them:  expires_at <= min(signal.expires_at).
function enforceEvidenceFreshness(context, body) {
  const support = new Set([
    ...body.evidence_refs,
    ...Object.values(body.materiality.axes).flatMap((a) => a.evidence_refs),
    ...body.domain_fit.evidence_refs,
  ]);
  const supporting = context.market_signals.filter((s) => support.has(s.signal_id));
  if (supporting.some((s) => toMs(s.expires_at) <= toMs(body.created_at))) {
    fail(E.FINDING_EVIDENCE_SIGNAL_EXPIRED, 'an expired signal cannot be active evidence for a Finding');
  }
  if (supporting.length && toMs(body.expires_at) > Math.min(...supporting.map((s) => toMs(s.expires_at)))) {
    fail(E.FINDING_OUTLIVES_EVIDENCE, 'a Finding cannot outlive the signals that support it');
  }
}

/**
 * Builds a Finding from a MarketingContext. merchant_id and brand_id come from the tenant/context - passing them (or a
 * finding_id) is refused. finding_id and hypothesis ids are derived deterministically from the content.
 */
export function buildMarketingFinding({ tenant, context, ...fields } = {}) {
  const merchantId = tenantMerchantId(tenant);
  const scope = contextScope(context, merchantId);
  for (const key of ['merchant_id', 'brand_id', 'finding_id']) {
    if (Object.hasOwn(fields, key)) fail(E.UNKNOWN_KEY, `finding.${key} is derived, not supplied`, { key });
  }
  const createdAt = isoTimestamp(fields.created_at, 'finding.created_at');
  const cited = [...refList(fields.evidence_refs, 'finding.evidence_refs'), ...refList(fields.contradictory_evidence_refs, 'finding.contradictory_evidence_refs')];
  const payload = {
    ...fields,
    ...scope,
    finding_id: PENDING_ID,
    limitations: [...textList(fields.limitations, 'finding.limitations', { max: 100 }), ...carriedLimitations(context, cited, createdAt)],
  };
  const body = findingBody(payload, { tenant, brand: null, requireHypothesisIds: false });
  enforceEvidenceFreshness(context, body);
  body.finding_id = deriveId('mfd', { ...body, finding_id: null });
  return deepFreeze(body);
}

// ---- freshness / readiness ----

/** FRESH until expires_at; at or after it the Finding is STALE (consultable, never BUILD-eligible without refresh). */
export function findingFreshness(finding, asOf) {
  if (!isPlainObject(finding)) fail(E.INVALID_FIELD, 'finding must be an object', { field: 'finding' });
  const expiresAt = isoTimestamp(finding.expires_at, 'finding.expires_at');
  return toMs(expiresAt) <= toMs(asOfValue(asOf)) ? FRESHNESS.STALE : FRESHNESS.FRESH;
}

/**
 * Can this Finding go to BUILD? A deterministic gate over structured fields only. Precedence (first match wins):
 *   STALE > REFER_TO_DOMAIN > NOT_MEASURABLE > NO_MATERIAL_SIGNAL > READY_FOR_BUILD
 * Staleness beats everything because an expired diagnosis must be refreshed before any other conclusion is trusted;
 * a referral beats the rest because a problem that belongs elsewhere is never a Marketing build; and so on down.
 * A PROBLEM/OPPORTUNITY whose materiality is still UNKNOWN is NOT_MEASURABLE (never READY on unknowns).
 */
export function evaluateFindingReadiness(finding, asOf) {
  const result = (status, ...reasonCodes) => deepFreeze({ status, reason_codes: reasonCodes });
  if (findingFreshness(finding, asOf) === FRESHNESS.STALE) return result(READINESS.STALE, 'FINDING_EXPIRED');
  const fit = finding.domain_fit?.status;
  const overall = finding.materiality?.overall;
  if (fit === DOMAIN_FIT_STATUS.REFER_TO_DOMAIN) return result(READINESS.REFER_TO_DOMAIN, 'DOMAIN_FIT_REFER_TO_DOMAIN');
  if (finding.finding_type === FINDING_TYPE.NOT_MEASURABLE) return result(READINESS.NOT_MEASURABLE, 'FINDING_NOT_MEASURABLE');
  if (fit === DOMAIN_FIT_STATUS.NOT_MEASURABLE) return result(READINESS.NOT_MEASURABLE, 'DOMAIN_FIT_NOT_MEASURABLE');
  if (finding.finding_type === FINDING_TYPE.NO_MATERIAL_SIGNAL) return result(READINESS.NO_MATERIAL_SIGNAL, 'FINDING_NO_MATERIAL_SIGNAL');
  if (overall === MATERIALITY_OVERALL.NOT_MATERIAL) return result(READINESS.NO_MATERIAL_SIGNAL, 'MATERIALITY_NOT_MATERIAL');
  if (fit === DOMAIN_FIT_STATUS.NO_MATERIAL_SIGNAL) return result(READINESS.NO_MATERIAL_SIGNAL, 'DOMAIN_FIT_NO_MATERIAL_SIGNAL');
  if (overall !== MATERIALITY_OVERALL.MATERIAL) return result(READINESS.NOT_MEASURABLE, 'MATERIALITY_UNKNOWN');
  if (NEEDS_EVIDENCE.has(finding.finding_type) && fit === DOMAIN_FIT_STATUS.MARKETING_RELEVANT) {
    return result(READINESS.READY_FOR_BUILD, 'FRESH_MATERIAL_MARKETING_RELEVANT');
  }
  return result(READINESS.NOT_MEASURABLE, 'FINDING_NOT_BUILD_ELIGIBLE');
}
