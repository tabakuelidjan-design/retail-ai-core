// C1 - Asset readiness. METADATA / REFERENCE readiness only: no pixel is read, nothing is segmented, nothing is sent to a provider.
// Aggregation (stated, not implied): NOT_READY > NOT_MEASURABLE > PARTIAL > READY. An unknown is never reported as ready.

import {
  ASSET_KIND, CI_ERROR as E, CI_VERSION, PRIVACY_CLASS, PRIVACY_ORDER, READINESS, RIGHTS_CLASS,
} from './constants.js';
import {
  bool, closedObject, deepFreeze, deriveId, enumValue, fail, integer, iso, ref, text, uuid,
} from './validation.js';

const ASSET_KEYS = [
  'asset_ref', 'kind', 'width_px', 'height_px', 'has_alpha', 'cutout_available', 'rights_class', 'privacy_class', 'released',
];
export const MIN_USABLE_RATIO = 0.5; // below this fraction of the target size the asset is not usable without a visible upscale

const rank = { READY: 0, PARTIAL: 1, NOT_MEASURABLE: 2, NOT_READY: 3 };
const worst = (statuses) => statuses.reduce((a, b) => (rank[b] > rank[a] ? b : a), READINESS.READY);

function check(name, status, reason) { return { check: name, status, reason_code: reason }; }

function assessAsset(input, target, i) {
  closedObject(input, ASSET_KEYS, `assets[${i}]`, E.ASSET_REPORT_INVALID);
  const kind = enumValue(input.kind, ASSET_KIND, `assets[${i}].kind`);
  const width = input.width_px == null ? null : integer(input.width_px, `assets[${i}].width_px`, { min: 1, max: 100000 });
  const height = input.height_px == null ? null : integer(input.height_px, `assets[${i}].height_px`, { min: 1, max: 100000 });
  const rights = enumValue(input.rights_class ?? RIGHTS_CLASS.UNKNOWN, RIGHTS_CLASS, `assets[${i}].rights_class`);
  const privacy = input.privacy_class == null ? null : enumValue(input.privacy_class, PRIVACY_CLASS, `assets[${i}].privacy_class`);
  const alpha = input.has_alpha == null ? null : bool(input.has_alpha, `assets[${i}].has_alpha`);
  const cutout = input.cutout_available == null ? null : bool(input.cutout_available, `assets[${i}].cutout_available`);
  const released = input.released == null ? null : bool(input.released, `assets[${i}].released`);

  const checks = [];
  if (width == null || height == null) checks.push(check('RESOLUTION', READINESS.NOT_MEASURABLE, 'DIMENSIONS_UNKNOWN'));
  else if (!target) checks.push(check('RESOLUTION', READINESS.NOT_MEASURABLE, 'NO_TARGET_SIZE'));
  else {
    const ratio = Math.min(width / target.width, height / target.height);
    if (ratio >= 1) checks.push(check('RESOLUTION', READINESS.READY, 'RESOLUTION_SUFFICIENT'));
    else if (ratio >= MIN_USABLE_RATIO) checks.push(check('RESOLUTION', READINESS.PARTIAL, 'UPSCALE_NEEDED'));
    else checks.push(check('RESOLUTION', READINESS.NOT_READY, 'RESOLUTION_TOO_LOW'));
  }
  if (rights === RIGHTS_CLASS.RESTRICTED) checks.push(check('RIGHTS', READINESS.NOT_READY, 'RIGHTS_RESTRICTED'));
  else if (rights === RIGHTS_CLASS.UNKNOWN) checks.push(check('RIGHTS', READINESS.PARTIAL, 'RIGHTS_UNKNOWN'));
  else checks.push(check('RIGHTS', READINESS.READY, 'RIGHTS_CLEAR'));
  if (privacy == null) checks.push(check('PRIVACY', READINESS.NOT_MEASURABLE, 'PRIVACY_UNCLASSIFIED'));
  else checks.push(check('PRIVACY', READINESS.READY, `PRIVACY_${privacy}`));
  if (kind === ASSET_KIND.PRODUCT) {
    if (cutout === true || alpha === true) checks.push(check('CUTOUT', READINESS.READY, 'CUTOUT_AVAILABLE'));
    else if (cutout === false) checks.push(check('CUTOUT', READINESS.PARTIAL, 'CUTOUT_NEEDED'));
    else checks.push(check('CUTOUT', READINESS.NOT_MEASURABLE, 'CUTOUT_UNKNOWN'));
    if (released === false) checks.push(check('RELEASE', READINESS.PARTIAL, 'PRODUCT_NOT_RELEASED'));
  }
  const status = worst(checks.map((c) => c.status));
  // "cloud_provider_allowed" is a flag for FUTURE routing: personal / restricted / unclassified media never leaves the platform by default.
  const cloudAllowed = privacy != null && PRIVACY_ORDER.indexOf(privacy) <= PRIVACY_ORDER.indexOf(PRIVACY_CLASS.BUSINESS) && released !== false;
  return {
    asset_ref: ref(input.asset_ref, `assets[${i}].asset_ref`), kind, status, checks, privacy_class: privacy, rights_class: rights,
    cloud_provider_allowed: cloudAllowed,
  };
}

/**
 * Builds the AssetReadinessReport for the assets of a run against the canvas it must fill (`target` = {width,height} or null).
 * `assets[]` carries metadata only; the Product & Asset Analyst produces it, a stored report is never an authority.
 */
export function buildAssetReadinessReport({ merchant_id, brand_id, assets, target = null, created_at } = {}) {
  if (!Array.isArray(assets) || assets.length > 100) fail(E.ASSET_REPORT_INVALID, 'assets must be an array of at most 100 entries', { field: 'assets' });
  const items = assets.map((a, i) => assessAsset(a, target, i)).sort((a, b) => (a.asset_ref < b.asset_ref ? -1 : 1));
  if (new Set(items.map((i) => i.asset_ref)).size !== items.length) fail(E.ASSET_REPORT_INVALID, 'the same asset_ref appears twice', { field: 'assets' });
  const status = items.length === 0 ? READINESS.NOT_READY : worst(items.map((i) => i.status));
  const body = {
    schema_version: CI_VERSION,
    merchant_id: uuid(merchant_id, 'merchant_id'),
    brand_id: uuid(brand_id, 'brand_id'),
    status,
    reason_codes: items.length === 0 ? ['NO_ASSETS'] : [],
    items,
    created_at: iso(created_at, 'created_at'),
  };
  return deepFreeze({ report_id: deriveId('car', body), ...body });
}

// ---- reuse lookup contract (contract only: the catalogue of approved assets is not built here)
const LOOKUP_KEYS = ['merchant_id', 'brand_id', 'product_ref', 'content_kind', 'channel', 'locale', 'max_results'];
const MATCH_KEYS = ['asset_ref', 'approved_at', 'provenance_ref', 'content_kind', 'channel', 'locale'];

export function normalizeReuseLookupRequest(input) {
  closedObject(input, LOOKUP_KEYS, 'reuse_lookup');
  const body = {
    merchant_id: uuid(input.merchant_id, 'reuse_lookup.merchant_id'),
    brand_id: uuid(input.brand_id, 'reuse_lookup.brand_id'),
    product_ref: ref(input.product_ref, 'reuse_lookup.product_ref'),
    content_kind: enumValue(input.content_kind, ['IMAGE', 'DOCUMENT'], 'reuse_lookup.content_kind'),
    channel: text(input.channel, 'reuse_lookup.channel', { max: 64 }),
    locale: text(input.locale, 'reuse_lookup.locale', { max: 35 }),
    max_results: integer(input.max_results ?? 10, 'reuse_lookup.max_results', { min: 1, max: 50 }),
  };
  return deepFreeze({ request_id: deriveId('clr', body), ...body });
}

/** A lookup result is a list of APPROVED assets from the same merchant; it carries references and provenance, never pixels. */
export function normalizeReuseLookupResult(input, request) {
  closedObject(input, ['request_id', 'matches'], 'reuse_result');
  if (input.request_id !== request.request_id) fail(E.ASSET_REPORT_INVALID, 'the lookup result answers another request', { field: 'reuse_result.request_id' });
  if (!Array.isArray(input.matches) || input.matches.length > request.max_results) fail(E.ASSET_REPORT_INVALID, 'reuse_result.matches exceeds the requested size', { field: 'reuse_result.matches' });
  const matches = input.matches.map((m, i) => {
    closedObject(m, MATCH_KEYS, `reuse_result.matches[${i}]`, E.ASSET_REPORT_INVALID);
    return {
      asset_ref: ref(m.asset_ref, `reuse_result.matches[${i}].asset_ref`),
      approved_at: iso(m.approved_at, `reuse_result.matches[${i}].approved_at`),
      provenance_ref: ref(m.provenance_ref, `reuse_result.matches[${i}].provenance_ref`),
      content_kind: enumValue(m.content_kind, ['IMAGE', 'DOCUMENT'], `reuse_result.matches[${i}].content_kind`),
      channel: text(m.channel, `reuse_result.matches[${i}].channel`, { max: 64 }),
      locale: text(m.locale, `reuse_result.matches[${i}].locale`, { max: 35 }),
    };
  }).sort((a, b) => (a.asset_ref < b.asset_ref ? -1 : 1));
  return deepFreeze({ request_id: request.request_id, matches });
}
