// AudienceIntent and MarketingPushProposal ("Poussée"): one structured Marketing OPTION submitted to the Socle.
//
// M2 PROPOSES, the Socle DECIDES. A Push is built only from a Finding that is really READY_FOR_BUILD (the M1 gate is
// reused, not re-implemented). It declares an intent, what it would consume, how long it takes, how it would be measured
// and how reversible it is. It carries no approval, no budget authority, no execution, no creative, no price, and
// READY_FOR_SOCLE is NOT approved / executable / budget-authorized / inventory-reserved / policy-cleared.
//
// One clock: the explicit `asOf` is the creation time AND the evaluation time of everything computed at build
// (finding gate, lead-time fit, readiness). Nothing here reads the system clock.
//
// Trust boundary: tenant, Brand Identity, Finding and every ref come from trusted server-side adapters; M2 validates shape,
// scope and coherence, and does no authentication or cryptographic verification.

import { evaluateFindingReadiness, normalizeMarketingFinding } from './finding.js';
import { READINESS } from './understand-constants.js';
import {
  ACTION_MODE, AUDIENCE_MODE, ELIGIBILITY_STATUS, FITNESS_OVERALL, FORBIDDEN_LEVER_TOKENS, LEAD_TIME_FIT,
  LEVER_FAMILY, M2_ERROR as X, M2_VERSION, PUSH_READINESS, REVERSIBILITY_STATUS,
} from './m2-constants.js';
import { canonical } from './m2-validation.js';
import { normalizeLeverFitness } from './lever-fitness.js';
import { buildEstimatedLeadTime, buildExecutionWindow, buildResourceRequirements, evaluateLeadTimeFit } from './resource-requirements.js';
import { buildMeasurementPlan, buildReversibility } from './measurement-plan.js';
import {
  asOfValue, closedObject, deepFreeze, deriveId, enumValue, fail, isoTimestamp, optionalRef, refList, requiredText,
  tenantMerchantId, tokenList, toMs, upperToken,
} from './understand-validation.js';

// ---- AudienceIntent ----
const AUDIENCE_KEYS = ['mode', 'segment_ref', 'criteria_refs', 'exclusion_refs', 'materialization_required'];

/**
 * What audience a Push intends - never who. Marketing carries no profile, no list, no PII and no query language: a segment is
 * an opaque ref that Customers owns, and a DEFINITION is a NON-executable set of criteria refs that must be materialized by
 * Customers before any use (`materialization_required` is always true for a DEFINITION).
 */
export function buildAudienceIntent(input) {
  closedObject(input, AUDIENCE_KEYS, 'audience');
  const mode = enumValue(input.mode, AUDIENCE_MODE, 'audience.mode', X.AUDIENCE_INVALID_MODE);
  const segmentRef = optionalRef(input.segment_ref, 'audience.segment_ref');
  const criteria = refList(input.criteria_refs, 'audience.criteria_refs');
  const exclusions = refList(input.exclusion_refs, 'audience.exclusion_refs');
  const materialization = input.materialization_required;

  if (mode === AUDIENCE_MODE.GENERAL && (segmentRef || criteria.length || exclusions.length || materialization === true)) {
    fail(X.AUDIENCE_FIELD_NOT_ALLOWED, 'a GENERAL audience carries no segment, criteria or exclusion');
  }
  if (mode === AUDIENCE_MODE.SEGMENT_REF) {
    if (!segmentRef) fail(X.AUDIENCE_SEGMENT_REQUIRED, 'a SEGMENT_REF audience needs a segment_ref');
    if (criteria.length || exclusions.length || materialization === true) fail(X.AUDIENCE_FIELD_NOT_ALLOWED, 'a SEGMENT_REF audience carries no definition');
  }
  if (mode === AUDIENCE_MODE.DEFINITION) {
    if (segmentRef) fail(X.AUDIENCE_FIELD_NOT_ALLOWED, 'a DEFINITION audience has no segment_ref');
    if (!criteria.length) fail(X.AUDIENCE_CRITERIA_REQUIRED, 'a DEFINITION audience needs at least one criteria_ref');
    if (materialization !== undefined && materialization !== true) fail(X.AUDIENCE_MATERIALIZATION_REQUIRED, 'a DEFINITION is not executable: materialization_required is always true');
  }
  return deepFreeze({
    mode,
    segment_ref: segmentRef,
    criteria_refs: criteria,
    exclusion_refs: exclusions,
    materialization_required: mode === AUDIENCE_MODE.DEFINITION,
  });
}

// ---- keys ----
// What a caller may supply. merchant_id, brand_id, finding_ref, push_id, created_at, lead_time_fit, readiness and
// schema_version are derived and therefore refused as input.
const BUILD_KEYS = [
  'action_mode', 'lever_family', 'lever_variant', 'hypothesis_ref', 'objective', 'subject_refs', 'audience', 'channels',
  'lever_fitness', 'resource_requirements', 'estimated_lead_time', 'valid_execution_window', 'measurement_plan', 'claim_refs',
  'policy_requirement_refs', 'consent_requirement_refs', 'promotion_rule_refs', 'risk_refs', 'unknown_refs', 'reversibility',
  'expires_at',
];
const PUSH_KEYS = [
  'push_id', 'schema_version', 'merchant_id', 'brand_id', 'finding_ref', ...BUILD_KEYS, 'lead_time_fit', 'created_at', 'readiness',
];

function leverToken(value, field) {
  const token = upperToken(value, field);
  if (FORBIDDEN_LEVER_TOKENS.includes(token)) fail(X.LEVER_FORBIDDEN, `${field} is owned by another domain and is not a Marketing lever`, { field });
  return token;
}

function leverFamily(value) {
  if (typeof value === 'string' && FORBIDDEN_LEVER_TOKENS.includes(value.trim())) {
    fail(X.LEVER_FORBIDDEN, 'push.lever_family is owned by another domain and is not a Marketing lever');
  }
  return enumValue(value, LEVER_FAMILY, 'push.lever_family', X.LEVER_INVALID_FAMILY);
}

// ---- Finding gate ----
/**
 * Validates the Finding (the M1 contract, including its tenant/brand scope) and applies the M1 readiness gate unchanged.
 * Anything but READY_FOR_BUILD (STALE, REFER_TO_DOMAIN, NOT_MEASURABLE, NO_MATERIAL_SIGNAL) is refused.
 */
export function gateFinding({ tenant, brand, finding, asOfIso }) {
  const validated = normalizeMarketingFinding(finding, { tenant, brand });
  const readiness = evaluateFindingReadiness(validated, asOfIso);
  if (readiness.status !== READINESS.READY_FOR_BUILD) {
    fail(X.FINDING_NOT_READY, `a Push needs a READY_FOR_BUILD Finding (found ${readiness.status})`, { readiness: readiness.status });
  }
  return validated;
}

// ---- readiness ----
function readinessOf(push, asOfIso) {
  const result = (status, ...reasonCodes) => ({ status, reason_codes: reasonCodes });
  if (toMs(push.expires_at) <= toMs(asOfIso)) return result(PUSH_READINESS.STALE, 'PROPOSAL_EXPIRED');

  const leadFit = evaluateLeadTimeFit(push.estimated_lead_time, push.valid_execution_window, asOfIso);
  const notEligible = [];
  if (push.lever_fitness.overall === FITNESS_OVERALL.NOT_FIT) notEligible.push('LEVER_FITNESS_NOT_FIT');
  if (leadFit.status === LEAD_TIME_FIT.NOT_FIT) notEligible.push('LEAD_TIME_NOT_FIT');
  if (push.action_mode === ACTION_MODE.TEST_SMALL && push.reversibility.status === REVERSIBILITY_STATUS.HARD_TO_REVERSE) {
    notEligible.push('TEST_SMALL_HARD_TO_REVERSE');
  }
  if (notEligible.length) return result(PUSH_READINESS.NOT_ELIGIBLE, ...notEligible);

  const needsEvidence = [];
  if (push.lever_fitness.overall === FITNESS_OVERALL.UNKNOWN) needsEvidence.push('LEVER_FITNESS_UNKNOWN');
  if (push.measurement_plan.eligibility_status === ELIGIBILITY_STATUS.UNKNOWN) needsEvidence.push('MEASUREMENT_ELIGIBILITY_UNKNOWN');
  if (needsEvidence.length) return result(PUSH_READINESS.NEEDS_EVIDENCE, ...needsEvidence);

  return result(PUSH_READINESS.READY_FOR_SOCLE, 'FIT_AND_MEASURABLE');
}

/**
 * Live readiness of a stored Push at `asOf`. Precedence: STALE > NOT_ELIGIBLE > NEEDS_EVIDENCE > READY_FOR_SOCLE.
 *   STALE          the proposal is expired (its expiry never exceeds its Finding's, so a stale Finding implies a stale Push)
 *   NOT_ELIGIBLE   lever fitness NOT_FIT, lead time NOT_FIT at asOf, or a TEST_SMALL that is HARD_TO_REVERSE
 *   NEEDS_EVIDENCE lever fitness UNKNOWN, or the measurement eligibility is unresolved (UNKNOWN)
 *   READY_FOR_SOCLE fresh, fitness FIT, lead time FIT, valid MeasurementPlan (a Push whose plan is invalid cannot exist)
 */
export function evaluatePushReadiness(push, asOf) {
  return deepFreeze(readinessOf(push, asOfValue(asOf)));
}

// ---- MarketingPushProposal ----
/**
 * @param {object} p
 * @param {object} p.tenant   resolved tenant
 * @param {object|null} [p.brand] resolved Brand Identity (checked against the Finding's brand scope; never inferred)
 * @param {object} p.finding  a complete M1 MarketingFinding; merchant_id, brand_id and finding_ref are derived from it
 * @param {string|Date} p.asOf the explicit clock = created_at
 * Remaining keys: BUILD_KEYS (closed). Passing merchant_id / brand_id / push_id / created_at... is refused.
 */
export function buildMarketingPushProposal({ tenant, brand = null, finding, asOf, ...fields } = {}) {
  tenantMerchantId(tenant);
  const createdAt = asOfValue(asOf);
  const validated = gateFinding({ tenant, brand, finding, asOfIso: createdAt });
  closedObject(fields, BUILD_KEYS, 'push');

  const actionMode = enumValue(fields.action_mode, ACTION_MODE, 'push.action_mode', X.ACTION_MODE_INVALID);
  const family = leverFamily(fields.lever_family);

  const subjectRefs = refList(fields.subject_refs, 'push.subject_refs', { max: 20 });
  if (!subjectRefs.length) fail(X.PUSH_SUBJECT_REQUIRED, 'a Push needs at least one subject_ref');
  const channels = tokenList(fields.channels, 'push.channels', { max: 10 });
  if (!channels.length) fail(X.PUSH_CHANNEL_REQUIRED, 'a Push needs at least one channel');
  for (const channel of channels) leverToken(channel, 'push.channels');

  const hypothesisRef = optionalRef(fields.hypothesis_ref, 'push.hypothesis_ref');
  if (hypothesisRef && !validated.hypotheses.some((h) => h.hypothesis_id === hypothesisRef)) {
    fail(X.HYPOTHESIS_UNKNOWN, 'push.hypothesis_ref is not a hypothesis of this Finding');
  }

  const expiresAt = isoTimestamp(fields.expires_at, 'push.expires_at', X.PUSH_INVALID_EXPIRY);
  if (toMs(expiresAt) <= toMs(createdAt)) fail(X.PUSH_INVALID_EXPIRY, 'push.expires_at must be after created_at');
  if (toMs(expiresAt) > toMs(validated.expires_at)) fail(X.PUSH_OUTLIVES_FINDING, 'a Push cannot outlive its Finding');

  const leadTime = buildEstimatedLeadTime(fields.estimated_lead_time ?? {});
  const window = buildExecutionWindow(fields.valid_execution_window ?? {});

  const body = {
    schema_version: M2_VERSION,
    merchant_id: validated.merchant_id,
    brand_id: validated.brand_id,
    finding_ref: validated.finding_id,
    hypothesis_ref: hypothesisRef,
    action_mode: actionMode,
    lever_family: family,
    lever_variant: fields.lever_variant == null ? null : leverToken(fields.lever_variant, 'push.lever_variant'),
    objective: requiredText(fields.objective, 'push.objective', { max: 300 }), // human text, never parsed by the engine
    subject_refs: subjectRefs,
    audience: buildAudienceIntent(fields.audience ?? {}),
    channels,
    lever_fitness: normalizeLeverFitness(fields.lever_fitness, 'push.lever_fitness'),
    resource_requirements: buildResourceRequirements(fields.resource_requirements ?? {}),
    estimated_lead_time: leadTime,
    valid_execution_window: window,
    lead_time_fit: evaluateLeadTimeFit(leadTime, window, createdAt),
    measurement_plan: buildMeasurementPlan(fields.measurement_plan ?? {}),
    claim_refs: refList(fields.claim_refs, 'push.claim_refs'),
    policy_requirement_refs: refList(fields.policy_requirement_refs, 'push.policy_requirement_refs'),
    consent_requirement_refs: refList(fields.consent_requirement_refs, 'push.consent_requirement_refs'),
    promotion_rule_refs: refList(fields.promotion_rule_refs, 'push.promotion_rule_refs'),
    risk_refs: refList(fields.risk_refs, 'push.risk_refs'),
    unknown_refs: refList(fields.unknown_refs, 'push.unknown_refs'),
    reversibility: buildReversibility(fields.reversibility ?? {}),
    created_at: createdAt,
    expires_at: expiresAt,
  };
  body.readiness = readinessOf(body, createdAt);
  return deepFreeze({ push_id: deriveId('mpp', body), ...body });
}

/**
 * Re-validates a STORED Push against the Finding it claims to come from. Every derived field (ids, scope, finding_ref,
 * lead_time_fit, readiness) is recomputed by rebuilding the Push from its own non-derived fields at its own created_at:
 * a forged or inconsistent Push is refused, never trusted.
 */
export function normalizeMarketingPushProposal(input, { tenant, finding, brand = null } = {}) {
  closedObject(input, PUSH_KEYS, 'push');
  const supplied = Object.fromEntries(BUILD_KEYS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
  // lever_variant / hypothesis_ref are stored as null when absent; null means "absent" for the builder too.
  const rebuilt = buildMarketingPushProposal({ tenant, brand, finding, asOf: input.created_at, ...supplied });
  if (canonical(rebuilt) !== canonical(input)) fail(X.PUSH_DERIVED_MISMATCH, 'the Push does not match what its own fields and Finding produce');
  return rebuilt;
}
