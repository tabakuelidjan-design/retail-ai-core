// MeasurementPlan and Reversibility.
//
// A MeasurementPlan only NAMES, by opaque ref, what will be measured and how it will be judged: no formula, no DSL, no
// statistical-power calculation (M2 computes none). Its derived `incrementality_candidate` never means "causality proven".
//
// For STEER (M4) - documented here, not implemented:
//   control_method NONE            -> no incremental claim is possible
//   control_method TIME            -> ceiling SUGGESTIVE
//   control_method HOLDOUT + ELIGIBLE -> incrementality may be measurable later (still a design intent, not a result)

import {
  CONTROL_METHOD, ELIGIBILITY_STATUS, M2_ERROR as X, REVERSIBILITY_STATUS,
} from './m2-constants.js';
import {
  closedObject, deepFreeze, enumValue, fail, isoTimestamp, opaqueRef, refList, tokenList, toMs,
} from './understand-validation.js';

const PLAN_KEYS = [
  'baseline_ref', 'primary_metric_ref', 'guardrail_metric_refs', 'observation_window', 'control_method', 'eligibility_status',
  'eligibility_evidence_refs', 'success_criterion_ref', 'failure_criterion_ref', 'stop_rule_refs', 'incrementality_candidate',
];
const WINDOW_KEYS = ['start', 'end'];
const REVERSIBILITY_KEYS = ['status', 'reason_codes', 'evidence_refs'];

function observationWindow(input) {
  closedObject(input, WINDOW_KEYS, 'measurement_plan.observation_window');
  const start = isoTimestamp(input.start, 'measurement_plan.observation_window.start', X.MEASUREMENT_INVALID_WINDOW);
  const end = isoTimestamp(input.end, 'measurement_plan.observation_window.end', X.MEASUREMENT_INVALID_WINDOW);
  if (toMs(end) <= toMs(start)) fail(X.MEASUREMENT_INVALID_WINDOW, 'measurement_plan.observation_window.end must be after start');
  return { start, end };
}

export function buildMeasurementPlan(input) {
  closedObject(input, PLAN_KEYS, 'measurement_plan');
  const control = enumValue(input.control_method, CONTROL_METHOD, 'measurement_plan.control_method', X.MEASUREMENT_INVALID_CONTROL);
  const eligibility = enumValue(input.eligibility_status, ELIGIBILITY_STATUS, 'measurement_plan.eligibility_status', X.MEASUREMENT_INVALID_ELIGIBILITY);
  const eligibilityEvidence = refList(input.eligibility_evidence_refs, 'measurement_plan.eligibility_evidence_refs');

  if (control === CONTROL_METHOD.HOLDOUT) {
    if (eligibility !== ELIGIBILITY_STATUS.ELIGIBLE) fail(X.MEASUREMENT_HOLDOUT_NOT_ELIGIBLE, 'a HOLDOUT design must be ELIGIBLE');
    if (!eligibilityEvidence.length) fail(X.MEASUREMENT_EVIDENCE_REQUIRED, 'a HOLDOUT design needs eligibility evidence');
  }
  const incrementalityCandidate = control === CONTROL_METHOD.HOLDOUT && eligibility === ELIGIBILITY_STATUS.ELIGIBLE;
  if (input.incrementality_candidate !== undefined && input.incrementality_candidate !== incrementalityCandidate) {
    fail(X.MEASUREMENT_INCREMENTALITY_MISMATCH, 'incrementality_candidate is derived and does not match the plan');
  }

  return deepFreeze({
    baseline_ref: opaqueRef(input.baseline_ref, 'measurement_plan.baseline_ref'),
    primary_metric_ref: opaqueRef(input.primary_metric_ref, 'measurement_plan.primary_metric_ref'),
    guardrail_metric_refs: refList(input.guardrail_metric_refs, 'measurement_plan.guardrail_metric_refs'),
    observation_window: observationWindow(input.observation_window ?? {}),
    control_method: control,
    eligibility_status: eligibility,
    eligibility_evidence_refs: eligibilityEvidence,
    success_criterion_ref: opaqueRef(input.success_criterion_ref, 'measurement_plan.success_criterion_ref'),
    failure_criterion_ref: opaqueRef(input.failure_criterion_ref, 'measurement_plan.failure_criterion_ref'),
    stop_rule_refs: refList(input.stop_rule_refs, 'measurement_plan.stop_rule_refs'),
    incrementality_candidate: incrementalityCandidate,
  });
}

/** Reversibility is a visible status with reasons, not a score. */
export function buildReversibility(input) {
  closedObject(input, REVERSIBILITY_KEYS, 'reversibility');
  const reasonCodes = tokenList(input.reason_codes, 'reversibility.reason_codes');
  if (!reasonCodes.length) fail(X.REVERSIBILITY_REASON_REQUIRED, 'reversibility needs at least one reason code');
  return deepFreeze({
    status: enumValue(input.status, REVERSIBILITY_STATUS, 'reversibility.status', X.REVERSIBILITY_INVALID_STATUS),
    reason_codes: reasonCodes,
    evidence_refs: refList(input.evidence_refs, 'reversibility.evidence_refs'),
  });
}
