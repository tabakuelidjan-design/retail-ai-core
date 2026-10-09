// C0 - Creative intake and trust boundary. References ONLY: the Marketing CreativeBrief, the Brand Context, the product / asset
// references and the approved claim references are NOT duplicated here (Marketing and Branding stay the owners). The intake pins
// which Brief deliverable is being answered, which claims may be used in the copy, and where the output will be seen.

import { CI_ERROR as E, CI_VERSION } from './constants.js';
import { normalizeOutputContext } from './output-context.js';
import {
  closedObject, deepFreeze, deriveId, fail, iso, ref, refList, rejectKeysDeep, uuid,
} from './validation.js';
import { FORBIDDEN_PROVIDER_KEYS } from './constants.js';

const KEYS = [
  'intake_id', 'schema_version', 'merchant_id', 'brand_id', 'brief_ref', 'deliverable_ref', 'brand_context_ref', 'product_refs', 'asset_refs', 'claim_refs',
  'output_context', 'evidence_refs', 'created_at',
];

/**
 * Normalizes the intake of one Creative run. The clock is explicit (`created_at`); there is no hidden time or randomness, and an
 * unknown key, a provider prompt / model, a URL used as a reference or a free-text claim is refused.
 */
export function normalizeCreativeIntake(input) {
  rejectKeysDeep(input, FORBIDDEN_PROVIDER_KEYS, E.FORBIDDEN_KEY, 'intake');
  closedObject(input, KEYS, 'intake');
  const productRefs = refList(input.product_refs, 'intake.product_refs', { max: 20 });
  const assetRefs = refList(input.asset_refs, 'intake.asset_refs', { min: 1, max: 50 });
  const body = {
    schema_version: CI_VERSION,
    merchant_id: uuid(input.merchant_id, 'intake.merchant_id'),
    brand_id: uuid(input.brand_id, 'intake.brand_id'),
    brief_ref: ref(input.brief_ref, 'intake.brief_ref'),
    deliverable_ref: ref(input.deliverable_ref, 'intake.deliverable_ref'),
    brand_context_ref: ref(input.brand_context_ref, 'intake.brand_context_ref'),
    product_refs: productRefs,
    asset_refs: assetRefs,
    claim_refs: refList(input.claim_refs, 'intake.claim_refs', { max: 50 }),
    output_context: normalizeOutputContext(input.output_context),
    evidence_refs: refList(input.evidence_refs, 'intake.evidence_refs', { max: 50 }),
    created_at: iso(input.created_at, 'intake.created_at'),
  };
  if (!body.product_refs.length && !body.claim_refs.length) {
    fail(E.INTAKE_INVALID, 'an intake needs at least one product reference or one approved claim reference', { field: 'intake' });
  }
  const id = deriveId('cin', body);
  if ((input.intake_id !== undefined && input.intake_id !== id) || (input.schema_version !== undefined && input.schema_version !== CI_VERSION)) {
    fail(E.ID_MISMATCH, 'intake.intake_id / schema_version do not follow from the content', { field: 'intake.intake_id' });
  }
  return deepFreeze({ intake_id: id, ...body });
}
