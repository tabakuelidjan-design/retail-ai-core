// Nordla identity - access: identity -> membership -> module -> session, and session -> access (ADR 0004, Core C3).
//
// A service is bound, by its own trusted configuration, to ONE merchant and ONE module (one service = one merchant, ADR 0003;
// choosing among several merchants is C15). Neither value is ever taken from a browser field.
//
//   authenticateAndOpenSession({ email, password, ipAddress })
//     1. C1b verifies the password (rate limits, journal)            -> the Supabase user id, nothing else
//     2-6. the database function identity_open_session re-checks, in ONE transaction under the per-merchant lock, that the
//        membership is ACTIVE (C2) and the module ACTIVE for the merchant (C3), reads the current role,
//     7-8. inserts the session (token hash only) and the SESSION_OPENED journal entry in the same transaction
//     9. returns the opaque token ONCE to the server layer that will set the cookie later (C5 / C10 / C11)
//   resolveAccessSession(rawToken, expectedModule)
//     validates the session (C1a: hash, expiry, inactivity, revocation, merchant and module of the service), then re-reads the
//     membership and the entitlement from the database on EVERY call - no authorisation cache. Returns only
//     { merchantId, userId, role, module }. A session whose membership or module is no longer ACTIVE is revoked and journalled.
//
// Public answers never tell membership and subscription problems apart: ACCESS_DENIED covers no membership, suspended membership,
// module not enabled and module suspended (the journal keeps the precise code). Supabase tokens, the token hash and the password are
// never returned.

import { randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';
import { loadIdentityConfig } from './config.js';
import { createSessionStore, generateSessionToken, hashSessionToken } from './sessions.js';
import { createMemberService } from './members.js';
import { createEventLog } from './events.js';
import { isModuleCode } from './modules.js';

export const OPEN_SESSION_FN = 'identity_open_session';
export const ENTITLEMENTS = 'module_entitlements';
export const PUBLIC_ERRORS = Object.freeze(['INVALID_CREDENTIALS', 'RATE_LIMITED', 'UNAVAILABLE', 'ACCESS_DENIED']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DENIED = Object.freeze({ ok: false, error: 'ACCESS_DENIED' });
const UNAVAILABLE = Object.freeze({ ok: false, error: 'UNAVAILABLE' });

/**
 * @param {{
 *   supabase: { select: Function, insert: Function, update: Function, rpc: Function },
 *   merchantId: string, moduleCode: string,       the service's own trusted configuration
 *   verifier: { verify: Function },               C1b verifier built for the same service (merchant + module journal context)
 *   config?: ReturnType<typeof loadIdentityConfig>, now?: () => Date, newId?: () => string, randomBytes?: (n: number) => Buffer,
 * }} deps
 */
export function createAccessService({ supabase, merchantId, moduleCode, verifier, config = loadIdentityConfig(), now = () => new Date(), newId = randomUUID, randomBytes = cryptoRandomBytes } = {}) {
  if (!supabase || !verifier || typeof verifier.verify !== 'function') throw new TypeError('createAccessService needs a Supabase client and a C1b verifier');
  if (typeof merchantId !== 'string' || !UUID.test(merchantId)) throw new TypeError('createAccessService: merchantId must be the service\'s configured merchant UUID');
  if (!isModuleCode(moduleCode)) throw new TypeError('createAccessService: moduleCode must be a registered module (finance, analytics, growth)');
  const merchant = merchantId.toLowerCase();
  const sessions = createSessionStore({ supabase, config, now, randomBytes });
  const members = createMemberService({ supabase, merchantId: merchant, module: moduleCode, now, newId });
  const events = createEventLog({ supabase, now, newId });

  /**
   * @param {{ email: string, password: string, ipAddress?: string }} input
   * @returns {Promise<{ ok: true, token: string, session: object } | { ok: false, error: string }>}
   */
  async function authenticateAndOpenSession(input = {}) {
    for (const k of Object.keys(input)) if (!['email', 'password', 'ipAddress'].includes(k)) throw new TypeError(`authenticateAndOpenSession() does not accept "${k}"`);
    const correlationId = newId();
    // 1. identity (C1b)
    const identity = await verifier.verify({ email: input.email, password: input.password, ip: input.ipAddress, correlationId });
    if (!identity.ok) return Object.freeze({ ok: false, error: identity.error });
    // 2-8. membership + module re-checked and session + journal written in ONE database transaction
    const token = generateSessionToken(randomBytes);
    const at = now();
    let out;
    try {
      out = await supabase.rpc(OPEN_SESSION_FN, {
        p_user: identity.identity.userId, p_merchant: merchant, p_module: moduleCode, p_token_hash: hashSessionToken(token),
        p_now: at.toISOString(), p_expires_at: new Date(at.getTime() + config.absoluteMs).toISOString(), p_correlation: correlationId,
      });
    } catch { return UNAVAILABLE; } // nothing was created: the function is one transaction
    if (!out || out.ok !== true || typeof out.session_id !== 'string') return DENIED;
    // 9. the token, once, for the server layer
    return Object.freeze({
      ok: true,
      token,
      session: Object.freeze({ sessionId: out.session_id, merchantId: merchant, userId: identity.identity.userId, role: out.role, module: moduleCode, expiresAt: new Date(at.getTime() + config.absoluteMs).toISOString() }),
    });
  }

  /** Revokes a session that lost its membership or module, and journals why (best effort: the answer is a refusal anyway). */
  async function closeLostAccess(session, type, code) {
    try { await sessions.revoke(session.id, { reason: 'REVOKED' }); } catch { /* the next request re-checks anyway */ }
    try {
      await events.record({ merchantId: merchant, userId: session.userId, sessionId: session.id, module: moduleCode, type, outcome: 'DENIED', entity: { type: 'module', id: moduleCode }, detail: { code } });
    } catch { /* journal unavailable: still a refusal */ }
  }

  /**
   * @param {string} rawToken the opaque token sent back by the browser (later: the cookie value)
   * @param {string} [expectedModule] the module of THIS service (anything else is refused)
   * @returns {Promise<{ ok: true, merchantId: string, userId: string, role: string, module: string } | { ok: false, error: string }>}
   */
  async function resolveAccessSession(rawToken, expectedModule = moduleCode) {
    if (expectedModule !== moduleCode) return DENIED; // a service only ever serves its own module
    let v;
    try { v = await sessions.validate(rawToken, { merchantId: merchant, module: moduleCode }); } catch { return UNAVAILABLE; }
    if (!v.ok) return DENIED;
    const s = v.session; // merchant, user and module come ONLY from the session row
    let membership;
    try { membership = await members.requireActiveMembership(s.userId); } catch { return UNAVAILABLE; }
    if (!membership.ok) { await closeLostAccess(s, 'SESSION_ACCESS_DENIED', membership.code === 'SUSPENDED' ? 'MEMBER_SUSPENDED' : 'NOT_MEMBER'); return DENIED; }
    let rows;
    try { rows = await supabase.select(ENTITLEMENTS, { select: 'merchant_id,module_code,status', merchant_id: `eq.${s.merchantId}`, module_code: `eq.${s.module}`, limit: '1' }); } catch { return UNAVAILABLE; }
    const ent = (rows ?? []).find((r) => String(r.merchant_id).toLowerCase() === s.merchantId && r.module_code === s.module);
    if (!ent || ent.status !== 'ACTIVE') { await closeLostAccess(s, 'MODULE_ACCESS_DENIED', ent ? 'MODULE_SUSPENDED' : 'MODULE_NOT_ENABLED'); return DENIED; }
    return Object.freeze({ ok: true, merchantId: s.merchantId, userId: s.userId, role: membership.role, module: s.module });
  }

  return Object.freeze({ authenticateAndOpenSession, resolveAccessSession });
}
