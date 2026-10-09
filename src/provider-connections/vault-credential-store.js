// Supabase Vault adapters of ProviderCredentialStore and SessionSecretStore.
//
// Everything goes through the narrow SECURITY DEFINER functions of migration 20261009200000 (provider_vault_*): the application never
// reads vault.decrypted_secrets or vault.secrets directly, never uses the deprecated pgsodium APIs, and never implements cryptography.
// If the Vault (or a function) is unavailable the call fails with PC_VAULT_UNAVAILABLE and NOTHING is written anywhere else: no
// plaintext column, no merchant_connectors.config, no environment fallback.

import { CREDENTIAL_STATUS, PC_ERROR as E } from './constants.js';
import {
  SealedSecret, deepFreeze, fail, iso, isPlainObject, seal, uuid,
} from './validation.js';
import { parseBundle, serializeBundle } from './credential-store.js';

const unavailable = () => fail(E.VAULT_UNAVAILABLE, 'the secret store is unavailable');

function rpcOf(supabase) {
  if (!supabase || typeof supabase.rpc !== 'function') throw new TypeError('the Vault stores need a Supabase client with rpc()');
  return async (fn, args) => {
    try { return await supabase.rpc(fn, args); } catch { return unavailable(); } // the error body may echo parameters: never kept
  };
}

const metadataFrom = (row) => (isPlainObject(row) ? deepFreeze({
  credential_id: row.id, merchant_id: row.merchant_id, connector_id: row.connector_id, provider: row.provider, vault_secret_id: row.vault_secret_id ?? null,
  credential_kind: row.credential_kind, status: row.status, scopes: [...(row.scopes ?? [])], expires_at: row.expires_at ?? null, refreshable: Boolean(row.refreshable),
  issued_at: row.issued_at ?? null, rotation_version: row.rotation_version, refresh_lease_until: row.refresh_lease_until ?? null, created_at: row.created_at, updated_at: row.updated_at,
  rotated_at: row.rotated_at ?? null, revoked_at: row.revoked_at ?? null,
}) : null);

/** @param {{ supabase: { rpc: Function } }} deps */
export function createVaultCredentialStore({ supabase }) {
  const rpc = rpcOf(supabase);
  const ids = (merchantId, connectorId) => ({ p_merchant: uuid(merchantId, 'merchant_id'), p_connector: uuid(connectorId, 'connector_id') });
  const bundleArgs = (tokens) => ({
    p_secret: serializeBundle(tokens), p_scopes: [...tokens.scopes], p_expires_at: tokens.expires_at, p_refreshable: tokens.refreshable, p_issued_at: tokens.issued_at,
  });

  return {
    kind: 'supabase-vault',

    async storeMerchantCredential({ merchantId, connectorId, provider, tokens }) {
      return metadataFrom(await rpc('provider_vault_store', { ...ids(merchantId, connectorId), p_provider: provider, ...bundleArgs(tokens) }));
    },
    async readMetadata({ merchantId, connectorId }) {
      return metadataFrom(await rpc('provider_vault_metadata', ids(merchantId, connectorId)));
    },
    async readMerchantCredential({ merchantId, connectorId }) {
      const out = await rpc('provider_vault_read', ids(merchantId, connectorId));
      if (!out) return null;
      const metadata = metadataFrom(out.metadata);
      if (metadata.status === CREDENTIAL_STATUS.REVOKED || out.secret == null) return { metadata, tokens: null };
      return { metadata, tokens: parseBundle(out.secret) };
    },
    async updateMerchantCredential({ merchantId, connectorId, tokens, expectedVersion }) {
      return metadataFrom(await rpc('provider_vault_rotate', { ...ids(merchantId, connectorId), p_expected_version: expectedVersion, ...bundleArgs(tokens) }));
    },
    async tryAcquireRefreshLease({ merchantId, connectorId, nowIso, leaseMs }) {
      return metadataFrom(await rpc('provider_vault_refresh_lease', { ...ids(merchantId, connectorId), p_now: iso(nowIso, 'now'), p_lease_seconds: Math.ceil(leaseMs / 1000) }));
    },
    async releaseRefreshLease({ merchantId, connectorId }) {
      await rpc('provider_vault_release_lease', ids(merchantId, connectorId));
    },
    async markExpired({ merchantId, connectorId }) {
      return metadataFrom(await rpc('provider_vault_mark_expired', ids(merchantId, connectorId)));
    },
    async revokeMerchantCredential({ merchantId, connectorId }) {
      return metadataFrom(await rpc('provider_vault_revoke', ids(merchantId, connectorId)));
    },
  };
}

/** Vault-backed SessionSecretStore: the PKCE verifier and the pending token bundle live in the Vault, referenced from the session row. */
export function createVaultSessionSecretStore({ supabase, clock = Date.now }) {
  const rpc = rpcOf(supabase);
  const args = (merchantId, sessionId, kind) => ({ p_merchant: uuid(merchantId, 'merchant_id'), p_session: uuid(sessionId, 'session_id'), p_kind: kind });
  const nowIso = () => new Date(clock()).toISOString();
  return {
    kind: 'supabase-vault',
    async put({ merchantId, sessionId, kind, secret }) {
      await rpc('provider_vault_session_put', { ...args(merchantId, sessionId, kind), p_secret: secret instanceof SealedSecret ? secret.reveal() : secret });
    },
    async peek({ merchantId, sessionId, kind }) {
      const value = await rpc('provider_vault_session_peek', { ...args(merchantId, sessionId, kind), p_now: nowIso() });
      return typeof value === 'string' ? seal(value) : null;
    },
    async take({ merchantId, sessionId, kind }) {
      const value = await rpc('provider_vault_session_take', { ...args(merchantId, sessionId, kind), p_now: nowIso() });
      return typeof value === 'string' ? seal(value) : null;
    },
    async delete({ merchantId, sessionId, kind }) {
      await rpc('provider_vault_session_delete', args(merchantId, sessionId, kind));
    },
  };
}
