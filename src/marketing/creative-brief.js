// CreativeDeliverableSpec and CreativeBrief.
//
// A Brief answers WHAT / WHY / FOR WHOM / WHERE / WHEN / WHAT MUST OR MUST NOT BE COMMUNICATED / WHICH OUTPUTS ARE NEEDED.
// It never answers HOW to design it: no prompt, model, provider, style, composition, layout, camera, lens, lighting, font,
// color, seed or render parameter can be stored (refused anywhere in the input). Those decisions belong to Creative
// Intelligence and Branding. `message_intent` is an intention, not the final copy, and is never parsed by the engine.
//
// Everything that comes from the Push or the Authorization (merchant, brand, finding, push, decision, objective, subjects,
// audience, channels, claims, policy, consent, promotions) is COPIED from the validated originals as a traceable snapshot and
// can never be re-entered by the caller. Claims stay opaque refs: no free-text claim is stored.
//
// Like every M2/M3 object, a Brief that is stored is not a live authority: readiness is recomputed from the originals.

import { CONTENT_KIND } from '../branding/constants.js';
import { MKT_ERROR as E } from './understand-constants.js';
import {
  BRIEF_READINESS, DERIVED_BRIEF_KEYS, FORBIDDEN_BRIEF_KEYS, M3_ERROR as Z, MARKETING_CREATE_VERSION, MAX_DELIVERABLES,
} from './m3-constants.js';
import { assertCreateReady, resolveCreateContext } from './create-gate.js';
import { canonical, rejectKeysDeep, safeRef, safeRefList } from './m3-validation.js';
import {
  closedObject, deepFreeze, deriveId, enumValue, fail, isPlainObject, isoTimestamp, localeValue, optionalText, requiredText,
  tokenList, toMs, upperToken,
} from './understand-validation.js';

const BUILD_KEYS = [
  'message_intent', 'cta_intent', 'deliverables', 'source_asset_refs', 'mandatory_content_refs', 'prohibited_content_refs',
  'locales', 'brief_limitations', 'expires_at',
];
const BRIEF_KEYS = [
  'brief_id', 'schema_version', 'merchant_id', 'brand_id', 'finding_ref', 'push_ref', 'decision_ref', 'authorization_ref', 'objective',
  'subject_refs', 'audience', 'channels', 'message_intent', 'cta_intent', 'claim_refs', 'policy_requirement_refs',
  'consent_requirement_refs', 'promotion_rule_refs', 'source_asset_refs', 'mandatory_content_refs', 'prohibited_content_refs',
  'locales', 'deliverables', 'brief_limitations', 'created_at', 'expires_at',
];
const DELIVERABLE_KEYS = [
  'deliverable_id', 'content_kind', 'channel', 'placement', 'format_ref', 'locale', 'needed_by', 'source_asset_refs',
  'mandatory_content_refs', 'requirement_refs',
];
const MAX_LOCALES = 30;
// A CTA intent is an intention, not a button: no raw link and no tracking parameter. (Safety check on the shape of the text; the
// engine never takes a business decision from it.)
const UNSAFE_CTA = /https?:\/\/|www\.|[?&](utm_|gclid|fbclid)|\butm_/i;

function deliverable(input, field, c) {
  closedObject(input, DELIVERABLE_KEYS, field);
  const contentKind = enumValue(input.content_kind, CONTENT_KIND, `${field}.content_kind`, Z.DELIVERABLE_INVALID_KIND);

  const channel = upperToken(input.channel, `${field}.channel`);
  if (!c.push.channels.includes(channel)) fail(Z.DELIVERABLE_CHANNEL_NOT_IN_PUSH, `${field}.channel is not one of the Push channels`, { field });
  const placement = upperToken(input.placement, `${field}.placement`, { code: Z.DELIVERABLE_INVALID_PLACEMENT });
  if (input.format_ref == null || (typeof input.format_ref === 'string' && !input.format_ref.trim())) {
    fail(Z.DELIVERABLE_FORMAT_REQUIRED, `${field}.format_ref is required`, { field });
  }
  const locale = localeValue(input.locale, `${field}.locale`);
  if (!c.locales.includes(locale)) fail(Z.DELIVERABLE_LOCALE_UNSUPPORTED, `${field}.locale is not one of the Brief locales`, { field });

  const neededBy = isoTimestamp(input.needed_by, `${field}.needed_by`, Z.DELIVERABLE_NEEDED_BY_INVALID);
  const limits = [
    ['brief_created_at', c.createdAt, (a, b) => toMs(a) > toMs(b)],
    ['push_execution_window_end', c.push.valid_execution_window.end, (a, b) => toMs(a) <= toMs(b)],
    ['authorization_expiry', c.authorization.expires_at, (a, b) => toMs(a) <= toMs(b)],
  ];
  for (const [limit, bound, ok] of limits) {
    if (!ok(neededBy, bound)) fail(Z.DELIVERABLE_NEEDED_BY_INVALID, `${field}.needed_by violates ${limit}`, { field, limit });
  }

  const body = {
    content_kind: contentKind,
    channel,
    placement,
    format_ref: safeRef(input.format_ref, `${field}.format_ref`),
    locale,
    needed_by: neededBy,
    source_asset_refs: safeRefList(input.source_asset_refs, `${field}.source_asset_refs`),
    mandatory_content_refs: safeRefList(input.mandatory_content_refs, `${field}.mandatory_content_refs`),
    requirement_refs: safeRefList(input.requirement_refs, `${field}.requirement_refs`),
  };
  const id = deriveId('mdl', body);
  if (input.deliverable_id !== undefined && input.deliverable_id !== id) fail(Z.DELIVERABLE_ID_MISMATCH, `${field}.deliverable_id does not follow from its content`, { field });
  return { deliverable_id: id, ...body };
}

function briefFrom(r, fields) {
  rejectKeysDeep(fields, FORBIDDEN_BRIEF_KEYS, Z.FORBIDDEN_CREATIVE_FIELD, 'brief');
  for (const key of Object.keys(fields)) {
    if (DERIVED_BRIEF_KEYS.includes(key)) fail(Z.BRIEF_DERIVED_FIELD_SUPPLIED, `brief.${key} is copied from the Push / Authorization and cannot be supplied`, { key });
  }
  closedObject(fields, BUILD_KEYS, 'brief');

  const createdAt = r.asOfIso;
  const { push, authorization } = r;
  const supported = r.brand.rebuilt.brand.supported_locales;

  if (!Array.isArray(fields.locales) || fields.locales.length === 0) fail(Z.BRIEF_LOCALE_REQUIRED, 'a Brief needs at least one locale');
  if (fields.locales.length > MAX_LOCALES) fail(E.INVALID_FIELD, 'brief.locales is too long', { field: 'brief.locales' });
  const locales = fields.locales.map((l, i) => localeValue(l, `brief.locales[${i}]`));
  if (new Set(locales).size !== locales.length) fail(Z.BRIEF_DUPLICATE_LOCALE, 'brief.locales contains the same locale twice');
  if (locales.some((l) => !supported.includes(l))) fail(Z.BRIEF_LOCALE_UNSUPPORTED, 'a Brief locale is not supported by the Brand');

  const cta = optionalText(fields.cta_intent, 'brief.cta_intent', { max: 200 });
  if (cta && UNSAFE_CTA.test(cta)) fail(Z.BRIEF_CTA_UNSAFE, 'brief.cta_intent states an intention: no raw link and no tracking code');

  if (!Array.isArray(fields.deliverables) || fields.deliverables.length === 0) fail(Z.BRIEF_DELIVERABLE_REQUIRED, 'a Brief needs at least one deliverable');
  if (fields.deliverables.length > MAX_DELIVERABLES) fail(E.INVALID_FIELD, `a Brief holds at most ${MAX_DELIVERABLES} deliverables`, { field: 'brief.deliverables' });
  const deliverables = fields.deliverables
    .map((d, i) => deliverable(d, `brief.deliverables[${i}]`, { push, authorization, locales, createdAt }))
    .sort((a, b) => (a.deliverable_id < b.deliverable_id ? -1 : 1));
  if (new Set(deliverables.map((d) => d.deliverable_id)).size !== deliverables.length) fail(Z.DELIVERABLE_DUPLICATE, 'the same deliverable appears twice');

  const expiresAt = isoTimestamp(fields.expires_at, 'brief.expires_at', Z.BRIEF_INVALID_EXPIRY);
  if (toMs(expiresAt) <= toMs(createdAt)) fail(Z.BRIEF_INVALID_EXPIRY, 'brief.expires_at must be after created_at');
  for (const [bound, at] of [['finding', r.finding.expires_at], ['push', push.expires_at], ['package', r.decisionPackage.expires_at], ['authorization', authorization.expires_at]]) {
    if (toMs(expiresAt) > toMs(at)) fail(Z.BRIEF_OUTLIVES_GOVERNING, `a Brief cannot outlive its ${bound}`, { bound });
  }

  const body = {
    schema_version: MARKETING_CREATE_VERSION,
    merchant_id: r.merchantId,
    brand_id: push.brand_id,
    finding_ref: push.finding_ref,
    push_ref: push.push_id,
    decision_ref: authorization.decision_ref,
    authorization_ref: authorization.authorization_ref,
    objective: push.objective,
    subject_refs: [...push.subject_refs],
    audience: structuredClone(push.audience),
    channels: [...push.channels],
    message_intent: requiredText(fields.message_intent, 'brief.message_intent'), // an intention, never the final copy; never parsed
    cta_intent: cta,
    claim_refs: [...push.claim_refs],
    policy_requirement_refs: [...push.policy_requirement_refs],
    consent_requirement_refs: [...push.consent_requirement_refs],
    promotion_rule_refs: [...push.promotion_rule_refs],
    source_asset_refs: safeRefList(fields.source_asset_refs, 'brief.source_asset_refs'),
    mandatory_content_refs: safeRefList(fields.mandatory_content_refs, 'brief.mandatory_content_refs'),
    prohibited_content_refs: safeRefList(fields.prohibited_content_refs, 'brief.prohibited_content_refs'),
    locales,
    deliverables,
    brief_limitations: tokenList(fields.brief_limitations, 'brief.brief_limitations', { max: 30 }),
    created_at: createdAt,
    expires_at: expiresAt,
  };
  return deepFreeze({ brief_id: deriveId('mcb', body), ...body });
}

/**
 * Builds a Brief. It requires the ORIGINALS and an explicit clock, and refuses anything but a live READY_FOR_CREATIVE gate:
 * { tenant, finding, decisionPackage, push, authorization, brandContext, asOf } + the closed Brief fields (BUILD_KEYS).
 */
export function buildCreativeBrief({
  tenant, finding, decisionPackage, push, authorization = null, brandContext = null, asOf, ...fields
} = {}) {
  const resolved = assertCreateReady(resolveCreateContext({ tenant, finding, decisionPackage, push, authorization, brandContext, asOf }));
  return briefFrom(resolved, fields);
}

/**
 * Re-validates a STORED Brief against the originals it claims to come from, by rebuilding it from its own non-derived fields at
 * its own created_at and comparing. A forged brief_id, snapshot field or deliverable is refused. This validates form and
 * derivable values only; it never authorizes a live conclusion (see evaluateBriefReadiness).
 */
export function normalizeCreativeBrief(input, context = {}) {
  closedObject(input, BRIEF_KEYS, 'brief');
  const supplied = Object.fromEntries(BUILD_KEYS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
  const rebuilt = buildCreativeBrief({ ...context, asOf: input.created_at, ...supplied });
  if (canonical(rebuilt) !== canonical(input)) fail(Z.BRIEF_DERIVED_MISMATCH, 'the Brief does not match what its own fields and originals produce');
  return rebuilt;
}

/**
 * LIVE readiness of a Brief at `asOf`. A stored status is never an authority: the answer is recomputed from the original
 * Finding, Package, Push, Authorization, Brand Context and the explicit asOf.
 * Precedence: STALE > NOT_AUTHORIZED > PUSH_NOT_READY > BRAND_GATED > READY_FOR_CREATIVE.
 * A Brief is only reported READY_FOR_CREATIVE after it has been re-validated against those originals; while the gate is not
 * READY the Brief is not inspected (it could only degrade the answer, never improve it).
 */
export function evaluateBriefReadiness(brief, context = {}) {
  const r = resolveCreateContext(context);
  if (!isPlainObject(brief)) fail(E.INVALID_FIELD, 'brief must be a Brief', { field: 'brief' });
  const briefExpired = typeof brief.expires_at === 'string' && toMs(brief.expires_at) <= toMs(r.asOfIso);
  if (r.gate.status === BRIEF_READINESS.STALE || briefExpired) {
    return deepFreeze({ status: BRIEF_READINESS.STALE, reason_codes: [...(r.gate.status === BRIEF_READINESS.STALE ? r.gate.reason_codes : []), ...(briefExpired ? ['BRIEF_EXPIRED'] : [])] });
  }
  if (r.gate.status !== BRIEF_READINESS.READY_FOR_CREATIVE) return deepFreeze({ status: r.gate.status, reason_codes: [...r.gate.reason_codes] });
  normalizeCreativeBrief(brief, context);
  return deepFreeze({ status: BRIEF_READINESS.READY_FOR_CREATIVE, reason_codes: ['BRIEF_VALID_AND_AUTHORIZED'] });
}
