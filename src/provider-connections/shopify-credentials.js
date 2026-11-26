// Per-merchant Shopify credentials for server-side readers (sync, Finance, reports). The merchant is the one the CALLER resolved from its
// authenticated Nordla context (never from request data, never from a Shopify shop). The shop and the token come from that merchant's own
// Shopify connector (provisioned through OAuth) and its Vault credential. Nothing here falls back to another merchant's connector.
import { normalizeShopDomain, SHOPIFY_READ_SCOPES } from './providers/shopify-oauth.js';
import { PC_ERROR } from './constants.js';

const PROVIDER = 'shopify';
// The codes the token manager raises when the merchant must connect again (values from PC_ERROR, e.g. PC_REAUTH_REQUIRED).
const OAUTH_REFUSALS = new Set([PC_ERROR.REAUTH_REQUIRED, PC_ERROR.CREDENTIAL_REVOKED, PC_ERROR.CREDENTIAL_NOT_FOUND]);

/**
 * @param {{ connectorRepository: { listForMerchant(merchantId: string): Promise<object[]> }, tokenManager: { getValidCredential(args: object): Promise<object> }, apiVersion?: string }} deps
 * @returns {(merchantId: string) => Promise<object>} one of
 *   { state: 'NOT_CONNECTED' }                 this merchant has no OAuth Shopify connector (the caller may use the global setup)
 *   { state: 'CONFIGURED', connectorId, shopDomain, apiVersion, accessToken }   server-side only: accessToken must never be logged or returned
 *   { state: 'AMBIGUOUS' | 'NOT_CONFIGURED' | 'MISCONFIGURED' | 'MISSING_SCOPES' | 'REAUTH_REQUIRED' | 'UNAVAILABLE', connectorId?, reason? }
 */
export function createShopifyCredentialResolver({ connectorRepository, tokenManager = null, tokenManagerFor = null, apiVersion = '2024-10' }) {
  if (!connectorRepository || (!tokenManager && !tokenManagerFor)) throw new TypeError('createShopifyCredentialResolver needs a connector repository and a token manager (or a factory for it)');
  // Built only when this merchant really has an OAuth Shopify connection: merchants without one never touch the Vault.
  const manager = () => tokenManager ?? tokenManagerFor();
  const credentialsFor = async function shopifyCredentialsFor(merchantId) {
    const all = await connectorRepository.listForMerchant(merchantId);
    const own = all.filter((c) => c.kind === PROVIDER && c.config?.provisioned_via === 'oauth');
    if (own.length === 0) return { state: 'NOT_CONNECTED' };
    if (own.length > 1) return { state: 'AMBIGUOUS', reason: 'SEVERAL_SHOPIFY_CONNECTIONS' }; // never pick one silently
    const connector = own[0];
    if (connector.status !== 'CONFIGURED') return { state: 'NOT_CONFIGURED', connectorId: connector.id, reason: `CONNECTOR_STATUS_${connector.status}` };
    const shopDomain = normalizeShopDomain(connector.config?.shop_domain);
    if (!shopDomain) return { state: 'MISCONFIGURED', connectorId: connector.id, reason: 'SHOP_DOMAIN' };
    let credential;
    try {
      credential = await manager().getValidCredential({ merchantId, connectorId: connector.id, provider: PROVIDER }); // refreshes when near expiry
    } catch (error) {
      const code = error?.code ?? 'ERROR';
      if (code === PC_ERROR.APP_MISCONFIGURED) return { state: 'MISCONFIGURED', connectorId: connector.id, reason: 'APP_SECRET_REJECTED' };
      return OAUTH_REFUSALS.has(code) ? { state: 'REAUTH_REQUIRED', connectorId: connector.id, reason: 'REAUTH_REQUIRED' } : { state: 'UNAVAILABLE', connectorId: connector.id, reason: code };
    }
    // The scopes that are ACTUALLY on the token decide, not what was requested earlier.
    const granted = new Set(credential.tokens?.scopes ?? []);
    const missing = SHOPIFY_READ_SCOPES.filter((s) => !granted.has(s));
    if (missing.length) return { state: 'MISSING_SCOPES', connectorId: connector.id, reason: 'SCOPE_MISSING' };
    const access = credential.tokens?.access_token;
    const accessToken = typeof access?.reveal === 'function' ? access.reveal() : access;
    if (typeof accessToken !== 'string' || !accessToken) return { state: 'REAUTH_REQUIRED', connectorId: connector.id, reason: 'NO_ACCESS_TOKEN' };
    return Object.freeze({ state: 'CONFIGURED', merchantId, connectorId: connector.id, shopDomain, apiVersion, accessToken, grantedScopes: [...granted] });
  };

  /**
   * Silent renewal after Shopify refused the access token: ONE refresh through the token manager (single-flight: a lease shared by
   * every worker), then the credential is read again. A refused refresh grant is REAUTH_REQUIRED; a rejected app secret is
   * MISCONFIGURED; any other failure is UNAVAILABLE (an outage, never a reconnection request).
   */
  credentialsFor.renew = async function renewShopifyCredential(merchantId) {
    const first = await credentialsFor(merchantId);
    if (first.state !== 'CONFIGURED') return first;
    const mgr = manager();
    try {
      await mgr.forceRefresh({ merchantId, connectorId: first.connectorId, provider: PROVIDER });
    } catch (error) {
      const code = error?.code ?? 'ERROR';
      if (code === PC_ERROR.APP_MISCONFIGURED) return { state: 'MISCONFIGURED', connectorId: first.connectorId, reason: 'APP_SECRET_REJECTED' };
      return OAUTH_REFUSALS.has(code) ? { state: 'REAUTH_REQUIRED', connectorId: first.connectorId, reason: 'REAUTH_REQUIRED' } : { state: 'UNAVAILABLE', connectorId: first.connectorId, reason: code };
    }
    return credentialsFor(merchantId);
  };
  return credentialsFor;
}
