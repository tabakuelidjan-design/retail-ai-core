// Marketing M3 -> Creative Intelligence: a tiny, PURE adapter from a real `CreativeHandoffPackage` to the C1 intake.
//
//   handoff { handoff_id, creative_brief, brand_interface, ... }  +  one deliverable_ref  +  the resolved FORMAT of its format_ref
//     ->  CreativeIntake
//
// It COPIES references and pins; it decides nothing:
//  - no business truth is copied (objective, audience, channels, statement...), and the prose of the Brief (message_intent, cta_intent,
//    brief_limitations) is never read;
//  - no product identity is invented: `subject_refs` are carried as they are, untyped;
//  - channel, placement, locale, format_ref and content_kind come from the deliverable, claims and requirements from the Brief;
//  - the canvas and zones come from the RESOLVED format (an injected resolver's answer), never from a guess.
// The handoff comes from a trusted Marketing adapter (M3 validates it against its originals); this adapter authenticates nothing and
// re-validates nothing of Marketing. Marketing M3 is not modified and not imported.

import { CI_ERROR as E, RESOURCE_KIND, RESOURCE_STATUS } from './constants.js';
import { normalizeCreativeIntake } from './intake.js';
import { directionForLocale } from './output-context.js';
import { normalizeResourceResolution } from './resource-resolver.js';
import {
  closedObject, fail, isPlainObject, iso, ref, refList, uuid,
} from './validation.js';

const FORMAT_METADATA_KEYS = [
  'canvas', 'aspect_ratio', 'physical_or_digital', 'viewing_distance_m', 'expected_dwell_time_s', 'safe_zones', 'forbidden_zones', 'production_constraints',
];
const union = (...lists) => [...new Set(lists.flat())].sort();

/**
 * @param {object} p
 * @param {object} p.handoff        a real CreativeHandoffPackage
 * @param {string} p.deliverable_ref a deliverable_id of the Brief inside the handoff
 * @param {object} p.resolved_format what the trusted resolver answered for that deliverable's format_ref (kind FORMAT, ACTIVE)
 * @param {string} p.created_at     explicit clock
 */
export function buildIntakeFromHandoff({
  handoff, deliverable_ref: deliverableRef, resolved_format: resolvedFormat, created_at: createdAt, evidence_refs: evidenceRefs = [],
} = {}) {
  if (!isPlainObject(handoff) || !isPlainObject(handoff.creative_brief) || !isPlainObject(handoff.brand_interface)) {
    fail(E.HANDOFF_INVALID, 'a CreativeHandoffPackage carries a creative_brief and a brand_interface', { field: 'handoff' });
  }
  const brief = handoff.creative_brief;
  if (handoff.brand_interface.brand?.brand_id !== brief.brand_id) fail(E.HANDOFF_INVALID, 'the brand interface belongs to another brand than the Brief', { field: 'handoff.brand_interface' });
  const at = iso(createdAt, 'created_at');
  if (typeof handoff.expires_at === 'string' && Date.parse(at) >= Date.parse(handoff.expires_at)) fail(E.HANDOFF_INVALID, 'the handoff has expired', { field: 'handoff.expires_at' });
  if (typeof handoff.created_at === 'string' && Date.parse(at) < Date.parse(handoff.created_at)) fail(E.HANDOFF_INVALID, 'the intake predates the handoff', { field: 'created_at' });
  const deliverable = Array.isArray(brief.deliverables) ? brief.deliverables.find((d) => d?.deliverable_id === ref(deliverableRef, 'deliverable_ref')) : null;
  if (!deliverable) fail(E.HANDOFF_INVALID, 'the Brief has no such deliverable', { field: 'deliverable_ref' });
  if (!brief.locales?.includes?.(deliverable.locale)) fail(E.HANDOFF_INVALID, 'the deliverable locale is not a Brief locale', { field: 'deliverable.locale' });

  // the format: its definition (canvas, zones) is a resource, resolved by an injected resolver - never derived from the reference text
  const merchantId = uuid(brief.merchant_id, 'brief.merchant_id');
  const format = normalizeResourceResolution(resolvedFormat, { ref: deliverable.format_ref, tenant: { merchantId } });
  if (format.status !== RESOURCE_STATUS.ACTIVE) fail(E.RESOURCE_NOT_ACTIVE, `the format is ${format.status}`, { field: 'resolved_format' });
  if (format.kind !== RESOURCE_KIND.FORMAT) fail(E.RESOURCE_KIND_MISMATCH, 'the resolver says this reference is not a format', { field: 'resolved_format' });
  closedObject(format.metadata ?? {}, FORMAT_METADATA_KEYS, 'resolved_format.metadata', E.RESOURCE_INVALID);
  const facts = format.metadata ?? {};

  return normalizeCreativeIntake({
    merchant_id: merchantId,
    brand_id: brief.brand_id,
    brief_ref: brief.brief_id,
    deliverable_ref: deliverable.deliverable_id,
    brand_context_ref: handoff.handoff_id, // the brand interface travels inside the handoff: its id is the stable pin
    subject_refs: refList(brief.subject_refs, 'brief.subject_refs'),
    source_asset_refs: union(refList(brief.source_asset_refs, 'brief.source_asset_refs'), refList(deliverable.source_asset_refs, 'deliverable.source_asset_refs')),
    claim_refs: refList(brief.claim_refs, 'brief.claim_refs'),
    mandatory_content_refs: union(refList(brief.mandatory_content_refs, 'brief.mandatory_content_refs'), refList(deliverable.mandatory_content_refs, 'deliverable.mandatory_content_refs')),
    prohibited_content_refs: refList(brief.prohibited_content_refs, 'brief.prohibited_content_refs'),
    requirement_refs: refList(deliverable.requirement_refs, 'deliverable.requirement_refs'),
    policy_requirement_refs: refList(brief.policy_requirement_refs, 'brief.policy_requirement_refs'),
    consent_requirement_refs: refList(brief.consent_requirement_refs, 'brief.consent_requirement_refs'),
    promotion_rule_refs: refList(brief.promotion_rule_refs, 'brief.promotion_rule_refs'),
    needed_by: deliverable.needed_by,
    output_context: {
      content_kind: deliverable.content_kind,
      channel: deliverable.channel,
      placement: deliverable.placement,
      format_ref: deliverable.format_ref,
      canvas: facts.canvas,
      aspect_ratio: facts.aspect_ratio,
      physical_or_digital: facts.physical_or_digital,
      viewing_distance_m: facts.viewing_distance_m ?? null,
      expected_dwell_time_s: facts.expected_dwell_time_s ?? null,
      safe_zones: facts.safe_zones ?? [],
      forbidden_zones: facts.forbidden_zones ?? [],
      locale: deliverable.locale,
      direction: directionForLocale(deliverable.locale), // the writing direction of the locale's language: a platform rule, not a choice
      production_constraints: facts.production_constraints ?? [],
    },
    evidence_refs: refList(evidenceRefs, 'evidence_refs'),
    created_at: at,
  });
}
