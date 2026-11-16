// Provider Provisioning & Live Connections V1: closed vocabularies and stable error codes.
//
//   PROVIDER PROVISIONING OWNS: the OAuth lifecycle · secure credential storage · account discovery · account selection / binding ·
//   scope verification · token refresh · connection health · disconnect / revoke.
//   ACTIVATION OWNS: capability gate · publishing · idempotency · provider submission / status · publication receipts.
//   MARKETING OWNS NEITHER.
//
// Provisioning never publishes, edits or deletes anything at a provider. No token, authorization code, PKCE verifier, raw OAuth state
// or client secret is ever stored in plaintext, logged, printed or returned to a browser.

import { CHANNEL_PROVIDER, CHANNEL_PROVIDERS } from '../activation/constants.js';

export const PROVISIONING_VERSION = 'provider-provisioning.v1';

export const PROVIDER = CHANNEL_PROVIDER;
export const PROVIDERS = CHANNEL_PROVIDERS;

export const OAUTH_SESSION_STATUS = Object.freeze({
  PENDING: 'PENDING', // authorization requested, nothing came back yet
  AUTHORIZED: 'AUTHORIZED', // the callback was consumed (single use), tokens held in the secret store, target not chosen yet
  BOUND: 'BOUND', // the merchant explicitly chose a target and it is bound to a connector
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
});
export const SESSION_TTL_MS = 10 * 60_000; // the state is short-lived
export const PENDING_BINDING_TTL_MS = 15 * 60_000; // the merchant must choose the target within this window

// Normalized OAuth errors (no raw provider body is ever kept).
export const OAUTH_ERROR = Object.freeze({
  USER_DENIED: 'USER_DENIED',
  INVALID_STATE: 'INVALID_STATE',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  CODE_EXCHANGE_FAILED: 'CODE_EXCHANGE_FAILED',
  TOKEN_RESPONSE_INVALID: 'TOKEN_RESPONSE_INVALID',
  SCOPE_MISSING: 'SCOPE_MISSING',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  APP_MISCONFIGURED: 'APP_MISCONFIGURED',
});

// What a connection can report. CONFIGURED / MISCONFIGURED are persisted on merchant_connectors (NOT_CONFIGURED too, e.g. after a
// disconnect); UNAVAILABLE and REAUTH_REQUIRED are RUNTIME states and are never written.
export const CONNECTION_STATE = Object.freeze({
  CONFIGURED: 'CONFIGURED',
  MISCONFIGURED: 'MISCONFIGURED',
  UNAVAILABLE: 'UNAVAILABLE',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
});

export const CREDENTIAL_KIND = Object.freeze({ OAUTH_TOKENS: 'OAUTH_TOKENS' });
export const CREDENTIAL_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', EXPIRED: 'EXPIRED', REVOKED: 'REVOKED' });
export const REFRESH_LEASE_MS = 60_000;

// Refresh policy: NORDLA policy values chosen from the lifetimes the providers document (verified 2026-10-09). They are not
// provider-mandated numbers and not a global default: each provider has its own.
//   TikTok     access token 24 h (expires_in 86400), refresh token 365 days, the refresh token can ROTATE.
//   Instagram  long-lived access token 60 days; refreshable only if the token is at least 24 h old and not expired.
//   Google     access token ~1 h; refresh token valid until revoked / invalidated (invalid_grant -> re-consent).
export const REFRESH_POLICY = Object.freeze({
  [PROVIDER.TIKTOK]: Object.freeze({ refresh_before_seconds: 3_600, min_token_age_seconds: 0 }),
  [PROVIDER.INSTAGRAM]: Object.freeze({ refresh_before_seconds: 7 * 86_400, min_token_age_seconds: 86_400 }),
  [PROVIDER.GOOGLE_BUSINESS_PROFILE]: Object.freeze({ refresh_before_seconds: 300, min_token_age_seconds: 0 }),
});

// Names of the project-level app settings (environment / deployment secrets): NAMES only, never values.
export const APP_ENV = Object.freeze({
  [PROVIDER.INSTAGRAM]: Object.freeze({ clientId: 'INSTAGRAM_CLIENT_ID', clientSecret: 'INSTAGRAM_CLIENT_SECRET', redirectUri: 'INSTAGRAM_REDIRECT_URI' }),
  [PROVIDER.TIKTOK]: Object.freeze({ clientId: 'TIKTOK_CLIENT_KEY', clientSecret: 'TIKTOK_CLIENT_SECRET', redirectUri: 'TIKTOK_REDIRECT_URI' }),
  [PROVIDER.GOOGLE_BUSINESS_PROFILE]: Object.freeze({ clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET', redirectUri: 'GOOGLE_REDIRECT_URI' }),
});

export const LIVE_READINESS = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  OAUTH_READY: 'OAUTH_READY',
  CONNECTED: 'CONNECTED',
  VERIFIED: 'VERIFIED',
  PRODUCTION_ELIGIBLE: 'PRODUCTION_ELIGIBLE',
});

export const PROVISIONING_STATUS = Object.freeze({
  BACKEND_READY: 'BACKEND_READY',
  APP_CONFIG_REQUIRED: 'APP_CONFIG_REQUIRED',
  OAUTH_CONSENT_REQUIRED: 'OAUTH_CONSENT_REQUIRED',
  PROVIDER_REVIEW_REQUIRED: 'PROVIDER_REVIEW_REQUIRED',
  MEDIA_DELIVERY_REQUIRED: 'MEDIA_DELIVERY_REQUIRED',
  PRODUCTION_READY: 'PRODUCTION_READY',
});

export const PC_ERROR = Object.freeze({
  UNKNOWN_KEY: 'PC_UNKNOWN_KEY',
  INVALID_FIELD: 'PC_INVALID_FIELD',
  TENANT_INVALID: 'PC_TENANT_INVALID',
  PROVIDER_UNSUPPORTED: 'PC_PROVIDER_UNSUPPORTED',
  RETURN_TO_REFUSED: 'PC_RETURN_TO_REFUSED',
  SECRET_LEAK: 'PC_SECRET_LEAK',

  // OAuth
  OAUTH: 'PC_OAUTH_ERROR', // carries a normalized OAUTH_ERROR code in `detail.oauth`
  SESSION_NOT_FOUND: 'PC_SESSION_NOT_FOUND',
  SESSION_STATE_CONFLICT: 'PC_SESSION_STATE_CONFLICT',
  APP_MISCONFIGURED: 'PC_APP_MISCONFIGURED',

  // credentials / vault
  CREDENTIAL_NOT_FOUND: 'PC_CREDENTIAL_NOT_FOUND',
  CREDENTIAL_REVOKED: 'PC_CREDENTIAL_REVOKED',
  CREDENTIAL_VERSION_CONFLICT: 'PC_CREDENTIAL_VERSION_CONFLICT',
  CREDENTIAL_SCOPE_MISMATCH: 'PC_CREDENTIAL_SCOPE_MISMATCH',
  VAULT_UNAVAILABLE: 'PC_VAULT_UNAVAILABLE',
  REAUTH_REQUIRED: 'PC_REAUTH_REQUIRED',
  REFRESH_IN_PROGRESS: 'PC_REFRESH_IN_PROGRESS',

  // binding
  TARGET_REQUIRED: 'PC_TARGET_REQUIRED',
  TARGET_NOT_FOUND: 'PC_TARGET_NOT_FOUND',
  TARGET_INELIGIBLE: 'PC_TARGET_INELIGIBLE',
  CONNECTOR_NOT_FOUND: 'PC_CONNECTOR_NOT_FOUND',
});

export class ProvisioningError extends Error {
  /** @param {string} code one of PC_ERROR @param {string} message never contains submitted values @param {object} [detail] non-secret context */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ProvisioningError';
    this.code = code;
    this.detail = detail;
  }
}
