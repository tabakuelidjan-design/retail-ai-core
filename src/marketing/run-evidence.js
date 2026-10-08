// OfflineAttributionObservation and RunEvidenceBundle: how measured results reach M4 through a NEUTRAL contract.
//
// M4 computes no metric and calls no source: the bundle only carries REFS to results produced by the existing deterministic
// measurement layer (or by a trusted adapter), the evidence class they belong to and the assessment status a trusted adapter
// decided. No number lives here, no model chooses a status, no PII is stored.
//
//   OBSERVED != ATTRIBUTED != OFFLINE_ATTRIBUTED != INCREMENTAL, and none of them is a causal proof by itself.
//
// A QR / promo code / short URL / POS marker / coupon / self-report is ATTRIBUTION: never incrementality, never causality
// (`causal_claim` is always false). A self-report stores a REF to its evidence, never the raw answer.

import { MKT_ERROR as E } from './understand-constants.js';
import {
  ASSESSMENT_STATUS, CRITERION_STATUS, DATA_STATE, EVIDENCE_CLASS, FORBIDDEN_PII_KEYS, FORBIDDEN_STEER_KEYS,
  INCREMENTALITY_STATUS, M4_ERROR as Z, MARKETING_STEER_VERSION, MAX_OFFLINE_OBSERVATIONS, OFFLINE_METHOD,
} from './m4-constants.js';
import { CONTROL_METHOD, ELIGIBILITY_STATUS } from './m2-constants.js';
import { verifiedRun } from './marketing-run.js';
import {
  canonical, rejectForbidden, safeRef, safeRefList, verifiedPush,
} from './m4-validation.js';
import {
  closedObject, deepFreeze, deriveId, enumValue, fail, isPlainObject, isoTimestamp, tenantMerchantId, tokenList, toMs,
} from './understand-validation.js';

const OFFLINE_KEYS = ['observation_id', 'method', 'result_ref', 'source_ref', 'evidence_refs', 'observed_at', 'limitations', 'causal_claim'];
const CRITERION_KEYS = ['criterion_ref', 'status', 'evidence_refs'];
const STOP_RULE_KEYS = ['rule_ref', 'status', 'evidence_refs'];
const OPTION_KEYS = [
  'tenant', 'push', 'run', 'data_state', 'evidence_class', 'assessment_status', 'primary_metric_ref', 'observed_result_refs',
  'attributed_result_refs', 'offline_attribution_observations', 'incremental_result_ref', 'success_criterion', 'failure_criterion',
  'stop_rule_assessments', 'guardrail_assessment_refs', 'evidence_refs', 'limitations', 'assessed_at',
];
const BUNDLE_KEYS = [
  'assessment_ref', 'schema_version', 'merchant_id', 'brand_id', 'run_ref', 'measurement_plan_ref', 'data_state', 'evidence_class',
  'assessment_status', 'primary_metric_ref', 'observed_result_refs', 'attributed_result_refs', 'offline_attribution_observations',
  'incremental_result_ref', 'success_criterion', 'failure_criterion', 'stop_rule_assessments', 'guardrail_assessment_refs',
  'evidence_refs', 'limitations', 'assessed_at',
];
const MAX_STOP_RULES = 20;

const guard = (value, field) => rejectForbidden(value, field, FORBIDDEN_STEER_KEYS, FORBIDDEN_PII_KEYS);

// ---------------------------------------------------------------- offline attribution
/**
 * Builds (or re-validates, when `observation_id` is supplied) ONE offline attribution observation. Methods are a closed list;
 * evidence is mandatory; `causal_claim` is always false (true is refused); a raw self-report text or any PII key is refused.
 */
export function buildOfflineAttributionObservation(input) {
  guard(input, 'offline_attribution');
  closedObject(input, OFFLINE_KEYS, 'offline_attribution');
  if (input.causal_claim !== undefined && input.causal_claim !== false) fail(Z.OFFLINE_CAUSAL_CLAIM, 'an offline attribution never claims causality (causal_claim is always false)');
  const evidence = safeRefList(input.evidence_refs, 'offline_attribution.evidence_refs');
  if (!evidence.length) fail(Z.OFFLINE_EVIDENCE_REQUIRED, 'an offline attribution needs evidence');
  const body = {
    method: enumValue(input.method, OFFLINE_METHOD, 'offline_attribution.method', Z.OFFLINE_INVALID_METHOD),
    result_ref: safeRef(input.result_ref, 'offline_attribution.result_ref'),
    source_ref: safeRef(input.source_ref, 'offline_attribution.source_ref'),
    evidence_refs: evidence,
    observed_at: isoTimestamp(input.observed_at, 'offline_attribution.observed_at'),
    limitations: tokenList(input.limitations, 'offline_attribution.limitations'),
    causal_claim: false,
  };
  const observation = { observation_id: deriveId('moa', body), ...body };
  if (input.observation_id !== undefined && input.observation_id !== observation.observation_id) {
    fail(Z.EVIDENCE_DERIVED_MISMATCH, 'the offline observation does not match its own id');
  }
  return deepFreeze(observation);
}

// ---------------------------------------------------------------- incrementality gate
/** true only for a HOLDOUT design that M2 declared ELIGIBLE (and therefore an incrementality candidate). */
export const incrementalityAllowed = (plan) => plan.control_method === CONTROL_METHOD.HOLDOUT
  && plan.eligibility_status === ELIGIBILITY_STATUS.ELIGIBLE && plan.incrementality_candidate === true;

/**
 * Derived incrementality status, separate from the outcome:
 *   UNTESTABLE      control NONE / TIME (the business layer's INCREMENTALITY_UNTESTABLE): no incremental claim is ever possible
 *   NOT_MEASURABLE  an eligible HOLDOUT whose execution / data quality is known to prevent an incremental conclusion
 *   UNKNOWN         the incremental data is expected but still pending
 *   MEASURABLE      HOLDOUT + ELIGIBLE + class INCREMENTAL + incremental ref + COMPLETE data
 */
export function deriveIncrementalityStatus(plan, bundle) {
  if (!incrementalityAllowed(plan)) return INCREMENTALITY_STATUS.UNTESTABLE;
  if (bundle.assessment_status === ASSESSMENT_STATUS.NOT_MEASURABLE) return INCREMENTALITY_STATUS.NOT_MEASURABLE;
  if (bundle.data_state === DATA_STATE.PENDING || bundle.assessment_status === ASSESSMENT_STATUS.UNKNOWN) return INCREMENTALITY_STATUS.UNKNOWN;
  if (bundle.data_state !== DATA_STATE.COMPLETE) return INCREMENTALITY_STATUS.NOT_MEASURABLE;
  if (bundle.evidence_class !== EVIDENCE_CLASS.INCREMENTAL || !bundle.incremental_result_ref) return INCREMENTALITY_STATUS.NOT_MEASURABLE;
  return INCREMENTALITY_STATUS.MEASURABLE;
}

// ---------------------------------------------------------------- criterion / stop rule assessments
function criterion(input, field, expectedRef) {
  closedObject(input, CRITERION_KEYS, field);
  const ref = safeRef(input.criterion_ref, `${field}.criterion_ref`);
  if (ref !== expectedRef) fail(Z.EVIDENCE_CRITERION_MISMATCH, `${field} is not the criterion of the MeasurementPlan`);
  return {
    criterion_ref: ref,
    status: enumValue(input.status, CRITERION_STATUS, `${field}.status`),
    evidence_refs: safeRefList(input.evidence_refs, `${field}.evidence_refs`),
  };
}

function stopRules(value, plan) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(E.INVALID_FIELD, 'stop_rule_assessments must be an array', { field: 'stop_rule_assessments' });
  if (value.length > MAX_STOP_RULES) fail(E.INVALID_FIELD, `at most ${MAX_STOP_RULES} stop rule assessments`, { field: 'stop_rule_assessments' });
  const out = value.map((entry, i) => {
    closedObject(entry, STOP_RULE_KEYS, `stop_rule_assessments[${i}]`);
    const ref = safeRef(entry.rule_ref, `stop_rule_assessments[${i}].rule_ref`);
    if (!plan.stop_rule_refs.includes(ref)) fail(Z.EVIDENCE_STOP_RULE_UNKNOWN, 'a stop rule assessment names a rule that is not in the MeasurementPlan');
    return {
      rule_ref: ref,
      status: enumValue(entry.status, CRITERION_STATUS, `stop_rule_assessments[${i}].status`),
      evidence_refs: safeRefList(entry.evidence_refs, `stop_rule_assessments[${i}].evidence_refs`),
    };
  });
  if (new Set(out.map((r) => r.rule_ref)).size !== out.length) fail(E.DUPLICATE_ENTRY, 'a stop rule is assessed more than once', { field: 'stop_rule_assessments' });
  return out;
}

// ---------------------------------------------------------------- RunEvidenceBundle
/**
 * @param {object} p { tenant, push, run, data_state, evidence_class, assessment_status, primary_metric_ref, observed_result_refs?,
 *                     attributed_result_refs?, offline_attribution_observations?, incremental_result_ref?, success_criterion,
 *                     failure_criterion, stop_rule_assessments?, guardrail_assessment_refs?, evidence_refs?, limitations?, assessed_at }
 * merchant_id, brand_id, run_ref, measurement_plan_ref and assessment_ref are DERIVED from the originals; none can be supplied.
 */
export function buildRunEvidenceBundle(options = {}) {
  const { tenant, push: pushInput, run: runInput, ...fields } = options;
  guard(fields, 'evidence');
  closedObject(options, OPTION_KEYS, 'evidence');
  const merchantId = tenantMerchantId(tenant);
  const push = verifiedPush(pushInput, merchantId);
  const run = verifiedRun(runInput, push, merchantId);
  const plan = push.measurement_plan;

  const dataState = enumValue(fields.data_state, DATA_STATE, 'evidence.data_state', Z.EVIDENCE_INVALID_STATE);
  const evidenceClass = enumValue(fields.evidence_class, EVIDENCE_CLASS, 'evidence.evidence_class', Z.EVIDENCE_INVALID_CLASS);
  const assessmentStatus = enumValue(fields.assessment_status, ASSESSMENT_STATUS, 'evidence.assessment_status', Z.EVIDENCE_INVALID_STATUS);

  const primary = safeRef(fields.primary_metric_ref, 'evidence.primary_metric_ref');
  if (primary !== plan.primary_metric_ref) fail(Z.EVIDENCE_METRIC_MISMATCH, 'the primary metric is not the one of the MeasurementPlan');

  const observed = safeRefList(fields.observed_result_refs, 'evidence.observed_result_refs');
  const attributed = safeRefList(fields.attributed_result_refs, 'evidence.attributed_result_refs');
  const offlineInput = fields.offline_attribution_observations ?? [];
  if (!Array.isArray(offlineInput)) fail(E.INVALID_FIELD, 'offline_attribution_observations must be an array', { field: 'evidence.offline_attribution_observations' });
  if (offlineInput.length > MAX_OFFLINE_OBSERVATIONS) fail(E.INVALID_FIELD, `at most ${MAX_OFFLINE_OBSERVATIONS} offline observations`, { field: 'evidence.offline_attribution_observations' });
  const offline = offlineInput.map((observation) => buildOfflineAttributionObservation(observation));
  if (new Set(offline.map((o) => o.observation_id)).size !== offline.length) fail(E.DUPLICATE_ENTRY, 'an offline observation is repeated', { field: 'evidence.offline_attribution_observations' });
  const incrementalRef = fields.incremental_result_ref == null ? null : safeRef(fields.incremental_result_ref, 'evidence.incremental_result_ref');

  // An incremental result exists only for an eligible HOLDOUT, and only together with the INCREMENTAL class (and the reverse).
  if ((incrementalRef || evidenceClass === EVIDENCE_CLASS.INCREMENTAL) && !incrementalityAllowed(plan)) {
    fail(Z.INCREMENTAL_RESULT_NOT_ALLOWED, 'an incremental result needs a HOLDOUT, ELIGIBLE, incrementality-candidate MeasurementPlan');
  }
  if (incrementalRef && evidenceClass !== EVIDENCE_CLASS.INCREMENTAL) {
    fail(Z.INCREMENTAL_RESULT_NOT_ALLOWED, 'an incremental_result_ref requires the INCREMENTAL evidence class');
  }
  const hasData = dataState === DATA_STATE.COMPLETE || dataState === DATA_STATE.PARTIAL;
  if (evidenceClass === EVIDENCE_CLASS.INCREMENTAL && hasData && !incrementalRef) {
    fail(Z.INCREMENTAL_RESULT_REQUIRED, 'the INCREMENTAL evidence class needs an incremental_result_ref when data is present');
  }
  const layerPresent = {
    [EVIDENCE_CLASS.OBSERVED]: observed.length > 0,
    [EVIDENCE_CLASS.ATTRIBUTED]: attributed.length > 0,
    [EVIDENCE_CLASS.OFFLINE_ATTRIBUTED]: offline.length > 0,
    [EVIDENCE_CLASS.INCREMENTAL]: Boolean(incrementalRef),
  };
  if (hasData && !layerPresent[evidenceClass]) fail(Z.EVIDENCE_LAYER_MISSING, 'the evidence class has no result of its own layer');

  const evidence = safeRefList(fields.evidence_refs, 'evidence.evidence_refs');
  if (hasData && !evidence.length) fail(Z.EVIDENCE_LAYER_MISSING, 'a bundle with data needs evidence refs');

  const assessedAt = isoTimestamp(fields.assessed_at, 'evidence.assessed_at');
  if (toMs(assessedAt) < toMs(run.activated_at)) fail(Z.EVIDENCE_BEFORE_ACTIVATION, 'the evidence was assessed before the activation');

  const body = {
    schema_version: MARKETING_STEER_VERSION,
    merchant_id: merchantId,
    brand_id: push.brand_id,
    run_ref: run.run_id,
    measurement_plan_ref: run.measurement_plan_ref,
    data_state: dataState,
    evidence_class: evidenceClass,
    assessment_status: assessmentStatus,
    primary_metric_ref: primary,
    observed_result_refs: observed,
    attributed_result_refs: attributed,
    offline_attribution_observations: offline,
    incremental_result_ref: incrementalRef,
    success_criterion: criterion(fields.success_criterion, 'evidence.success_criterion', plan.success_criterion_ref),
    failure_criterion: criterion(fields.failure_criterion, 'evidence.failure_criterion', plan.failure_criterion_ref),
    stop_rule_assessments: stopRules(fields.stop_rule_assessments, plan),
    guardrail_assessment_refs: safeRefList(fields.guardrail_assessment_refs, 'evidence.guardrail_assessment_refs'), // opaque: no guardrail engine in M4
    evidence_refs: evidence,
    limitations: tokenList(fields.limitations, 'evidence.limitations'),
    assessed_at: assessedAt,
  };
  return deepFreeze({ assessment_ref: deriveId('mre', body), ...body });
}

/** Re-validates a STORED bundle against its Run and Push by rebuilding it from its own non-derived fields. */
export function normalizeRunEvidenceBundle(input, { tenant, push, run } = {}) {
  closedObject(input, BUNDLE_KEYS, 'evidence');
  if (!isPlainObject(input)) fail(E.INVALID_FIELD, 'evidence must be an object', { field: 'evidence' });
  const { assessment_ref: _ref, schema_version: _v, merchant_id: _m, brand_id: _b, run_ref: _r, measurement_plan_ref: _p, ...supplied } = input;
  const rebuilt = buildRunEvidenceBundle({ tenant, push, run, ...supplied });
  if (canonical(rebuilt) !== canonical(input)) fail(Z.EVIDENCE_DERIVED_MISMATCH, 'the evidence bundle does not match what its own fields and Run produce');
  return rebuilt;
}
