// Shared validators, crypto helpers and the secret boundary of Provider Provisioning. Pure (randomness and clock are injected).

import {
  createHash, randomBytes, timingSafeEqual,
} from 'node:crypto';
import { PC_ERROR as E, ProvisioningError, PROVIDERS } from './constants.js';

export {
  SealedSecret, seal, redact, findSecretLeaks, assertNoSecrets, deepFreeze, deriveId, canonical, sortedUnique,
} from '../activation/validation.js';
export const fail = (code, message, detail = {}) => { throw new ProvisioningError(code, message, detail); };
export const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export function closedObject(value, allowedKeys, field) {
  if (!isPlainObject(value)) fail(E.INVALID_FIELD, `${field} must be an object`, { field });
  for (const key of Object.keys(value)) if (!allowedKeys.includes(key)) fail(E.UNKNOWN_KEY, `${field}.${key} is not part of this contract`, { field, key });
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(E.INVALID_FIELD, `${field} must be a UUID`, { field });
  return value.toLowerCase();
}

/** The tenant comes from the server context (the canonical resolver), never from a request parameter. */
export function merchantOf(tenant) {
  if (!isPlainObject(tenant) || !['session', 'env', 'legacy_shopify'].includes(tenant.source) || typeof tenant.merchantId !== 'string' || !UUID.test(tenant.merchantId)) {
    fail(E.TENANT_INVALID, 'tenant must be the result of the canonical tenant resolver');
  }
  return tenant.merchantId.toLowerCase();
}

export function providerOf(value) {
  if (!PROVIDERS.includes(value)) fail(E.PROVIDER_UNSUPPORTED, 'this provider is not supported');
  return value;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
export function iso(value, field) {
  const ms = typeof value === 'string' && ISO.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) fail(E.INVALID_FIELD, `${field} must be an ISO-8601 timestamp with an explicit offset`, { field });
  return new Date(ms).toISOString();
}
export const nowIsoOf = (clock) => new Date(clock()).toISOString();
export const toMs = (value) => Date.parse(value);

// ------------------------------------------------------------------ OAuth state / PKCE
/** 32 random bytes, base64url. The raw value only travels in the authorization URL; only its hash is ever persisted. */
export const randomToken = (rng = randomBytes, bytes = 32) => rng(bytes).toString('base64url');
export const sha256Hex = (value) => createHash('sha256').update(String(value)).digest('hex');
export const pkceChallengeOf = (verifier) => createHash('sha256').update(String(verifier)).digest('base64url'); // S256
export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8'); const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * return_to is an INTERNAL route: it must match the allowlist exactly or by path prefix, and can never be an absolute URL, a
 * protocol-relative URL, a backslash trick or contain control characters (no open redirect).
 */
// backslashes and control characters (written with escapes so that the source stays plain text)
const CONTROL_OR_BACKSLASH = new RegExp(`[${String.fromCharCode(92)}${String.fromCharCode(92)}\u0000-\u001f]`);
export function safeReturnTo(value, allowlist = ['/connections']) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 200 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value) || /^\/[a-z][a-z0-9+.-]*:/i.test(value)) {
    fail(E.RETURN_TO_REFUSED, 'return_to must be an internal route');
  }
  const path = value.split(/[?#]/)[0];
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { fail(E.RETURN_TO_REFUSED, 'return_to is not a valid route'); }
  if (decoded.split('/').includes('..') || decoded.includes('//') || CONTROL_OR_BACKSLASH.test(decoded)) fail(E.RETURN_TO_REFUSED, 'return_to must be a plain internal route');
  if (!allowlist.some((allowed) => path === allowed || path.startsWith(`${allowed}/`))) fail(E.RETURN_TO_REFUSED, 'return_to is not an allowed internal route');
  return value;
}
