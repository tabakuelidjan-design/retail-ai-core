// Instagram (Instagram API with Instagram Login) OAuth provisioning. Facts verified against the official Meta documentation on 2026-10-09
// (business-login page of instagram-api-with-instagram-login):
//   authorization window  https://www.instagram.com/oauth/authorize  (client_id, redirect_uri, response_type=code, scope, state)
//   current scopes        instagram_business_basic · instagram_business_content_publish (· manage_messages · manage_comments, not requested here);
//                         the old business_* scope names were deprecated on 2025-01-27
//   code                  valid 1 hour, single use; a trailing "#_" is not part of it (stripped)
//   short-lived token     POST https://api.instagram.com/oauth/access_token (client_id, client_secret, grant_type=authorization_code, redirect_uri, code)
//   long-lived token      GET  https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret&access_token  (server side only, ~60 days)
//   refresh               GET  https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token
//                         (token >= 24 h old, not expired, instagram_business_basic granted; a token not refreshed within 60 days expires)
//   account check         GET  https://graph.instagram.com/<version>/me?fields=user_id,username,account_type  (account_type Business | Media_Creator)
//   PKCE is not mentioned by the documentation: not used. No documented revoke endpoint: a disconnect is local (the merchant removes the
//   app in Instagram settings).
// Only the minimum scopes needed to publish are requested. The Graph API version is configuration (INSTAGRAM_GRAPH_API_VERSION).

import { OAUTH_ERROR, PROVIDER } from '../constants.js';
import { deepFreeze, seal } from '../validation.js';
import { OAuthFailure, bundleFromResponse, oauthRequest, parseScopes } from './common.js';

export const INSTAGRAM_MINIMUM_SCOPES = Object.freeze(['instagram_business_basic', 'instagram_business_content_publish']);
const PROFESSIONAL = ['Business', 'Media_Creator'];

export function createInstagramOAuth({ http, timeoutMs, now = Date.now } = {}) {
  const call = (request) => oauthRequest(http, request, { timeoutMs, now, classify: (r) => (r.status === 400 || r.status === 401 ? { code: OAUTH_ERROR.CODE_EXCHANGE_FAILED, reauth: r.status === 401, safeCode: r.body?.error_type ?? r.body?.error?.code ?? r.status } : {}) });
  const versionOf = (appConfig) => {
    if (!appConfig.graphVersion || !/^v\d+\.\d+$/.test(appConfig.graphVersion)) throw new OAuthFailure({ code: OAUTH_ERROR.APP_MISCONFIGURED, safeCode: 'GRAPH_VERSION' });
    return appConfig.graphVersion;
  };

  async function me(tokens, appConfig) {
    const res = await call({ method: 'GET', url: `https://graph.instagram.com/${versionOf(appConfig)}/me`, query: { fields: 'user_id,username,account_type', access_token: tokens.access_token } });
    return { id: String(res.body?.user_id ?? res.body?.id ?? ''), username: res.body?.username ?? null, accountType: res.body?.account_type ?? null };
  }

  const candidateOf = (account, tokens) => {
    const reasons = [];
    if (!PROFESSIONAL.includes(account.accountType)) reasons.push('ACCOUNT_NOT_PROFESSIONAL'); // a consumer account can never publish through the API
    for (const scope of INSTAGRAM_MINIMUM_SCOPES) if (!tokens.scopes.includes(scope)) reasons.push('SCOPE_MISSING');
    return deepFreeze({
      provider: PROVIDER.INSTAGRAM, external_id: account.id, display_name: account.username, account_type: account.accountType, location_name: null,
      granted_scopes: [...tokens.scopes], eligibility: { eligible: reasons.length === 0, reasons: [...new Set(reasons)].sort() }, review_signals: [],
      safe_metadata: { account_type: account.accountType },
    });
  };

  return {
    provider: PROVIDER.INSTAGRAM,
    descriptor: deepFreeze({
      minimum_scopes: INSTAGRAM_MINIMUM_SCOPES, uses_pkce: false, revocable_remotely: false,
      verified_against: [
        'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login',
        'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started',
      ],
      verified_at: '2026-10-09T00:00:00.000Z',
    }),

    buildAuthorizationRequest({ appConfig, state, redirectUri = appConfig.redirectUri }) {
      const url = new URL('https://www.instagram.com/oauth/authorize');
      url.searchParams.set('client_id', appConfig.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', INSTAGRAM_MINIMUM_SCOPES.join(','));
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchangeCode({ appConfig, code, redirectUri = appConfig.redirectUri }) {
      const clean = String(code).replace(/#_$/, '');
      const short = await call({ method: 'POST', url: 'https://api.instagram.com/oauth/access_token', form: { client_id: appConfig.clientId, client_secret: appConfig.clientSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: seal(clean) } });
      const first = Array.isArray(short.body?.data) ? short.body.data[0] : short.body;
      if (!first || typeof first.access_token !== 'string' || first.user_id == null) throw new OAuthFailure({ code: OAUTH_ERROR.TOKEN_RESPONSE_INVALID, safeCode: 'SHORT_TOKEN' });
      const long = await call({ method: 'GET', url: 'https://graph.instagram.com/access_token', query: { grant_type: 'ig_exchange_token', client_secret: appConfig.clientSecret, access_token: seal(first.access_token) } });
      return bundleFromResponse({
        accessToken: long.body?.access_token, expiresInSeconds: long.body?.expires_in, scopes: parseScopes(first.permissions), externalUserId: first.user_id, refreshable: true, nowMs: now(),
      });
    },

    async refreshToken({ tokens }) {
      const res = await call({ method: 'GET', url: 'https://graph.instagram.com/refresh_access_token', query: { grant_type: 'ig_refresh_token', access_token: tokens.access_token } });
      return bundleFromResponse({
        accessToken: res.body?.access_token, expiresInSeconds: res.body?.expires_in, scopes: tokens.scopes, externalUserId: tokens.external_user_id, refreshable: true, nowMs: now(),
      });
    },

    async discoverTargets({ tokens, appConfig }) { return [candidateOf(await me(tokens, appConfig), tokens)]; },

    async verifyTarget({ tokens, appConfig, externalId }) {
      const account = await me(tokens, appConfig);
      if (account.id !== String(externalId)) throw new OAuthFailure({ code: OAUTH_ERROR.SCOPE_MISSING, safeCode: 'ACCOUNT_MISMATCH' });
      return candidateOf(account, tokens);
    },

    async revoke() { return deepFreeze({ remote: false, reason: 'NO_DOCUMENTED_REVOKE_ENDPOINT' }); },

    normalizeOAuthError(error) {
      if (error instanceof OAuthFailure) return { code: error.code, reauth: error.reauth, safe_provider_code: error.safe_provider_code };
      return { code: OAUTH_ERROR.PROVIDER_UNAVAILABLE, reauth: false, safe_provider_code: 'UNEXPECTED' };
    },
  };
}
