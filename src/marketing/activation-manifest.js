// ActivationManifest: exactly what COULD be activated, handed to the Socle / policy / execution layer. It activates nothing.
//
// M3 owns no activation authority: `execution_decision` is always null, and there is no function to approve, override the
// Guardian, force or publish anyway. No connector, no publication, no scheduler: `activation_window` is a CONSTRAINT, not a job.
// Claims, policy, consent and promotion rules are carried as opaque refs; M3 validates none of them (no compliance engine).
//
// Every brief deliverable has exactly ONE delivery (none silently forgotten). The window is bounded by the Push execution window,
// the authorization, the Brief and every candidate: a sub-window is accepted, a wider one refused.
//
// READY_FOR_POLICY only means "the assets may enter the Socle / policy / execution controls" - never that publication is authorized.
// Like every M2/M3 object, a stored manifest is never a live authority: `readiness` is a snapshot at created_at, and the live
// answer is recomputed from the originals, the Brief, the candidates (and their manifests) and the explicit clock.

import { MKT_ERROR as E } from './understand-constants.js';
import {
  ACTIVATION_READINESS, BRIEF_READINESS, M3_ERROR as Z, MARKETING_CREATE_VERSION, VALIDATION_STATUS,
} from './m3-constants.js';
import { normalizeCreativeBrief } from './creative-brief.js';
import { validateCandidateEntry } from './creative-validation.js';
import { assertCreateReady, resolveCreateContext } from './create-gate.js';
import { canonical } from './m3-validation.js';
import { REVERSIBILITY_STATUS } from './m2-constants.js';
import {
  closedObject, deepFreeze, deriveId, fail, isPlainObject, isoTimestamp, toMs,
} from './understand-validation.js';

const OPTION_KEYS = [
  'tenant', 'finding', 'decisionPackage', 'push', 'authorization', 'brandContext', 'asOf', 'brief', 'candidates', 'activation_window', 'expires_at',
];
const EVALUATE_KEYS = ['tenant', 'finding', 'decisionPackage', 'push', 'authorization', 'brandContext', 'asOf', 'brief', 'candidates'];
const ENTRY_KEYS = ['candidate', 'candidateManifest', 'semanticAssessment', 'validation'];
const WINDOW_KEYS = ['start', 'end'];
const MANIFEST_KEYS = [
  'activation_manifest_id', 'schema_version', 'merchant_id', 'brand_id', 'finding_ref', 'push_ref', 'decision_ref', 'authorization_ref',
  'brief_ref', 'created_at', 'expires_at', 'activation_window', 'deliveries', 'measurement_plan_ref', 'claim_refs',
  'policy_requirement_refs', 'consent_requirement_refs', 'promotion_rule_refs', 'unresolved_requirement_refs', 'review_signals',
  'readiness', 'execution_decision',
];
const MAX_ENTRIES = 20;

// Precedence among the validations: BLOCKED > REVIEW_REQUIRED > NOT_MEASURABLE > READY_FOR_POLICY (STALE is a live property).
function readinessFrom(statuses) {
  const result = (status, code) => ({ status, reason_codes: [code] });
  if (statuses.includes(VALIDATION_STATUS.BLOCKED)) return result(ACTIVATION_READINESS.BLOCKED, 'VALIDATION_BLOCKED');
  if (statuses.includes(VALIDATION_STATUS.REVIEW_REQUIRED)) return result(ACTIVATION_READINESS.REVIEW_REQUIRED, 'VALIDATION_REVIEW_REQUIRED');
  if (statuses.includes(VALIDATION_STATUS.NOT_MEASURABLE)) return result(ACTIVATION_READINESS.NOT_MEASURABLE, 'VALIDATION_NOT_MEASURABLE');
  return result(ACTIVATION_READINESS.READY_FOR_POLICY, 'ALL_DELIVERABLES_VALIDATED');
}

// What the Socle still has to resolve for THIS Push (the Push-scoped counterpart of the M2 package derivation): visible, never resolved here.
function unresolvedRefs(push) {
  const r = push.resource_requirements;
  const refs = [
    ...push.claim_refs, ...push.policy_requirement_refs, ...push.consent_requirement_refs, ...push.promotion_rule_refs, ...push.unknown_refs,
    ...r.operational_capacity_refs, ...r.inventory_requirement_refs, ...r.creative_capacity_refs, ...r.contact_capacity_refs, ...r.other_resource_refs,
    ...(push.audience.segment_ref ? [push.audience.segment_ref] : []), ...push.audience.criteria_refs,
  ];
  return [...new Set(refs)];
}

function reviewSignals(push) {
  const r = push.resource_requirements;
  const has = {
    FINANCE_VERDICT_REQUIRED: Boolean(r.cash),
    INVENTORY_VERDICT_REQUIRED: r.inventory_requirement_refs.length > 0,
    CAPACITY_VERDICT_REQUIRED: r.operational_capacity_refs.length > 0 || r.creative_capacity_refs.length > 0 || r.contact_capacity_refs.length > 0 || Boolean(r.human_time),
    POLICY_CLEARANCE_REQUIRED: push.claim_refs.length > 0 || push.policy_requirement_refs.length > 0 || push.consent_requirement_refs.length > 0 || push.promotion_rule_refs.length > 0,
    REVERSIBILITY_UNKNOWN: push.reversibility.status === REVERSIBILITY_STATUS.UNKNOWN,
    HARD_TO_REVERSE_PRESENT: push.reversibility.status === REVERSIBILITY_STATUS.HARD_TO_REVERSE,
  };
  return Object.keys(has).filter((signal) => has[signal]);
}

// Deterministic, unique, stable union: Push signals, Brand Context signals and every Guardian report signal. Nothing is lost on the
// way and nothing here changes readiness; the signals stay visible for the Socle / policy / human review.
function allReviewSignals(push, brandContext, validations) {
  const fromBrand = Array.isArray(brandContext?.review_signals) ? brandContext.review_signals : [];
  const fromGuardian = validations.flatMap((v) => [...v.report.guardian_report.brand_review_signals, ...v.report.guardian_report.guardian_review_signals]);
  return [...new Set([...reviewSignals(push), ...fromBrand, ...fromGuardian])].sort();
}

function entriesOf(value) {
  if (!Array.isArray(value) || value.length === 0) fail(Z.ACTIVATION_DELIVERABLE_MISSING, 'an Activation Manifest needs one candidate per brief deliverable');
  if (value.length > MAX_ENTRIES) fail(E.INVALID_FIELD, `at most ${MAX_ENTRIES} candidates`, { field: 'candidates' });
  return value.map((entry, i) => {
    closedObject(entry, ENTRY_KEYS, `candidates[${i}]`);
    return entry;
  });
}

// One validation per candidate, all computed here by the Guardian; a supplied `validation` is only CROSS-CHECKED against it.
function validationsOf({ resolved, tenant, brief, entries }) {
  return entries.map((entry, i) => {
    const { candidate, report } = validateCandidateEntry({ resolved, tenant, brief, entry });
    if (entry.validation !== undefined && canonical(entry.validation) !== canonical(report)) {
      fail(Z.ACTIVATION_VALIDATION_MISMATCH, `candidates[${i}].validation does not match the Guardian validation of that candidate`);
    }
    return { candidate, report };
  });
}

function coverage(brief, validations) {
  const byDeliverable = new Map();
  for (const v of validations) {
    if (byDeliverable.has(v.candidate.deliverable_ref)) fail(Z.ACTIVATION_DUPLICATE_DELIVERABLE, 'a deliverable has more than one candidate');
    byDeliverable.set(v.candidate.deliverable_ref, v);
  }
  for (const d of brief.deliverables) {
    if (!byDeliverable.has(d.deliverable_id)) fail(Z.ACTIVATION_DELIVERABLE_MISSING, 'a brief deliverable has no candidate');
  }
  return byDeliverable;
}

function activationWindow(input, { push, authorization, brief, validations }) {
  closedObject(input, WINDOW_KEYS, 'activation_window');
  const start = isoTimestamp(input.start, 'activation_window.start', Z.ACTIVATION_WINDOW_INVALID);
  const end = isoTimestamp(input.end, 'activation_window.end', Z.ACTIVATION_WINDOW_INVALID);
  if (toMs(end) <= toMs(start)) fail(Z.ACTIVATION_WINDOW_INVALID, 'activation_window.end must be after start');
  if (toMs(start) < toMs(push.valid_execution_window.start)) fail(Z.ACTIVATION_WINDOW_WIDER, 'the activation window starts before the Push execution window', { bound: 'push_window_start' });
  const endBounds = [
    ['push_window_end', push.valid_execution_window.end], ['authorization_expiry', authorization.expires_at], ['brief_expiry', brief.expires_at],
    ...validations.map((v) => ['candidate_expiry', v.candidate.candidate_expires_at]),
  ];
  for (const [bound, at] of endBounds) {
    if (toMs(end) > toMs(at)) fail(Z.ACTIVATION_WINDOW_WIDER, 'the activation window is wider than what governs it', { bound });
  }
  return { start, end };
}

/**
 * Builds the manifest. Requires the originals and an explicit clock; the live create gate must be READY_FOR_CREATIVE.
 * @param {object} p { tenant, finding, decisionPackage, push, authorization, brandContext, asOf, brief,
 *                     candidates: [{ candidate, candidateManifest, semanticAssessment?, validation? }], activation_window, expires_at }
 */
export function buildActivationManifest(options = {}) {
  closedObject(options, OPTION_KEYS, 'activation');
  const {
    brief, candidates, activation_window: windowInput, expires_at: expiresInput, ...context
  } = options;
  const resolved = assertCreateReady(resolveCreateContext(context));
  const storedBrief = normalizeCreativeBrief(brief, context);
  if (toMs(storedBrief.expires_at) <= toMs(resolved.asOfIso)) fail(Z.BRIEF_STALE, 'the Brief has expired');

  const validations = validationsOf({ resolved, tenant: context.tenant, brief: storedBrief, entries: entriesOf(candidates) });
  const byDeliverable = coverage(storedBrief, validations);
  const { push, authorization } = resolved;

  const createdAt = resolved.asOfIso;
  const window = activationWindow(windowInput ?? {}, { push, authorization, brief: storedBrief, validations });
  const expiresAt = isoTimestamp(expiresInput, 'activation.expires_at', Z.ACTIVATION_INVALID_EXPIRY);
  if (toMs(expiresAt) <= toMs(createdAt)) fail(Z.ACTIVATION_INVALID_EXPIRY, 'activation.expires_at must be after created_at');
  const governing = [
    ['finding', resolved.finding.expires_at], ['push', push.expires_at], ['package', resolved.decisionPackage.expires_at],
    ['authorization', authorization.expires_at], ['brief', storedBrief.expires_at],
    ...validations.map((v) => ['candidate', v.candidate.candidate_expires_at]),
  ];
  for (const [bound, at] of governing) {
    if (toMs(expiresAt) > toMs(at)) fail(Z.ACTIVATION_OUTLIVES_GOVERNING, `an Activation Manifest cannot outlive its ${bound}`, { bound });
  }

  const deliveries = storedBrief.deliverables.map((d) => {
    const { candidate, report } = byDeliverable.get(d.deliverable_id);
    return {
      deliverable_ref: d.deliverable_id,
      candidate_ref: candidate.candidate_id,
      channel: d.channel,
      placement: d.placement,
      format_ref: d.format_ref,
      locale: d.locale,
      validation_ref: report.validation_id,
      validation_status: report.validation_status,
    };
  });

  const body = {
    schema_version: MARKETING_CREATE_VERSION,
    merchant_id: resolved.merchantId,
    brand_id: storedBrief.brand_id,
    finding_ref: storedBrief.finding_ref,
    push_ref: push.push_id,
    decision_ref: authorization.decision_ref,
    authorization_ref: authorization.authorization_ref,
    brief_ref: storedBrief.brief_id,
    created_at: createdAt,
    expires_at: expiresAt,
    activation_window: window,
    deliveries,
    measurement_plan_ref: `${push.push_id}#measurement`, // a pointer to the M2 plan inside the Push, never a copy
    claim_refs: [...push.claim_refs],
    policy_requirement_refs: [...push.policy_requirement_refs],
    consent_requirement_refs: [...push.consent_requirement_refs],
    promotion_rule_refs: [...push.promotion_rule_refs],
    unresolved_requirement_refs: unresolvedRefs(push),
    review_signals: allReviewSignals(push, context.brandContext, validations),
    readiness: readinessFrom(validations.map((v) => v.report.validation_status)),
    execution_decision: null,
  };
  return deepFreeze({ activation_manifest_id: deriveId('mam', body), ...body });
}

/**
 * Re-validates a STORED manifest against the originals, the Brief and the candidates it claims to come from, by rebuilding it
 * from its own non-derived fields at its own created_at and comparing. A forged id, delivery, validation status or readiness is
 * refused. It never authorizes a live conclusion (see evaluateActivationReadiness). A manifest built against a previous Brand
 * Memory version no longer re-validates and must be rebuilt.
 */
export function normalizeActivationManifest(input, options = {}) {
  closedObject(input, MANIFEST_KEYS, 'activation manifest');
  const entries = entriesOf(options.candidates);
  const known = new Set(entries.map((e) => e.candidate?.candidate_id));
  for (const delivery of input.deliveries ?? []) {
    if (!known.has(delivery?.candidate_ref)) fail(Z.ACTIVATION_UNKNOWN_CANDIDATE, 'a delivery names a candidate that was not supplied', { candidate_ref: delivery?.candidate_ref });
  }
  const rebuilt = buildActivationManifest({
    ...options, asOf: input.created_at, activation_window: input.activation_window, expires_at: input.expires_at,
  });
  if (canonical(rebuilt) !== canonical(input)) fail(Z.ACTIVATION_DERIVED_MISMATCH, 'the manifest does not match what its own fields, Brief and candidates produce');
  return rebuilt;
}

/**
 * LIVE activation readiness at `asOf`: STALE > BLOCKED > REVIEW_REQUIRED > NOT_MEASURABLE > READY_FOR_POLICY.
 * A stored `readiness` or `validation_status` is NEVER read as an authority. The answer is recomputed from the original Finding,
 * Package, Push, Authorization, Brand Context, the Brief, every candidate and its manifest (the Guardian is re-run) and the
 * explicit clock.
 *   STALE    the Finding, Push, Package, Authorization, Brief, a candidate or the manifest has expired
 *   BLOCKED  the live gate is not READY (not authorized, Push not ready, Brand Context GATED) or a Guardian validation is BLOCKED
 * READY_FOR_POLICY is NOT an execution approval.
 * @param {object} manifest the stored manifest
 * @param {object} options { tenant, finding, decisionPackage, push, authorization, brandContext, asOf, brief, candidates }
 */
export function evaluateActivationReadiness(manifest, options = {}) {
  closedObject(options, EVALUATE_KEYS, 'activation evaluation');
  if (!isPlainObject(manifest)) fail(E.INVALID_FIELD, 'manifest must be an Activation Manifest', { field: 'manifest' });
  const { brief, candidates, ...context } = options;
  const r = resolveCreateContext(context);

  // staleness is read in the safe direction only (an expiry can degrade the answer, never improve it)
  const expired = (value) => typeof value === 'string' && toMs(value) <= toMs(r.asOfIso);
  const stale = [];
  if (r.gate.status === BRIEF_READINESS.STALE) stale.push(...r.gate.reason_codes);
  if (expired(manifest.expires_at)) stale.push('MANIFEST_EXPIRED');
  if (isPlainObject(brief) && expired(brief.expires_at)) stale.push('BRIEF_EXPIRED');
  if (Array.isArray(candidates) && candidates.some((e) => expired(e?.candidate?.candidate_expires_at))) stale.push('CANDIDATE_EXPIRED');
  if (stale.length) return deepFreeze({ status: ACTIVATION_READINESS.STALE, reason_codes: [...new Set(stale)] });

  if (r.gate.status !== BRIEF_READINESS.READY_FOR_CREATIVE) {
    return deepFreeze({ status: ACTIVATION_READINESS.BLOCKED, reason_codes: [r.gate.status, ...r.gate.reason_codes] });
  }

  normalizeActivationManifest(manifest, { ...context, brief, candidates });
  const storedBrief = normalizeCreativeBrief(brief, context);
  const live = validationsOf({ resolved: r, tenant: context.tenant, brief: storedBrief, entries: entriesOf(candidates) });
  coverage(storedBrief, live);
  return deepFreeze(readinessFrom(live.map((v) => v.report.validation_status)));
}
