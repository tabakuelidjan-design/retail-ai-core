// CreativeOutputContext: where and how the creative will be seen. Channel facts (safe zones, canvas sizes) are supplied by explicit
// contracts / configuration - the generic layout logic carries no per-platform heuristic.
//
// safe_zones: regions inside which every piece of content that must stay visible (text, price, CTA, logo, product) has to lie. An
// empty list means "the whole canvas is safe". forbidden_zones: regions that critical content must never overlap (e.g. a platform UI
// overlay). All coordinates are canvas pixels.

import { CI_ERROR as E, CI_SUPPORTED_CONTENT_KINDS, MEDIUM, RTL_LANGUAGES, TEXT_DIRECTION } from './constants.js';
import { CONTENT_KIND } from '../branding/constants.js';
import {
  closedObject, contains, deepFreeze, enumValue, fail, idToken, integer, locale, optionalNumber, rect, ref, tokenList, upperToken,
} from './validation.js';

const KEYS = [
  'content_kind', 'channel', 'placement', 'format_ref', 'canvas', 'aspect_ratio', 'physical_or_digital', 'viewing_distance_m', 'expected_dwell_time_s',
  'safe_zones', 'forbidden_zones', 'locale', 'direction', 'production_constraints',
];
export const MIN_CANVAS = 64;
export const MAX_CANVAS = 16384;
const MAX_ZONES = 20;

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
export function reducedAspectRatio(width, height) {
  const g = gcd(width, height);
  return `${width / g}:${height / g}`;
}

export function normalizeCanvas(input, field = 'canvas') {
  closedObject(input, ['width', 'height'], field, E.CANVAS_INVALID);
  return {
    width: integer(input.width, `${field}.width`, { min: MIN_CANVAS, max: MAX_CANVAS, code: E.CANVAS_INVALID }),
    height: integer(input.height, `${field}.height`, { min: MIN_CANVAS, max: MAX_CANVAS, code: E.CANVAS_INVALID }),
  };
}

function zones(value, field, canvas) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ZONES) fail(E.ZONE_INVALID, `${field} must be an array of at most ${MAX_ZONES} zones`, { field });
  const full = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const out = value.map((zone, i) => {
    closedObject(zone, ['zone_id', 'x', 'y', 'width', 'height'], `${field}[${i}]`, E.ZONE_INVALID);
    const r = rect({ x: zone.x, y: zone.y, width: zone.width, height: zone.height }, `${field}[${i}]`, { code: E.ZONE_INVALID });
    if (!contains(full, r, 1e-9)) fail(E.ZONE_INVALID, `${field}[${i}] must lie inside the canvas`, { field });
    return { zone_id: idToken(zone.zone_id, `${field}[${i}].zone_id`), ...r };
  });
  if (new Set(out.map((z) => z.zone_id)).size !== out.length) fail(E.ZONE_INVALID, `${field} holds the same zone_id twice`, { field });
  return out.sort((a, b) => (a.zone_id < b.zone_id ? -1 : 1));
}

export function directionForLocale(locale) {
  return RTL_LANGUAGES.includes(locale.split('-')[0]) ? TEXT_DIRECTION.RTL : TEXT_DIRECTION.LTR;
}

export function normalizeOutputContext(input) {
  closedObject(input, KEYS, 'output_context');
  const contentKind = enumValue(input.content_kind, CONTENT_KIND, 'output_context.content_kind');
  if (!CI_SUPPORTED_CONTENT_KINDS.includes(contentKind)) fail(E.CONTENT_KIND_UNSUPPORTED, 'Creative Intelligence C1 expresses still IMAGE / DOCUMENT outputs only', { field: 'output_context.content_kind' });
  const canvas = normalizeCanvas(input.canvas, 'output_context.canvas');
  const ratio = reducedAspectRatio(canvas.width, canvas.height);
  if (input.aspect_ratio !== ratio) fail(E.ASPECT_RATIO_MISMATCH, 'output_context.aspect_ratio does not follow from the canvas (reduced W:H)', { field: 'output_context.aspect_ratio' });
  const loc = locale(input.locale, 'output_context.locale');
  const direction = enumValue(input.direction, TEXT_DIRECTION, 'output_context.direction');
  if (direction !== directionForLocale(loc)) fail(E.DIRECTION_LOCALE_MISMATCH, 'output_context.direction contradicts the locale', { field: 'output_context.direction' });
  const medium = enumValue(input.physical_or_digital, MEDIUM, 'output_context.physical_or_digital');
  const viewing = optionalNumber(input.viewing_distance_m, 'output_context.viewing_distance_m', { min: 0.05, max: 500 });
  if (viewing != null && medium !== MEDIUM.PHYSICAL) fail(E.INVALID_FIELD, 'viewing_distance_m only applies to a PHYSICAL output', { field: 'output_context.viewing_distance_m' });
  const dwell = optionalNumber(input.expected_dwell_time_s, 'output_context.expected_dwell_time_s', { min: 0.1, max: 3600 });
  const safe = zones(input.safe_zones, 'output_context.safe_zones', canvas);
  const forbidden = zones(input.forbidden_zones, 'output_context.forbidden_zones', canvas);
  const ids = [...safe, ...forbidden].map((z) => z.zone_id);
  if (new Set(ids).size !== ids.length) fail(E.ZONE_INVALID, 'a zone_id cannot be both a safe and a forbidden zone', { field: 'output_context' });
  return deepFreeze({
    content_kind: contentKind,
    channel: upperToken(input.channel, 'output_context.channel'),
    placement: upperToken(input.placement, 'output_context.placement'),
    format_ref: ref(input.format_ref, 'output_context.format_ref'),
    canvas,
    aspect_ratio: ratio,
    physical_or_digital: medium,
    viewing_distance_m: viewing,
    expected_dwell_time_s: dwell,
    safe_zones: safe,
    forbidden_zones: forbidden,
    locale: loc,
    direction,
    production_constraints: tokenList(input.production_constraints, 'output_context.production_constraints'),
  });
}
