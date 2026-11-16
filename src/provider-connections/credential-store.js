// ProviderCredentialStore: the ONLY place a merchant's provider credentials (access / refresh tokens) live, plus the SessionSecretStore
// for the two short-lived secrets of an OAuth flow (the PKCE verifier and the tokens waiting for the merchant's explicit target choice).
//
// Production design: SUPABASE VAULT (vault-credential-store.js). The database keeps METADATA only (connector_credentials: a vault_secret_id,
// scopes, expiry, refreshable, status...), never a token. There is no home-grown cryptography here and no fallback to plaintext or to
// merchant_connectors.config: when the Vault is unavailable the store raises PC_VAULT_UNAVAILABLE and nothing is written.
//
// This module holds the contract, the token bundle and an IN-MEMORY fake for tests. A fake is NOT proof of production.

import { CREDENTIAL_KIND, CREDENTIAL_STATUS, PC_ERROR as E } from './constants.js';
import {
  SealedSecret, deepFreeze, fail, isPlainObject, iso, seal, sortedUnique, toMs, uuid,
} from './validation.js';

// ------------------------------------------------------------------ token bundle (sealed in memory)
/** @returns the bundle with sealed secrets; its JSON form exists only inside a store boundary (serializeBundle). */
export function makeTokenBundle({
  accessToken, refreshToken = null, expiresAt = null, scopes = [], refreshable = null, externalUserId = null, issuedAt,
}) {
  if (typeof accessToken !== 'string' && !(accessToken instanceof SealedSecret)) fail(E.INVALID_FIELD, 'a token bundle needs an access token');
  return deepFreeze({
    access_token: seal(accessToken instanceof SealedSecret ? accessToken.reveal() : accessToken),
    refresh_token: refreshToken ? seal(refreshToken instanceof SealedSecret ? refreshToken.reveal() : refreshToken) : null,
    expires_at: expiresAt == null ? null : iso(expiresAt, 'expires_at'),
    scopes: sortedUnique(scopes),
    refreshable: refreshable == null ? Boolean(refreshToken) : Boolean(refreshable),
    external_user_id: externalUserId == null ? null : String(externalUserId),
    issued_at: iso(issuedAt, 'issued_at'),
  });
}

/** Store boundary only: the plaintext JSON handed to the Vault (never logged, never persisted outside it). */
export const serializeBundle = (bundle) => JSON.stringify({
  access_token: bundle.access_token.reveal(),
  refresh_token: bundle.refresh_token ? bundle.refresh_token.reveal() : null,
  expires_at: bundle.expires_at,
  scopes: bundle.scopes,
  refreshable: bundle.refreshable,
  external_user_id: bundle.external_user_id,
  issued_at: bundle.issued_at,
});

export function parseBundle(json) {
  let raw;
  try { raw = JSON.parse(json); } catch { fail(E.VAULT_UNAVAILABLE, 'the stored credential could not be read'); }
  if (!isPlainObject(raw) || typeof raw.access_token !== 'string') fail(E.VAULT_UNAVAILABLE, 'the stored credential is malformed');
  return makeTokenBundle({
    accessToken: raw.access_token, refreshToken: raw.refresh_token, expiresAt: raw.expires_at, scopes: raw.scopes ?? [], refreshable: raw.refreshable,
    externalUserId: raw.external_user_id, issuedAt: raw.issued_at,
  });
}

/** The non-secret metadata row (connector_credentials). */
// the fields derived from the bundle always win over the previous row (a rotation must update expiry, scopes and issue time)
export const metadataOf = (bundle, extra) => deepFreeze({
  ...extra, credential_kind: CREDENTIAL_KIND.OAUTH_TOKENS, scopes: [...bundle.scopes], expires_at: bundle.expires_at, refreshable: bundle.refreshable, issued_at: bundle.issued_at,
});

// ------------------------------------------------------------------ in-memory fake (tests / sandboxes only)
/**
 * @param {{ lookupConnector: (connectorId) => ({merchantId, kind}|null), clock?: () => number, failWith?: string|null }} deps
 */
export function createInMemoryCredentialStore({ lookupConnector, clock = Date.now, failWith = null } = {}) {
  if (typeof lookupConnector !== 'function') throw new TypeError('the fake store needs a connector lookup (merchant / connector ownership is enforced)');
  const rows = new Map(); // connector_id -> metadata
  const secrets = new Map(); // vault_secret_id -> JSON string (the fake Vault)
  let counter = 0;
  const guard = () => { if (failWith) fail(E.VAULT_UNAVAILABLE, 'the secret store is unavailable'); };
  const nowIso = () => new Date(clock()).toISOString();

  function owner(merchantId, connectorId, provider) {
    const connector = lookupConnector(uuid(connectorId, 'connector_id'));
    if (!connector || connector.merchantId.toLowerCase() !== uuid(merchantId, 'merchant_id')) fail(E.CREDENTIAL_SCOPE_MISMATCH, 'the connector does not belong to this merchant');
    if (provider !== undefined && connector.kind !== provider) fail(E.CREDENTIAL_SCOPE_MISMATCH, 'the connector is not of this provider');
    return connector;
  }

  const store = {
    kind: 'in-memory-fake',
    _rows: rows,
    _secrets: secrets,

    async storeMerchantCredential({ merchantId, connectorId, provider, tokens }) {
      guard();
      owner(merchantId, connectorId, provider);
      const existing = rows.get(connectorId);
      if (existing && existing.status !== CREDENTIAL_STATUS.REVOKED) fail(E.SESSION_STATE_CONFLICT, 'this connector already has an active credential: rotate it instead');
      counter += 1;
      const vaultId = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
      secrets.set(vaultId, serializeBundle(tokens));
      const row = metadataOf(tokens, {
        credential_id: `c0000000-0000-4000-8000-${String(counter).padStart(12, '0')}`, merchant_id: merchantId, connector_id: connectorId, provider, vault_secret_id: vaultId,
        status: CREDENTIAL_STATUS.ACTIVE, rotation_version: 1, refresh_lease_until: null, created_at: nowIso(), updated_at: nowIso(), rotated_at: null, revoked_at: null,
      });
      rows.set(connectorId, row);
      return row;
    },

    async readMetadata({ merchantId, connectorId }) {
      guard();
      owner(merchantId, connectorId);
      return rows.get(connectorId) ?? null;
    },

    /** { metadata, tokens } - tokens is null for a REVOKED credential. null when the connector has none. */
    async readMerchantCredential({ merchantId, connectorId }) {
      guard();
      owner(merchantId, connectorId);
      const row = rows.get(connectorId);
      if (!row) return null;
      if (row.status === CREDENTIAL_STATUS.REVOKED) return { metadata: row, tokens: null };
      return { metadata: row, tokens: parseBundle(secrets.get(row.vault_secret_id)) };
    },

    /** Rotation: replaces the secret atomically; null when `expectedVersion` is stale (someone else rotated first). */
    async updateMerchantCredential({ merchantId, connectorId, tokens, expectedVersion }) {
      guard();
      owner(merchantId, connectorId);
      const row = rows.get(connectorId);
      if (!row || row.status === CREDENTIAL_STATUS.REVOKED) fail(E.CREDENTIAL_REVOKED, 'there is no active credential to rotate');
      if (row.rotation_version !== expectedVersion) return null;
      secrets.set(row.vault_secret_id, serializeBundle(tokens));
      const next = metadataOf(tokens, {
        ...row, status: CREDENTIAL_STATUS.ACTIVE, rotation_version: row.rotation_version + 1, refresh_lease_until: null, updated_at: nowIso(), rotated_at: nowIso(),
      });
      rows.set(connectorId, next);
      return next;
    },

    /** Atomic anti-double-refresh lease (a second worker gets null). */
    async tryAcquireRefreshLease({ merchantId, connectorId, nowIso: at, leaseMs }) {
      guard();
      owner(merchantId, connectorId);
      const row = rows.get(connectorId);
      if (!row || row.status === CREDENTIAL_STATUS.REVOKED) return null;
      if (row.refresh_lease_until && toMs(row.refresh_lease_until) > toMs(at)) return null;
      const next = deepFreeze({ ...row, refresh_lease_until: new Date(toMs(at) + leaseMs).toISOString() });
      rows.set(connectorId, next);
      return next;
    },
    async releaseRefreshLease({ merchantId, connectorId }) {
      guard();
      owner(merchantId, connectorId);
      const row = rows.get(connectorId);
      if (row) rows.set(connectorId, deepFreeze({ ...row, refresh_lease_until: null }));
    },

    async markExpired({ merchantId, connectorId }) {
      guard();
      owner(merchantId, connectorId);
      const row = rows.get(connectorId);
      if (!row || row.status === CREDENTIAL_STATUS.REVOKED) return row ?? null;
      const next = deepFreeze({ ...row, status: CREDENTIAL_STATUS.EXPIRED, updated_at: nowIso() });
      rows.set(connectorId, next);
      return next;
    },

    /** The secret is destroyed; the metadata row stays as technical history. */
    async revokeMerchantCredential({ merchantId, connectorId }) {
      guard();
      owner(merchantId, connectorId);
      const row = rows.get(connectorId);
      if (!row) return null;
      secrets.delete(row.vault_secret_id);
      const next = deepFreeze({ ...row, status: CREDENTIAL_STATUS.REVOKED, revoked_at: nowIso(), updated_at: nowIso(), refresh_lease_until: null });
      rows.set(connectorId, next);
      return next;
    },
  };
  return store;
}

/** In-memory SessionSecretStore: one secret per (merchant, session, kind), single reader on `take`, with a TTL. */
export function createInMemorySessionSecretStore({ clock = Date.now, failWith = null } = {}) {
  const entries = new Map();
  const key = (merchantId, sessionId, kind) => `${merchantId}:${sessionId}:${kind}`;
  const guard = () => { if (failWith) fail(E.VAULT_UNAVAILABLE, 'the secret store is unavailable'); };
  return {
    kind: 'in-memory-fake',
    _entries: entries,
    async put({ merchantId, sessionId, kind, secret, ttlMs }) {
      guard();
      entries.set(key(merchantId, sessionId, kind), { secret: secret instanceof SealedSecret ? secret.reveal() : secret, expiresAt: clock() + ttlMs });
    },
    async peek({ merchantId, sessionId, kind }) {
      guard();
      const entry = entries.get(key(merchantId, sessionId, kind));
      if (!entry || entry.expiresAt <= clock()) return null;
      return seal(entry.secret);
    },
    /** Read and destroy in one step. */
    async take({ merchantId, sessionId, kind }) {
      guard();
      const k = key(merchantId, sessionId, kind);
      const entry = entries.get(k);
      entries.delete(k);
      if (!entry || entry.expiresAt <= clock()) return null;
      return seal(entry.secret);
    },
    async delete({ merchantId, sessionId, kind }) { guard(); entries.delete(key(merchantId, sessionId, kind)); },
  };
}
