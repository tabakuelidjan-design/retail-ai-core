// Paramètres > Sécurité: what Nordla really does for the signed-in person, nothing more. It REUSES the identity layer (src/identity): Supabase Auth checks the password
// (createGoTrueVerifier), Nordla sessions live in app_sessions (one row per module and merchant), the journal is identity_events. No new session mechanism.
//
// Every method takes the SESSION's identity ({ userId, merchantId, sessionId?, role, module }): a person only ever sees or revokes their OWN sessions, never another account's.
// Actions that cannot really run are reported as { available: false, reason } and their routes refuse (FEATURE_UNAVAILABLE): the page never offers a button the server cannot honour.
import { hashSessionToken } from '../identity/sessions.js';
import { moduleOf } from '../identity/modules.js';

export class SecurityError extends Error { constructor(code, message, extra = {}) { super(message); this.name = 'SecurityError'; this.code = code; Object.assign(this, extra); } }
export const MANAGER_ROLES = Object.freeze(['OWNER', 'ADMIN']);
export const MIN_PASSWORD = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Events shown to the person (their own, in this merchant). Team events (invitations, roles, suspensions) stay in Équipe et accès. */
export const ACTIVITY_LABELS = Object.freeze({
  SESSION_OPENED: 'Connexion', LOGOUT: 'Déconnexion', LOGOUT_ALL: 'Déconnexion de toutes les sessions', SESSION_REVOKED: 'Autres sessions déconnectées',
  PASSWORD_CHANGED: 'Mot de passe changé', PASSWORD_CHANGE_FAILED: 'Changement de mot de passe refusé', SESSION_ACCESS_DENIED: 'Session fermée (accès retiré)',
});
const DETAIL_KEYS = ['scope', 'count', 'code']; // the only detail fields ever returned

const NO_MFA_REASON = 'La connexion Nordla ne demande pas encore de second facteur : un facteur enregistré chez le fournisseur ne protégerait pas la connexion. L’inscription reste désactivée tant que ce contrôle n’existe pas.';
const NO_RECOVERY_REASON = 'Nordla n’a pas encore de page de réinitialisation : le fournisseur enverrait un lien qui n’ouvre aucun écran Nordla. En cas de perte du mot de passe, contactez le propriétaire du compte Nordla.';

/**
 * @param {{ supabase, adminAuth: { getUser(id): Promise<object|null>, setPassword(id, pw): Promise<boolean> }|null, verifier: { verifyPassword(email, pw): Promise<object> }|null,
 *   events: { record: Function }, sessions: { logoutCurrent: Function }, rules: object, now?: () => Date, idleMs?: number }} deps
 */
export function createSecurityService({ supabase, adminAuth = null, verifier = null, events, sessions, rules, now = () => new Date(), idleMs = 7_200_000 }) {
  const failures = new Map(); // password-change attempts per person: 5 failures / 15 min
  const recent = (u) => (failures.get(u) ?? []).filter((t) => now().getTime() - t < 900_000);
  const blocked = (u) => recent(u).length >= 5;
  const failed = (u) => failures.set(u, [...recent(u), now().getTime()]);
  const journal = async (me, type, outcome, detail = {}, entity = null) => {
    try { await events.record({ merchantId: me.merchantId, userId: me.userId, sessionId: me.sessionId ?? null, module: me.module, type, outcome, ...(entity ? { entity } : {}), detail }); return true; } catch { return false; }
  };
  const need = (me) => { if (!me || !UUID.test(me.userId ?? '') || !UUID.test(me.merchantId ?? '')) throw new SecurityError('SESSION_REQUIRED', 'Session requise.'); return me; };

  /** The id of the session behind a cookie token, only when that session belongs to this person. */
  async function currentSessionId(me, token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const rows = await supabase.select('app_sessions', { select: 'id,user_id', token_hash: `eq.${hashSessionToken(token)}`, limit: '1' });
    return rows?.[0] && String(rows[0].user_id).toLowerCase() === me.userId ? rows[0].id : null;
  }

  async function account(me) {
    need(me);
    let user = null; let providerOk = Boolean(adminAuth);
    if (adminAuth) { try { user = await adminAuth.getUser(me.userId); } catch { providerOk = false; } }
    const factors = Array.isArray(user?.factors) ? user.factors.filter((f) => f.status === 'verified').length : null;
    const canPassword = Boolean(adminAuth && verifier && providerOk && user?.email);
    return {
      scope: 'PERSONAL',
      signInMethod: { id: 'email_password', label: 'Adresse e-mail et mot de passe', providers: user?.identities?.map((i) => i.provider) ?? null },
      email: user?.email ?? null, lastSignInAt: user?.last_sign_in_at ?? null, providerReachable: providerOk,
      mfa: { enrolledFactors: factors, requiredAtSignIn: false, enrollment: { available: false, reason: NO_MFA_REASON }, label: 'Non demandée à la connexion Nordla' },
      passkeys: { available: false, reason: 'Les clés d’accès (passkeys) sont prévues pour une version suivante.' },
      password: { available: canPassword, minLength: MIN_PASSWORD, reason: canPassword ? null : 'Le service d’authentification n’est pas joignable depuis ce serveur.' },
      recovery: { available: false, reason: NO_RECOVERY_REASON },
    };
  }

  async function listSessions(me, token) {
    need(me);
    const cur = await currentSessionId(me, token);
    const t = now().getTime();
    const rows = (await supabase.select('app_sessions', { select: 'id,merchant_id,module,created_at,last_seen_at,expires_at', user_id: `eq.${me.userId}`, revoked_at: 'is.null', expires_at: `gt.${now().toISOString()}`, order: 'created_at.desc', limit: '50' })) ?? [];
    const live = rows.filter((r) => t - new Date(r.last_seen_at).getTime() < idleMs);
    const ids = [...new Set(live.map((r) => r.merchant_id))];
    const names = ids.length ? Object.fromEntries(((await supabase.select('merchants', { select: 'id,name', id: `in.(${ids.join(',')})` })) ?? []).map((m) => [m.id, m.name])) : {};
    const list = live.map((r) => ({ id: r.id, current: r.id === cur, module: r.module, moduleLabel: moduleOf(r.module)?.name ?? r.module, merchantName: names[r.merchant_id] ?? null, sameMerchant: String(r.merchant_id).toLowerCase() === me.merchantId, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, device: null }));
    const others = list.filter((s) => !s.current);
    return { scope: 'PERSONAL', sessions: list, currentFound: Boolean(cur), deviceInfo: { available: false, reason: 'Nordla n’enregistre ni le navigateur ni l’appareil d’une session.' },
      scopeOfOthers: { count: others.length, modules: [...new Set(others.map((s) => s.moduleLabel))], merchants: [...new Set(others.map((s) => s.merchantName).filter(Boolean))], otherMerchants: others.some((s) => !s.sameMerchant) } };
  }

  async function revokeCurrent(me, token) {
    need(me);
    const r = await sessions.logoutCurrent(token, { merchantId: me.merchantId, module: me.module });
    if (r.revoked) await journal(me, 'LOGOUT', 'SUCCESS', {}, { type: 'session', id: r.sessionId });
    return { revoked: Boolean(r.revoked) };
  }

  async function revokeAllExcept(me, cur) {
    const rows = await supabase.update('app_sessions', { user_id: `eq.${me.userId}`, id: `neq.${cur}`, revoked_at: 'is.null' }, { revoked_at: now().toISOString(), revoked_reason: 'LOGOUT_OTHERS' });
    return Array.isArray(rows) ? rows.length : 0;
  }

  /** Revokes every other active session of THIS person (all merchants, all modules), keeping the current one. */
  async function revokeOthers(me, token) {
    need(me);
    const cur = await currentSessionId(me, token);
    if (!cur) throw new SecurityError('CURRENT_SESSION_UNKNOWN', 'La session actuelle est introuvable : rien n’a été déconnecté.');
    const count = await revokeAllExcept(me, cur);
    await journal(me, 'SESSION_REVOKED', 'SUCCESS', { scope: 'others', count }, { type: 'session', id: cur });
    return { revoked: count };
  }

  async function activity(me) {
    need(me);
    const rows = (await supabase.select('identity_events', { select: 'occurred_at,event_type,outcome,module,detail', user_id: `eq.${me.userId}`, merchant_id: `eq.${me.merchantId}`, event_type: `in.(${Object.keys(ACTIVITY_LABELS).join(',')})`, order: 'occurred_at.desc', limit: '30' })) ?? [];
    return { scope: 'PERSONAL', events: rows.map((r) => ({ at: r.occurred_at, type: r.event_type, label: ACTIVITY_LABELS[r.event_type] ?? r.event_type, outcome: r.outcome, module: r.module, detail: Object.fromEntries(DETAIL_KEYS.filter((k) => r.detail && k in r.detail).map((k) => [k, r.detail[k]])) })),
      note: 'Connexions, déconnexions et changements de mot de passe de votre compte dans ce commerce. Les invitations, suspensions et changements de rôle sont dans Équipe et accès → Historique des accès.' };
  }

  async function changePassword(me, token, { current, next } = {}) {
    need(me);
    if (!adminAuth || !verifier) throw new SecurityError('FEATURE_UNAVAILABLE', 'Le changement de mot de passe est indisponible.');
    if (typeof current !== 'string' || typeof next !== 'string' || !current || next.length < MIN_PASSWORD || next.length > 200) throw new SecurityError('VALIDATION', `Le nouveau mot de passe doit faire au moins ${MIN_PASSWORD} caractères.`);
    if (next === current) throw new SecurityError('VALIDATION', 'Le nouveau mot de passe doit être différent de l’actuel.');
    if (blocked(me.userId)) throw new SecurityError('RATE_LIMITED', 'Trop de tentatives. Réessayez dans quelques minutes.');
    const cur = await currentSessionId(me, token);
    if (!cur) throw new SecurityError('CURRENT_SESSION_UNKNOWN', 'La session actuelle est introuvable : rien n’a été changé.');
    let user; try { user = await adminAuth.getUser(me.userId); } catch { throw new SecurityError('UNAVAILABLE', 'Le service d’authentification ne répond pas : rien n’a été changé.'); }
    if (!user?.email) throw new SecurityError('FEATURE_UNAVAILABLE', 'Le compte n’utilise pas un mot de passe Nordla.');
    const v = await verifier.verifyPassword(String(user.email).toLowerCase(), current);
    if (!v.ok) {
      if (v.kind === 'UNAVAILABLE') throw new SecurityError('UNAVAILABLE', 'Le service d’authentification ne répond pas : rien n’a été changé.');
      failed(me.userId); await journal(me, 'PASSWORD_CHANGE_FAILED', 'DENIED', { code: 'BAD_CURRENT' });
      throw new SecurityError('BAD_CURRENT_PASSWORD', 'Le mot de passe actuel est incorrect.');
    }
    if (v.userId !== me.userId) throw new SecurityError('FEATURE_UNAVAILABLE', 'Compte incohérent.');
    let ok = false; try { ok = await adminAuth.setPassword(me.userId, next); } catch { ok = false; }
    if (!ok) { await journal(me, 'PASSWORD_CHANGE_FAILED', 'FAILURE', { code: 'PROVIDER_REFUSED' }); throw new SecurityError('PROVIDER_REFUSED', 'Le fournisseur a refusé ce mot de passe (trop faible ou déjà utilisé). Rien n’a été changé.'); }
    failures.delete(me.userId);
    const closed = await revokeAllExcept(me, cur); // a changed password closes every other session of the person
    await journal(me, 'PASSWORD_CHANGED', 'SUCCESS', { scope: 'others', count: closed }, { type: 'session', id: cur });
    return { changed: true, otherSessionsClosed: closed };
  }

  function teamRules(me) {
    need(me);
    return { scope: 'TEAM', canManage: MANAGER_ROLES.includes(me.role),
      applied: [
        { id: 'session_lifetime', label: 'Durée maximale d’une session', value: `${rules.absoluteHours} h`, editable: false },
        { id: 'idle', label: 'Déconnexion après inactivité', value: `${rules.idleMinutes} min`, editable: false, note: 'Identique pour tous les rôles ; un réglage par rôle est prévu pour une étape suivante.' },
        { id: 'attempts', label: 'Tentatives de connexion', value: `${rules.maxEmailFailures} échecs par adresse, ${rules.maxIpFailures} par réseau, blocage ${Math.round(rules.blockSeconds / 60)} min`, editable: false },
        { id: 'membership', label: 'Appartenance vérifiée à chaque requête', value: 'Active', editable: false, note: 'Un membre suspendu perd l’accès immédiatement.' },
        { id: 'csrf', label: 'Protection contre les requêtes forgées et cookies sécurisés', value: 'Active', editable: false },
      ],
      requireMfa: { available: false, enabled: false, reason: 'Non applicable côté serveur : la connexion Nordla n’a pas d’étape de second facteur, aucun membre ne peut s’inscrire et la récupération du compte propriétaire n’est pas définie.' } };
  }
  function saveTeamRules(me) {
    need(me);
    if (!MANAGER_ROLES.includes(me.role)) throw new SecurityError('FORBIDDEN_ROLE', 'Votre rôle ne permet pas de modifier les règles de l’équipe.');
    throw new SecurityError('FEATURE_UNAVAILABLE', 'Aucune règle de l’équipe n’est encore modifiable.');
  }

  return Object.freeze({ account, listSessions, revokeCurrent, revokeOthers, activity, changePassword, teamRules, saveTeamRules });
}
