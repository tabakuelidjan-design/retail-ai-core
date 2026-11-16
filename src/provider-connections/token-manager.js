// ProviderTokenManager: valid credentials on demand, server side only.
//
//   getValidCredential   VALID -> as is · REFRESH -> refresh before it expires · REAUTH -> the merchant must consent again
//   refresh safety       a store-level LEASE (compare-and-set) so two workers never refresh the same connector at once - a refresh token
//                        can ROTATE (TikTok), so a second concurrent refresh could destroy the grant - and the new secret replaces the old
//                        one in one atomic, versioned write
//   REAUTH_REQUIRED      a RUNTIME state (the credential is marked EXPIRED, the connector row is untouched); a temporary outage is
//                        UNAVAILABLE, never MISCONFIGURED
// Refresh thresholds are PER PROVIDER (REFRESH_POLICY), taken from the lifetimes each provider documents.

import {
  CREDENTIAL_STATUS, OAUTH_ERROR, PC_ERROR as E, ProvisioningError, REFRESH_LEASE_MS, REFRESH_POLICY,
} from './constants.js';
import { fail, toMs } from './validation.js';

export const CREDENTIAL_DECISION = Object.freeze({ VALID: 'VALID', REFRESH: 'REFRESH', REAUTH: 'REAUTH' });

/** Pure decision from non-secret metadata: valid, refresh now, or the merchant must re-consent. */
export function decideCredential(metadata, nowMs, policy) {
  if (metadata.status === CREDENTIAL_STATUS.REVOKED) return CREDENTIAL_DECISION.REAUTH;
  if (metadata.status === CREDENTIAL_STATUS.EXPIRED) return CREDENTIAL_DECISION.REAUTH;
  if (!metadata.expires_at) return CREDENTIAL_DECISION.VALID;
  const remaining = (toMs(metadata.expires_at) - nowMs) / 1000;
  const age = metadata.issued_at ? (nowMs - toMs(metadata.issued_at)) / 1000 : Infinity;
  if (remaining <= 0) return metadata.refreshable && age >= policy.min_token_age_seconds ? CREDENTIAL_DECISION.REFRESH : CREDENTIAL_DECISION.REAUTH;
  if (remaining <= policy.refresh_before_seconds) return metadata.refreshable && age >= policy.min_token_age_seconds ? CREDENTIAL_DECISION.REFRESH : CREDENTIAL_DECISION.VALID;
  return CREDENTIAL_DECISION.VALID;
}

/**
 * @param {{ store, oauthAdapters: Record<string, object>, appConfigFor: (provider) => object, clock?: () => number, sleep?: (ms) => Promise<void>,
 *           logger?: Function, policy?: object, leaseMs?: number, waitMs?: number, maxWaits?: number }} deps
 */
export function createProviderTokenManager({
  store, oauthAdapters, appConfigFor, clock = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), logger = () => {}, policy = REFRESH_POLICY,
  leaseMs = REFRESH_LEASE_MS, waitMs = 250, maxWaits = 40,
}) {
  const adapterOf = (provider) => oauthAdapters[provider] ?? fail(E.PROVIDER_UNSUPPORTED, 'this provider has no OAuth adapter');
  const nowIso = () => new Date(clock()).toISOString();
  const log = (event, extra) => logger({ event, ...extra });

  async function refresh({ merchantId, connectorId, provider, force }) {
    const adapter = adapterOf(provider);
    let lease = await store.tryAcquireRefreshLease({ merchantId, connectorId, nowIso: nowIso(), leaseMs });
    for (let i = 0; !lease && i < maxWaits; i += 1) { // another worker is refreshing: wait for its result instead of refreshing twice
      await sleep(waitMs);
      const seen = await store.readMerchantCredential({ merchantId, connectorId });
      if (seen?.tokens && decideCredential(seen.metadata, clock(), policy[provider]) === CREDENTIAL_DECISION.VALID && !force) return { ...seen, refreshed: false };
      lease = await store.tryAcquireRefreshLease({ merchantId, connectorId, nowIso: nowIso(), leaseMs });
    }
    if (!lease) fail(E.REFRESH_IN_PROGRESS, 'another worker is refreshing this credential');
    try {
      const current = await store.readMerchantCredential({ merchantId, connectorId });
      if (!current?.tokens) fail(E.CREDENTIAL_REVOKED, 'the credential was revoked');
      if (!force && decideCredential(current.metadata, clock(), policy[provider]) === CREDENTIAL_DECISION.VALID) return { ...current, refreshed: false }; // refreshed just before we got the lease
      let next;
      try {
        next = await adapter.refreshToken({ appConfig: appConfigFor(provider), tokens: current.tokens });
      } catch (error) {
        if (error instanceof ProvisioningError) throw error;
        const normalized = adapter.normalizeOAuthError(error);
        log('credential.refresh_failed', { merchant_id: merchantId, connector_id: connectorId, provider, safe_code: normalized.safe_provider_code, oauth: normalized.code });
        if (normalized.reauth || normalized.code === OAUTH_ERROR.TOKEN_RESPONSE_INVALID) {
          await store.markExpired({ merchantId, connectorId });
          throw new ProvisioningError(E.REAUTH_REQUIRED, 'the provider no longer accepts this grant: the merchant must connect again', { provider });
        }
        throw new ProvisioningError(E.OAUTH, 'the provider could not refresh the credential right now', { oauth: normalized.code, provider });
      }
      const metadata = await store.updateMerchantCredential({ merchantId, connectorId, tokens: next, expectedVersion: current.metadata.rotation_version });
      if (!metadata) { const winner = await store.readMerchantCredential({ merchantId, connectorId }); return { ...winner, refreshed: false }; }
      log('credential.refreshed', { merchant_id: merchantId, connector_id: connectorId, provider, rotation_version: metadata.rotation_version });
      return { metadata, tokens: next, refreshed: true };
    } finally {
      await store.releaseRefreshLease({ merchantId, connectorId });
    }
  }

  return {
    async getValidCredential({ merchantId, connectorId, provider }) {
      const read = await store.readMerchantCredential({ merchantId, connectorId });
      if (!read) throw new ProvisioningError(E.CREDENTIAL_NOT_FOUND, 'this connector has no credential', { provider });
      if (!read.tokens) throw new ProvisioningError(E.CREDENTIAL_REVOKED, 'this connector was disconnected', { provider });
      const decision = decideCredential(read.metadata, clock(), policy[provider]);
      if (decision === CREDENTIAL_DECISION.VALID) return { ...read, refreshed: false };
      if (decision === CREDENTIAL_DECISION.REAUTH) {
        if (read.metadata.status === CREDENTIAL_STATUS.ACTIVE) await store.markExpired({ merchantId, connectorId });
        throw new ProvisioningError(E.REAUTH_REQUIRED, 'the credential cannot be refreshed: the merchant must connect again', { provider });
      }
      return refresh({ merchantId, connectorId, provider, force: false });
    },

    async refreshIfNeeded(args) { return this.getValidCredential(args); },

    async forceRefresh({ merchantId, connectorId, provider }) {
      const read = await store.readMerchantCredential({ merchantId, connectorId });
      if (!read?.tokens) throw new ProvisioningError(read ? E.CREDENTIAL_REVOKED : E.CREDENTIAL_NOT_FOUND, 'there is no active credential', { provider });
      if (!read.metadata.refreshable) throw new ProvisioningError(E.REAUTH_REQUIRED, 'this credential is not refreshable', { provider });
      return refresh({ merchantId, connectorId, provider, force: true });
    },

    /** Local destruction first (the merchant's intent is honoured whatever the provider answers), then a best-effort provider revoke. */
    async revoke({ merchantId, connectorId, provider }) {
      const read = await store.readMerchantCredential({ merchantId, connectorId });
      if (!read) return { remote: false, local: false, reason: 'NO_CREDENTIAL' };
      let remote = { remote: false, reason: 'NOT_ATTEMPTED' };
      if (read.tokens) {
        const adapter = adapterOf(provider);
        try { remote = await adapter.revoke({ appConfig: appConfigFor(provider), tokens: read.tokens }); } catch (error) {
          remote = { remote: false, reason: adapter.normalizeOAuthError(error).code };
        }
      }
      await store.revokeMerchantCredential({ merchantId, connectorId });
      return { remote: Boolean(remote.remote), local: true, reason: remote.reason ?? null };
    },
  };
}
