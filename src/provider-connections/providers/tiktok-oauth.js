// TikTok (Login Kit, OAuth 2.0) provisioning. Facts verified against the official TikTok documentation on 2026-10-09:
//   authorization URL   https://www.tiktok.com/v2/auth/authorize/  (client_key, scope [comma-separated], redirect_uri, state, response_type=code)
//   redirect URI rules  registered in the app, absolute https, static (no query string), no fragment, at most 10, each under 512 characters
//   callback            code, scopes, state (or error / error_description)
//   token endpoint      POST https://open.tiktokapis.com/v2/oauth/token/  (application/x-www-form-urlencoded)
//                       exchange: client_key, client_secret, code (URL-decoded), grant_type=authorization_code, redirect_uri
//                       refresh : client_key, client_secret, grant_type=refresh_token, refresh_token
//                       response: open_id, scope, access_token, expires_in (86400: 24 h), refresh_token, refresh_expires_in (365 days), token_type
//                       the refresh token may ROTATE: the returned one replaces the old one
//   revoke              POST https://open.tiktokapis.com/v2/oauth/revoke/  (client_key, client_secret, token)
//   PKCE                code_verifier is required only for mobile / desktop apps: not used for this web (server) flow
//   identity            the stable account id is the open_id of the token response; the display name comes from
//                       POST /v2/post/publish/creator_info/query/ (video.publish), a read-only call
// Minimum scope: video.publish only (posting). Nothing is published during provisioning.

import { OAUTH_ERROR, PROVIDER } from '../constants.js';
import { deepFreeze, seal } from '../validation.js';
import {
  OAuthFailure, bearerOf, bundleFromResponse, oauthRequest, parseScopes,
} from './common.js';

export const TIKTOK_MINIMUM_SCOPES = Object.freeze(['video.publish']);

export function createTikTokOAuth({ http, timeoutMs, now = Date.now } = {}) {
  const classify = (r) => {
    const code = r.body?.error;
    if (code === 'invalid_client' || code === 'unauthorized_client') return { code: OAUTH_ERROR.APP_MISCONFIGURED, safeCode: code };
    if (code === 'invalid_grant' || r.status === 401) return { code: OAUTH_ERROR.CODE_EXCHANGE_FAILED, reauth: true, safeCode: code ?? r.status };
    if (code === 'invalid_request' || r.status === 400) return { code: OAUTH_ERROR.CODE_EXCHANGE_FAILED, safeCode: code ?? r.status };
    return {};
  };
  const call = (request) => oauthRequest(http, request, { timeoutMs, now, classify });

  const tokenRequest = (appConfig, extra) => call({
    method: 'POST', url: 'https://open.tiktokapis.com/v2/oauth/token/', form: { client_key: appConfig.clientId, client_secret: appConfig.clientSecret, ...extra },
  });
  const fromResponse = (body, previous) => bundleFromResponse({
    accessToken: body?.access_token, refreshToken: body?.refresh_token ?? previous?.refresh_token?.reveal(), expiresInSeconds: body?.expires_in, scopes: parseScopes(body?.scope ?? previous?.scopes),
    externalUserId: body?.open_id ?? previous?.external_user_id, refreshable: Boolean(body?.refresh_token ?? previous?.refresh_token), nowMs: now(),
  });

  async function creator(tokens) {
    const res = await call({ method: 'POST', url: 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/', headers: bearerOf(tokens), body: {} });
    return res.body?.data ?? {};
  }
  const candidateOf = (tokens, info, appConfig) => {
    const reasons = TIKTOK_MINIMUM_SCOPES.filter((s) => !tokens.scopes.includes(s)).map(() => 'SCOPE_MISSING');
    return deepFreeze({
      provider: PROVIDER.TIKTOK, external_id: String(tokens.external_user_id ?? ''), display_name: info.creator_nickname ?? null, account_type: 'TIKTOK_CREATOR', location_name: null,
      granted_scopes: [...tokens.scopes], eligibility: { eligible: reasons.length === 0 && Boolean(tokens.external_user_id), reasons },
      review_signals: appConfig?.clientAudited ? [] : ['TIKTOK_UNAUDITED_PRIVATE_ONLY'], // an unaudited client can only post privately
      safe_metadata: { privacy_level_options: [...(info.privacy_level_options ?? [])] },
    });
  };

  return {
    provider: PROVIDER.TIKTOK,
    descriptor: deepFreeze({
      minimum_scopes: TIKTOK_MINIMUM_SCOPES, uses_pkce: false, revocable_remotely: true,
      verified_against: [
        'https://developers.tiktok.com/doc/login-kit-web', 'https://developers.tiktok.com/doc/oauth-user-access-token-management',
        'https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info',
      ],
      verified_at: '2026-10-09T00:00:00.000Z',
    }),

    buildAuthorizationRequest({ appConfig, state, redirectUri = appConfig.redirectUri }) {
      // TikTok redirect URI rules: absolute https, static (no query string), no fragment, under 512 characters
      const target = new URL(redirectUri);
      if (target.protocol !== 'https:' || target.search || target.hash || redirectUri.length >= 512) throw new OAuthFailure({ code: OAUTH_ERROR.APP_MISCONFIGURED, safeCode: 'REDIRECT_URI_RULES' });
      const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
      url.searchParams.set('client_key', appConfig.clientId);
      url.searchParams.set('scope', TIKTOK_MINIMUM_SCOPES.join(','));
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchangeCode({ appConfig, code, redirectUri = appConfig.redirectUri }) {
      const res = await tokenRequest(appConfig, { code: seal(decodeURIComponent(String(code))), grant_type: 'authorization_code', redirect_uri: redirectUri });
      return fromResponse(res.body, null);
    },

    async refreshToken({ appConfig, tokens }) {
      if (!tokens.refresh_token) throw new OAuthFailure({ code: OAUTH_ERROR.CODE_EXCHANGE_FAILED, reauth: true, safeCode: 'NO_REFRESH_TOKEN' });
      const res = await tokenRequest(appConfig, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
      return fromResponse(res.body, tokens); // the refresh token may rotate: the new one wins, otherwise the old one is kept
    },

    async discoverTargets({ tokens, appConfig }) { return [candidateOf(tokens, await creator(tokens), appConfig)]; },

    async verifyTarget({ tokens, appConfig, externalId }) {
      if (String(tokens.external_user_id) !== String(externalId)) throw new OAuthFailure({ code: OAUTH_ERROR.SCOPE_MISSING, safeCode: 'ACCOUNT_MISMATCH' });
      return candidateOf(tokens, await creator(tokens), appConfig);
    },

    async revoke({ appConfig, tokens }) {
      await call({ method: 'POST', url: 'https://open.tiktokapis.com/v2/oauth/revoke/', form: { client_key: appConfig.clientId, client_secret: appConfig.clientSecret, token: tokens.access_token } });
      return deepFreeze({ remote: true });
    },

    normalizeOAuthError(error) {
      if (error instanceof OAuthFailure) return { code: error.code, reauth: error.reauth, safe_provider_code: error.safe_provider_code };
      return { code: OAUTH_ERROR.PROVIDER_UNAVAILABLE, reauth: false, safe_provider_code: 'UNEXPECTED' };
    },
  };
}
