// MarketingFollowUpProposal: ONE option of continuation that Marketing prepares for the Socle. Marketing never decides that it wins.
//
// There is no winner, no ranking, no score and no auto-execution here: PROPOSE_SCALE does not scale anything, PROPOSE_STOP stops
// nothing, PROPOSE_ADJUST defines no change (it carries `change_refs`). READY_FOR_SOCLE means "may enter the Socle arbitration".
// Admissibility is derived from the LIVE result (re-evaluated from its originals), never from a stored outcome:
//   SCALE      CONFIRMED + INCREMENTAL + MEASURABLE + EXECUTED, and no PARTIAL_EXECUTION / STOP_RULE_MET / MEASUREMENT_NOT_MEASURABLE
//   CONTINUE   CONFIRMED, or SUGGESTIVE + SUPPORTS
//   STOP       REFUTED, or SUGGESTIVE + CHALLENGES, or any stop rule MET
//   ADJUST     SUGGESTIVE | REFUTED | NOT_MEASURABLE, with change_refs
//   TEST_AGAIN SUGGESTIVE | NOT_MEASURABLE   (UNKNOWN is not enough: the data may simply be pending)
//   DO_NOTHING always admissible, with reason codes and evidence ("not now", not "never")

import {
  DIRECTION, EVIDENCE_CLASS, EXECUTION_STATUS, FOLLOW_UP_READINESS, FOLLOW_UP_TYPE, FORBIDDEN_PII_KEYS, FORBIDDEN_STEER_KEYS,
  INCREMENTALITY_STATUS, M4_ERROR as Z, MARKETING_STEER_VERSION, OUTCOME, RESULT_SIGNAL, RESULT_STATE,
} from './m4-constants.js';
import { evaluateMarketingRunResult } from './run-result.js';
import {
  assertOwnId, canonical, rejectForbiddenExtras, safeRefList, sortedUnique,
} from './m4-validation.js';
import {
  asOfValue, closedObject, deepFreeze, deriveId, enumValue, fail, isoTimestamp, tokenList, toMs,
} from './understand-validation.js';

const OPTION_KEYS = [
  'tenant', 'push', 'run', 'bundle', 'result', 'asOf', 'proposal_type', 'reason_codes', 'evidence_refs', 'change_refs', 'expires_at',
];
const ORIGINALS = ['tenant', 'push', 'run', 'bundle', 'result'];
const FOLLOW_UP_KEYS = [
  'follow_up_id', 'schema_version', 'merchant_id', 'brand_id', 'run_ref', 'result_ref', 'proposal_type', 'reason_codes', 'evidence_refs',
  'change_refs', 'created_at', 'expires_at', 'readiness',
];
const EVALUATE_KEYS = ['tenant', 'push', 'run', 'bundle', 'result', 'asOf'];
const SCALE_BLOCKERS = [RESULT_SIGNAL.PARTIAL_EXECUTION, RESULT_SIGNAL.STOP_RULE_MET, RESULT_SIGNAL.MEASUREMENT_NOT_MEASURABLE];

/** Is `type` admissible for this LIVE result and Run? (pure; the single source of the admissibility rules) */
export function followUpAdmissible(type, live, run) {
  const { outcome, direction } = live;
  const stopMet = live.review_signals.includes(RESULT_SIGNAL.STOP_RULE_MET);
  switch (type) {
    case FOLLOW_UP_TYPE.PROPOSE_SCALE:
      return outcome === OUTCOME.CONFIRMED && live.evidence_class === EVIDENCE_CLASS.INCREMENTAL
        && live.incrementality_status === INCREMENTALITY_STATUS.MEASURABLE && run.execution_status === EXECUTION_STATUS.EXECUTED
        && live.result_state === RESULT_STATE.FINAL && !SCALE_BLOCKERS.some((s) => live.review_signals.includes(s));
    case FOLLOW_UP_TYPE.PROPOSE_CONTINUE:
      return outcome === OUTCOME.CONFIRMED || (outcome === OUTCOME.SUGGESTIVE && direction === DIRECTION.SUPPORTS);
    case FOLLOW_UP_TYPE.PROPOSE_STOP:
      return outcome === OUTCOME.REFUTED || (outcome === OUTCOME.SUGGESTIVE && direction === DIRECTION.CHALLENGES) || stopMet;
    case FOLLOW_UP_TYPE.PROPOSE_ADJUST:
      return [OUTCOME.SUGGESTIVE, OUTCOME.REFUTED, OUTCOME.NOT_MEASURABLE].includes(outcome);
    case FOLLOW_UP_TYPE.PROPOSE_TEST_AGAIN:
      return [OUTCOME.SUGGESTIVE, OUTCOME.NOT_MEASURABLE].includes(outcome);
    case FOLLOW_UP_TYPE.DO_NOTHING:
      return true;
    default:
      return false;
  }
}

const liveOf = (options, asOf) => evaluateMarketingRunResult(options.result, {
  tenant: options.tenant, push: options.push, run: options.run, bundle: options.bundle, asOf,
});

/**
 * @param {object} p { tenant, push, run, bundle, result, asOf, proposal_type, reason_codes?, evidence_refs?, change_refs?, expires_at }
 *   Scope, result_ref and readiness are DERIVED. `result` is the STORED result, re-evaluated live at `asOf`.
 */
export function buildMarketingFollowUpProposal(options = {}) {
  rejectForbiddenExtras(options, ORIGINALS, 'follow_up', FORBIDDEN_STEER_KEYS, FORBIDDEN_PII_KEYS);
  closedObject(options, OPTION_KEYS, 'follow_up');
  const createdAt = asOfValue(options.asOf);
  const type = enumValue(options.proposal_type, FOLLOW_UP_TYPE, 'follow_up.proposal_type', Z.FOLLOW_UP_INVALID_TYPE);
  const live = liveOf(options, createdAt);
  if (!followUpAdmissible(type, live, options.run)) fail(Z.FOLLOW_UP_NOT_ADMISSIBLE, `${type} is not admissible for a result that is ${live.outcome}/${live.direction}`);

  const suppliedReasons = tokenList(options.reason_codes, 'follow_up.reason_codes');
  const evidence = safeRefList(options.evidence_refs, 'follow_up.evidence_refs');
  const changes = safeRefList(options.change_refs, 'follow_up.change_refs');
  if (type === FOLLOW_UP_TYPE.DO_NOTHING) {
    if (!suppliedReasons.length) fail(Z.FOLLOW_UP_REASON_REQUIRED, 'DO_NOTHING needs reason codes');
    if (!evidence.length) fail(Z.FOLLOW_UP_EVIDENCE_REQUIRED, 'DO_NOTHING needs evidence');
    if (changes.length) fail(Z.FOLLOW_UP_NOT_ADMISSIBLE, 'DO_NOTHING changes nothing');
  }
  if (type === FOLLOW_UP_TYPE.PROPOSE_ADJUST && !changes.length) fail(Z.FOLLOW_UP_CHANGES_REQUIRED, 'PROPOSE_ADJUST needs change_refs: M4 defines no change itself');

  const derivedReasons = [`RESULT_${live.outcome}`];
  if (type === FOLLOW_UP_TYPE.DO_NOTHING && live.outcome === OUTCOME.UNKNOWN) derivedReasons.push('WAITING_FOR_DATA'); // never a new test while data is pending
  const expiresAt = isoTimestamp(options.expires_at, 'follow_up.expires_at', Z.FOLLOW_UP_INVALID_EXPIRY);
  if (toMs(expiresAt) <= toMs(createdAt)) fail(Z.FOLLOW_UP_INVALID_EXPIRY, 'follow_up.expires_at must be after created_at');

  const body = {
    schema_version: MARKETING_STEER_VERSION,
    merchant_id: live.merchant_id,
    brand_id: live.brand_id,
    run_ref: live.run_ref,
    result_ref: options.result.result_id,
    proposal_type: type,
    reason_codes: sortedUnique([...suppliedReasons, ...derivedReasons]),
    evidence_refs: evidence,
    change_refs: changes,
    created_at: createdAt,
    expires_at: expiresAt,
    readiness: evidence.length || type === FOLLOW_UP_TYPE.DO_NOTHING ? FOLLOW_UP_READINESS.READY_FOR_SOCLE : FOLLOW_UP_READINESS.NEEDS_EVIDENCE,
  };
  return deepFreeze({ follow_up_id: deriveId('mfu', body), ...body });
}

/** Re-validates a STORED follow-up against its originals by rebuilding it at its own created_at. */
export function normalizeMarketingFollowUpProposal(input, options = {}) {
  closedObject(input, FOLLOW_UP_KEYS, 'follow_up');
  const rebuilt = buildMarketingFollowUpProposal({
    ...options,
    asOf: input.created_at,
    proposal_type: input.proposal_type,
    reason_codes: input.reason_codes,
    evidence_refs: input.evidence_refs,
    change_refs: input.change_refs,
    expires_at: input.expires_at,
  });
  if (canonical(rebuilt) !== canonical(input)) fail(Z.FOLLOW_UP_DERIVED_MISMATCH, 'the follow-up does not match what its originals produce');
  return rebuilt;
}

/**
 * LIVE readiness of a follow-up at `asOf`: STALE > NOT_ELIGIBLE > NEEDS_EVIDENCE > READY_FOR_SOCLE. A stored `readiness` is a
 * snapshot and is ignored; admissibility is recomputed from the live result.
 *   STALE          the follow-up has expired
 *   NOT_ELIGIBLE   the live result no longer admits this type (e.g. the result degraded)
 *   NEEDS_EVIDENCE the type is admissible but carries no evidence
 */
export function evaluateFollowUpReadiness(followUp, options = {}) {
  closedObject(options, EVALUATE_KEYS, 'follow_up evaluation');
  assertOwnId(followUp, 'follow_up_id', 'mfu', Z.FOLLOW_UP_DERIVED_MISMATCH, 'the follow-up does not match its own id');
  const asOf = asOfValue(options.asOf);
  const live = liveOf(options, asOf);
  if (followUp.merchant_id !== live.merchant_id || followUp.brand_id !== live.brand_id || followUp.run_ref !== live.run_ref || followUp.result_ref !== options.result.result_id) {
    fail(Z.PACKAGE_SCOPE_MISMATCH, 'the follow-up is not about this tenant, brand, Run and result');
  }
  const result = (status, ...codes) => deepFreeze({ status, reason_codes: codes });
  if (toMs(followUp.expires_at) <= toMs(asOf)) return result(FOLLOW_UP_READINESS.STALE, 'FOLLOW_UP_EXPIRED');
  if (!followUpAdmissible(followUp.proposal_type, live, options.run)) return result(FOLLOW_UP_READINESS.NOT_ELIGIBLE, 'RESULT_NO_LONGER_ADMITS_THIS_FOLLOW_UP');
  if (followUp.proposal_type !== FOLLOW_UP_TYPE.DO_NOTHING && !followUp.evidence_refs.length) return result(FOLLOW_UP_READINESS.NEEDS_EVIDENCE, 'EVIDENCE_MISSING');
  return result(FOLLOW_UP_READINESS.READY_FOR_SOCLE, 'ADMISSIBLE_AND_EVIDENCED');
}
