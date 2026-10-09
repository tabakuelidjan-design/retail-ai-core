// Shared validators and the secret boundary of the Activation layer. Pure.
// Messages never echo submitted values; they name the field only.

import { inspect } from 'node:util';
import { ACT_ERROR as E, ActivationError } from './constants.js';

export { deepFreeze, deriveId } from '../marketing/understand-validation.js';
export { canonical } from '../marketing/m2-validation.js';

export const fail = (code, message, detail = {}) => { throw new ActivationError(code, message, detail); };
export const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export function closedObject(value, allowedKeys, field) {
  if (!isPlainObject(value)) fail(E.INVALID_FIELD, `${field} must be an object`, { field });
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) fail(E.UNKNOWN_KEY, `${field}.${key} is not part of this contract`, { field, key });
  }
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(E.INVALID_FIELD, `${field} must be a UUID`, { field });
  return value.toLowerCase();
}

// References are opaque tokens: no whitespace, '@', '?', '&', '=' ... and never a URL, a data/blob/file location or a path.
const REF = /^[A-Za-z0-9][A-Za-z0-9:_./#-]*$/;
const SCHEME = /^(https?|ftp|ftps|file|data|blob|ws|wss):/i;
export function ref(value, field, { max = 300 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !REF.test(value) || SCHEME.test(value)) {
    fail(E.INVALID_FIELD, `${field} must be an opaque reference (no URL, no whitespace, no query)`, { field });
  }
  return value;
}
export const optionalRef = (value, field) => (value == null ? null : ref(value, field));
export function refList(value, field, { max = 50 } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) fail(E.INVALID_FIELD, `${field} must be an array of at most ${max} references`, { field });
  return [...new Set(value.map((item, i) => ref(item, `${field}[${i}]`)))];
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
export function iso(value, field, code = E.INVALID_TIMESTAMP) {
  const match = typeof value === 'string' ? ISO.exec(value) : null;
  const ms = match ? Date.parse(value) : NaN;
  if (!match || Number.isNaN(ms)) fail(code, `${field} must be an ISO-8601 timestamp with an explicit offset`, { field });
  return new Date(ms).toISOString();
}
export const optionalIso = (value, field) => (value == null ? null : iso(value, field));
export const asOfIso = (value, field = 'asOf') => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : iso(value, field));
export const toMs = (isoValue) => Date.parse(isoValue);

export function enumValue(value, allowed, field, code = E.INVALID_FIELD) {
  const list = Array.isArray(allowed) ? allowed : Object.values(allowed);
  if (typeof value !== 'string' || !list.includes(value)) fail(code, `${field} is not an allowed value`, { field });
  return value;
}

export const sortedUnique = (values) => [...new Set(values)].sort();

// ---------------------------------------------------------------- secrets
/** A secret that can be used but never printed, serialized, logged or persisted. */
export class SealedSecret {
  #value;
  constructor(value) {
    if (typeof value !== 'string' || !value) throw new TypeError('a sealed secret needs a non-empty string');
    this.#value = value;
    Object.freeze(this);
  }
  reveal() { return this.#value; }
  toJSON() { return '[REDACTED]'; }
  toString() { return '[REDACTED]'; }
  [inspect.custom]() { return '[REDACTED]'; }
}
export const seal = (value) => (value instanceof SealedSecret ? value : new SealedSecret(value));

const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|api[-_]?key|bearer|credential|verifier|signature|signed|private[-_]?key/i;
// keys that look secret-like but are scope/permission lists or names
const SAFE_KEYS = new Set(['granted_scopes', 'required_scopes', 'credential_ref']);
const SECRET_VALUE = [
  /bearer\s+[A-Za-z0-9._~+/=-]{6,}/i,
  /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/,
  /(?:access_token|refresh_token|client_secret|code_verifier|app_secret|api[_-]?key)=\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:IGAA|IGQ|EAA|act\.|sk_[l]ive_)[A-Za-z0-9._-]{12,}/,
];
const URL_WITH_QUERY = /\bhttps?:\/\/[^\s"']*\?[^\s"']+/i;
const URL_WITH_USERINFO = /\bhttps?:\/\/[^\s/@"']+@/i;

/** Paths (never values) of every key or value that looks like a secret or a signed / credentialed URL. */
export function findSecretLeaks(value, path = '') {
  const out = [];
  if (value instanceof SealedSecret) return [path || '(sealed)'];
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...findSecretLeaks(v, `${path}[${i}]`)));
  else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (!SAFE_KEYS.has(k) && SECRET_KEY.test(k) && v != null && v !== '' && v !== '[REDACTED]') out.push(p);
      else out.push(...findSecretLeaks(v, p));
    }
  } else if (typeof value === 'string') {
    if (SECRET_VALUE.some((re) => re.test(value)) || URL_WITH_QUERY.test(value) || URL_WITH_USERINFO.test(value)) out.push(path || '(value)');
  }
  return out;
}

/** Throws when anything that is about to be persisted or logged looks like a secret or a signed URL. */
export function assertNoSecrets(value, field) {
  const paths = findSecretLeaks(value);
  if (paths.length) fail(E.SECRET_LEAK, `${field} must not contain a secret, a token or a signed URL`, { paths });
  return value;
}

/** Deep copy that replaces every secret by `[REDACTED]` and strips URL queries / credentials. Used for logs and error details. */
export function redact(value) {
  if (value instanceof SealedSecret) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(redact);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, !SAFE_KEYS.has(k) && SECRET_KEY.test(k) && v != null && v !== '' ? '[REDACTED]' : redact(v)]));
  }
  if (typeof value === 'string') {
    return value
      .replace(/(https?:\/\/)[^\s/@"']+@/gi, '$1[REDACTED]@')
      .replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/gi, '$1?[REDACTED]')
      .replace(/bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]')
      .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, '[REDACTED]')
      .replace(/((?:access_token|refresh_token|client_secret|code_verifier|app_secret|api[_-]?key)=)[^\s&"']+/gi, '$1[REDACTED]');
  }
  return value;
}
