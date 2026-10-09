// Per-kind metadata contracts. The resolver validates what an owner adapter says about a resource; it never stores it.
//
// FORMAT is a resource kind (not a separate resolver). Its metadata is EXACTLY:
//   { canvas: { width, height, unit }, medium, safe_zones, forbidden_zones, production_constraints }
// - the aspect ratio is never stated (it is derived from the canvas by whoever needs it);
// - `channel` and `placement` are Marketing deliverable facts and can never be format facts.
// FONT, ASSET and CLAIM carry the minimum that real typography, a verified render and an exact approved wording need. The other kinds
// carry free descriptive metadata that can never hold a location or a payload.

import {
  ASSET_MEDIA_TYPES, ASSET_ORIGIN, FONT_FORMATS, FONT_STYLES, FORMAT_MEDIUM, FORMAT_UNITS, RES_ERROR as E, RESOURCE_KIND as K,
} from './constants.js';
import {
  assertNoLocation, closedObject, enumValue, fail, hex64, isPlainObject, number, ref, text, upperToken,
} from './validation.js';

const ZONE_KEYS = ['zone_id', 'x', 'y', 'width', 'height'];

function zones(value, field, canvas) {
  if (!Array.isArray(value) || value.length > 20) fail(E.METADATA_INVALID, `${field} must be an array of at most 20 zones`, { field });
  const out = value.map((z, i) => {
    closedObject(z, ZONE_KEYS, `${field}[${i}]`, E.METADATA_INVALID);
    const zone = {
      zone_id: text(z.zone_id, `${field}[${i}].zone_id`, { max: 64 }),
      x: number(z.x, `${field}[${i}].x`, { min: 0 }),
      y: number(z.y, `${field}[${i}].y`, { min: 0 }),
      width: number(z.width, `${field}[${i}].width`, { min: 0.0001 }),
      height: number(z.height, `${field}[${i}].height`, { min: 0.0001 }),
    };
    if (zone.x + zone.width > canvas.width + 1e-9 || zone.y + zone.height > canvas.height + 1e-9) fail(E.METADATA_INVALID, `${field}[${i}] must lie inside the canvas`, { field });
    return zone;
  });
  if (new Set(out.map((z) => z.zone_id)).size !== out.length) fail(E.METADATA_INVALID, `${field} repeats a zone_id`, { field });
  return out.sort((a, b) => (a.zone_id < b.zone_id ? -1 : 1));
}

export function normalizeFormatMetadata(input) {
  closedObject(input, ['canvas', 'medium', 'safe_zones', 'forbidden_zones', 'production_constraints'], 'format.metadata', E.METADATA_INVALID);
  closedObject(input.canvas, ['width', 'height', 'unit'], 'format.metadata.canvas', E.METADATA_INVALID);
  const canvas = {
    width: number(input.canvas.width, 'format.metadata.canvas.width', { min: 1, max: 100000 }),
    height: number(input.canvas.height, 'format.metadata.canvas.height', { min: 1, max: 100000 }),
    unit: enumValue(input.canvas.unit, FORMAT_UNITS, 'format.metadata.canvas.unit'),
  };
  if (!Array.isArray(input.production_constraints) || input.production_constraints.length > 30) fail(E.METADATA_INVALID, 'format.metadata.production_constraints must be an array of tokens', { field: 'production_constraints' });
  return {
    canvas,
    medium: enumValue(input.medium, FORMAT_MEDIUM, 'format.metadata.medium'),
    safe_zones: zones(input.safe_zones, 'format.metadata.safe_zones', canvas),
    forbidden_zones: zones(input.forbidden_zones, 'format.metadata.forbidden_zones', canvas),
    production_constraints: [...new Set(input.production_constraints.map((t, i) => upperToken(t, `format.metadata.production_constraints[${i}]`)))].sort(),
  };
}

export function normalizeFontMetadata(input) {
  closedObject(input, ['family', 'style', 'weight', 'version', 'format', 'content_hash', 'license_ref'], 'font.metadata', E.METADATA_INVALID);
  return {
    family: text(input.family, 'font.metadata.family', { max: 100 }),
    style: enumValue(input.style, FONT_STYLES, 'font.metadata.style'),
    weight: number(input.weight, 'font.metadata.weight', { min: 1, max: 1000, integer: true }),
    version: text(input.version, 'font.metadata.version', { max: 64 }),
    format: enumValue(input.format, FONT_FORMATS, 'font.metadata.format'),
    content_hash: hex64(input.content_hash, 'font.metadata.content_hash'),
    // where the commercial-rights record lives; null states that none is available (it is never invented)
    license_ref: input.license_ref == null ? null : ref(input.license_ref, 'font.metadata.license_ref'),
  };
}

export function normalizeAssetMetadata(input) {
  closedObject(input, ['media_type', 'width_px', 'height_px', 'content_hash', 'origin', 'approval_ref'], 'asset.metadata', E.METADATA_INVALID);
  return {
    media_type: enumValue(input.media_type, ASSET_MEDIA_TYPES, 'asset.metadata.media_type'),
    width_px: number(input.width_px, 'asset.metadata.width_px', { min: 1, max: 100000, integer: true }),
    height_px: number(input.height_px, 'asset.metadata.height_px', { min: 1, max: 100000, integer: true }),
    content_hash: hex64(input.content_hash, 'asset.metadata.content_hash'),
    origin: enumValue(input.origin, ASSET_ORIGIN, 'asset.metadata.origin'),
    approval_ref: input.approval_ref == null ? null : ref(input.approval_ref, 'asset.metadata.approval_ref'),
  };
}

export function normalizeClaimMetadata(input) {
  closedObject(input, ['approved_wording', 'approval_ref'], 'claim.metadata', E.METADATA_INVALID);
  return {
    approved_wording: text(input.approved_wording, 'claim.metadata.approved_wording', { max: 300 }),
    // an approved claim states WHO / WHAT approved it; without it the claim is not approved
    approval_ref: ref(input.approval_ref, 'claim.metadata.approval_ref'),
  };
}

function free(input, kind) {
  if (input == null) return null;
  if (!isPlainObject(input) || JSON.stringify(input).length > 4096) fail(E.METADATA_INVALID, `${kind} metadata must be a small plain object`, { kind });
  assertNoLocation(input, `${kind}.metadata`);
  return JSON.parse(JSON.stringify(input));
}

const SPECIFIC = {
  [K.FORMAT]: normalizeFormatMetadata,
  [K.FONT]: normalizeFontMetadata,
  [K.ASSET]: normalizeAssetMetadata,
  [K.CLAIM]: normalizeClaimMetadata,
};

/** Validates the metadata of a resolved resource for its kind. FORMAT / FONT / ASSET / CLAIM are strict; the rest are free but location-free. */
export function normalizeMetadata(kind, input) {
  const strict = SPECIFIC[kind];
  if (strict) {
    if (input == null) fail(E.METADATA_INVALID, `a ${kind} resource carries its metadata`, { kind });
    const out = strict(input);
    assertNoLocation(out, `${kind}.metadata`);
    return out;
  }
  return free(input, kind);
}
