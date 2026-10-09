// ProductUnderstandingPackage: what the pipeline must know about a REAL product before it may place it in a scene.
// Coordinates are fractions (0..1) of the source asset, so they survive any resolution.
//
// The commerce default is PIXEL_PRESERVE (the product pixels are placed untouched) or COMPOSITE (a cut-out of the same pixels on
// a new scene). CONTROLLED_EDIT and GENERATIVE_REFERENCE are CONTRACT modes for later lanes: they need an explicit justification
// reference and, for an edit, protected regions - and the C1 renderer refuses to render them.

import {
  CI_ERROR as E, CI_VERSION, ORIENTATION, PRESERVATION_MODE,
} from './constants.js';
import {
  bool, closedObject, deepFreeze, deriveId, enumValue, fail, iso, normalizedRegion, optionalRef, ref, refList, uuid,
} from './validation.js';

const POLICY_KEYS = ['mode', 'allow_crop', 'allow_relight', 'allow_shadow', 'allow_rotation', 'justification_ref'];
const KEYS = [
  'package_id', 'schema_version', 'merchant_id', 'brand_id', 'product_ref', 'asset_refs', 'protected_regions', 'logo_regions', 'packaging_text_regions',
  'dominant_orientation', 'product_bounds', 'transformation_policy', 'created_at',
];

function regions(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30) fail(E.REGION_INVALID, `${field} must be an array of at most 30 regions`, { field });
  const out = value.map((r, i) => normalizedRegion(r, `${field}[${i}]`));
  if (new Set(out.map((r) => r.region_id)).size !== out.length) fail(E.REGION_INVALID, `${field} holds the same region_id twice`, { field });
  return out.sort((a, b) => (a.region_id < b.region_id ? -1 : 1));
}

export function normalizeTransformationPolicy(input, field = 'transformation_policy') {
  closedObject(input, POLICY_KEYS, field, E.PRESERVATION_POLICY_INVALID);
  const mode = enumValue(input.mode, PRESERVATION_MODE, `${field}.mode`, E.PRESERVATION_POLICY_INVALID);
  const policy = {
    mode,
    allow_crop: bool(input.allow_crop ?? false, `${field}.allow_crop`),
    allow_relight: bool(input.allow_relight ?? false, `${field}.allow_relight`),
    allow_shadow: bool(input.allow_shadow ?? false, `${field}.allow_shadow`),
    allow_rotation: bool(input.allow_rotation ?? false, `${field}.allow_rotation`),
    justification_ref: optionalRef(input.justification_ref, `${field}.justification_ref`),
  };
  if (mode === PRESERVATION_MODE.PIXEL_PRESERVE && (policy.allow_relight || policy.allow_rotation || policy.allow_crop)) {
    fail(E.PRESERVATION_POLICY_INVALID, 'PIXEL_PRESERVE keeps the pixels as they are: no crop, no relight, no rotation', { field });
  }
  if (mode === PRESERVATION_MODE.COMPOSITE && policy.allow_relight) {
    fail(E.PRESERVATION_POLICY_INVALID, 'COMPOSITE places the original cut-out pixels: relighting belongs to CONTROLLED_EDIT', { field });
  }
  if (mode === PRESERVATION_MODE.IDENTITY_PRESERVE && (policy.allow_crop || policy.allow_rotation)) {
    fail(E.PRESERVATION_POLICY_INVALID, 'IDENTITY_PRESERVE allows no crop and no rotation: relighting, shadow and a new background are its purpose', { field });
  }
  if ([PRESERVATION_MODE.CONTROLLED_EDIT, PRESERVATION_MODE.GENERATIVE_REFERENCE, PRESERVATION_MODE.IDENTITY_PRESERVE].includes(mode) && !policy.justification_ref) {
    fail(E.PRESERVATION_POLICY_INVALID, `${mode} needs a justification_ref: real commerce defaults to PIXEL_PRESERVE or COMPOSITE`, { field });
  }
  return policy;
}

export function normalizeProductUnderstanding(input) {
  closedObject(input, KEYS, 'product_understanding');
  const protectedRegions = regions(input.protected_regions, 'product_understanding.protected_regions');
  const logoRegions = regions(input.logo_regions, 'product_understanding.logo_regions');
  const packagingRegions = regions(input.packaging_text_regions, 'product_understanding.packaging_text_regions');
  const policy = normalizeTransformationPolicy(input.transformation_policy, 'product_understanding.transformation_policy');
  // A logo or a packaging text is part of the product identity: it is always protected, whatever else is declared.
  const protectedIds = new Set(protectedRegions.map((r) => r.region_id));
  for (const r of [...logoRegions, ...packagingRegions]) {
    if (!protectedIds.has(r.region_id) && !protectedRegions.some((p) => p.x <= r.x && p.y <= r.y && p.x + p.width >= r.x + r.width && p.y + p.height >= r.y + r.height)) {
      fail(E.REGION_INVALID, 'every logo / packaging-text region must be covered by a protected region', { field: 'product_understanding.protected_regions' });
    }
  }
  if ([PRESERVATION_MODE.CONTROLLED_EDIT, PRESERVATION_MODE.IDENTITY_PRESERVE].includes(policy.mode) && protectedRegions.length === 0) {
    fail(E.PRESERVATION_POLICY_INVALID, `${policy.mode} needs protected regions`, { field: 'product_understanding.protected_regions' });
  }
  const bounds = input.product_bounds == null ? null : normalizedRegion({ region_id: 'bounds', ...input.product_bounds }, 'product_understanding.product_bounds');
  const body = {
    schema_version: CI_VERSION,
    merchant_id: uuid(input.merchant_id, 'product_understanding.merchant_id'),
    brand_id: uuid(input.brand_id, 'product_understanding.brand_id'),
    product_ref: ref(input.product_ref, 'product_understanding.product_ref'),
    asset_refs: refList(input.asset_refs, 'product_understanding.asset_refs', { min: 1, max: 20 }),
    protected_regions: protectedRegions,
    logo_regions: logoRegions,
    packaging_text_regions: packagingRegions,
    dominant_orientation: enumValue(input.dominant_orientation ?? ORIENTATION.UNKNOWN, ORIENTATION, 'product_understanding.dominant_orientation'),
    product_bounds: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null,
    transformation_policy: policy,
    created_at: iso(input.created_at, 'product_understanding.created_at'),
  };
  const id = deriveId('cpu', body);
  if ((input.package_id !== undefined && input.package_id !== id) || (input.schema_version !== undefined && input.schema_version !== CI_VERSION)) {
    fail(E.ID_MISMATCH, 'product_understanding.package_id / schema_version do not follow from the content', { field: 'product_understanding.package_id' });
  }
  return deepFreeze({ package_id: id, ...body });
}

