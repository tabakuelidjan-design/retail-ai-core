// SocleDecisionPackage: the structured set of Marketing options handed to the Socle for ONE Finding.
//
// It recommends nothing. There is no winner, no best/recommended/selected option, no ranking and no score - proposals are
// stored in a canonical order (by push_id) that carries NO meaning. DO_NOTHING is always present, and TEST_SMALL is always
// explicitly considered (included, or declared not applicable with reasons and evidence). The package_status is a state of
// the package, not a decision: READY_FOR_SOCLE means "worth the Socle's arbitration", nothing more.
//
// Not resolved here (open dependencies): the Socle decision itself, Finance budget verdict, Inventory/capacity verdicts,
// policy / compliance / consent clearance, contact-pressure arbitration, Customers segment materialization.

import { MKT_ERROR as E } from './understand-constants.js';
import {
  M2_ERROR as X, M2_VERSION, MAX_PROPOSALS, PACKAGE_STATUS, PUSH_READINESS, ACTION_MODE, REVERSIBILITY_STATUS, TEST_SMALL_DISPOSITION,
} from './m2-constants.js';
import { gateFinding, evaluatePushReadiness, normalizeMarketingPushProposal } from './push-proposal.js';
import {
  asOfValue, closedObject, deepFreeze, deriveId, enumValue, fail, isPlainObject, isoTimestamp, opaqueRef, refList, tenantMerchantId,
  tokenList, toMs,
} from './understand-validation.js';

const BUILD_KEYS = ['proposals', 'do_nothing', 'test_small_disposition', 'expires_at'];
const DO_NOTHING_KEYS = ['reason_codes', 'evidence_refs'];
const INCLUDED_KEYS = ['status', 'proposal_ref'];
const NOT_APPLICABLE_KEYS = ['status', 'reason_codes', 'evidence_refs'];

// Why the Socle may not simply act on this package: what is still unresolved, derived deterministically from the proposals.
const REVIEW_SIGNAL_ORDER = [
  'FINANCE_VERDICT_REQUIRED', 'INVENTORY_VERDICT_REQUIRED', 'CAPACITY_VERDICT_REQUIRED', 'POLICY_CLEARANCE_REQUIRED',
  'REVERSIBILITY_UNKNOWN', 'HARD_TO_REVERSE_PRESENT',
];

function doNothing(input) {
  if (input == null) fail(X.PACKAGE_DO_NOTHING_REQUIRED, 'a Decision Package always carries do_nothing');
  closedObject(input, DO_NOTHING_KEYS, 'do_nothing');
  const reasonCodes = tokenList(input.reason_codes, 'do_nothing.reason_codes');
  if (!reasonCodes.length) fail(X.PACKAGE_DO_NOTHING_REQUIRED, 'do_nothing needs at least one reason code');
  return { reason_codes: reasonCodes, evidence_refs: refList(input.evidence_refs, 'do_nothing.evidence_refs') };
}

// TEST_SMALL is always explicitly considered: either a TEST_SMALL proposal of this package, or a justified "not applicable".
function testSmallDisposition(input, proposals) {
  if (input == null) fail(X.PACKAGE_TEST_SMALL_DISPOSITION_INVALID, 'TEST_SMALL must be explicitly considered: test_small_disposition is required');
  if (!isPlainObject(input)) fail(E.INVALID_FIELD, 'test_small_disposition must be an object', { field: 'test_small_disposition' });
  const status = enumValue(input.status, TEST_SMALL_DISPOSITION, 'test_small_disposition.status', X.PACKAGE_TEST_SMALL_DISPOSITION_INVALID);
  const testSmall = proposals.filter((p) => p.action_mode === ACTION_MODE.TEST_SMALL);

  if (status === TEST_SMALL_DISPOSITION.INCLUDED) {
    closedObject(input, INCLUDED_KEYS, 'test_small_disposition');
    const ref = opaqueRef(input.proposal_ref, 'test_small_disposition.proposal_ref', { code: X.PACKAGE_TEST_SMALL_DISPOSITION_INVALID });
    if (!testSmall.some((p) => p.push_id === ref)) {
      fail(X.PACKAGE_TEST_SMALL_DISPOSITION_INVALID, 'INCLUDED must point at a TEST_SMALL proposal of this package');
    }
    return { status, proposal_ref: ref };
  }

  closedObject(input, NOT_APPLICABLE_KEYS, 'test_small_disposition');
  const reasonCodes = tokenList(input.reason_codes, 'test_small_disposition.reason_codes');
  const evidenceRefs = refList(input.evidence_refs, 'test_small_disposition.evidence_refs');
  if (!reasonCodes.length || !evidenceRefs.length) {
    fail(X.PACKAGE_TEST_SMALL_DISPOSITION_INVALID, 'NOT_APPLICABLE needs reason codes and evidence');
  }
  if (testSmall.length) fail(X.PACKAGE_TEST_SMALL_DISPOSITION_INVALID, 'NOT_APPLICABLE contradicts a TEST_SMALL proposal in this package');
  return { status, reason_codes: reasonCodes, evidence_refs: evidenceRefs };
}

function scopeCheck(proposal, validatedFinding) {
  if (!isPlainObject(proposal)) fail(E.INVALID_FIELD, 'every proposal must be a Push object', { field: 'proposals' });
  const scope = [
    ['merchant', proposal.merchant_id, validatedFinding.merchant_id],
    ['brand', proposal.brand_id ?? null, validatedFinding.brand_id ?? null],
    ['finding', proposal.finding_ref, validatedFinding.finding_id],
  ];
  for (const [name, got, want] of scope) {
    if (got !== want) fail(X.PACKAGE_SCOPE_MISMATCH, `a proposal belongs to another ${name}`, { scope: name });
  }
}

function unresolvedRefs(proposals) {
  const refs = [];
  for (const p of proposals) {
    const r = p.resource_requirements;
    refs.push(
      ...p.claim_refs, ...p.policy_requirement_refs, ...p.consent_requirement_refs, ...p.promotion_rule_refs, ...p.unknown_refs,
      ...r.operational_capacity_refs, ...r.inventory_requirement_refs, ...r.creative_capacity_refs, ...r.contact_capacity_refs,
      ...r.other_resource_refs,
    );
    if (p.audience.segment_ref) refs.push(p.audience.segment_ref);
    refs.push(...p.audience.criteria_refs);
  }
  return [...new Set(refs)];
}

function reviewSignals(proposals) {
  const has = {
    FINANCE_VERDICT_REQUIRED: proposals.some((p) => p.resource_requirements.cash),
    INVENTORY_VERDICT_REQUIRED: proposals.some((p) => p.resource_requirements.inventory_requirement_refs.length),
    CAPACITY_VERDICT_REQUIRED: proposals.some((p) => {
      const r = p.resource_requirements;
      return r.operational_capacity_refs.length || r.creative_capacity_refs.length || r.contact_capacity_refs.length || r.human_time;
    }),
    POLICY_CLEARANCE_REQUIRED: proposals.some((p) => p.claim_refs.length || p.policy_requirement_refs.length
      || p.consent_requirement_refs.length || p.promotion_rule_refs.length),
    REVERSIBILITY_UNKNOWN: proposals.some((p) => p.reversibility.status === REVERSIBILITY_STATUS.UNKNOWN),
    HARD_TO_REVERSE_PRESENT: proposals.some((p) => p.reversibility.status === REVERSIBILITY_STATUS.HARD_TO_REVERSE),
  };
  return REVIEW_SIGNAL_ORDER.filter((signal) => has[signal]);
}

function statusAt(pkg, asOfIso) {
  if (toMs(pkg.expires_at) <= toMs(asOfIso)) return PACKAGE_STATUS.STALE;
  const readiness = pkg.proposals.map((p) => evaluatePushReadiness(p, asOfIso).status);
  if (readiness.includes(PUSH_READINESS.READY_FOR_SOCLE)) return PACKAGE_STATUS.READY_FOR_SOCLE;
  if (readiness.includes(PUSH_READINESS.NEEDS_EVIDENCE)) return PACKAGE_STATUS.NEEDS_EVIDENCE;
  // every proposal is NOT_ELIGIBLE, or there is none (then the explicit justification was required at build time)
  return PACKAGE_STATUS.NO_ELIGIBLE_MARKETING_ACTION;
}

/**
 * Live status of a stored package at `asOf`. STALE once the package (which never outlives its Finding or any proposal) has
 * expired; otherwise READY_FOR_SOCLE if at least one proposal is READY_FOR_SOCLE, else NEEDS_EVIDENCE if at least one needs
 * evidence, else NO_ELIGIBLE_MARKETING_ACTION. This is a state, never a decision.
 */
export function evaluatePackageStatus(pkg, asOf) {
  if (!isPlainObject(pkg) || !Array.isArray(pkg.proposals) || !pkg.do_nothing || !pkg.test_small_disposition) {
    fail(E.INVALID_FIELD, 'pkg must be a Decision Package', { field: 'pkg' });
  }
  return statusAt(pkg, asOfValue(asOf));
}

/**
 * @param {object} p
 * @param {object} p.tenant resolved tenant
 * @param {object|null} [p.brand] resolved Brand Identity
 * @param {object} p.finding the complete M1 Finding the package is about (must be READY_FOR_BUILD at asOf)
 * @param {string|Date} p.asOf explicit clock = created_at
 * Remaining keys (closed): proposals[<=10 built Pushes], do_nothing {reason_codes, evidence_refs}, test_small_disposition, expires_at.
 */
export function buildSocleDecisionPackage({ tenant, brand = null, finding, asOf, ...fields } = {}) {
  tenantMerchantId(tenant);
  const createdAt = asOfValue(asOf);
  const validated = gateFinding({ tenant, brand, finding, asOfIso: createdAt });
  closedObject(fields, BUILD_KEYS, 'package');

  const rawProposals = fields.proposals ?? [];
  if (!Array.isArray(rawProposals)) fail(E.INVALID_FIELD, 'package.proposals must be an array', { field: 'package.proposals' });
  if (rawProposals.length > MAX_PROPOSALS) fail(X.PACKAGE_TOO_MANY_PROPOSALS, `a package holds at most ${MAX_PROPOSALS} proposals`);
  rawProposals.forEach((p) => scopeCheck(p, validated));
  const ids = rawProposals.map((p) => p.push_id);
  if (new Set(ids).size !== ids.length) fail(X.PACKAGE_DUPLICATE_PUSH, 'a push_id appears twice in the package');

  // each proposal is re-validated and its derived fields recomputed; the canonical order (by push_id) is NOT a ranking
  const proposals = rawProposals
    .map((p) => normalizeMarketingPushProposal(p, { tenant, finding: validated, brand }))
    .sort((a, b) => (a.push_id < b.push_id ? -1 : 1));

  const nothing = doNothing(fields.do_nothing);
  if (!proposals.length && !nothing.evidence_refs.length) {
    fail(X.PACKAGE_EMPTY_NEEDS_JUSTIFICATION, 'a package without any proposal needs an explicit, evidenced do_nothing justification');
  }
  const disposition = testSmallDisposition(fields.test_small_disposition, proposals);

  const expiresAt = isoTimestamp(fields.expires_at, 'package.expires_at', X.PACKAGE_INVALID_EXPIRY);
  if (toMs(expiresAt) <= toMs(createdAt)) fail(X.PACKAGE_INVALID_EXPIRY, 'package.expires_at must be after created_at');
  if (toMs(expiresAt) > toMs(validated.expires_at)) fail(X.PACKAGE_OUTLIVES_FINDING, 'a package cannot outlive its Finding');
  if (proposals.some((p) => toMs(expiresAt) > toMs(p.expires_at))) fail(X.PACKAGE_OUTLIVES_PROPOSAL, 'a package cannot outlive any of its proposals');

  const body = {
    schema_version: M2_VERSION,
    merchant_id: validated.merchant_id,
    brand_id: validated.brand_id,
    finding_ref: validated.finding_id,
    created_at: createdAt,
    expires_at: expiresAt,
    proposals,
    do_nothing: nothing,
    test_small_disposition: disposition,
    unresolved_requirement_refs: unresolvedRefs(proposals),
    review_signals: reviewSignals(proposals),
  };
  body.package_status = statusAt(body, createdAt);
  return deepFreeze({ package_id: deriveId('mpk', body), ...body });
}
