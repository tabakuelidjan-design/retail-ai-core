// Shared validators of Creative Intelligence C1. Pure, no clock, no randomness, no I/O.
// Messages never echo submitted values; they name the field only. Every reference is an OPAQUE token: never a URL, a data/blob/file
// location, a path with a host, an e-mail or a query string.

import { createHash } from 'node:crypto';
import { CI_ERROR as E, CreativeIntelligenceError, PRIVACY_ORDER } from './constants.js';
import { localeValue } from '../marketing/understand-validation.js';

export { deepFreeze, deriveId } from '../marketing/understand-validation.js';
export { canonical } from '../marketing/m2-validation.js';

export const fail = (code, message, detail = {}) => { throw new CreativeIntelligenceError(code, message, detail); };
export const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export function closedObject(value, allowedKeys, field, code = E.UNKNOWN_KEY) {
  if (!isPlainObject(value)) fail(E.INVALID_FIELD, `${field} must be a plain object`, { field });
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) fail(code, `${field}.${key} is not part of this contract`, { field, key });
  }
  return value;
}

/** Refuses a forbidden key anywhere in a (JSON-like) value. Case-insensitive on the key name. */
export function rejectKeysDeep(value, forbidden, code, field, path = '') {
  if (Array.isArray(value)) {
    value.forEach((item, i) => rejectKeysDeep(item, forbidden, code, field, `${path}[${i}]`));
  } else if (value != null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (forbidden.includes(key.toLowerCase())) fail(code, `${field}${path ? `.${path}` : ''}.${key} is not allowed in this contract`, { field, key });
      rejectKeysDeep(inner, forbidden, code, field, path ? `${path}.${key}` : key);
    }
  }
  return value;
}

const REF = /^[A-Za-z0-9][A-Za-z0-9:_./#-]*$/;
// Resource identity uses the platform convention `kind-ish://name` (asset://, claim://, format://, category://...). Only TRANSPORT schemes -
// a location, a payload, a script - are refused. Nothing here ever reads a reference to decide what KIND of thing it names.
const LOCATION_SCHEME = /^(https?|ftps?|sftp|ssh|file|data|blob|wss?|javascript|mailto|tel|s3|gs|gcs|drive):/i;
const HOST_PATH = /^(www\.|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\/)/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const TOKEN = /^[A-Z][A-Z0-9_]*$/;

/** An opaque, durable reference. A URL, a host/path, a data/blob/file location or a query string can never be one. */
export function ref(value, field, { max = 300 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !REF.test(value) || LOCATION_SCHEME.test(value) || HOST_PATH.test(value)) {
    fail(E.INVALID_REFERENCE, `${field} must be an opaque reference (no URL, no host, no whitespace, no query)`, { field });
  }
  return value;
}
export const optionalRef = (value, field) => (value == null ? null : ref(value, field));
export function refList(value, field, { max = 100, min = 0 } = {}) {
  if (value == null) value = [];
  if (!Array.isArray(value) || value.length > max || value.length < min) fail(E.INVALID_FIELD, `${field} must be an array of ${min}..${max} references`, { field });
  return [...new Set(value.map((item, i) => ref(item, `${field}[${i}]`)))].sort();
}

export function idToken(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) fail(E.INVALID_FIELD, `${field} must be an identifier (letters, digits, _ . : -)`, { field });
  return value;
}
export function upperToken(value, field, { max = 64 } = {}) {
  if (typeof value !== 'string' || value.length > max || !TOKEN.test(value)) fail(E.INVALID_FIELD, `${field} must be an UPPER_SNAKE token`, { field });
  return value;
}
export function tokenList(value, field, { max = 30 } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) fail(E.INVALID_FIELD, `${field} must be an array of at most ${max} tokens`, { field });
  return [...new Set(value.map((v, i) => upperToken(v, `${field}[${i}]`)))].sort();
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
export function text(value, field, { max = 500, min = 1, multiline = false } = {}) {
  if (typeof value !== 'string') fail(E.INVALID_FIELD, `${field} must be a string`, { field });
  const normalized = value.normalize('NFC');
  const probe = multiline ? normalized.replace(/\n/g, '') : normalized;
  if (normalized.length < min || normalized.length > max || CONTROL.test(probe) || (!multiline && normalized.includes('\n')) || !normalized.trim()) {
    fail(E.INVALID_FIELD, `${field} must be ${min}..${max} printable characters`, { field });
  }
  return normalized;
}
export const optionalText = (value, field, options) => (value == null ? null : text(value, field, options));

export function enumValue(value, allowed, field, code = E.INVALID_FIELD) {
  const list = Array.isArray(allowed) ? allowed : Object.values(allowed);
  if (typeof value !== 'string' || !list.includes(value)) fail(code, `${field} is not an allowed value`, { field });
  return value;
}

export function integer(value, field, { min = -Infinity, max = Infinity, code = E.INVALID_FIELD } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) fail(code, `${field} must be an integer in [${min}, ${max}]`, { field });
  return value;
}
export function number(value, field, { min = -Infinity, max = Infinity, code = E.INVALID_FIELD } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(code, `${field} must be a finite number in [${min}, ${max}]`, { field });
  return value;
}
export const optionalNumber = (value, field, options) => (value == null ? null : number(value, field, options));
export function bool(value, field) {
  if (typeof value !== 'boolean') fail(E.INVALID_FIELD, `${field} must be a boolean`, { field });
  return value;
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** #RGB / #RRGGBB, normalized to upper-case #RRGGBB. No named colour, no function, nothing that could carry markup. */
export function hexColor(value, field) {
  if (typeof value !== 'string' || !HEX.test(value)) fail(E.COLOR_INVALID, `${field} must be a #RGB or #RRGGBB colour`, { field });
  const body = value.slice(1).toUpperCase();
  return `#${body.length === 3 ? [...body].map((c) => c + c).join('') : body}`;
}
export const optionalHexColor = (value, field) => (value == null ? null : hexColor(value, field));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(E.INVALID_FIELD, `${field} must be a UUID`, { field });
  return value.toLowerCase();
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
export function iso(value, field) {
  const match = typeof value === 'string' ? ISO.exec(value) : null;
  const ms = match ? Date.parse(value) : NaN;
  if (!match || Number.isNaN(ms)) fail(E.INVALID_TIMESTAMP, `${field} must be an ISO-8601 timestamp with an explicit offset`, { field });
  return new Date(ms).toISOString();
}

/** Axis-aligned rectangle in canvas pixels (or normalized units, by the caller's bounds). */
export function rect(value, field, { code = E.GEOMETRY_INVALID, maxCoordinate = 100000 } = {}) {
  closedObject(value, ['x', 'y', 'width', 'height'], field, code);
  return {
    x: number(value.x, `${field}.x`, { min: -maxCoordinate, max: maxCoordinate, code }),
    y: number(value.y, `${field}.y`, { min: -maxCoordinate, max: maxCoordinate, code }),
    width: number(value.width, `${field}.width`, { min: 0.0001, max: maxCoordinate, code }),
    height: number(value.height, `${field}.height`, { min: 0.0001, max: maxCoordinate, code }),
  };
}

/** A region expressed as fractions (0..1) of an asset: the same coordinates whatever the pixel size. */
export function normalizedRegion(value, field) {
  closedObject(value, ['region_id', 'x', 'y', 'width', 'height'], field, E.REGION_INVALID);
  const r = {
    region_id: idToken(value.region_id, `${field}.region_id`),
    x: number(value.x, `${field}.x`, { min: 0, max: 1, code: E.REGION_INVALID }),
    y: number(value.y, `${field}.y`, { min: 0, max: 1, code: E.REGION_INVALID }),
    width: number(value.width, `${field}.width`, { min: 0.0001, max: 1, code: E.REGION_INVALID }),
    height: number(value.height, `${field}.height`, { min: 0.0001, max: 1, code: E.REGION_INVALID }),
  };
  if (r.x + r.width > 1 + 1e-9 || r.y + r.height > 1 + 1e-9) fail(E.REGION_INVALID, `${field} must stay inside the asset`, { field });
  return r;
}

export function intersects(a, b, epsilon = 0) {
  return a.x < b.x + b.width - epsilon && b.x < a.x + a.width - epsilon && a.y < b.y + b.height - epsilon && b.y < a.y + a.height - epsilon;
}
export function contains(outer, inner, epsilon = 0) {
  return inner.x >= outer.x - epsilon && inner.y >= outer.y - epsilon
    && inner.x + inner.width <= outer.x + outer.width + epsilon && inner.y + inner.height <= outer.y + outer.height + epsilon;
}
export const area = (r) => r.width * r.height;

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/** The digest of an approved text: any later change of the characters changes it. */
export const textDigest = (content) => sha256(content.normalize('NFC'));

export const privacyAtLeast = (providerClass, inputClass) => PRIVACY_ORDER.indexOf(providerClass) >= PRIVACY_ORDER.indexOf(inputClass);

export function plainJson(value, field, depth = 0) {
  if (depth > 12) fail(E.AGENT_OUTPUT_INVALID, `${field} is nested too deeply`, { field });
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(E.AGENT_OUTPUT_INVALID, `${field} holds a non-finite number`, { field });
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => plainJson(v, `${field}[${i}]`, depth + 1));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainJson(v, `${field}.${k}`, depth + 1)]));
  fail(E.AGENT_OUTPUT_INVALID, `${field} must be plain JSON data (no function, class instance, undefined or symbol)`, { field });
  return undefined;
}

/** A BCP 47 locale (language[-Script][-REGION]) normalized by the platform; the refusal is a Creative Intelligence error. */
export function locale(value, field) {
  try {
    return localeValue(value, field);
  } catch {
    return fail(E.INVALID_FIELD, `${field} must be a BCP 47 locale such as fr-BE`, { field });
  }
}
