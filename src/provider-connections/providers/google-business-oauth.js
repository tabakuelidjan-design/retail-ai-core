// Google Business Profile OAuth provisioning. Facts verified against the official Google documentation on 2026-10-09:
//   authorization endpoint  https://accounts.google.com/o/oauth2/v2/auth  (client_id, redirect_uri, response_type=code, scope, state,
//                           access_type=offline to receive a refresh token, prompt=consent to get a refresh token again)
//   token endpoint          POST https://oauth2.googleapis.com/token  (code, client_id, client_secret, redirect_uri, grant_type=authorization_code)
//                           response: access_token, expires_in, refresh_token (only with access_type=offline), scope (space-delimited), token_type=Bearer
//   refresh                 grant_type=refresh_token (standard OAuth 2.0); invalid_grant = expired / invalidated grant: the merchant must consent again
//   revoke                  POST https://oauth2.googleapis.com/revoke  (token)
//   scope                   https://www.googleapis.com/auth/business.manage (the only scope requested)
//   account discovery       GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts            (accounts.list)
//   location discovery      GET https://mybusinessbusinessinformation.googleapis.com/v1/accounts/{id}/locations?readMask=...&pageSize=100  (locations.list)
//   resource name           the local-post parent is accounts/{accountId}/locations/{locationId}: it is built from the account name and the
//                           location name returned by those two lists (to be re-verified in a sandbox together with the readMask fields name,title,storeCode)
//   PKCE                    S256 PKCE is used for this web-server flow (supported by Google OAuth 2.0; the code_verifier is sent at the token exchange)
// The explicit LOCATION is the binding target: an account alone is never a publication target.

import { OAUTH_ERROR, PROVIDER } from '../constants.js';
import { deepFreeze, seal } from '../validation.js';
import {
  OAuthFailure, bearerOf, bundleFromResponse, oauthRequest, parseScopes,
} from './common.js';

export const GOOGLE_MINIMUM_SCOPES = Object.freeze(['https://www.googleapis.com/auth/business.manage']);
const MAX_PAGES = 10;

export function createGoogleBusinessOAuth({ http, timeoutMs, now = Date.now } = {}) {
  const classify = (r) => {
    const code = r.body?.error;
    if (code === 'invalid_grant') return { code: OAUTH_ERROR.CODE_EXCHANGE_FAILED, reauth: true, safeCode: code };
    if (code === 'invalid_client' || code === 'unauthorized_client') return { code: OAUTH_ERROR.APP_MISCONFIGURED, safeCode: code };
    if (r.status === 401 || r.status === 403) return { code: OAUTH_ERROR.SCOPE_MISSING, reauth: r.status === 401, safeCode: r.body?.error?.status ?? r.status };
    if (r.status === 400) return { code: OAUTH_ERROR.CODE_EXCHANGE_FAILED, safeCode: code ?? r.status };
    return {};
  };
  const call = (request) => oauthRequest(http, request, { timeoutMs, now, classify });
  const fromResponse = (body, previous) => bundleFromResponse({
    accessToken: body?.access_token, refreshToken: body?.refresh_token ?? previous?.refresh_token?.reveal(), expiresInSeconds: body?.expires_in,
    scopes: parseScopes(body?.scope ?? previous?.scopes), externalUserId: previous?.external_user_id ?? null, refreshable: Boolean(body?.refresh_token ?? previous?.refresh_token), nowMs: now(),
  });

  async function pages(url, tokens, listKey, query) {
    const out = [];
    let pageToken = null;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const res = await call({ method: 'GET', url, headers: bearerOf(tokens), query: { ...query, ...(pageToken ? { pageToken } : {}) } });
      out.push(...(Array.isArray(res.body?.[listKey]) ? res.body[listKey] : []));
      pageToken = res.body?.nextPageToken ?? null;
      if (!pageToken) break;
    }
    return out;
  }

  async function discover(tokens) {
    const accounts = await pages('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', tokens, 'accounts', { pageSize: 20 });
    const reasons = GOOGLE_MINIMUM_SCOPES.filter((s) => !tokens.scopes.includes(s)).map(() => 'SCOPE_MISSING');
    const candidates = [];
    for (const account of accounts) {
      if (typeof account?.name !== 'string' || !/^accounts\/[^/]+$/.test(account.name)) continue;
      const locations = await pages(`https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations`, tokens, 'locations', { readMask: 'name,title,storeCode', pageSize: 100 });
      for (const location of locations) {
        if (typeof location?.name !== 'string' || !/^locations\/[^/]+$/.test(location.name)) continue;
        candidates.push(deepFreeze({
          provider: PROVIDER.GOOGLE_BUSINESS_PROFILE, external_id: `${account.name}/${location.name}`, display_name: location.title ?? null, account_type: account.type ?? null,
          location_name: location.name, granted_scopes: [...tokens.scopes], eligibility: { eligible: reasons.length === 0, reasons },
          review_signals: [], safe_metadata: { account_name: account.name, account_display_name: account.accountName ?? null, store_code: location.storeCode ?? null },
        }));
      }
    }
    return candidates;
  }

  return {
    provider: PROVIDER.GOOGLE_BUSINESS_PROFILE,
    descriptor: deepFreeze({
      minimum_scopes: GOOGLE_MINIMUM_SCOPES, uses_pkce: true, revocable_remotely: true,
      verified_against: [
        'https://developers.google.com/identity/protocols/oauth2/web-server', 'https://developers.google.com/my-business/content/account-data',
        'https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations/list',
      ],
      verified_at: '2026-10-09T00:00:00.000Z',
    }),

    buildAuthorizationRequest({ appConfig, state, pkceChallenge, redirectUri = appConfig.redirectUri }) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', appConfig.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', GOOGLE_MINIMUM_SCOPES.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('access_type', 'offline'); // a refresh token is returned only with offline access
      url.searchParams.set('prompt', 'consent');
      if (pkceChallenge) { url.searchParams.set('code_challenge', pkceChallenge); url.searchParams.set('code_challenge_method', 'S256'); }
      return url.toString();
    },

    async exchangeCode({ appConfig, code, redirectUri = appConfig.redirectUri, pkceVerifier }) {
      const form = { code: seal(String(code)), client_id: appConfig.clientId, client_secret: appConfig.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' };
      if (pkceVerifier) form.code_verifier = pkceVerifier;
      const res = await call({ method: 'POST', url: 'https://oauth2.googleapis.com/token', form });
      return fromResponse(res.body, null);
    },

    async refreshToken({ appConfig, tokens }) {
      if (!tokens.refresh_token) throw new OAuthFailure({ code: OAUTH_ERROR.CODE_EXCHANGE_FAILED, reauth: true, safeCode: 'NO_REFRESH_TOKEN' });
      const res = await call({
        method: 'POST', url: 'https://oauth2.googleapis.com/token', form: { client_id: appConfig.clientId, client_secret: appConfig.clientSecret, refresh_token: tokens.refresh_token, grant_type: 'refresh_token' },
      });
      return fromResponse(res.body, tokens);
    },

    discoverTargets({ tokens }) { return discover(tokens); },

    /** Re-reads the lists and finds the exact location: a revoked grant, a removed location or another scope fail here. */
    async verifyTarget({ tokens, externalId }) {
      const found = (await discover(tokens)).find((c) => c.external_id === externalId);
      if (!found) throw new OAuthFailure({ code: OAUTH_ERROR.SCOPE_MISSING, safeCode: 'LOCATION_NOT_AUTHORIZED' });
      return found;
    },

    async revoke({ tokens }) {
      await call({ method: 'POST', url: 'https://oauth2.googleapis.com/revoke', form: { token: tokens.refresh_token ?? tokens.access_token } });
      return deepFreeze({ remote: true });
    },

    normalizeOAuthError(error) {
      if (error instanceof OAuthFailure) return { code: error.code, reauth: error.reauth, safe_provider_code: error.safe_provider_code };
      return { code: OAUTH_ERROR.PROVIDER_UNAVAILABLE, reauth: false, safe_provider_code: 'UNEXPECTED' };
    },
  };
}
