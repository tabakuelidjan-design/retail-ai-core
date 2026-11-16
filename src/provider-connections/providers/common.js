// Shared pieces of the OAuth provider adapters: the HTTP boundary (injected, always with a timeout), the normalized OAuth failure, the
// app settings loader (NAMES come from APP_ENV, VALUES from the environment / deployment secrets) and the token bundle builder.
//
// A raw provider response is NEVER persisted or logged: it is parsed, an allowlist of fields is kept, the rest is discarded.

import { callProvider, ProviderCallError, parseRetryAfter } from '../../activation/providers/http.js';
import {
  APP_ENV, OAUTH_ERROR, PC_ERROR as E, ProvisioningError,
} from '../constants.js';
import { makeTokenBundle } from '../credential-store.js';
import {
  SealedSecret, deepFreeze, fail, isPlainObject, seal,
} from '../validation.js';

/** A normalized OAuth / provider failure. `reauth` = the grant is no longer valid and the merchant must consent again. */
export class OAuthFailure extends Error {
  constructor({ code, reauth = false, safeCode = null, retryAfterMs = null }) {
    super(code);
    this.name = 'OAuthFailure';
    this.code = code;
    this.reauth = reauth;
    this.safe_provider_code = safeCode == null ? null : String(safeCode).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
    this.retry_after_ms = retryAfterMs;
  }
}

/**
 * One provider call. `classify(response)` returns { code, reauth, safeCode } for a refused response; 2xx is accepted otherwise.
 * Network failures and timeouts are PROVIDER_UNAVAILABLE (temporary: never MISCONFIGURED).
 */
export async function oauthRequest(http, request, { timeoutMs, classify = () => ({}), now = Date.now } = {}) {
  if (typeof http !== 'function') throw new TypeError('an OAuth adapter needs an injected http function');
  let response;
  try {
    response = await callProvider(http, request, { timeoutMs });
  } catch (error) {
    throw new OAuthFailure({ code: OAUTH_ERROR.PROVIDER_UNAVAILABLE, safeCode: error instanceof ProviderCallError ? error.kind : 'NETWORK' });
  }
  if (response.status >= 200 && response.status < 300 && !(isPlainObject(response.body) && typeof response.body.error === 'string')) return response;
  const mapped = classify(response) ?? {};
  const unavailable = response.status === 429 || response.status >= 500;
  throw new OAuthFailure({
    code: mapped.code ?? (unavailable ? OAUTH_ERROR.PROVIDER_UNAVAILABLE : OAUTH_ERROR.CODE_EXCHANGE_FAILED),
    reauth: Boolean(mapped.reauth),
    safeCode: mapped.safeCode ?? (typeof response.body?.error === 'string' ? response.body.error : response.status),
    retryAfterMs: parseRetryAfter(response.headers, now()),
  });
}

export const parseScopes = (value) => {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  return [];
};

/** Builds the sealed bundle from an allowlisted token response; anything missing or malformed is TOKEN_RESPONSE_INVALID. */
export function bundleFromResponse({
  accessToken, refreshToken = null, expiresInSeconds = null, scopes, externalUserId = null, refreshable = null, nowMs,
}) {
  if (typeof accessToken !== 'string' || accessToken.length < 8) throw new OAuthFailure({ code: OAUTH_ERROR.TOKEN_RESPONSE_INVALID, safeCode: 'NO_ACCESS_TOKEN' });
  if (expiresInSeconds != null && !(Number.isFinite(Number(expiresInSeconds)) && Number(expiresInSeconds) > 0)) throw new OAuthFailure({ code: OAUTH_ERROR.TOKEN_RESPONSE_INVALID, safeCode: 'BAD_EXPIRY' });
  return makeTokenBundle({
    accessToken,
    refreshToken: typeof refreshToken === 'string' && refreshToken ? refreshToken : null,
    expiresAt: expiresInSeconds == null ? null : new Date(nowMs + Number(expiresInSeconds) * 1000).toISOString(),
    scopes,
    refreshable,
    externalUserId,
    issuedAt: new Date(nowMs).toISOString(),
  });
}

/**
 * The project-level app settings of a provider, from the environment (deployment secrets). Missing values raise APP_MISCONFIGURED naming
 * the variables (never a value). The client secret is sealed at once.
 */
export function loadProviderAppConfig(provider, env = process.env) {
  const names = APP_ENV[provider];
  if (!names) fail(E.PROVIDER_UNSUPPORTED, 'this provider is not supported');
  const values = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, typeof env[name] === 'string' ? env[name].trim() : '']));
  const missing = Object.entries(names).filter(([key]) => !values[key]).map(([, name]) => name);
  if (missing.length) throw new ProvisioningError(E.APP_MISCONFIGURED, 'the provider app settings are incomplete', { provider, missing });
  let redirect;
  try { redirect = new URL(values.redirectUri); } catch { throw new ProvisioningError(E.APP_MISCONFIGURED, 'the redirect URI is not a URL', { provider, invalid: [names.redirectUri] }); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
  if (redirect.hash || redirect.search || (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && local))) {
    throw new ProvisioningError(E.APP_MISCONFIGURED, 'the redirect URI must be https (http only on localhost) without a query or a fragment', { provider, invalid: [names.redirectUri] });
  }
  return deepFreeze({
    provider, clientId: values.clientId, clientSecret: seal(values.clientSecret), redirectUri: values.redirectUri,
    graphVersion: env.INSTAGRAM_GRAPH_API_VERSION?.trim() || null,
    clientAudited: String(env.TIKTOK_CLIENT_AUDITED ?? '').trim().toLowerCase() === 'true',
  });
}

/** `Authorization: Bearer <token>` as a sealed header (revealed only by the HTTP boundary). */
export const bearerOf = (tokens) => ({ Authorization: seal(`Bearer ${tokens.access_token.reveal()}`) });

export const revealedOrNull = (secret) => (secret instanceof SealedSecret ? secret.reveal() : null);
