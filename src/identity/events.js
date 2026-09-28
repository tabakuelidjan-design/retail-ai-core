// Nordla identity - append-only security journal (ADR 0004, Core C1a; table identity_events).
//
// Only technical identifiers describe the actor (user_id, session_id): never an e-mail address. The free `detail` object is checked
// recursively (objects and arrays, keys compared case-insensitively) and refused when it carries anything credential-like or an
// e-mail address. Errors name the PATH of what was refused, never its value. This module only inserts: the journal cannot be
// updated or deleted (enforced by the database, see the migration).

import { randomUUID as cryptoRandomUUID } from 'node:crypto';

export const TABLE = 'identity_events';

/** Known event types (ADR 0004 section 2.2). A new type is added here, deliberately. */
export const EVENT_TYPES = Object.freeze([
  'LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'LOGOUT', 'LOGOUT_ALL', 'SESSION_CREATED', 'SESSION_EXPIRED', 'SESSION_REVOKED', 'ACCESS_DENIED',
  'ACCOUNT_CREATED', 'MEMBER_ADDED', 'ROLE_CHANGED', 'MEMBER_SUSPENDED', 'MODULE_ENABLED', 'MODULE_DISABLED',
  'MFA_ENROLLED', 'MFA_CHALLENGE_FAILED', 'RATE_LIMITED',
  // Core C1b - identity verification only (no Nordla session is created by these)
  'AUTH_SUCCEEDED', 'AUTH_FAILED', 'AUTH_RATE_LIMITED', 'AUTH_UNAVAILABLE',
]);
export const OUTCOMES = Object.freeze(['SUCCESS', 'FAILURE', 'DENIED']);

export const EVENT_ERROR_CODES = Object.freeze({
  EVENT_INVALID: 'EVENT_INVALID',
  EVENT_DETAIL_FORBIDDEN: 'EVENT_DETAIL_FORBIDDEN',
  EVENT_STORE_FAILED: 'EVENT_STORE_FAILED',
});

export class IdentityEventError extends Error {
  /** @param {string} code @param {string} message fixed text, never data @param {object} [detail] e.g. { field } or { paths } */
  constructor(code, message, detail = {}) { super(message); this.name = 'IdentityEventError'; this.code = code; this.detail = detail; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE = /^[a-z][a-z0-9_-]{1,39}$/;
const ENTITY_TYPE = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_DETAIL_BYTES = 4096;
const MAX_DEPTH = 6;

// A key whose normalised name (lower case, letters and digits only) contains one of these is refused, at any depth.
const FORBIDDEN_KEY_PARTS = ['password', 'passwd', 'passphrase', 'secret', 'token', 'cookie', 'apikey', 'authorization', 'bearer', 'credential', 'privatekey', 'email', 'mail'];
// A value that looks like one of these is refused whatever its key is called (checked on every string, at any depth).
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i;
const FORBIDDEN_VALUES = [
  EMAIL,
  /^bearer\s+\S/i, // an authorization header
  /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/, // a JWT (e.g. a Supabase access token)
  /^shp(at|ss|ca|pa)_/i, // a Shopify token
  /^sk_(live|test)_/i, // a payment secret key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // a private key
  /^[A-Za-z0-9_-]{43}$/, // the shape of a Nordla session token (32 bytes, base64url)
  /^[0-9a-f]{64}$/i, // a SHA-256 / 256-bit key in hex (e.g. a session token hash)
];

/** Paths (never values) of every key or string in `value` that must not be journalled. */
export function findForbiddenPaths(value, path = '', depth = 0) {
  const out = [];
  if (depth > MAX_DEPTH) { out.push(path || '(root)'); return out; }
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...findForbiddenPaths(v, `${path}[${i}]`, depth + 1)));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      const norm = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (FORBIDDEN_KEY_PARTS.some((s) => norm.includes(s))) out.push(p);
      else out.push(...findForbiddenPaths(v, p, depth + 1));
    }
  } else if (typeof value === 'string' && FORBIDDEN_VALUES.some((re) => re.test(value.trim()))) out.push(path || '(value)');
  return out;
}

const invalid = (field) => { throw new IdentityEventError(EVENT_ERROR_CODES.EVENT_INVALID, `The event field "${field}" is invalid.`, { field }); };
const optUuid = (v, field) => (v === undefined || v === null ? null : typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : invalid(field));

/** Validates an event and returns the row to insert (throws IdentityEventError). Pure. */
export function buildEventRow({ merchantId, userId = null, sessionId = null, module, type, outcome, correlationId, entity = null, detail = {} } = {}, { newId = cryptoRandomUUID } = {}) {
  const row = {
    merchant_id: typeof merchantId === 'string' && UUID.test(merchantId) ? merchantId.toLowerCase() : invalid('merchantId'),
    user_id: optUuid(userId, 'userId'),
    session_id: optUuid(sessionId, 'sessionId'),
    module: typeof module === 'string' && MODULE.test(module) ? module : invalid('module'),
    event_type: EVENT_TYPES.includes(type) ? type : invalid('type'),
    outcome: OUTCOMES.includes(outcome) ? outcome : invalid('outcome'),
    correlation_id: correlationId === undefined || correlationId === null ? newId() : optUuid(correlationId, 'correlationId'),
    entity_type: null,
    entity_id: null,
  };
  if (entity !== null && entity !== undefined) {
    if (typeof entity !== 'object' || !ENTITY_TYPE.test(String(entity.type ?? ''))) invalid('entity.type');
    const id = entity.id;
    if (typeof id !== 'string' || id.trim() === '' || id.length > 200) invalid('entity.id');
    if (findForbiddenPaths(id).length) throw new IdentityEventError(EVENT_ERROR_CODES.EVENT_DETAIL_FORBIDDEN, 'The event entity must be a technical identifier.', { paths: ['entity.id'] });
    row.entity_type = entity.type; row.entity_id = id;
  }
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) invalid('detail');
  let json;
  try { json = JSON.stringify(detail); } catch { invalid('detail'); }
  if (Buffer.byteLength(json, 'utf8') > MAX_DETAIL_BYTES) throw new IdentityEventError(EVENT_ERROR_CODES.EVENT_INVALID, `The event detail is larger than ${MAX_DETAIL_BYTES} bytes.`, { field: 'detail' });
  const copy = JSON.parse(json);
  const paths = findForbiddenPaths(copy);
  if (paths.length) throw new IdentityEventError(EVENT_ERROR_CODES.EVENT_DETAIL_FORBIDDEN, 'The event detail contains data that must never be journalled (credential or e-mail address).', { paths });
  row.detail = copy;
  return row;
}

/**
 * @param {{ supabase: { insert: Function }, now?: () => Date, newId?: () => string }} deps
 */
export function createEventLog({ supabase, now = () => new Date(), newId = cryptoRandomUUID } = {}) {
  if (!supabase || typeof supabase.insert !== 'function') throw new TypeError('createEventLog needs a Supabase client with insert()');
  /**
   * Appends one event. Returns { id, correlationId }.
   * @param {Parameters<typeof buildEventRow>[0]} event
   */
  async function record(event) {
    const row = { ...buildEventRow(event, { newId }), occurred_at: now().toISOString() };
    let rows;
    try { rows = await supabase.insert(TABLE, [row]); } catch (e) {
      throw new IdentityEventError(EVENT_ERROR_CODES.EVENT_STORE_FAILED, 'The security journal could not be written.', { cause: e?.name ?? 'Error' });
    }
    return { id: rows?.[0]?.id ?? null, correlationId: row.correlation_id };
  }
  return Object.freeze({ record });
}
