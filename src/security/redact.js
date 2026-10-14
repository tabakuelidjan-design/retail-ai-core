// Nordla HTTP security (Core C4) - log redaction and public errors.
//
// redact(): recursive copy where every sensitive KEY (password, token, authorization, cookie, secret, e-mail, IP, session, CSRF,
// key...) and every sensitive-looking VALUE (e-mail address, bearer / JWT / session token, IP address, long hex secret) is replaced
// by '[REDACTED]' - never partially masked. requestLogEntry() keeps only an allow-list of safe fields. publicError() never returns a
// stack, a local path, a raw database / Supabase message or any secret.

import { isIP } from 'node:net';

export const REDACTED = '[REDACTED]';
// normalised key (lower case, letters and digits only) containing one of these -> redacted
const SENSITIVE_KEY_PARTS = ['pass', 'token', 'auth', 'cookie', 'secret', 'mail', 'session', 'csrf', 'apikey', 'privatekey', 'credential', 'bearer', 'signature'];
const SENSITIVE_KEYS_EXACT = ['ip', 'ipaddress', 'clientip', 'remoteaddress', 'xrealip', 'xforwardedfor', 'key', 'sid'];
const SENSITIVE_VALUES = [
  /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i, // e-mail address
  /^bearer\s+\S/i, // authorization header
  /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/, // JWT
  /^[A-Za-z0-9_-]{43}$/, // Nordla session / CSRF token shape (32 bytes, base64url)
  /^[0-9a-f]{64}$/i, // 256-bit hex (hash, key)
  /^shp(at|ss|ca|pa)_/i, /^sk_(live|test)_/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const MAX_DEPTH = 8;

const sensitiveKey = (k) => {
  const n = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEYS_EXACT.includes(n) || SENSITIVE_KEY_PARTS.some((p) => n.includes(p));
};
const sensitiveValue = (v) => typeof v === 'string' && (isIP(v.trim()) !== 0 || SENSITIVE_VALUES.some((re) => re.test(v.trim())));

/** A redacted deep copy (objects, arrays, Errors). Never mutates its input. */
export function redact(value, depth = 0) {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value instanceof Error) return { name: value.name, code: value.code ?? null }; // no message, no stack
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sensitiveKey(k) ? REDACTED : redact(v, depth + 1);
    return out;
  }
  return sensitiveValue(value) ? REDACTED : value;
}

const ROUTE = /^\/[A-Za-z0-9/_:.-]{0,200}$/;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/**
 * The only request log line shape: requestId, method, normalised route (a pattern such as /api/session, never a query string),
 * status, duration, module and a non-sensitive internal code. Anything else is dropped.
 */
export function requestLogEntry({ requestId, method, route, status, durationMs, module, code = null } = {}) {
  return Object.freeze({
    requestId: typeof requestId === 'string' && /^[0-9a-f-]{36}$/.test(requestId) ? requestId : null,
    method: typeof method === 'string' && /^[A-Z]{3,7}$/.test(method) ? method : null,
    route: typeof route === 'string' && ROUTE.test(route) ? route : null,
    status: Number.isInteger(status) ? status : null,
    durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    module: typeof module === 'string' && /^[a-z][a-z0-9_-]{1,39}$/.test(module) ? module : null,
    code: typeof code === 'string' && CODE.test(code) ? code : null,
  });
}

/** Public error bodies: generic, French, with a request id - never a stack, a path, a raw upstream message or a secret. */
export const PUBLIC_ERRORS = Object.freeze({
  BAD_REQUEST: Object.freeze({ error: 'BAD_REQUEST', status: 400, message: 'Requête invalide.' }),
  FORBIDDEN: Object.freeze({ error: 'FORBIDDEN', status: 403, message: 'Action refusée.' }),
  METHOD_NOT_ALLOWED: Object.freeze({ error: 'METHOD_NOT_ALLOWED', status: 405, message: 'Méthode non autorisée.' }),
  PAYLOAD_TOO_LARGE: Object.freeze({ error: 'PAYLOAD_TOO_LARGE', status: 413, message: 'Requête trop volumineuse.' }),
  UNSUPPORTED_MEDIA_TYPE: Object.freeze({ error: 'UNSUPPORTED_MEDIA_TYPE', status: 415, message: 'Format de requête non accepté.' }),
  INTERNAL_ERROR: Object.freeze({ error: 'INTERNAL_ERROR', status: 500, message: 'Une erreur est survenue. Réessayez plus tard.' }),
});

/** The public body for any thrown error: a known public code, else INTERNAL_ERROR. Never the error's message or stack. */
export function publicError(err, { requestId = null } = {}) {
  const known = err && typeof err.publicCode === 'string' && PUBLIC_ERRORS[err.publicCode];
  const base = known || PUBLIC_ERRORS.INTERNAL_ERROR;
  return Object.freeze({ error: base.error, status: base.status, message: base.message, requestId: typeof requestId === 'string' ? requestId : null });
}

/** An error carrying a public code (BAD_REQUEST, FORBIDDEN, ...) and a non-sensitive internal code for the logs. */
export class HttpSecurityError extends Error {
  constructor(publicCode, internalCode) { super(internalCode); this.name = 'HttpSecurityError'; this.publicCode = publicCode; this.code = internalCode; }
}
