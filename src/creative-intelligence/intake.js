// C0 - Creative intake and trust boundary. REFERENCES ONLY: the Marketing CreativeBrief, the Brand Context, the subjects, the assets,
// the claims and the requirements are NOT duplicated here (Marketing and Branding stay the owners). The intake pins which Brief
// deliverable is being answered and where the output will be seen.
//
// `subject_refs` are NOT typed: a subject may be a product, a collection, a category or something else, and only a trusted resolver can
// say which (resource-resolver.js). The intake therefore carries no `product_refs`: a product identity is never invented from a string.
// Prose from the Brief (message_intent, cta_intent, limitations) is never read.

import { CI_ERROR as E, CI_VERSION, FORBIDDEN_PROVIDER_KEYS } from './constants.js';
import { normalizeOutputContext } from './output-context.js';
import {
  closedObject, deepFreeze, deriveId, fail, iso, ref, refList, rejectKeysDeep, uuid,
} from './validation.js';

const KEYS = [
  'intake_id', 'schema_version', 'merchant_id', 'brand_id', 'brief_ref', 'deliverable_ref', 'brand_context_ref', 'subject_refs',
  'source_asset_refs', 'claim_refs', 'mandatory_content_refs', 'prohibited_content_refs', 'requirement_refs', 'policy_requirement_refs',
  'consent_requirement_refs', 'promotion_rule_refs', 'needed_by', 'output_context', 'evidence_refs', 'created_at',
];

/**
 * Normalizes the intake of one Creative run. The clock is explicit (`created_at`); there is no hidden time or randomness, and an
 * unknown key, a provider prompt / model, a URL used as a reference or a free-text claim is refused.
 */
export function normalizeCreativeIntake(input) {
  rejectKeysDeep(input, FORBIDDEN_PROVIDER_KEYS, E.FORBIDDEN_KEY, 'intake');
  closedObject(input, KEYS, 'intake');
  const body = {
    schema_version: CI_VERSION,
    merchant_id: uuid(input.merchant_id, 'intake.merchant_id'),
    brand_id: uuid(input.brand_id, 'intake.brand_id'),
    brief_ref: ref(input.brief_ref, 'intake.brief_ref'),
    deliverable_ref: ref(input.deliverable_ref, 'intake.deliverable_ref'),
    brand_context_ref: ref(input.brand_context_ref, 'intake.brand_context_ref'),
    subject_refs: refList(input.subject_refs, 'intake.subject_refs', { max: 50 }),
    source_asset_refs: refList(input.source_asset_refs, 'intake.source_asset_refs', { max: 50 }),
    claim_refs: refList(input.claim_refs, 'intake.claim_refs', { max: 50 }),
    mandatory_content_refs: refList(input.mandatory_content_refs, 'intake.mandatory_content_refs', { max: 50 }),
    prohibited_content_refs: refList(input.prohibited_content_refs, 'intake.prohibited_content_refs', { max: 50 }),
    requirement_refs: refList(input.requirement_refs, 'intake.requirement_refs', { max: 50 }),
    policy_requirement_refs: refList(input.policy_requirement_refs, 'intake.policy_requirement_refs', { max: 50 }),
    consent_requirement_refs: refList(input.consent_requirement_refs, 'intake.consent_requirement_refs', { max: 50 }),
    promotion_rule_refs: refList(input.promotion_rule_refs, 'intake.promotion_rule_refs', { max: 50 }),
    needed_by: iso(input.needed_by, 'intake.needed_by'),
    output_context: normalizeOutputContext(input.output_context),
    evidence_refs: refList(input.evidence_refs, 'intake.evidence_refs', { max: 50 }),
    created_at: iso(input.created_at, 'intake.created_at'),
  };
  if (!body.subject_refs.length && !body.claim_refs.length) {
    fail(E.INTAKE_INVALID, 'an intake needs at least one subject reference or one approved claim reference', { field: 'intake' });
  }
  if (body.mandatory_content_refs.some((r) => body.prohibited_content_refs.includes(r))) {
    fail(E.INTAKE_INVALID, 'a content reference cannot be both mandatory and prohibited', { field: 'intake' });
  }
  const id = deriveId('cin', body);
  if ((input.intake_id !== undefined && input.intake_id !== id) || (input.schema_version !== undefined && input.schema_version !== CI_VERSION)) {
    fail(E.ID_MISMATCH, 'intake.intake_id / schema_version do not follow from the content', { field: 'intake.intake_id' });
  }
  return deepFreeze({ intake_id: id, ...body });
}
