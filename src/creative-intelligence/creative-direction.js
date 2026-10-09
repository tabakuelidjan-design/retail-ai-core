// CreativeDirection: the HOW of one expressive idea for an already approved Brief. It carries intent (enums), never a provider
// prompt: a prompt / model / seed is ephemeral adapter data and is refused anywhere in the input.

import {
  CI_ERROR as E, CI_VERSION, FORBIDDEN_PROVIDER_KEYS, HIERARCHY_ROLE, NEGATIVE_SPACE, PRODUCT_ROLE, SPATIAL_INTENT,
} from './constants.js';
import {
  closedObject, deepFreeze, deriveId, enumValue, fail, refList, rejectKeysDeep, text, tokenList, uuid, ref,
} from './validation.js';

const KEYS = [
  'merchant_id', 'brand_id', 'brief_ref', 'concept', 'copy_intent', 'visual_intent', 'product_role', 'spatial_intent',
  'negative_space_intent', 'hierarchy', 'required_asset_refs', 'claim_refs', 'forbidden_transformations', 'evidence_refs',
];
const FULL_KEYS = ['direction_id', 'schema_version', ...KEYS];

export function normalizeCreativeDirection(input) {
  rejectKeysDeep(input, FORBIDDEN_PROVIDER_KEYS, E.FORBIDDEN_KEY, 'direction');
  closedObject(input, FULL_KEYS, 'direction');
  const hierarchy = Array.isArray(input.hierarchy) ? input.hierarchy : null;
  if (!hierarchy || hierarchy.length === 0 || hierarchy.length > 8) fail(E.DIRECTION_INVALID, 'direction.hierarchy must list 1..8 roles in reading order', { field: 'direction.hierarchy' });
  const roles = hierarchy.map((r, i) => enumValue(r, HIERARCHY_ROLE, `direction.hierarchy[${i}]`));
  if (new Set(roles).size !== roles.length) fail(E.DIRECTION_INVALID, 'direction.hierarchy lists a role twice', { field: 'direction.hierarchy' });
  const productRole = enumValue(input.product_role, PRODUCT_ROLE, 'direction.product_role');
  if (productRole === PRODUCT_ROLE.ABSENT && roles.includes(HIERARCHY_ROLE.PRODUCT)) fail(E.DIRECTION_INVALID, 'a direction with no product cannot rank the product in its hierarchy', { field: 'direction.hierarchy' });
  if (productRole === PRODUCT_ROLE.HERO && !roles.includes(HIERARCHY_ROLE.PRODUCT)) fail(E.DIRECTION_INVALID, 'a HERO product must appear in the hierarchy', { field: 'direction.hierarchy' });
  const body = {
    schema_version: CI_VERSION,
    merchant_id: uuid(input.merchant_id, 'direction.merchant_id'),
    brand_id: uuid(input.brand_id, 'direction.brand_id'),
    brief_ref: ref(input.brief_ref, 'direction.brief_ref'),
    concept: text(input.concept, 'direction.concept', { max: 300 }),
    copy_intent: text(input.copy_intent, 'direction.copy_intent', { max: 300 }),
    visual_intent: text(input.visual_intent, 'direction.visual_intent', { max: 300 }),
    product_role: productRole,
    spatial_intent: enumValue(input.spatial_intent, SPATIAL_INTENT, 'direction.spatial_intent'),
    negative_space_intent: enumValue(input.negative_space_intent, NEGATIVE_SPACE, 'direction.negative_space_intent'),
    hierarchy: roles,
    required_asset_refs: refList(input.required_asset_refs, 'direction.required_asset_refs', { max: 30 }),
    claim_refs: refList(input.claim_refs, 'direction.claim_refs', { max: 30 }),
    forbidden_transformations: tokenList(input.forbidden_transformations, 'direction.forbidden_transformations'),
    evidence_refs: refList(input.evidence_refs, 'direction.evidence_refs', { max: 30 }),
  };
  const id = deriveId('cdr', body);
  if (input.schema_version !== undefined && input.schema_version !== CI_VERSION) fail(E.ID_MISMATCH, 'direction.schema_version is not this contract version', { field: 'direction.schema_version' });
  if (input.direction_id !== undefined && input.direction_id !== id) fail(E.ID_MISMATCH, 'direction.direction_id does not follow from its content', { field: 'direction.direction_id' });
  return deepFreeze({ direction_id: id, ...body });
}

/** Several directions must be genuinely different ideas: the same content twice is not a second candidate. */
export function assertDistinctDirections(directions) {
  const ids = directions.map((d) => d.direction_id);
  if (new Set(ids).size !== ids.length) fail(E.DIRECTION_NOT_DISTINCT, 'the same creative direction appears twice');
  const spatial = directions.map((d) => `${d.spatial_intent}|${d.concept.toLowerCase()}`);
  if (new Set(spatial).size !== spatial.length) fail(E.DIRECTION_NOT_DISTINCT, 'two directions share the same concept and spatial intent');
  return directions;
}
