// Nordla identity - "do these credentials belong to this Supabase user?" (ADR 0004, Core C1b).
//
// Answers ONLY that question. It does not decide which merchant the person belongs to, which role they have or which modules they may
// open (C2, C3), and it never creates a Nordla session: no session store is given to it, nothing is written to app_sessions, no
// cookie exists here. The final order will be: C1b identity -> C2 membership + role -> C3 module enabled -> only then a session.
//
//   verify({ email, password, ip }) ->
//     { ok: true,  identity: { userId } }
//     { ok: false, error: 'INVALID_CREDENTIALS' }   unknown address, wrong password, refused account, malformed input: ONE answer
//     { ok: false, error: 'RATE_LIMITED' }          too many failures: says neither which limit nor whether the account exists
//     { ok: false, error: 'UNAVAILABLE' }           Supabase Auth or the attempt store cannot answer (fail closed)
//
// Journal (identity_events): AUTH_SUCCEEDED / AUTH_FAILED / AUTH_RATE_LIMITED / AUTH_UNAVAILABLE. Never an e-mail, a password, an IP
// or a token. Failures carry only 16-hex prefixes of the keyed HMAC subjects (subjectRef / sourceRef): enough to see that several
// failures share a subject, useless without the secret key. The merchant_id of an event is the merchant of the SERVICE where the
// attempt happened (fixed at construction from the tenant resolver) - never a value sent by the caller, never an attribution of the
// person to that merchant.

import { randomUUID } from 'node:crypto';
import { normalizeEmail } from './rate-limit.js';

export const PUBLIC_ERRORS = Object.freeze(['INVALID_CREDENTIALS', 'RATE_LIMITED', 'UNAVAILABLE']);
const ALLOWED_INPUT = new Set(['email', 'password', 'ip', 'correlationId']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ref = (hmac) => hmac.slice(0, 16);

/**
 * @param {{
 *   gotrue: { verifyPassword(email: string, password: string): Promise<object> },
 *   limiter: { subjects: Function, isBlocked: Function, recordFailure: Function },
 *   events: { record: Function },
 *   service: { merchantId: string, module: string },   the calling service's own tenant (resolver) and name - journal context only
 *   newId?: () => string,
 * }} deps
 */
export function createIdentityVerifier({ gotrue, limiter, events, service, newId = randomUUID } = {}) {
  if (!gotrue || !limiter || !events || !service || !UUID.test(String(service.merchantId ?? '')) || typeof service.module !== 'string') {
    throw new TypeError('createIdentityVerifier needs gotrue, limiter, events and the service context { merchantId, module }');
  }
  const context = Object.freeze({ merchantId: service.merchantId.toLowerCase(), module: service.module });

  const journal = (type, outcome, correlationId, extra = {}) => events.record({ ...context, type, outcome, correlationId, ...extra });
  const quietly = async (p) => { try { await p; } catch { /* a failure answer never depends on the journal */ } };

  /**
   * @param {{ email: string, password: string, ip?: string, correlationId?: string }} input
   */
  async function verify(input = {}) {
    for (const k of Object.keys(input)) if (!ALLOWED_INPUT.has(k)) throw new TypeError(`verify() does not accept "${k}"`);
    const { email, password, ip } = input;
    const correlationId = UUID.test(String(input.correlationId ?? '')) ? input.correlationId : newId();
    const s = limiter.subjects({ email, ip });
    const refs = { subjectRef: ref(s.email), sourceRef: ref(s.ip) };

    let blocked;
    try { blocked = await limiter.isBlocked(s); } catch {
      await quietly(journal('AUTH_UNAVAILABLE', 'FAILURE', correlationId, { detail: { reason: 'RATE_LIMIT_STORE' } }));
      return { ok: false, error: 'UNAVAILABLE' };
    }
    if (blocked) {
      await quietly(journal('AUTH_RATE_LIMITED', 'DENIED', correlationId, { detail: refs }));
      return { ok: false, error: 'RATE_LIMITED' };
    }

    const normalized = normalizeEmail(email);
    const result = normalized ? await gotrue.verifyPassword(normalized, typeof password === 'string' ? password : '') : { ok: false, kind: 'INVALID' };

    if (result.ok) {
      try {
        await journal('AUTH_SUCCEEDED', 'SUCCESS', correlationId, { userId: result.userId, detail: { supabaseLocalLogout: result.localLogout } });
      } catch { return { ok: false, error: 'UNAVAILABLE' }; } // no unjournalled success
      return { ok: true, identity: Object.freeze({ userId: result.userId }) };
    }
    if (result.kind === 'UNAVAILABLE') {
      await quietly(journal('AUTH_UNAVAILABLE', 'FAILURE', correlationId, { detail: { reason: result.reason } }));
      return { ok: false, error: 'UNAVAILABLE' };
    }
    let blockedNow = false;
    try { blockedNow = (await limiter.recordFailure(s)).blocked; } catch { /* still a refusal; the next check fails closed if the store is down */ }
    await quietly(journal('AUTH_FAILED', 'FAILURE', correlationId, { detail: { ...refs, blockedNow } }));
    return { ok: false, error: 'INVALID_CREDENTIALS' };
  }

  return Object.freeze({ verify });
}
