// MarketingLearning: what the company is really allowed to reuse as knowledge. "Do not learn the wrong lesson."
//
//   CONFIRMED / REFUTED  only from an INCREMENTAL result (a valid eligible HOLDOUT, EXECUTED, FINAL, COMPLETE data)
//   SUGGESTIVE           a useful signal, never promoted to a fact
//   NOT_MEASURABLE       a lesson about the LIMITS of the test: it neither confirms nor refutes the hypothesis
//   UNKNOWN              never a learning ("we do not know yet")
//
// A Learning is created only from a FINAL result that is re-evaluated LIVE from its originals (a stored outcome is never read as
// an authority). It never mutates M1 (Finding, CandidateHypothesis, MarketSignal); a future UNDERSTAND iteration may consume it
// through an adapter. Nothing is persisted here and no day count is hard-coded: `valid_until` comes with its `validity_basis_ref`.

import {
  EVIDENCE_CLASS, EXECUTION_STATUS, FORBIDDEN_PII_KEYS, FORBIDDEN_STEER_KEYS, LEARNING_CONCLUSION, M4_ERROR as Z, MARKETING_STEER_VERSION,
  OUTCOME, RESULT_SIGNAL, RESULT_STATE, REUSE_STATUS,
} from './m4-constants.js';
import { evaluateMarketingRunResult } from './run-result.js';
import {
  assertOwnId, canonical, rejectForbiddenExtras, safeRef,
} from './m4-validation.js';
import {
  asOfValue, closedObject, deepFreeze, deriveId, fail, isoTimestamp, toMs,
} from './understand-validation.js';

const OPTION_KEYS = ['tenant', 'push', 'run', 'bundle', 'result', 'asOf', 'valid_until', 'validity_basis_ref'];
const ORIGINALS = ['tenant', 'push', 'run', 'bundle', 'result'];
const LEARNING_KEYS = [
  'learning_id', 'schema_version', 'merchant_id', 'brand_id', 'finding_ref', 'hypothesis_ref', 'push_ref', 'run_ref', 'result_ref',
  'conclusion', 'direction', 'evidence_class', 'evidence_refs', 'limitations', 'learned_at', 'valid_until', 'validity_basis_ref', 'reuse_status',
];
const SNAPSHOT_FIELDS = ['result_state', 'outcome', 'direction', 'evidence_class', 'incrementality_status'];

/**
 * @param {object} p { tenant, push, run, bundle, result, asOf, valid_until, validity_basis_ref }
 *   `result` is the STORED result; it is re-evaluated live at `asOf` and must still say what it said (outcome, direction, class...).
 */
export function buildMarketingLearning(options = {}) {
  rejectForbiddenExtras(options, ORIGINALS, 'learning', FORBIDDEN_STEER_KEYS, FORBIDDEN_PII_KEYS);
  closedObject(options, OPTION_KEYS, 'learning');
  const learnedAt = asOfValue(options.asOf);
  const live = evaluateMarketingRunResult(options.result, {
    tenant: options.tenant, push: options.push, run: options.run, bundle: options.bundle, asOf: learnedAt,
  });
  if (live.result_state !== RESULT_STATE.FINAL) fail(Z.LEARNING_RESULT_NOT_FINAL, 'a Learning is created only from a FINAL result');
  if (!Object.values(LEARNING_CONCLUSION).includes(live.outcome)) fail(Z.LEARNING_OUTCOME_NOT_ALLOWED, `an ${live.outcome} result is not a learning`);
  if (SNAPSHOT_FIELDS.some((field) => options.result[field] !== live[field])) {
    fail(Z.LEARNING_RESULT_NOT_LIVE, 'the stored result no longer says what the live evaluation says');
  }
  const conclusive = live.outcome === OUTCOME.CONFIRMED || live.outcome === OUTCOME.REFUTED;
  if (conclusive && options.run.execution_status === EXECUTION_STATUS.PARTIAL) fail(Z.LEARNING_PARTIAL_EXECUTION, 'a PARTIAL execution cannot teach CONFIRMED or REFUTED');
  if (conclusive && live.evidence_class !== EVIDENCE_CLASS.INCREMENTAL) fail(Z.LEARNING_OUTCOME_NOT_ALLOWED, 'CONFIRMED and REFUTED need INCREMENTAL evidence');

  const validUntil = isoTimestamp(options.valid_until, 'learning.valid_until', Z.LEARNING_INVALID_VALIDITY);
  if (toMs(validUntil) <= toMs(learnedAt)) fail(Z.LEARNING_INVALID_VALIDITY, 'learning.valid_until must be after learned_at');

  const body = {
    schema_version: MARKETING_STEER_VERSION,
    merchant_id: live.merchant_id,
    brand_id: live.brand_id,
    finding_ref: live.finding_ref,
    hypothesis_ref: live.hypothesis_ref,
    push_ref: live.push_ref,
    run_ref: live.run_ref,
    result_ref: options.result.result_id,
    conclusion: live.outcome,
    direction: live.direction,
    evidence_class: live.evidence_class,
    evidence_refs: [...live.evidence_refs],
    limitations: [...live.limitations],
    learned_at: learnedAt,
    valid_until: validUntil,
    validity_basis_ref: safeRef(options.validity_basis_ref, 'learning.validity_basis_ref'),
    reuse_status: REUSE_STATUS.REUSABLE,
  };
  return deepFreeze({ learning_id: deriveId('mlg', body), ...body });
}

/** Re-validates a STORED Learning against its originals by rebuilding it at its own learned_at. */
export function normalizeMarketingLearning(input, options = {}) {
  closedObject(input, LEARNING_KEYS, 'learning');
  const rebuilt = buildMarketingLearning({
    ...options, asOf: input.learned_at, valid_until: input.valid_until, validity_basis_ref: input.validity_basis_ref,
  });
  if (canonical(rebuilt) !== canonical(input)) fail(Z.LEARNING_DERIVED_MISMATCH, 'the Learning does not match what its originals produce');
  return rebuilt;
}

/**
 * Derived reuse status at `asOf`: REUSABLE until valid_until, STALE from then on. A STALE learning stays auditable but must no
 * longer be injected as a current truth. The stored `reuse_status` is a snapshot and is ignored.
 */
export function evaluateLearningReuse(learning, { asOf } = {}) {
  assertOwnId(learning, 'learning_id', 'mlg', Z.LEARNING_DERIVED_MISMATCH, 'the Learning does not match its own id');
  const stale = toMs(asOfValue(asOf)) >= toMs(learning.valid_until);
  return deepFreeze({
    reuse_status: stale ? REUSE_STATUS.STALE : REUSE_STATUS.REUSABLE,
    review_signals: stale ? [RESULT_SIGNAL.LEARNING_STALE] : [],
  });
}
