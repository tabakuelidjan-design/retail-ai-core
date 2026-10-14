// Nordla identity - access: identity -> membership -> module -> session, and session -> access (ADR 0004, Core C3).
//
// A service is bound, by its own trusted configuration, to ONE merchant and ONE module (one service = one merchant, ADR 0003;
// choosing among several merchants is C15). Neither value is ever taken from a caller. Use createIdentityService (service.js) to
// build it from ONE validated configuration; createAccessService refuses a verifier whose context is another merchant or module.
//
//   authenticateAndOpenSession({ email, password, ipAddress })
//     1. C1b verifies the password (rate limits, journal)
//     2-8. through C1b's authorize hook - so a refusal counts against the limits like a wrong password - the database function
//        identity_open_session re-checks, in ONE transaction under the per-merchant lock, the ACTIVE membership (C2) and the ACTIVE
//        module (C3), reads the current role, inserts the session (token hash only) and the SESSION_OPENED journal entry
//     9. returns the opaque token ONCE to the server layer that will set the cookie later (C5 / C10 / C11)
//   resolveAccessSession(rawToken)
//     validates the session (C1a) against the service's merchant and module, then re-reads the membership and the entitlement on
//     EVERY call (no authorisation cache). Returns only { merchantId, userId, role, module }. A session that lost its membership
//     or its module is revoked and journalled.
//
// ONE public login failure: unknown address, wrong password, refused account, no membership, suspended membership, module absent,
// module suspended and a merchant the person does not belong to all give exactly LOGIN_FAILED (same code, status, structure and
// message). The journal keeps the real reason (AUTH_FAILED = invalid credentials; SESSION_ACCESS_DENIED / MODULE_ACCESS_DENIED with
// NOT_MEMBER, MEMBER_SUSPENDED, MODULE_NOT_ENABLED, MODULE_SUSPENDED). Only RATE_LIMITED and UNAVAILABLE are told apart. Supabase
// tokens, the token hash and the password are never returned.

import { randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';
import { loadIdentityConfig } from './config.js';
import { createSessionStore, generateSessionToken, hashSessionToken } from './sessions.js';
import { createMemberService } from './members.js';
import { createEventLog } from './events.js';
import { isModuleCode } from './modules.js';

export const OPEN_SESSION_FN = 'identity_open_session';
export const ENTITLEMENTS = 'module_entitlements';

/** The only answers a caller (later: the login route) can ever see. Frozen, compared as a whole by the tests. */
export const PUBLIC_RESULTS = Object.freeze({
  LOGIN_FAILED: Object.freeze({ ok: false, error: 'LOGIN_FAILED', status: 401, message: 'Impossible de vous connecter avec ces informations.' }),
  RATE_LIMITED: Object.freeze({ ok: false, error: 'RATE_LIMITED', status: 429, message: 'Trop de tentatives. Réessayez dans quelques minutes.' }),
  UNAVAILABLE: Object.freeze({ ok: false, error: 'UNAVAILABLE', status: 503, message: 'La connexion est momentanément indisponible. Réessayez plus tard.' }),
});
/** Refusal of a session on an ordinary request (not a login). */
export const SESSION_REFUSED = Object.freeze({ ok: false, error: 'SESSION_INVALID', status: 401, message: 'Votre session n\'est plus valide. Reconnectez-vous.' });
export const SESSION_UNAVAILABLE = PUBLIC_RESULTS.UNAVAILABLE;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN_KEYS = Object.freeze(['email', 'password', 'ipAddress']);

/**
 * @param {{
 *   supabase: { select: Function, update: Function, insert: Function, rpc: Function },
 *   merchantId: string, moduleCode: string,       the service's own trusted configuration
 *   verifier: { verify: Function, context: { merchantId: string, module: string } },   C1b verifier built for the SAME merchant and module
 *   config?: ReturnType<typeof loadIdentityConfig>, now?: () => Date, newId?: () => string, randomBytes?: (n: number) => Buffer,
 * }} deps
 */
export function createAccessService({ supabase, merchantId, moduleCode, verifier, config = loadIdentityConfig(), now = () => new Date(), newId = randomUUID, randomBytes = cryptoRandomBytes } = {}) {
  if (!supabase || !verifier || typeof verifier.verify !== 'function') throw new TypeError('createAccessService needs a Supabase client and a C1b verifier');
  if (typeof merchantId !== 'string' || !UUID.test(merchantId)) throw new TypeError('createAccessService: merchantId must be the service\'s configured merchant UUID');
  if (!isModuleCode(moduleCode)) throw new TypeError('createAccessService: moduleCode must be a registered module (finance, analytics, growth)');
  const merchant = merchantId.toLowerCase();
  const ctx = verifier.context;
  if (!ctx || String(ctx.merchantId).toLowerCase() !== merchant || ctx.module !== moduleCode) {
    throw new TypeError('createAccessService: the C1b verifier was built for another merchant or module (inconsistent service configuration)');
  }
  const sessions = createSessionStore({ supabase, config, now, randomBytes });
  const members = createMemberService({ supabase, merchantId: merchant, module: moduleCode, now, newId });
  const events = createEventLog({ supabase, now, newId });

  /**
   * @param {{ email: string, password: string, ipAddress?: string }} input  any other field is a programming error and throws
   * @returns {Promise<{ ok: true, token: string, session: object } | typeof PUBLIC_RESULTS[keyof typeof PUBLIC_RESULTS]>}
   */
  async function authenticateAndOpenSession(input = {}) {
    if (input === null || typeof input !== 'object') throw new TypeError('authenticateAndOpenSession() takes { email, password, ipAddress }');
    for (const k of Object.keys(input)) if (!LOGIN_KEYS.includes(k)) throw new TypeError(`authenticateAndOpenSession() does not accept "${k}"`);
    const token = generateSessionToken(randomBytes);
    let expiresAt;
    // 2-8: run by C1b right after a correct password, before the attempt is settled
    const authorize = async (userId, correlationId) => {
      const at = now();
      expiresAt = new Date(at.getTime() + config.absoluteMs).toISOString();
      let out;
      try {
        out = await supabase.rpc(OPEN_SESSION_FN, { p_user: userId, p_merchant: merchant, p_module: moduleCode, p_token_hash: hashSessionToken(token), p_now: at.toISOString(), p_expires_at: expiresAt, p_correlation: correlationId });
      } catch { return { ok: false, unavailable: true }; } // one transaction: nothing was created
      if (!out || out.ok !== true || typeof out.session_id !== 'string') return { ok: false }; // precise code already journalled by the database
      return { ok: true, value: { sessionId: out.session_id, role: out.role } };
    };
    const r = await verifier.verify({ email: input.email, password: input.password, ip: input.ipAddress, correlationId: newId() }, { authorize });
    if (!r.ok) return r.error === 'RATE_LIMITED' ? PUBLIC_RESULTS.RATE_LIMITED : r.error === 'UNAVAILABLE' ? PUBLIC_RESULTS.UNAVAILABLE : PUBLIC_RESULTS.LOGIN_FAILED;
    // 9. the token, once, for the server layer
    return Object.freeze({
      ok: true,
      token,
      session: Object.freeze({ sessionId: r.authorization.sessionId, merchantId: merchant, userId: r.identity.userId, role: r.authorization.role, module: moduleCode, expiresAt }),
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
   * @param {string} rawToken the opaque token sent back by the browser (later: the cookie value). The merchant and the module are
   *   the service's own; any extra argument is a programming error and throws.
   * @returns {Promise<{ ok: true, merchantId: string, userId: string, role: string, module: string } | typeof SESSION_REFUSED>}
   */
  async function resolveAccessSession(rawToken, ...extra) {
    if (extra.length) throw new TypeError('resolveAccessSession() takes only the session token (merchant and module come from the service)');
    if (rawToken !== undefined && rawToken !== null && typeof rawToken !== 'string') throw new TypeError('resolveAccessSession() takes the token as a string');
    let v;
    try { v = await sessions.validate(rawToken, { merchantId: merchant, module: moduleCode }); } catch { return SESSION_UNAVAILABLE; }
    if (!v.ok) return SESSION_REFUSED;
    const s = v.session; // merchant, user and module come ONLY from the session row
    let membership;
    try { membership = await members.requireActiveMembership(s.userId); } catch { return SESSION_UNAVAILABLE; }
    if (!membership.ok) { await closeLostAccess(s, 'SESSION_ACCESS_DENIED', membership.code === 'SUSPENDED' ? 'MEMBER_SUSPENDED' : 'NOT_MEMBER'); return SESSION_REFUSED; }
    let rows;
    try { rows = await supabase.select(ENTITLEMENTS, { select: 'merchant_id,module_code,status', merchant_id: `eq.${s.merchantId}`, module_code: `eq.${s.module}`, limit: '1' }); } catch { return SESSION_UNAVAILABLE; }
    const ent = (rows ?? []).find((r) => String(r.merchant_id).toLowerCase() === s.merchantId && r.module_code === s.module);
    if (!ent || ent.status !== 'ACTIVE') { await closeLostAccess(s, 'MODULE_ACCESS_DENIED', ent ? 'MODULE_SUSPENDED' : 'MODULE_NOT_ENABLED'); return SESSION_REFUSED; }
    return Object.freeze({ ok: true, merchantId: s.merchantId, userId: s.userId, role: membership.role, module: s.module });
  }

  return Object.freeze({ context: Object.freeze({ merchantId: merchant, module: moduleCode }), authenticateAndOpenSession, resolveAccessSession });
}
