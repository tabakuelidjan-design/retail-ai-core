// Shopify OAuth provisioning, per merchant. The merchant gives its own *.myshopify.com domain, Nordla sends it to the install screen of
// THAT shop, and the access token returned for that shop is stored in Vault for that merchant only. Nothing here reads a shop from the
// environment: the app's client id and secret identify the Nordla app, never a store.
//
// Flow (Shopify "authorization code grant", offline access token):
//   authorize   https://{shop}/admin/oauth/authorize?client_id&scope&redirect_uri&state
//   callback    Shopify sends code, state, shop, hmac, host, timestamp. The hmac is verified (HMAC-SHA256 with the app secret, over the
//               sorted query without hmac/signature) before anything else; the shop must be a *.myshopify.com domain.
//   exchange    POST https://{shop}/admin/oauth/access_token  { client_id, client_secret, code }  -> { access_token, scope }
//   identify    POST https://{shop}/admin/api/{version}/graphql.json  (X-Shopify-Access-Token)  shop { id name myshopifyDomain }
// Offline tokens do not expire on their own: there is no refresh. A merchant removes the app in the Shopify admin (no remote revoke here).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { OAUTH_ERROR } from '../constants.js';
import { deepFreeze } from '../validation.js';
import { SHOP_QUERY } from '../../shopify/queries.js';
import { OAuthFailure, bundleFromResponse, oauthRequest, parseScopes } from './common.js';

const SHOPIFY_PROVIDER = 'shopify';
// The shop domain travels with the token bundle (not secret) so a refresh goes back to the SAME shop.
const withShop = (bundle, shop) => deepFreeze({ ...bundle, shop_domain: shop });

/** Read-only scopes for sales, catalogue, inventory and locations. Customer scopes are NOT requested (see docs/security/shopify-auth.md). */
export const SHOPIFY_READ_SCOPES = Object.freeze(['read_orders', 'read_products', 'read_inventory', 'read_locations']);
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,99}\.myshopify\.com$/;
const DEFAULT_API_VERSION = '2024-10';

/** The *.myshopify.com domain of a shop, lower-case, or null. Anything else (custom domains, URLs, look-alikes) is refused. */
export function normalizeShopDomain(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return SHOP_DOMAIN.test(v) ? v : null;
}

/**
 * Shopify HMAC of a callback query: sorted keys (without hmac and signature), `key=value` joined by `&`, `&` and `%` escaped in values.
 * @param {Record<string, string>} query the decoded query parameters the callback carried
 */
// The app secret may arrive sealed (SealedSecret from the settings loader): it is revealed only here, for the HMAC.
const plain = (value) => (typeof value?.reveal === 'function' ? value.reveal() : value);

export function shopifyCallbackHmac(query, clientSecret) {
  const message = Object.keys(query).filter((k) => k !== 'hmac' && k !== 'signature').sort()
    .map((k) => `${k}=${String(query[k]).replace(/%/g, '%25').replace(/&/g, '%26')}`).join('&');
  return createHmac('sha256', plain(clientSecret)).update(message).digest('hex');
}

/** True when the callback's hmac matches the app secret (constant-time compare). A missing or malformed hmac is false. */
export function verifyShopifyCallback(query, clientSecret) {
  if (typeof query?.hmac !== 'string' || !/^[0-9a-f]{64}$/i.test(query.hmac) || !plain(clientSecret)) return false;
  const expected = Buffer.from(shopifyCallbackHmac(query, clientSecret), 'hex');
  const given = Buffer.from(query.hmac.toLowerCase(), 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * @param {{ http: Function, timeoutMs?: number, now?: () => number, scopes?: string[], apiVersion?: string }} options
 *   `http` is the injected, timeout-bounded HTTP function of the provider connections runtime (never a raw fetch here).
 */
export function createShopifyOAuth({ http, timeoutMs, now = Date.now, scopes = SHOPIFY_READ_SCOPES, apiVersion = DEFAULT_API_VERSION } = {}) {
  // The code exchange (connect) and identification keep their classification: a refused code means the merchant must connect again.
  const classifyConnect = (r) => {
    const grantRefused = r.status === 401 || r.status === 403 || (r.status === 400 && r.body?.error === 'invalid_grant');
    return grantRefused ? { code: OAUTH_ERROR.CODE_EXCHANGE_FAILED, reauth: true, safeCode: 'GRANT_REFUSED' } : { code: OAUTH_ERROR.CODE_EXCHANGE_FAILED, reauth: false, safeCode: 'REJECTED' };
  };
  // The refresh of an existing grant is classified strictly: 400 invalid_grant = the merchant's refresh grant is gone (reconnection);
  // 401 invalid_client = the Nordla app secret is rejected (configuration, never a merchant state); anything else is transient.
  const classifyRefresh = (r) => {
    if (r.status === 401 && r.body?.error === 'invalid_client') return { code: OAUTH_ERROR.APP_MISCONFIGURED, reauth: false, safeCode: 'APP_SECRET_REJECTED' };
    if (r.status === 400 && r.body?.error === 'invalid_grant') return { code: OAUTH_ERROR.CODE_EXCHANGE_FAILED, reauth: true, safeCode: 'GRANT_REFUSED' };
    return { code: OAUTH_ERROR.CODE_EXCHANGE_FAILED, reauth: false, safeCode: 'REJECTED' };
  };
  const call = (request, { refresh = false } = {}) => oauthRequest(http, request, { timeoutMs, now, classify: refresh ? classifyRefresh : classifyConnect });
  const shopOf = (shop) => normalizeShopDomain(shop) ?? (() => { throw new OAuthFailure({ code: OAUTH_ERROR.APP_MISCONFIGURED, safeCode: 'SHOP_DOMAIN' }); })();

  async function identify({ shop, accessToken }) {
    const res = await call({
      method: 'POST',
      url: `https://${shop}/admin/api/${apiVersion}/graphql.json`,
      headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      body: { query: SHOP_QUERY },
    });
    const s = res.body?.data?.shop;
    if (!s || typeof s.id !== 'string' || !s.id) throw new OAuthFailure({ code: OAUTH_ERROR.TOKEN_RESPONSE_INVALID, safeCode: 'NO_SHOP' });
    return { id: s.id, name: s.name ?? null, myshopifyDomain: normalizeShopDomain(s.myshopifyDomain) };
  }

  const candidateOf = (shopInfo, tokens, requestedShop) => {
    const reasons = [];
    if (shopInfo.myshopifyDomain !== requestedShop) reasons.push('SHOP_MISMATCH'); // the token must belong to the shop the merchant asked for
    for (const scope of scopes) if (!tokens.scopes.includes(scope)) reasons.push('SCOPE_MISSING');
    return deepFreeze({
      provider: SHOPIFY_PROVIDER, external_id: shopInfo.id, display_name: shopInfo.name, account_type: null, location_name: shopInfo.myshopifyDomain,
      granted_scopes: [...tokens.scopes], eligibility: { eligible: reasons.length === 0, reasons: [...new Set(reasons)].sort() }, review_signals: [],
      safe_metadata: { shop_domain: shopInfo.myshopifyDomain },
    });
  };

  return {
    provider: SHOPIFY_PROVIDER,
    descriptor: deepFreeze({ minimum_scopes: scopes, uses_pkce: false, revocable_remotely: false, offline_token: true, expiring_offline_token: true }),

    buildAuthorizationRequest({ appConfig, state, redirectUri = appConfig.redirectUri, shop }) {
      const url = new URL(`https://${shopOf(shop)}/admin/oauth/authorize`);
      url.searchParams.set('client_id', appConfig.clientId);
      url.searchParams.set('scope', scopes.join(','));
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      return url.toString();
    },

    /** Exchange at the shop the callback named (already checked against the pending session by the caller). */
    async exchangeCode({ appConfig, code, shop }) {
      const res = await call({
        method: 'POST',
        url: `https://${shopOf(shop)}/admin/oauth/access_token`,
        body: { client_id: appConfig.clientId, client_secret: appConfig.clientSecret, code: String(code), expiring: 1 },
      });
      // expiring offline token: the access token lasts ~1 h, the refresh token rotates on every refresh. Without a refresh token the grant is refused.
      if (typeof res.body?.refresh_token !== 'string' || !res.body.refresh_token) throw new OAuthFailure({ code: OAUTH_ERROR.TOKEN_RESPONSE_INVALID, safeCode: 'NO_REFRESH_TOKEN' });
      return withShop(bundleFromResponse({
        accessToken: res.body?.access_token, refreshToken: res.body.refresh_token, expiresInSeconds: res.body?.expires_in, scopes: parseScopes(res.body?.scope), externalUserId: null, refreshable: true, nowMs: now(),
      }), shopOf(shop));
    },

    /** Expiring offline tokens: POST access_token with grant_type=refresh_token. Returns a NEW refresh token that replaces the old one. */
    async refreshToken({ appConfig, tokens }) {
      const shop = shopOf(tokens?.shop_domain);
      const refreshToken = tokens?.refresh_token == null ? null : (typeof tokens.refresh_token.reveal === 'function' ? tokens.refresh_token.reveal() : tokens.refresh_token);
      if (!refreshToken) throw new OAuthFailure({ code: OAUTH_ERROR.TOKEN_RESPONSE_INVALID, safeCode: 'NO_REFRESH_TOKEN' });
      const res = await call({
        method: 'POST',
        url: `https://${shop}/admin/oauth/access_token`,
        body: { client_id: appConfig.clientId, client_secret: appConfig.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken },
      }, { refresh: true });
      const scopes = res.body?.scope ? parseScopes(res.body.scope) : tokens.scopes;
      if (typeof res.body?.refresh_token !== 'string' || !res.body.refresh_token) throw new OAuthFailure({ code: OAUTH_ERROR.TOKEN_RESPONSE_INVALID, safeCode: 'NO_REFRESH_TOKEN' });
      return withShop(bundleFromResponse({
        accessToken: res.body?.access_token, refreshToken: res.body.refresh_token, expiresInSeconds: res.body?.expires_in, scopes, externalUserId: null, refreshable: true, nowMs: now(),
      }), shop);
    },

    async discoverTargets({ tokens, shop }) {
      const requested = shopOf(shop);
      return [candidateOf(await identify({ shop: requested, accessToken: tokens.access_token }), tokens, requested)];
    },

    async verifyTarget({ tokens, shop, externalId }) {
      const requested = shopOf(shop);
      const info = await identify({ shop: requested, accessToken: tokens.access_token });
      if (info.id !== String(externalId)) throw new OAuthFailure({ code: OAUTH_ERROR.SCOPE_MISSING, safeCode: 'SHOP_MISMATCH' });
      return candidateOf(info, tokens, requested);
    },

    async revoke() { return deepFreeze({ remote: false, reason: 'UNINSTALL_IN_SHOPIFY_ADMIN' }); },

    normalizeOAuthError(error) {
      if (error instanceof OAuthFailure) return { code: error.code, reauth: error.reauth, safe_provider_code: error.safe_provider_code };
      return { code: OAUTH_ERROR.PROVIDER_UNAVAILABLE, reauth: false, safe_provider_code: 'UNEXPECTED' };
    },
  };
}
