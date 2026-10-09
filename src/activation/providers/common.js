// Shared pieces of the provider adapters: the normalized error, the closed-schema helpers and the adapter outcome shapes.
// A raw provider payload is NEVER kept: only a normalized code, a retry hint and a short safe provider code survive.

import { PROVIDER_ERROR as PE, RETRYABLE_PROVIDER_ERRORS, ACT_ERROR as E } from '../constants.js';
import { redact, seal } from '../validation.js';
import { ProviderCallError, callProvider, parseRetryAfter } from './http.js';
import { deepFreeze, fail, isPlainObject } from '../validation.js';

/** Thrown by an adapter when the provider (or the network) refused or failed: carries only the normalized classification. */
export class ProviderRejection extends Error {
  constructor({ code, safeCode = null, retryAfterMs = null }) {
    super(code);
    this.name = 'ProviderRejection';
    this.code = code;
    this.retryable = RETRYABLE_PROVIDER_ERRORS.includes(code);
    this.safe_provider_code = safeCode == null ? null : String(safeCode).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
    this.retry_after_ms = retryAfterMs;
  }
}

export const statusToCode = (status) => {
  if (status === 429) return PE.RATE_LIMITED;
  if (status === 401) return PE.AUTH_INVALID;
  if (status === 403) return PE.SCOPE_MISSING;
  if (status === 408 || status === 504) return PE.TIMEOUT;
  if (status >= 500) return PE.PROVIDER_UNAVAILABLE;
  if (status === 404) return PE.ACCOUNT_INVALID;
  if (status >= 400) return PE.PERMANENT_REJECTION;
  return null;
};

/**
 * One provider call. Returns the parsed response when `accept(response)` is true; otherwise throws a ProviderRejection built by
 * `mapError(response)` (provider-specific) falling back to the HTTP status. Network failures and timeouts are normalized too.
 */
export async function providerCall(http, request, { timeoutMs, mapError, accept = (r) => r.status >= 200 && r.status < 300, now = Date.now }) {
  let response;
  try {
    response = await callProvider(http, request, { timeoutMs });
  } catch (error) {
    if (error instanceof ProviderCallError) throw new ProviderRejection({ code: error.kind === 'TIMEOUT' ? PE.TIMEOUT : PE.PROVIDER_UNAVAILABLE, safeCode: error.kind });
    throw new ProviderRejection({ code: PE.PROVIDER_UNAVAILABLE, safeCode: 'NETWORK' });
  }
  if (accept(response)) return response;
  const mapped = mapError?.(response) ?? {};
  throw new ProviderRejection({
    code: mapped.code ?? statusToCode(response.status) ?? PE.PERMANENT_REJECTION,
    safeCode: mapped.safeCode ?? response.status,
    retryAfterMs: parseRetryAfter(response.headers, now()),
  });
}

/** Normalizes anything thrown during an adapter call into { code, retryable, safe_provider_code, retry_after_ms } (no payload). */
export function normalizeThrown(error) {
  if (error instanceof ProviderRejection) {
    return deepFreeze({ code: error.code, retryable: error.retryable, safe_provider_code: error.safe_provider_code, retry_after_ms: error.retry_after_ms });
  }
  return deepFreeze({ code: PE.PROVIDER_UNAVAILABLE, retryable: true, safe_provider_code: 'UNEXPECTED', retry_after_ms: null });
}

export function closedOptions(options, allowed, field) {
  if (!isPlainObject(options)) fail(E.PROVIDER_OPTIONS_INVALID, `${field} must be an object`, { field });
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) fail(E.PROVIDER_OPTIONS_INVALID, `${field}.${key} is not an allowed provider option`, { field, key });
  }
  return options;
}

export const outcome = (fields) => deepFreeze(fields);
export const safeText = (value) => redact(String(value ?? '')).slice(0, 200);

export function requireHttp(http) {
  if (typeof http !== 'function') throw new TypeError('a provider adapter needs an injected http function');
  return http;
}

/** `Authorization: Bearer <token>` as a sealed value: revealed only by the http boundary, serialized as "[REDACTED]" everywhere else. */
export const bearerHeader = (credential) => ({ Authorization: seal(`Bearer ${credential.access_token.reveal()}`) });
