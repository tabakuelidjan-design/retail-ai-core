// Nordla HTTP security (Core C4) - stateless CSRF protection bound to the session and the module.
//
//   csrfToken = base64url( HMAC-SHA-256( NORDLA_CSRF_KEY, "nordla-csrf:v1:<module>:<raw session token>" ) )
//
// Nothing is stored: the server recomputes the expected value from the session cookie. A mutation is accepted only when
//   1. the Origin is exactly an allowed origin of this host (checked by the caller with checkOrigin, see guards below);
//   2. the X-Nordla-CSRF header and the CSRF cookie are both present and equal;
//   3. both equal the value derived from THIS session and THIS module (a token of another session or module never matches;
//      a new login gives a new session, so an old token stops matching).
// Every comparison is constant-time (crypto.timingSafeEqual on equal-length buffers). The CSRF token is never logged.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const CSRF_HEADER = 'x-nordla-csrf';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Constant-time equality of two strings (false when lengths differ, without comparing contents). */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8'); const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * @param {{ key: Buffer, moduleCode: string }} cfg  key: >= 32 bytes, distinct from the rate-limit key (config.js)
 */
export function createCsrf({ key, moduleCode }) {
  /** The CSRF token of a session in this module. */
  const tokenFor = (sessionToken) => {
    if (typeof sessionToken !== 'string' || !TOKEN.test(sessionToken)) return null;
    return createHmac('sha256', key).update(`nordla-csrf:v1:${moduleCode}:${sessionToken}`, 'utf8').digest('base64url');
  };

  /**
   * Checks the CSRF pair of a mutating request.
   * @param {{ sessionToken: string|null, cookieToken: string|null, headerToken: string|undefined }} p
   * @returns {{ ok: true } | { ok: false, code: string }}
   */
  function verify({ sessionToken, cookieToken, headerToken }) {
    const expected = tokenFor(sessionToken);
    if (!expected) return { ok: false, code: 'CSRF_NO_SESSION' };
    if (typeof headerToken !== 'string' || headerToken === '') return { ok: false, code: 'CSRF_HEADER_MISSING' };
    if (typeof cookieToken !== 'string' || cookieToken === '') return { ok: false, code: 'CSRF_COOKIE_MISSING' };
    const pairOk = constantTimeEqual(headerToken, cookieToken);
    const sessionOk = constantTimeEqual(headerToken, expected);
    return pairOk && sessionOk ? { ok: true } : { ok: false, code: 'CSRF_MISMATCH' };
  }

  return Object.freeze({ tokenFor, verify });
}
