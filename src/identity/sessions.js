// Nordla identity - server sessions (ADR 0004, Core C1a). One session = one user, in one merchant, in one module/service.
//
//   token      32 cryptographically random bytes, base64url (43 characters). Returned ONCE by create(); never stored, never logged,
//              never put in an error. Only its SHA-256 (hex) is stored, in app_sessions.token_hash (unique).
//   lifetime   absolute expiry fixed at creation (config.absoluteMs, at most 12 h); inactivity expiry computed from last_seen_at
//              (config.idleMs, 2 h by default).
//   activity   last_seen_at is rewritten at most once per config.touchMs (5 min by default): a validation inside that window
//              reads only, the first validation after it does exactly one write.
//   revocation final and idempotent: a second revocation (or a logout of an already closed session) writes nothing and succeeds.
//
// No cookie, no HTTP route, no Supabase Auth call here (C1b and later). The clock and the random source are injectable for tests.
// Errors are IdentityError with a stable code; their message and detail never contain a token, a token hash or a database message.

import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { loadIdentityConfig } from './config.js';

export const TABLE = 'app_sessions';
export const TOKEN_BYTES = 32;
/** Why a revocation happened. Stored in app_sessions.revoked_reason. */
export const REVOCATION_REASONS = Object.freeze(['LOGOUT', 'LOGOUT_ALL', 'REVOKED']);
/** Why a token was refused by validate(). Internal: a client must always get the same answer whatever the reason. */
export const REFUSAL_REASONS = Object.freeze(['MALFORMED', 'UNKNOWN', 'REVOKED', 'EXPIRED', 'IDLE_EXPIRED', 'WRONG_MERCHANT', 'WRONG_MODULE']);

export const IDENTITY_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  SESSION_STORE_FAILED: 'SESSION_STORE_FAILED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
});

export class IdentityError extends Error {
  /** @param {string} code @param {string} message fixed text, never data @param {object} [detail] non-sensitive context */
  constructor(code, message, detail = {}) { super(message); this.name = 'IdentityError'; this.code = code; this.detail = detail; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE = /^[a-z][a-z0-9_-]{1,39}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/; // base64url of exactly 32 bytes, no padding

const bad = (what) => { throw new IdentityError(IDENTITY_ERROR_CODES.INVALID_ARGUMENT, `${what} is invalid.`, { field: what }); };
const uuid = (v, what) => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad(what));
const moduleName = (v) => (typeof v === 'string' && MODULE.test(v) ? v : bad('module'));

/** SHA-256 (lower-case hex) of a session token: the only form in which a token is ever stored or looked up. */
export const hashSessionToken = (token) => createHash('sha256').update(String(token), 'utf8').digest('hex');

/** A new opaque session token: TOKEN_BYTES random bytes, base64url. */
export function generateSessionToken(randomBytes = cryptoRandomBytes) {
  const bytes = randomBytes(TOKEN_BYTES);
  if (!bytes || bytes.length < TOKEN_BYTES) throw new IdentityError(IDENTITY_ERROR_CODES.INVALID_ARGUMENT, 'The random source returned too few bytes.');
  return Buffer.from(bytes).subarray(0, TOKEN_BYTES).toString('base64url');
}

const iso = (d) => new Date(d).toISOString();
const ms = (v) => new Date(v).getTime();

/** What callers may see of a session row: never the token hash. */
function view(row) {
  return Object.freeze({
    id: row.id, merchantId: row.merchant_id, userId: row.user_id, module: row.module,
    createdAt: iso(row.created_at), lastSeenAt: iso(row.last_seen_at), expiresAt: iso(row.expires_at),
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null, revokedReason: row.revoked_reason ?? null,
  });
}

/**
 * @param {{
 *   supabase: { select: Function, insert: Function, update: Function },
 *   config?: ReturnType<typeof loadIdentityConfig>,
 *   now?: () => Date,
 *   randomBytes?: (n: number) => Buffer,
 * }} deps
 */
export function createSessionStore({ supabase, config = loadIdentityConfig(), now = () => new Date(), randomBytes = cryptoRandomBytes } = {}) {
  if (!supabase || typeof supabase.select !== 'function' || typeof supabase.insert !== 'function' || typeof supabase.update !== 'function') {
    throw new TypeError('createSessionStore needs a Supabase client with select(), insert() and update()');
  }
  // Every database call goes through here: a failure becomes a fixed message (the raw error could quote the query, i.e. the hash).
  const db = async (op, f) => {
    try { return await f(); } catch (e) { throw new IdentityError(IDENTITY_ERROR_CODES.SESSION_STORE_FAILED, `The session store could not ${op}.`, { cause: e?.name ?? 'Error' }); }
  };

  const findByToken = async (token) => {
    const rows = await db('be read', () => supabase.select(TABLE, { select: '*', token_hash: `eq.${hashSessionToken(token)}`, limit: '1' }));
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  };

  /**
   * Low-level insert of a session row (C1a). Since C3 the database refuses a direct INSERT on app_sessions to the service role: a
   * real session is opened only by src/identity/access.js through identity_open_session, which re-checks the membership and the
   * module and journals SESSION_OPENED in the same transaction. Kept for the C1a unit tests of the session rules.
   * Returns the token ONCE and a view of the session.
   * @param {{ userId: string, merchantId: string, module: string }} p
   */
  async function create({ userId, merchantId, module } = {}) {
    const row = { user_id: uuid(userId, 'userId'), merchant_id: uuid(merchantId, 'merchantId'), module: moduleName(module) };
    const token = generateSessionToken(randomBytes);
    const at = now();
    const inserted = await db('be written', () => supabase.insert(TABLE, [{
      ...row, token_hash: hashSessionToken(token), created_at: iso(at), last_seen_at: iso(at), expires_at: iso(at.getTime() + config.absoluteMs),
    }]));
    return { token, session: view(inserted[0]) };
  }

  /** Why a stored session cannot be used at time `t` (null when it can). The absolute expiry wins over inactivity. */
  const refusal = (row, t) => {
    if (row.revoked_at) return 'REVOKED';
    if (t >= ms(row.expires_at)) return 'EXPIRED';
    if (t - ms(row.last_seen_at) >= config.idleMs) return 'IDLE_EXPIRED';
    return null;
  };

  /**
   * Records activity with the write limit: nothing is written when last_seen_at is younger than config.touchMs; otherwise exactly
   * one update (filtered on the session id and "not revoked"). Returns the (possibly refreshed) view.
   * @param {ReturnType<typeof view>} session a view returned by create() or validate()
   */
  async function touch(session) {
    const t = now().getTime();
    if (t - ms(session.lastSeenAt) < config.touchMs) return session;
    const rows = await db('be updated', () => supabase.update(TABLE, { id: `eq.${uuid(session.id, 'sessionId')}`, revoked_at: 'is.null' }, { last_seen_at: iso(t) }));
    return Array.isArray(rows) && rows.length ? view(rows[0]) : session;
  }

  /**
   * Loads and validates a token for THIS merchant and THIS module. One read; at most one write (the activity update above).
   * @param {string} token
   * @param {{ merchantId: string, module: string }} expected what the calling service serves
   * @returns {Promise<{ ok: true, session: object } | { ok: false, reason: string }>} reason is for logs only (REFUSAL_REASONS)
   */
  async function validate(token, { merchantId, module } = {}) {
    const wantMerchant = uuid(merchantId, 'merchantId'); const wantModule = moduleName(module);
    if (typeof token !== 'string' || !TOKEN.test(token)) return { ok: false, reason: 'MALFORMED' };
    const row = await findByToken(token);
    if (!row) return { ok: false, reason: 'UNKNOWN' };
    if (String(row.merchant_id).toLowerCase() !== wantMerchant) return { ok: false, reason: 'WRONG_MERCHANT' };
    if (row.module !== wantModule) return { ok: false, reason: 'WRONG_MODULE' };
    const why = refusal(row, now().getTime());
    if (why) return { ok: false, reason: why };
    return { ok: true, session: await touch(view(row)) };
  }

  /**
   * Revokes one session. Idempotent: an already revoked session is left as it is (its first reason is kept) and nothing is written.
   * @param {string} sessionId @param {{ reason?: string }} [o]
   * @returns {Promise<{ revoked: boolean }>} revoked = true only when this call closed it
   */
  async function revoke(sessionId, { reason = 'REVOKED' } = {}) {
    const id = uuid(sessionId, 'sessionId');
    if (!REVOCATION_REASONS.includes(reason)) bad('reason');
    const rows = await db('be updated', () => supabase.update(TABLE, { id: `eq.${id}`, revoked_at: 'is.null' }, { revoked_at: iso(now()), revoked_reason: reason }));
    return { revoked: Array.isArray(rows) && rows.length > 0 };
  }

  /**
   * « Se déconnecter » : closes the session behind this token in the current module only. Unknown, malformed, other-merchant or
   * other-module tokens and already closed sessions are a no-op (idempotent, nothing written).
   * @returns {Promise<{ revoked: boolean, sessionId: string|null, userId: string|null }>}
   */
  async function logoutCurrent(token, { merchantId, module } = {}) {
    const wantMerchant = uuid(merchantId, 'merchantId'); const wantModule = moduleName(module);
    const none = { revoked: false, sessionId: null, userId: null };
    if (typeof token !== 'string' || !TOKEN.test(token)) return none;
    const row = await findByToken(token);
    if (!row || String(row.merchant_id).toLowerCase() !== wantMerchant || row.module !== wantModule) return none;
    const { revoked } = row.revoked_at ? { revoked: false } : await revoke(row.id, { reason: 'LOGOUT' });
    return { revoked, sessionId: row.id, userId: row.user_id };
  }

  /**
   * « Se déconnecter partout » : revokes every still-active session of this user - all merchants, all modules - in one update.
   * Other users are untouched. Idempotent: a second call finds nothing to revoke.
   * @returns {Promise<{ revoked: number }>}
   */
  async function logoutEverywhere(userId) {
    const id = uuid(userId, 'userId');
    const rows = await db('be updated', () => supabase.update(TABLE, { user_id: `eq.${id}`, revoked_at: 'is.null' }, { revoked_at: iso(now()), revoked_reason: 'LOGOUT_ALL' }));
    return { revoked: Array.isArray(rows) ? rows.length : 0 };
  }

  return Object.freeze({ create, validate, touch, revoke, logoutCurrent, logoutEverywhere });
}
