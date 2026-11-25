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
  const call = (request) => oauthRequest(http, request, {
    timeoutMs,
    now,
    classify: (r) => (r.status === 401 || r.status === 403 ? { code: OAUTH_ERROR.CODE_EXCHANGE_FAILED, reauth: true, safeCode: 'REFUSED' } : { code: OAUTH_ERROR.CODE_EXCHANGE_FAILED, reauth: false, safeCode: 'REJECTED' }),
  });
  const shopOf = (shop) => normalizeShopDomain(shop) ?? (() => { throw new OAuthFailure({ code: OAUTH_ERROR.APP_MISCONFIGURED, safeCode: 'SHOP_DOMAIN' }); })();

  async function identify({ shop, accessToken }) {
    const res = await call({
      method: 'POST',
      url: `https://${shop}/admin/api/${apiVersion}/graphql.json`,
      headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      json: { query: SHOP_QUERY },
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
    descriptor: deepFreeze({ minimum_scopes: scopes, uses_pkce: false, revocable_remotely: false, offline_token: true }),

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
        json: { client_id: appConfig.clientId, client_secret: appConfig.clientSecret, code: String(code) },
      });
      return bundleFromResponse({ accessToken: res.body?.access_token, scopes: parseScopes(res.body?.scope), externalUserId: null, refreshable: false, nowMs: now() });
    },

    /** No refresh: an offline token stays valid until the app is removed. Asking for one is a programming error, reported as such. */
    async refreshToken() { throw new OAuthFailure({ code: OAUTH_ERROR.TOKEN_RESPONSE_INVALID, safeCode: 'NOT_REFRESHABLE' }); },

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
