import { CORE_CATEGORY as C, makeCoreError, redact } from './taxonomy.js';

// NORDLA CORE RESILIENCE: THE PROVIDER BOUNDARY. A provider's failure becomes a CoreError with a stable subcode and ONE flag that matters to recovery: `transient` (a retry of an idempotent operation may help).
// Provider quirks stay behind this boundary: no raw body, no request id, no status text, no URL reaches a caller (the status class is kept as a scalar). A provider is not a capability: an unavailable model or
// capability is a TOOL_CAPABILITY_LIMIT, a refusal is a PROVIDER_FAILURE that is not transient, and neither is retried blindly.

export const PROVIDER_SUBCODE = Object.freeze({
  PROVIDER_TIMEOUT: { transient: true }, PROVIDER_RATE_LIMITED: { transient: true }, PROVIDER_NETWORK: { transient: true }, PROVIDER_UNAVAILABLE: { transient: true },
  PROVIDER_SERVER_ERROR: { transient: true }, PROVIDER_AUTH: { transient: false }, PROVIDER_REFUSAL: { transient: false }, PROVIDER_REJECTED: { transient: false }, PROVIDER_UNKNOWN: { transient: false },
});

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'NETWORK']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'TIMEOUT', 'HTTP_TIMEOUT', 'ABORT_ERR', 'ESOCKETTIMEDOUT']);

/**
 * `failure`: any error-like object ({ status, code, name, message, retryAfterMs }) or a failed HTTP result. Returns a CoreError whose `diagnostics` hold only scalars (status class, transient flag, retry delay).
 */
export function classifyProviderFailure(failure, { module, stage, evidence_ref = null, tenant = null } = {}) {
  const status = Number.isInteger(failure?.status) ? failure.status : null;
  const code = String(failure?.code ?? '').toUpperCase();
  const text = `${failure?.name ?? ''} ${failure?.message ?? ''} ${code}`.toLowerCase();
  const where = { module, stage, evidence_ref, tenant };
  const make = (subcode, category, human, extra = {}) => makeCoreError({
    ...where, category, code: subcode, human_message: human,
    diagnostics: { status_class: status ? `${Math.floor(status / 100)}xx` : null, transient: PROVIDER_SUBCODE[subcode]?.transient ?? false, retry_after_ms: Number.isFinite(failure?.retryAfterMs) ? failure.retryAfterMs : null, ...extra },
  });
  if (TIMEOUT_CODES.has(code) || failure?.name === 'AbortError' || failure?.name === 'TimeoutError' || /timed? ?out|timeout/.test(text)) return make('PROVIDER_TIMEOUT', C.PROVIDER_FAILURE, 'The provider did not answer in time.');
  if (status === 429 || /rate.?limit|too many requests|quota/.test(text)) return make('PROVIDER_RATE_LIMITED', C.PROVIDER_FAILURE, 'The provider is limiting the request rate.');
  if (NETWORK_CODES.has(code) || /fetch failed|network|socket hang up|econnreset/.test(text)) return make('PROVIDER_NETWORK', C.PROVIDER_FAILURE, 'The connection to the provider failed.');
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|invalid api key|authentication/.test(text)) return make('PROVIDER_AUTH', C.PROVIDER_FAILURE, 'The provider did not accept the credentials.');
  if (/content.?(?:filter|polic)|safety|refus|inappropriate|moderation|not allowed to/.test(text)) return make('PROVIDER_REFUSAL', C.PROVIDER_FAILURE, 'The provider refused the request.');
  if (status === 404 || /model.?(?:not.?found|unavailable)|capability.?unavailable|unsupported (?:model|capability)|not supported/.test(text)) {
    return makeCoreError({ ...where, category: C.TOOL_CAPABILITY_LIMIT, code: 'PROVIDER_CAPABILITY_UNAVAILABLE', human_message: 'The provider does not offer the requested capability.', diagnostics: { status_class: status ? `${Math.floor(status / 100)}xx` : null } });
  }
  if (status === 408 || status === 502 || status === 503 || status === 504) return make('PROVIDER_UNAVAILABLE', C.PROVIDER_FAILURE, 'The provider is temporarily unavailable.');
  if (status !== null && status >= 500) return make('PROVIDER_SERVER_ERROR', C.PROVIDER_FAILURE, 'The provider failed on its side.');
  if (status !== null && status >= 400) return make('PROVIDER_REJECTED', C.PROVIDER_FAILURE, 'The provider rejected the request.');
  return make('PROVIDER_UNKNOWN', C.PROVIDER_FAILURE, redact('The provider failed in an unrecognised way.'));
}

export const isTransient = (error) => error?.diagnostics?.transient === true;
