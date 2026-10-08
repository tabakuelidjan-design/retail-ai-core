// MarketingRunResult: what Nordla can honestly say about a Run at a given time.
//
//   OBSERVED != ATTRIBUTED != INCREMENTAL != CAUSAL
//
// The outcome is DERIVED from the evidence class, the data state, the assessment status chosen by a trusted measurement adapter,
// the MeasurementPlan design and the Run's execution status. CONFIRMED / REFUTED exist only for a FINAL, EXECUTED, INCREMENTAL
// result of an eligible HOLDOUT design with COMPLETE data. Everything else is capped at SUGGESTIVE, NOT_MEASURABLE or UNKNOWN.
// UNKNOWN ("we do not have the expected data yet") is never merged with NOT_MEASURABLE ("we know the design or the data cannot
// conclude"). M4 computes no number: refs only. A stored result is a snapshot, never a live authority.

import {
  ASSESSMENT_STATUS, DATA_STATE, DIRECTION, EVIDENCE_CLASS, EXECUTION_STATUS, FINALIZATION_REASON, INCREMENTALITY_STATUS,
  M4_ERROR as Z, MARKETING_STEER_VERSION, OUTCOME, RESULT_SIGNAL, RESULT_STATE, CRITERION_STATUS,
} from './m4-constants.js';
import { CONTROL_METHOD } from './m2-constants.js';
import { verifiedRun } from './marketing-run.js';
import { deriveIncrementalityStatus, incrementalityAllowed, normalizeRunEvidenceBundle } from './run-evidence.js';
import {
  assertOwnId, canonical, sortedUnique, verifiedPush,
} from './m4-validation.js';
import {
  asOfValue, closedObject, deepFreeze, deriveId, fail, tenantMerchantId, toMs,
} from './understand-validation.js';

const OPTION_KEYS = ['tenant', 'push', 'run', 'bundle', 'asOf'];
const EVALUATE_KEYS = ['tenant', 'push', 'run', 'bundle', 'asOf'];
const RESULT_KEYS = [
  'result_id', 'schema_version', 'merchant_id', 'brand_id', 'run_ref', 'finding_ref', 'push_ref', 'hypothesis_ref', 'assessment_ref',
  'evaluated_at', 'result_state', 'finalization_reason', 'evidence_class', 'outcome', 'direction', 'incrementality_status',
  'observed_result_refs', 'attributed_result_refs', 'offline_attribution_refs', 'incremental_result_ref', 'success_criterion',
  'failure_criterion', 'stop_rule_assessments', 'evidence_refs', 'limitations', 'review_signals',
];

// How conclusive an outcome is. A live re-evaluation may degrade; it may only improve with strictly newer evidence.
const CONCLUSIVENESS = Object.freeze({
  [OUTCOME.UNKNOWN]: 0, [OUTCOME.NOT_MEASURABLE]: 1, [OUTCOME.SUGGESTIVE]: 2, [OUTCOME.CONFIRMED]: 3, [OUTCOME.REFUTED]: 3,
});

const stopRuleMet = (bundle) => bundle.stop_rule_assessments.some((r) => r.status === CRITERION_STATUS.MET);

function outcomeOf({ state, run, plan, bundle, incrementality }) {
  const inconclusive = (outcome) => ({ outcome, direction: DIRECTION.INCONCLUSIVE });
  if (state === RESULT_STATE.PENDING) return inconclusive(OUTCOME.UNKNOWN); // waiting for the window: nothing is concluded yet
  const status = bundle.assessment_status;
  if (status === ASSESSMENT_STATUS.NOT_MEASURABLE) return inconclusive(OUTCOME.NOT_MEASURABLE); // known insufficiency
  if (bundle.data_state === DATA_STATE.PENDING || status === ASSESSMENT_STATUS.UNKNOWN) return inconclusive(OUTCOME.UNKNOWN); // not yet known
  if (bundle.data_state !== DATA_STATE.COMPLETE) return inconclusive(OUTCOME.NOT_MEASURABLE); // PARTIAL / UNAVAILABLE data cannot conclude
  if (status === ASSESSMENT_STATUS.INCONCLUSIVE) return inconclusive(OUTCOME.NOT_MEASURABLE);

  const direction = status === ASSESSMENT_STATUS.SUPPORTS ? DIRECTION.SUPPORTS : DIRECTION.CHALLENGES;
  // CONFIRMED / REFUTED: ONLY a FINAL, EXECUTED, INCREMENTAL result of an eligible HOLDOUT. NONE / TIME can never reach them.
  const conclusive = bundle.evidence_class === EVIDENCE_CLASS.INCREMENTAL
    && incrementality === INCREMENTALITY_STATUS.MEASURABLE
    && incrementalityAllowed(plan)
    && run.execution_status === EXECUTION_STATUS.EXECUTED;
  if (!conclusive) return { outcome: OUTCOME.SUGGESTIVE, direction };
  return { outcome: direction === DIRECTION.SUPPORTS ? OUTCOME.CONFIRMED : OUTCOME.REFUTED, direction };
}

function limitationsOf({ run, plan, bundle, outcome, incrementality }) {
  const limits = [...bundle.limitations];
  if (bundle.evidence_class === EVIDENCE_CLASS.OBSERVED) limits.push('OBSERVATION_IS_NOT_ATTRIBUTION');
  if (bundle.evidence_class === EVIDENCE_CLASS.ATTRIBUTED) limits.push('ATTRIBUTION_IS_NOT_CAUSALITY');
  if (bundle.evidence_class === EVIDENCE_CLASS.OFFLINE_ATTRIBUTED) limits.push('OFFLINE_ATTRIBUTION_IS_NOT_CAUSALITY');
  if (incrementality === INCREMENTALITY_STATUS.UNTESTABLE) {
    limits.push(plan.control_method === CONTROL_METHOD.TIME ? 'TIME_BASED_CONTROL_ONLY' : 'NO_CONTROL_DESIGN');
  }
  if (run.execution_status === EXECUTION_STATUS.PARTIAL) limits.push('PARTIAL_EXECUTION');
  if (bundle.data_state !== DATA_STATE.COMPLETE) limits.push(`DATA_${bundle.data_state}`);
  if (outcome !== OUTCOME.CONFIRMED && outcome !== OUTCOME.REFUTED) limits.push('INCREMENTALITY_NOT_ESTABLISHED');
  return sortedUnique(limits);
}

function signalsOf({ run, bundle, outcome, direction, incrementality, hypothesisRef }) {
  const signals = [];
  if (run.execution_status === EXECUTION_STATUS.PARTIAL) signals.push(RESULT_SIGNAL.PARTIAL_EXECUTION);
  if (bundle.evidence_class === EVIDENCE_CLASS.OBSERVED) signals.push(RESULT_SIGNAL.OBSERVED_ONLY);
  if (bundle.evidence_class === EVIDENCE_CLASS.ATTRIBUTED) signals.push(RESULT_SIGNAL.ATTRIBUTION_ONLY);
  if (bundle.evidence_class === EVIDENCE_CLASS.OFFLINE_ATTRIBUTED) signals.push(RESULT_SIGNAL.OFFLINE_ATTRIBUTION_ONLY);
  if (incrementality === INCREMENTALITY_STATUS.UNTESTABLE) signals.push(RESULT_SIGNAL.INCREMENTALITY_UNTESTABLE);
  if (outcome === OUTCOME.NOT_MEASURABLE || bundle.assessment_status === ASSESSMENT_STATUS.NOT_MEASURABLE) signals.push(RESULT_SIGNAL.MEASUREMENT_NOT_MEASURABLE);
  if (bundle.data_state === DATA_STATE.PENDING) signals.push(RESULT_SIGNAL.DATA_PENDING);
  if (stopRuleMet(bundle)) signals.push(RESULT_SIGNAL.STOP_RULE_MET);
  if (direction === DIRECTION.CHALLENGES && hypothesisRef) signals.push(RESULT_SIGNAL.RESULT_CHALLENGES_HYPOTHESIS);
  return sortedUnique(signals);
}

function resultBody({ push, run, bundle, asOfIso }) {
  if (toMs(bundle.assessed_at) > toMs(asOfIso)) fail(Z.EVIDENCE_IN_FUTURE, 'the evidence was assessed after the evaluation time');
  if (toMs(asOfIso) < toMs(run.created_at)) fail(Z.EVIDENCE_IN_FUTURE, 'a result cannot be evaluated before its Run exists');
  const plan = push.measurement_plan;

  const windowComplete = toMs(asOfIso) >= toMs(run.observation_window.end);
  const metEarly = stopRuleMet(bundle);
  const state = windowComplete || metEarly ? RESULT_STATE.FINAL : RESULT_STATE.PENDING;
  let finalization = null;
  if (windowComplete) finalization = FINALIZATION_REASON.OBSERVATION_WINDOW_COMPLETE;
  else if (metEarly) finalization = FINALIZATION_REASON.STOP_RULE_MET;

  const incrementality = deriveIncrementalityStatus(plan, bundle);
  const { outcome, direction } = outcomeOf({ state, run, plan, bundle, incrementality });
  const hypothesisRef = push.hypothesis_ref ?? null; // the result evaluates the hypothesis if there is one, else the expected Push outcome

  return {
    schema_version: MARKETING_STEER_VERSION,
    merchant_id: run.merchant_id,
    brand_id: run.brand_id,
    run_ref: run.run_id,
    finding_ref: run.finding_ref,
    push_ref: run.push_ref,
    hypothesis_ref: hypothesisRef,
    assessment_ref: bundle.assessment_ref,
    evaluated_at: asOfIso,
    result_state: state,
    finalization_reason: finalization,
    evidence_class: bundle.evidence_class,
    outcome,
    direction,
    incrementality_status: incrementality,
    observed_result_refs: [...bundle.observed_result_refs],
    attributed_result_refs: [...bundle.attributed_result_refs],
    offline_attribution_refs: bundle.offline_attribution_observations.map((o) => o.observation_id),
    incremental_result_ref: bundle.incremental_result_ref,
    success_criterion: bundle.success_criterion,
    failure_criterion: bundle.failure_criterion,
    stop_rule_assessments: bundle.stop_rule_assessments,
    evidence_refs: sortedUnique([
      ...bundle.evidence_refs, ...bundle.guardrail_assessment_refs, ...bundle.success_criterion.evidence_refs,
      ...bundle.failure_criterion.evidence_refs, ...bundle.stop_rule_assessments.flatMap((r) => r.evidence_refs),
      ...bundle.offline_attribution_observations.flatMap((o) => o.evidence_refs),
    ]),
    limitations: limitationsOf({ run, plan, bundle, outcome, incrementality }),
    review_signals: signalsOf({ run, bundle, outcome, direction, incrementality, hypothesisRef }),
  };
}

function originals(options) {
  const merchantId = tenantMerchantId(options.tenant);
  const push = verifiedPush(options.push, merchantId);
  const run = verifiedRun(options.run, push, merchantId);
  const bundle = normalizeRunEvidenceBundle(options.bundle, { tenant: options.tenant, push, run });
  return {
    merchantId, push, run, bundle,
  };
}

/**
 * @param {object} p { tenant, push, run, bundle, asOf } - the originals and the explicit clock. Scope, state, outcome, direction and
 *                   incrementality status are DERIVED; none can be supplied.
 */
export function buildMarketingRunResult(options = {}) {
  closedObject(options, OPTION_KEYS, 'result');
  const asOfIso = asOfValue(options.asOf);
  const { push, run, bundle } = originals(options);
  const body = resultBody({
    push, run, bundle, asOfIso,
  });
  return deepFreeze({ result_id: deriveId('mrr', body), ...body });
}

/** Re-validates a STORED result against the originals it claims to come from, by rebuilding it at its own evaluated_at. */
export function normalizeMarketingRunResult(input, options = {}) {
  closedObject(input, RESULT_KEYS, 'result');
  const rebuilt = buildMarketingRunResult({ ...options, asOf: input.evaluated_at });
  if (canonical(rebuilt) !== canonical(input)) fail(Z.RESULT_DERIVED_MISMATCH, 'the result does not match what its originals produce');
  return rebuilt;
}

/**
 * LIVE evaluation at `asOf`: recomputed from the ORIGINAL Run, Push and evidence bundle and the explicit clock. The stored
 * `outcome`, `direction`, `result_state` and `incrementality_status` are NEVER read as an authority - they are a snapshot.
 *   - a stored result must belong to this Run and Push and match its own id (a forged one is refused);
 *   - the live answer may DEGRADE at any time (new evidence, an expiry of the window...);
 *   - it may only IMPROVE with strictly newer evidence: a FINAL stored result cannot become more conclusive when the supplied
 *     bundle is not newer than the result (evidence loss or a replayed older bundle cannot silently improve it).
 * @returns the live MarketingRunResult at `asOf`
 */
export function evaluateMarketingRunResult(stored, options = {}) {
  closedObject(options, EVALUATE_KEYS, 'result evaluation');
  const asOfIso = asOfValue(options.asOf);
  const { merchantId, push, run, bundle } = originals(options);
  assertOwnId(stored, 'result_id', 'mrr', Z.RESULT_DERIVED_MISMATCH, 'the result does not match its own id');
  closedObject(stored, RESULT_KEYS, 'result');
  const sameScope = stored.merchant_id === merchantId && stored.brand_id === push.brand_id && stored.push_ref === push.push_id
    && stored.run_ref === run.run_id && stored.finding_ref === run.finding_ref;
  if (!sameScope) fail(Z.RESULT_SCOPE_MISMATCH, 'the result is not in the scope of the tenant, the Push and the Run');
  if (toMs(stored.evaluated_at) > toMs(asOfIso)) fail(Z.EVIDENCE_IN_FUTURE, 'the stored result was evaluated after the live clock');

  const body = resultBody({
    push, run, bundle, asOfIso,
  });
  if (stored.result_state === RESULT_STATE.FINAL
      && CONCLUSIVENESS[body.outcome] > CONCLUSIVENESS[stored.outcome]
      && toMs(bundle.assessed_at) <= toMs(stored.evaluated_at)) {
    fail(Z.RESULT_EVIDENCE_REGRESSION, 'a FINAL result cannot become more conclusive without strictly newer evidence');
  }
  return deepFreeze({ result_id: deriveId('mrr', body), ...body });
}
