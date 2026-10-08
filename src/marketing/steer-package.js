// MarketingSteerPackage: the follow-up options Marketing submits to the Socle, in one object. The Socle arbitrates.
//
// DO_NOTHING is ALWAYS present, with reason codes and evidence. There is NO winner, NO selected / recommended follow-up, NO ranking
// and NO score: the package lists options side by side (at most 10) and states, deterministically, whether anything is READY_FOR_SOCLE.
// NO_ELIGIBLE_FOLLOW_UP is a visible state, not a final decision. A stored package is a snapshot; its live status is recomputed
// from the originals (Run, Push, evidence, result, every follow-up) and the explicit clock.

import {
  FOLLOW_UP_READINESS, FORBIDDEN_PII_KEYS, FORBIDDEN_STEER_KEYS, FOLLOW_UP_TYPE, M4_ERROR as Z, MARKETING_STEER_VERSION, MAX_FOLLOW_UPS,
  STEER_PACKAGE_STATUS,
} from './m4-constants.js';
import { evaluateMarketingRunResult } from './run-result.js';
import { evaluateFollowUpReadiness } from './follow-up-proposal.js';
import {
  assertOwnId, canonical, rejectForbiddenExtras, safeRefList, sortedUnique,
} from './m4-validation.js';
import {
  asOfValue, closedObject, deepFreeze, deriveId, fail, isPlainObject, isoTimestamp, tokenList, toMs,
} from './understand-validation.js';

const OPTION_KEYS = ['tenant', 'push', 'run', 'bundle', 'result', 'follow_ups', 'do_nothing', 'asOf', 'expires_at'];
// objects owned by other domains / earlier steps (follow_ups are scanned by their own builder) are never scanned here
const ORIGINALS = ['tenant', 'push', 'run', 'bundle', 'result', 'follow_ups'];
const PACKAGE_KEYS = [
  'steer_package_id', 'schema_version', 'merchant_id', 'brand_id', 'run_ref', 'result_ref', 'created_at', 'expires_at', 'proposals',
  'proposal_readiness', 'do_nothing', 'package_status', 'unresolved_requirement_refs', 'review_signals',
];
const EVALUATE_KEYS = ['tenant', 'push', 'run', 'bundle', 'result', 'asOf'];
const DO_NOTHING_KEYS = ['reason_codes', 'evidence_refs'];
const SNAPSHOT_FIELDS = ['result_state', 'outcome', 'direction', 'evidence_class', 'incrementality_status'];

function doNothing(input) {
  if (!isPlainObject(input)) fail(Z.PACKAGE_DO_NOTHING_REQUIRED, 'a Steer Package always carries do_nothing');
  closedObject(input, DO_NOTHING_KEYS, 'do_nothing');
  const reasons = tokenList(input.reason_codes, 'do_nothing.reason_codes');
  if (!reasons.length) fail(Z.PACKAGE_DO_NOTHING_REQUIRED, 'do_nothing needs reason codes');
  const evidence = safeRefList(input.evidence_refs, 'do_nothing.evidence_refs');
  if (!evidence.length) fail(Z.PACKAGE_DO_NOTHING_EVIDENCE_REQUIRED, 'do_nothing needs evidence');
  return { reason_codes: reasons, evidence_refs: evidence };
}

function statusOf(readiness, { expired, resultLive }) {
  if (expired || !resultLive) return STEER_PACKAGE_STATUS.STALE;
  const statuses = readiness.map((r) => r.status);
  if (statuses.includes(FOLLOW_UP_READINESS.READY_FOR_SOCLE)) return STEER_PACKAGE_STATUS.READY_FOR_SOCLE;
  if (statuses.includes(FOLLOW_UP_READINESS.NEEDS_EVIDENCE)) return STEER_PACKAGE_STATUS.NEEDS_EVIDENCE;
  return STEER_PACKAGE_STATUS.NO_ELIGIBLE_FOLLOW_UP;
}

// Re-validates every follow-up (own id, scope) and computes its LIVE readiness at asOf.
function followUpsOf(value, context) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(Z.PACKAGE_SCOPE_MISMATCH, 'follow_ups must be an array');
  if (value.length > MAX_FOLLOW_UPS) fail(Z.PACKAGE_TOO_MANY_FOLLOW_UPS, `a Steer Package holds at most ${MAX_FOLLOW_UPS} follow-ups`);
  const ids = new Set();
  return value.map((followUp) => {
    const readiness = evaluateFollowUpReadiness(followUp, context); // own id + scope + live admissibility
    if (ids.has(followUp.follow_up_id)) fail(Z.PACKAGE_DUPLICATE_FOLLOW_UP, 'a follow-up is listed twice');
    ids.add(followUp.follow_up_id);
    return { followUp, readiness: { follow_up_id: followUp.follow_up_id, status: readiness.status, reason_codes: [...readiness.reason_codes] } };
  });
}

const isResultLive = (stored, live) => SNAPSHOT_FIELDS.every((field) => stored[field] === live[field]);

/**
 * @param {object} p { tenant, push, run, bundle, result, follow_ups, do_nothing, asOf, expires_at }
 *   `result` and `follow_ups` are STORED objects; they are re-evaluated live at `asOf`. Scope, status, unresolved refs and review
 *   signals are DERIVED. No winner / ranking / score can be supplied.
 */
export function buildMarketingSteerPackage(options = {}) {
  rejectForbiddenExtras(options, ORIGINALS, 'steer_package', FORBIDDEN_STEER_KEYS, FORBIDDEN_PII_KEYS);
  closedObject(options, OPTION_KEYS, 'steer_package');
  const createdAt = asOfValue(options.asOf);
  const context = {
    tenant: options.tenant, push: options.push, run: options.run, bundle: options.bundle, result: options.result, asOf: createdAt,
  };
  const live = evaluateMarketingRunResult(options.result, {
    tenant: options.tenant, push: options.push, run: options.run, bundle: options.bundle, asOf: createdAt,
  });
  const entries = followUpsOf(options.follow_ups, context);
  const nothing = doNothing(options.do_nothing);

  const expiresAt = isoTimestamp(options.expires_at, 'steer_package.expires_at', Z.PACKAGE_INVALID_EXPIRY);
  if (toMs(expiresAt) <= toMs(createdAt)) fail(Z.PACKAGE_INVALID_EXPIRY, 'steer_package.expires_at must be after created_at');
  for (const { followUp } of entries) {
    if (toMs(expiresAt) > toMs(followUp.expires_at)) fail(Z.PACKAGE_INVALID_EXPIRY, 'a Steer Package cannot outlive one of its follow-ups');
  }

  const readiness = entries.map((e) => e.readiness);
  const resultLive = isResultLive(options.result, live);
  const { push, run } = options;
  const body = {
    schema_version: MARKETING_STEER_VERSION,
    merchant_id: live.merchant_id,
    brand_id: live.brand_id,
    run_ref: live.run_ref,
    result_ref: options.result.result_id,
    created_at: createdAt,
    expires_at: expiresAt,
    proposals: entries.map((e) => e.followUp),
    proposal_readiness: readiness,
    do_nothing: nothing,
    package_status: statusOf(readiness, { expired: false, resultLive }),
    unresolved_requirement_refs: sortedUnique([
      ...push.claim_refs, ...push.policy_requirement_refs, ...push.consent_requirement_refs, ...push.promotion_rule_refs,
      ...entries.flatMap((e) => (e.followUp.proposal_type === FOLLOW_UP_TYPE.DO_NOTHING ? [] : e.followUp.change_refs)),
    ]),
    review_signals: sortedUnique([...run.review_signals, ...live.review_signals]),
  };
  return deepFreeze({ steer_package_id: deriveId('msp', body), ...body });
}

/** Re-validates a STORED package against its originals by rebuilding it from its own proposals at its own created_at. */
export function normalizeMarketingSteerPackage(input, options = {}) {
  closedObject(input, PACKAGE_KEYS, 'steer_package');
  const rebuilt = buildMarketingSteerPackage({
    ...options, follow_ups: input.proposals, do_nothing: input.do_nothing, asOf: input.created_at, expires_at: input.expires_at,
  });
  if (canonical(rebuilt) !== canonical(input)) fail(Z.PACKAGE_DERIVED_MISMATCH, 'the Steer Package does not match what its originals produce');
  return rebuilt;
}

/**
 * LIVE status of a package at `asOf`: STALE > READY_FOR_SOCLE > NEEDS_EVIDENCE > NO_ELIGIBLE_FOLLOW_UP. A stored `package_status` and
 * the stored readiness of its proposals are snapshots and are ignored. STALE: the package has expired, or the stored result no
 * longer says what the live evaluation says.
 */
export function evaluateSteerPackageStatus(pkg, options = {}) {
  closedObject(options, EVALUATE_KEYS, 'steer_package evaluation');
  assertOwnId(pkg, 'steer_package_id', 'msp', Z.PACKAGE_DERIVED_MISMATCH, 'the Steer Package does not match its own id');
  const asOf = asOfValue(options.asOf);
  const live = evaluateMarketingRunResult(options.result, {
    tenant: options.tenant, push: options.push, run: options.run, bundle: options.bundle, asOf,
  });
  if (pkg.merchant_id !== live.merchant_id || pkg.brand_id !== live.brand_id || pkg.run_ref !== live.run_ref || pkg.result_ref !== options.result.result_id) {
    fail(Z.PACKAGE_SCOPE_MISMATCH, 'the Steer Package is not about this tenant, brand, Run and result');
  }
  const expired = toMs(pkg.expires_at) <= toMs(asOf);
  const resultLive = isResultLive(options.result, live);
  const entries = followUpsOf(pkg.proposals, { ...options, asOf });
  const status = statusOf(entries.map((e) => e.readiness), { expired, resultLive });
  const reasons = [];
  if (expired) reasons.push('PACKAGE_EXPIRED');
  if (!resultLive) reasons.push('RESULT_NO_LONGER_LIVE');
  return deepFreeze({ status, reason_codes: reasons.length ? reasons : [status] });
}
