// "Exiger la double authentification des Propriétaires et Administrateurs": reading the rule, deciding per request, changing it (database functions of migration 20261118130000).
// The HTTP gate asks `blocked(access)` on EVERY request, so a session that was already open, a promotion to administrator or a removed factor take effect at once.
// The answer per (merchant, person) is cached for a few seconds only (a verified factor added through Sécurité clears the cache of that person immediately).
// If the rule cannot be verified, business requests stay closed. Enrolment and sign-in remain reachable at the HTTP gate.
import { randomUUID } from 'node:crypto';
import { createSecurityMonitor } from '../security/monitor.js';

export const EXEMPT = /^\/api\/(security|auth)(\/|$)/;
const rows = (r) => (Array.isArray(r) ? r : r == null ? [] : [r]);
export class MfaPolicyError extends Error {
  constructor() { super('MFA policy could not be verified'); this.name = 'MfaPolicyError'; this.code = 'MFA_POLICY_UNAVAILABLE'; }
}

export function createMfaRule({ supabase, now = () => Date.now(), ttlMs = 8000, newId = randomUUID, module = 'security' }) {
  if (!supabase?.rpc) throw new TypeError('createMfaRule needs a Supabase client');
  const cache = new Map();
  const report = createSecurityMonitor({ module: 'security', now });
  const unavailable = () => { report('MFA_POLICY_UNAVAILABLE'); return new MfaPolicyError(); };
  async function status(merchantId, userId) {
    const k = `${merchantId}|${userId}`; const hit = cache.get(k); if (hit && now() - hit.at < ttlMs) return hit.v;
    let v; try { v = await supabase.rpc('security_mfa_status', { p_merchant: merchantId, p_user: userId }); } catch { throw unavailable(); }
    if (!v || ['required', 'privileged', 'compliant'].some((key) => typeof v[key] !== 'boolean')) throw unavailable();
    cache.set(k, { at: now(), v }); if (cache.size > 2000) cache.clear(); return v;
  }
  return Object.freeze({
    status,
    /** true when this request must be refused: the rule is ON, the member is OWNER/ADMIN and has no verified second factor. */
    async blocked(access) { const s = await status(access.merchantId, access.userId); return Boolean(s.required && s.privileged && !s.compliant); },
    forget(merchantId, userId) { cache.delete(`${merchantId}|${userId}`); },
    forgetAll() { cache.clear(); },
    async enabled(merchantId) {
      let result;
      try { result = await supabase.select('merchant_security_settings', { merchant_id: `eq.${merchantId}`, select: 'require_mfa_privileged', limit: '1' }); } catch { throw unavailable(); }
      const row = rows(result)[0];
      if (row && typeof row.require_mfa_privileged !== 'boolean') throw unavailable();
      return row?.require_mfa_privileged ?? false;
    },
    async noncompliant(merchantId) { try { return rows(await supabase.rpc('security_mfa_noncompliant', { p_merchant: merchantId })).map((r) => ({ id: r.user_id, role: r.role, label: r.label })); } catch { return null; } },
    async set({ merchantId, actor, enabled, at = new Date() }) {
      const r = await supabase.rpc('security_set_require_mfa', { p_merchant: merchantId, p_actor: actor, p_enabled: Boolean(enabled), p_now: at.toISOString(), p_correlation: newId(), p_module: module });
      this.forgetAll(); return r;
    },
  });
}
