// ProviderOAuthSession: the server-side record of ONE authorization request (CSRF state + optional PKCE), and its repository.
//
//   state        32 random bytes (base64url); only its SHA-256 is persisted; single use (PENDING -> AUTHORIZED is a compare-and-set);
//                short-lived; bound to (merchant, provider)
//   PKCE         an S256 challenge is stored; the raw verifier is a sealed secret kept in the SessionSecretStore (Vault), never in the table
//   never stored in plaintext anywhere: the raw state, the PKCE verifier, the authorization code, any token
//   return_to    an internal route from an allowlist (no open redirect)

import {
  OAUTH_SESSION_STATUS as S, PC_ERROR as E, SESSION_TTL_MS,
} from './constants.js';
import {
  assertNoSecrets, deepFreeze, fail, iso, pkceChallengeOf, randomToken, safeReturnTo, seal, sha256Hex, toMs, uuid,
} from './validation.js';

const TABLE = 'provider_oauth_sessions';

function redirectUriOf(value) {
  let url;
  try { url = new URL(value); } catch { fail(E.INVALID_FIELD, 'the redirect URI is not a URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.hash || url.search || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) fail(E.INVALID_FIELD, 'the redirect URI must be https (http only on localhost) without a query or a fragment');
  return value;
}

/**
 * @returns {{ session: object, state: SealedSecret, pkceVerifier: SealedSecret|null }} `session` is the row to insert (no secret);
 *          `state` goes into the authorization URL only; `pkceVerifier` goes to the SessionSecretStore only.
 */
export function buildOAuthSession({
  merchantId, provider, redirectUri, descriptor, returnTo = null, returnToAllowlist, actorRef = null, nowMs, ttlMs = SESSION_TTL_MS, rng,
}) {
  const state = randomToken(rng);
  const verifier = descriptor.uses_pkce ? randomToken(rng, 48) : null;
  const session = {
    merchant_id: uuid(merchantId, 'merchant_id'),
    provider,
    state_hash: sha256Hex(state),
    pkce_challenge: verifier ? pkceChallengeOf(verifier) : null,
    redirect_uri: redirectUriOf(redirectUri),
    requested_scopes: [...descriptor.minimum_scopes],
    status: S.PENDING,
    return_to: safeReturnTo(returnTo, returnToAllowlist),
    actor_ref: actorRef == null ? null : String(actorRef).slice(0, 200),
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + ttlMs).toISOString(),
  };
  assertNoSecrets(session, 'oauth session');
  return { session, state: seal(state), pkceVerifier: verifier ? seal(verifier) : null };
}

const fromRow = (r) => deepFreeze({
  id: r.id, merchant_id: r.merchant_id, provider: r.provider, state_hash: r.state_hash, pkce_challenge: r.pkce_challenge ?? null, redirect_uri: r.redirect_uri,
  requested_scopes: [...(r.requested_scopes ?? [])], status: r.status, return_to: r.return_to ?? null, actor_ref: r.actor_ref ?? null, created_at: r.created_at,
  expires_at: r.expires_at, authorized_at: r.authorized_at ?? null, completed_at: r.completed_at ?? null, bound_connector_id: r.bound_connector_id ?? null, failure_code: r.failure_code ?? null,
});

/** @param {{ supabase: { select: Function, insert: Function, update: Function, rpc?: Function } }} deps */
export function createOAuthSessionRepository({ supabase }) {
  if (!supabase || typeof supabase.select !== 'function') throw new TypeError('createOAuthSessionRepository needs a Supabase client');
  const store = (what, fn) => fn().catch(() => fail(E.VAULT_UNAVAILABLE, `${what} failed`));

  async function cas(merchantId, id, fromStatuses, patch) {
    const filter = { id: `eq.${uuid(id, 'session_id')}`, merchant_id: `eq.${uuid(merchantId, 'merchant_id')}`, status: fromStatuses.length === 1 ? `eq.${fromStatuses[0]}` : `in.(${fromStatuses.join(',')})` };
    assertNoSecrets(patch, 'oauth session update');
    const rows = await store('the session update', () => supabase.update(TABLE, filter, patch));
    return rows && rows.length ? fromRow(rows[0]) : null; // null = lost the race (already consumed / finished)
  }

  return {
    async create(session) {
      assertNoSecrets(session, 'oauth session');
      const rows = await store('the session insert', () => supabase.insert(TABLE, [session]));
      return fromRow(rows[0]);
    },
    /** Lookup by the HASH of the state, inside the server-side merchant: the callback can never address another merchant's session. */
    async findByStateHash({ merchantId, stateHash }) {
      const rows = await store('the session read', () => supabase.select(TABLE, { select: '*', merchant_id: `eq.${uuid(merchantId, 'merchant_id')}`, state_hash: `eq.${stateHash}`, limit: '1' }));
      return rows.length ? fromRow(rows[0]) : null;
    },
    async getById({ merchantId, id }) {
      const rows = await store('the session read', () => supabase.select(TABLE, { select: '*', merchant_id: `eq.${uuid(merchantId, 'merchant_id')}`, id: `eq.${uuid(id, 'session_id')}`, limit: '1' }));
      return rows.length ? fromRow(rows[0]) : null;
    },
    /** Single use: PENDING -> AUTHORIZED exactly once. A replay gets null. */
    authorize: ({ merchantId, id, nowIso }) => cas(merchantId, id, [S.PENDING], { status: S.AUTHORIZED, authorized_at: iso(nowIso, 'now') }),
    markBound: ({ merchantId, id, connectorId, nowIso }) => cas(merchantId, id, [S.AUTHORIZED], { status: S.BOUND, bound_connector_id: connectorId, completed_at: iso(nowIso, 'now') }),
    markFailed: ({ merchantId, id, code, nowIso }) => cas(merchantId, id, [S.PENDING, S.AUTHORIZED], { status: S.FAILED, failure_code: String(code).replace(/[^A-Z_]/g, '').slice(0, 40) || 'UNKNOWN', completed_at: iso(nowIso, 'now') }),
    markExpired: ({ merchantId, id, nowIso }) => cas(merchantId, id, [S.PENDING, S.AUTHORIZED], { status: S.EXPIRED, completed_at: iso(nowIso, 'now') }),
    /** Removes expired, never-bound sessions (and their Vault secrets, inside the database function). */
    async cleanupExpired({ nowIso }) {
      if (typeof supabase.rpc !== 'function') return 0;
      return store('the session cleanup', () => supabase.rpc('provider_oauth_cleanup', { p_now: iso(nowIso, 'now') }));
    },
    isExpired: (session, nowMs) => toMs(session.expires_at) <= nowMs,
  };
}
