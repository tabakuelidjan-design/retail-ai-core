// Nordla single sign-on contract v2 (Core -> Finance, Core -> Analytics). Phase 2.
//
// 1. Who issues: ONLY the Nordla Core server, for a person who already holds a valid Nordla session and whose access the Core checked
//    (membership ACTIVE, role allowed for the module, entitlement ACTIVE for THIS merchant). The browser never builds a ticket.
// 2. Ticket (HMAC-SHA256, one key per audience, single use, 60 s, never more than 120 s):
//      v    2
//      iss  'nordla-core'
//      aud  'nordla-finance' | 'nordla-analytics'   (a ticket never works for another audience)
//      m    merchant id (the merchant this service serves)
//      u    person id (users.id)
//      r    role at issuance (OWNER | ADMIN | ACCOUNTANT | VIEWER)
//      mod  module key ('finance' | 'analytics')
//      jti  random id, iat, exp
// 3. Who checks: the SERVICE, on every use. It refuses unless the ticket is valid AND the person's CURRENT access still holds:
//    not suspended, not removed, same role as the ticket, role still allowed for the module, entitlement still ACTIVE.
//    So a person suspended or removed after issuance loses access as soon as they use a ticket.
//    The ticket is the only identity the service accepts from the Nordla side; no shared permanent token is used for it.
// Keys: one per module, canonical base64url of 32 random bytes, never the dashboard token (identity/sso-keys.js, docs/sso-keys.md).
// 4. Return to Core: each service keeps a link back to the Nordla home (NORDLA_HOME_URL, https only); it carries no ticket.
// 5. Refusals are named (SSO_*, MEMBER_*, ROLE_CHANGED, MODULE_*) in the journal; the browser sees only a generic 403.
//
// Shared-token access is a separate legacy path; hosted services can disable it with NORDLA_SSO_ONLY=1.

import { createSessionAssurance } from './session-assurance.js';
import { MODULE_CODES } from './modules.js';
import { decideModuleOpen } from './module-catalog.js';
import { createMfaRule } from '../settings-security/mfa-rule.js';

export const SSO_CONTRACT = Object.freeze({
  version: 2,
  issuer: 'nordla-core',
  ticketTtlSeconds: 60,
  maxTtlSeconds: 120,
  audienceOf: Object.freeze({ finance: 'nordla-finance', analytics: 'nordla-analytics' }),
  modules: Object.freeze(['finance', 'analytics']),
});

const MEMBERS = 'merchant_members';
const ENTITLEMENTS = 'module_entitlements';

/**
 * Builds the access check a service runs at USE time. Pure apart from the injected reader: `supabase.select(table, query)`.
 * Default deny: any missing row, unknown status or read error is a refusal.
 * @returns {(input: {merchantId: string, userId: string, role: string, module: string}) => Promise<{ok: true, role: string} | {ok: false, code: string}>}
 */
export function createAccessChecker({ supabase, merchantId, requireCoreSession = false }) {
  const merchant = String(merchantId ?? '').toLowerCase();
  if (!merchant) throw new TypeError('createAccessChecker: merchantId is required');
  // No cache here: removing a factor or enabling the rule must affect an already open service session on its next request.
  const mfaRule = typeof supabase?.rpc === 'function' ? createMfaRule({ supabase, ttlMs: 0 }) : null;
  const assurance = createSessionAssurance({ supabase });
  return async function checkAccess({ merchantId: claimed, userId, role, module, authSessionId = null, trace = null }) {
    if (String(claimed ?? '').toLowerCase() !== merchant) return { ok: false, code: 'SSO_WRONG_MERCHANT' };
    if (!SSO_CONTRACT.modules.includes(module) || !MODULE_CODES.includes(module)) return { ok: false, code: 'MODULE_UNKNOWN' };
    if (typeof userId !== 'string' || !userId) return { ok: false, code: 'NOT_MEMBER' };
    // Optional trace (timings only, never a value): each read's start and duration, relative to the start of this check, so overlaps are visible.
    const started = performance.now();
    const step = (name, p) => { const s = performance.now(); return Promise.resolve(p).finally(() => { if (trace) trace.push(`${name};start=${(s - started).toFixed(1)};dur=${(performance.now() - s).toFixed(1)}`); }); };
    try {
      // the membership and the module entitlement are independent reads: they run together (same answers, one round trip less)
      const [rows, ent] = await Promise.all([
        step('members', supabase.select(MEMBERS, { select: 'role,status,removed_at', merchant_id: `eq.${merchant}`, user_id: `eq.${userId}`, limit: '1' })),
        step('entitlement', supabase.select(ENTITLEMENTS, { select: 'merchant_id,module_code,status', merchant_id: `eq.${merchant}`, module_code: `eq.${module}`, limit: '1' }).then((x) => x ?? [])),
      ]);
      const m = (rows ?? [])[0];
      if (!m || String(m.merchant_id ?? merchant).toLowerCase() !== merchant) return { ok: false, code: 'NOT_MEMBER' };
      if (m.removed_at) return { ok: false, code: 'NOT_MEMBER' };
      if (m.status !== 'ACTIVE') return { ok: false, code: 'MEMBER_SUSPENDED' };
      if (m.role !== role) return { ok: false, code: 'ROLE_CHANGED' };
      const e = ent[0];
      if (!e || e.status !== 'ACTIVE' || String(e.merchant_id ?? merchant).toLowerCase() !== merchant) return { ok: false, code: 'MODULE_NOT_ENABLED' };
      const d = decideModuleOpen({ key: module, role, activeCodes: new Set([module]) });
      if (!d.ok) return { ok: false, code: d.code === 'FORBIDDEN' ? 'MODULE_ROLE_FORBIDDEN' : d.code };
      if (!mfaRule) return { ok: false, code: 'MFA_POLICY_UNAVAILABLE' };
      // the session assurance and the MFA rule are independent: both are checked on every request, together (the first refusal in the same order wins)
      const [source, blocked] = await Promise.all([
        (authSessionId || requireCoreSession) ? step('assurance', assurance.check({merchantId:merchant,userId,sessionId:authSessionId,module:'sourcing'})) : Promise.resolve({ ok: true }),
        step('mfa', mfaRule.blocked({ merchantId: merchant, userId, sessionId:authSessionId, module:'sourcing' })),
      ]);
      if (!source.ok) return {ok:false,code:source.code};
      if (blocked) return { ok: false, code: 'MFA_REQUIRED_FOR_ROLE' };
      return { ok: true, role };
    } catch (error) {
      if (error?.code === 'MFA_POLICY_UNAVAILABLE') return { ok: false, code: 'MFA_POLICY_UNAVAILABLE' };
      return { ok: false, code: 'SSO_ACCESS_UNAVAILABLE' };
    }
  };
}
