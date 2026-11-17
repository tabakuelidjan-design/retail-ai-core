// Paramètres -> Équipe et accès: the service the page goes through. ONE service per deployment; the merchant is ALWAYS the session's (tenant.merchantId),
// the actor and the role ALWAYS come from the session (never from a request body). Decisions that must be atomic (who may do what, the last owner, the
// single-use invitation) are taken by the database functions under a per-merchant lock; this layer re-checks the rights first so that the interface and
// the API refuse early, with a precise French message, and never rely on the screen hiding a button.
import { createHash, randomBytes as nodeRandomBytes, randomUUID } from 'node:crypto';
import * as M from './model.js';

export class TeamError extends Error { constructor(code, message, extra = {}) { super(message ?? code); this.name = 'TeamError'; this.code = code; Object.assign(this, extra); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const hashToken = (token) => createHash('sha256').update(String(token), 'utf8').digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const MIN_PASSWORD = 12;
const REFUSED = new Set(Object.keys(M.REFUSAL));

export function createTeamService({ repo, auth = null, now = () => new Date(), origin = '', randomBytes = nodeRandomBytes, newId = randomUUID, ttlDays = M.INVITATION_TTL_DAYS } = {}) {
  if (!repo) throw new TypeError('createTeamService needs a repository');
  const merchantOf = (tenant) => { const id = tenant?.merchantId; if (typeof id !== 'string' || !UUID.test(id)) throw new TeamError('TENANT_REQUIRED', 'Commerce introuvable.'); return id.toLowerCase(); };
  const needManager = (role) => { if (!M.MANAGER_ROLES.has(role)) throw new TeamError('FORBIDDEN_ROLE', M.REFUSAL.FORBIDDEN_ROLE); };
  const at = () => now().toISOString();
  const expiry = () => new Date(now().getTime() + ttlDays * 86_400_000).toISOString();
  const newToken = () => randomBytes(32).toString('base64url');
  const linkFor = (token) => `${String(origin).replace(/\/+$/, '')}/invitation/${token}`;
  const refuse = (r) => { if (r.ok) return r; const code = REFUSED.has(r.code) ? r.code : (r.code === 'ACTOR_NOT_MEMBER' || r.code === 'ACTOR_SUSPENDED' ? 'FORBIDDEN' : 'FORBIDDEN'); throw new TeamError(code, M.REFUSAL[code] ?? M.REFUSAL.FORBIDDEN, { reason: r.code, ...(r.invitation_id ? { invitationId: r.invitation_id } : {}) }); };
  const uuid = (v) => { if (typeof v !== 'string' || !UUID.test(v)) throw new TeamError('NOT_FOUND', M.REFUSAL.NOT_FOUND); return v.toLowerCase(); };

  const statusOf = (m) => (m.removed_at ? 'REMOVED' : m.status);
  const nameOf = (m) => m.display_name || (m.email ? m.email.split('@')[0] : 'Membre');
  function actionsFor(actorRole, actorId, m) {
    const st = statusOf(m); const self = m.user_id === actorId; const manages = (M.MANAGES[actorRole] ?? []).includes(m.role) && (actorRole === 'OWNER' || !self);
    const roles = manages && st !== 'REMOVED' ? (M.ASSIGNABLE[actorRole] ?? []).filter((r) => r !== m.role) : [];
    return { changeRole: roles, suspend: manages && st === 'ACTIVE', reactivate: manages && st === 'SUSPENDED', remove: manages && st !== 'REMOVED' };
  }
  const memberView = (m, actorRole, actorId) => ({
    id: m.user_id, name: nameOf(m), email: m.email, role: m.role, roleLabel: M.roleLabel(m.role), status: statusOf(m), statusLabel: M.STATUS[statusOf(m)] ?? m.status, since: m.created_at ?? null, suspendedAt: m.suspended_at ?? null, removedAt: m.removed_at ?? null,
    isSelf: m.user_id === actorId, actions: actionsFor(actorRole, actorId, m),
  });
  const invitationView = (i, nowIso, actorRole) => {
    const status = i.status === 'PENDING' && i.expires_at <= nowIso ? 'EXPIRED' : i.status; const manageable = actorRole === 'OWNER' || (actorRole === 'ADMIN' && i.role === 'VIEWER');
    return { id: i.id, email: i.email, role: i.role, roleLabel: M.roleLabel(i.role), status, statusLabel: M.INVITATION_STATUS[status], sentAt: i.sent_at, expiresAt: i.expires_at, sendCount: i.send_count, createdAt: i.created_at, acceptedAt: i.accepted_at ?? null, cancelledAt: i.cancelled_at ?? null, canResend: manageable && (status === 'PENDING' || status === 'EXPIRED'), canCancel: manageable && status === 'PENDING' };
  };
  const allMembers = async (mid) => (await repo.listMembers(mid)).filter((m) => String(m.user_id));
  async function target(mid, userId) { const id = uuid(userId); const t = (await allMembers(mid)).find((m) => m.user_id === id); if (!t) throw new TeamError('NOT_FOUND', M.REFUSAL.TARGET_NOT_MEMBER); return t; }
  const roleCheck = (actorRole, role) => { if (!M.ROLES[role]) throw new TeamError('ROLE_INVALID', M.REFUSAL.ROLE_INVALID); if (!(M.ASSIGNABLE[actorRole] ?? []).includes(role)) throw new TeamError('FORBIDDEN', 'Vous ne pouvez pas attribuer ce rôle : il dépasse ce que votre rôle peut déléguer.'); };

  return Object.freeze({
    /** The rights grid is public to every member (it is documentation of what is enforced). */
    rights() { return { roles: M.ROLE_ORDER.map((r) => ({ ...M.ROLES[r], rights: M.rightsOf(r) })), levelLabel: M.LEVEL_LABEL, sensitiveLabel: M.SENSITIVE_LABEL, notControlled: M.NOT_CONTROLLED, nextRole: M.NEXT_ROLE }; },
    rightsOfRole(role) { if (!M.ROLES[role]) throw new TeamError('ROLE_INVALID', M.REFUSAL.ROLE_INVALID); return { role, roleLabel: M.roleLabel(role), ...M.rightsOf(role) }; },

    async overview({ tenant, role, actor }) {
      const mid = merchantOf(tenant); const manager = M.MANAGER_ROLES.has(role);
      return { merchant: { name: await repo.merchantName(mid) }, me: { id: actor ?? null, role, roleLabel: M.roleLabel(role) }, canManage: manager, assignable: M.ASSIGNABLE[role] ?? [], roles: M.ROLE_ORDER.map((r) => ({ id: r, label: M.ROLES[r].label, summary: M.ROLES[r].summary })), nextRole: M.NEXT_ROLE, ttlDays,
        sections: [{ id: 'members', label: 'Membres', locked: !manager }, { id: 'invitations', label: 'Invitations', locked: !manager }, { id: 'roles', label: 'Rôles et permissions', locked: false }, { id: 'history', label: 'Historique des accès', locked: !manager }] };
    },

    async members({ tenant, role, actor, q = '', roleFilter = '', status = '' }) {
      const mid = merchantOf(tenant); needManager(role);
      const needle = String(q ?? '').trim().toLowerCase();
      const rows = (await allMembers(mid)).map((m) => memberView(m, role, actor))
        .filter((m) => (!needle || m.name.toLowerCase().includes(needle) || String(m.email ?? '').toLowerCase().includes(needle)) && (!roleFilter || m.role === roleFilter) && (!status || m.status === status));
      return { members: rows, total: rows.length };
    },
    async member({ tenant, role, actor, userId }) {
      const mid = merchantOf(tenant); needManager(role); const m = await target(mid, userId);
      return { member: memberView(m, role, actor), rights: M.rightsOf(m.role), establishments: { enforced: false, note: 'Le périmètre par établissement n’est pas appliqué côté serveur : ce membre accède à tous les établissements du commerce.' }, ...(statusOf(m) === 'REMOVED' ? { removed: true } : {}) };
    },
    async changeRole({ tenant, role, actor, userId, newRole }) {
      const mid = merchantOf(tenant); needManager(role); roleCheck(role, newRole); const t = await target(mid, userId);
      if (statusOf(t) === 'REMOVED') throw new TeamError('MEMBER_REMOVED', M.REFUSAL.MEMBER_REMOVED);
      refuse(await repo.member({ merchantId: mid, actor, target: t.user_id, action: 'CHANGE_ROLE', role: newRole, now: at(), correlation: newId() }));
      return this.member({ tenant, role, actor, userId });
    },
    async setStatus({ tenant, role, actor, userId, action }) { // SUSPEND | REACTIVATE | REMOVE
      const mid = merchantOf(tenant); needManager(role); const t = await target(mid, userId);
      if (action !== 'REMOVE' && statusOf(t) === 'REMOVED') throw new TeamError('MEMBER_REMOVED', M.REFUSAL.MEMBER_REMOVED);
      const base = { merchantId: mid, actor, target: t.user_id, now: at(), correlation: newId() };
      refuse(action === 'REMOVE' ? await repo.remove(base) : await repo.member({ ...base, action }));
      return this.member({ tenant, role, actor, userId });
    },

    async invitations({ tenant, role }) {
      const mid = merchantOf(tenant); needManager(role); const nowIso = at();
      const rows = (await repo.listInvitations(mid)).map((i) => invitationView(i, nowIso, role));
      return { invitations: rows, ttlDays, mail: { sent: false, note: 'L’envoi automatique d’e-mails n’est pas configuré : copiez le lien affiché à la création et transmettez-le à la personne invitée.' } };
    },
    /** Preview of the rights a role would give, shown BEFORE the invitation is sent (same data as the grid). */
    async invite({ tenant, role, actor, email, newRole }) {
      const mid = merchantOf(tenant); needManager(role);
      if (!M.validEmail(email)) throw new TeamError('EMAIL_INVALID', M.REFUSAL.EMAIL_INVALID);
      roleCheck(role, newRole);
      const token = newToken();
      const r = refuse(await repo.inviteCreate({ merchantId: mid, actor, email: M.normalizeEmail(email), role: newRole, tokenHash: hashToken(token), now: at(), expires: expiry(), correlation: newId() }));
      const inv = (await repo.listInvitations(mid)).find((i) => i.id === r.invitation_id);
      return { invitation: invitationView(inv, at(), role), link: linkFor(token), linkNote: 'Ce lien ne sera plus affiché. Il est valable une seule fois, pour cette adresse e-mail, et expire dans ' + ttlDays + ' jours.' };
    },
    async resend({ tenant, role, actor, invitationId }) {
      const mid = merchantOf(tenant); needManager(role); const token = newToken();
      refuse(await repo.inviteResend({ merchantId: mid, actor, invitation: uuid(invitationId), tokenHash: hashToken(token), now: at(), expires: expiry(), correlation: newId() }));
      const inv = (await repo.listInvitations(mid)).find((i) => i.id === invitationId.toLowerCase());
      return { invitation: invitationView(inv, at(), role), link: linkFor(token), linkNote: 'Un nouveau lien a été créé : l’ancien ne fonctionne plus.' };
    },
    async cancel({ tenant, role, actor, invitationId }) {
      const mid = merchantOf(tenant); needManager(role);
      refuse(await repo.inviteCancel({ merchantId: mid, actor, invitation: uuid(invitationId), now: at(), correlation: newId() }));
      const inv = (await repo.listInvitations(mid)).find((i) => i.id === invitationId.toLowerCase());
      return { invitation: invitationView(inv, at(), role) };
    },

    /** Who did what, when. Technical ids -> names, invitation ids -> addresses (managers only, this merchant only). No token, no link, no free-form detail. */
    async history({ tenant, role, limit = 50, before = null }) {
      const mid = merchantOf(tenant); needManager(role);
      const lim = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
      const [members, invs, events] = await Promise.all([allMembers(mid), repo.listInvitations(mid), repo.events(mid, { limit: lim + 1, beforeId: before || null })]);
      const names = new Map(members.map((m) => [m.user_id, nameOf(m)])); const mails = new Map(invs.map((i) => [i.id, i.email]));
      const page = events.slice(0, lim);
      const items = page.map((e) => {
        const d = e.detail ?? {}; const isInv = e.entity_type === 'invitation';
        const subject = isInv ? { kind: 'invitation', label: mails.get(e.entity_id) ?? 'Invitation' } : e.entity_type === 'user' ? { kind: 'member', label: names.get(e.entity_id) ?? 'Membre' } : null;
        return { id: e.id, at: e.occurred_at, type: e.event_type, label: M.HISTORY_EVENTS[e.event_type] ?? e.event_type, outcome: e.outcome, actor: e.user_id ? (names.get(e.user_id) ?? 'Membre') : 'Système', subject,
          change: e.event_type === 'MEMBER_ROLE_CHANGED' ? { from: M.roleLabel(d.fromRole), to: M.roleLabel(d.toRole) } : d.toRole ? { to: M.roleLabel(d.toRole) } : d.role ? { role: M.roleLabel(d.role) } : null,
          refusal: e.outcome === 'DENIED' ? (M.REFUSAL[d.code] ?? 'Refusé.') : null };
      });
      return { items, next: events.length > lim ? page.at(-1).id : null };
    },

    // ------------------------------------------------------------------ public side (the person who received the link): no session, token only
    async inviteInfo(token) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { state: 'INVALID' };
      const i = await repo.lookupInvitation(hashToken(token), at()); if (!i) return { state: 'INVALID' };
      if (i.status !== 'PENDING') return { state: i.status }; // ACCEPTED | EXPIRED | CANCELLED
      return { state: 'PENDING', merchantName: i.merchant_name, email: i.email, role: i.role, roleLabel: M.roleLabel(i.role), accountExists: !!i.account_exists, expiresAt: i.expires_at, rights: M.rightsOf(i.role), minPassword: MIN_PASSWORD };
    },
    /** Accepts for the intended recipient only: the account e-mail is the invited one (created here, or proved with its password). */
    async acceptInvite({ token, password, name = '' }) {
      if (!auth) throw new TeamError('ACCEPT_UNAVAILABLE', 'L’acceptation n’est pas disponible pour le moment.');
      const info = await this.inviteInfo(token); if (info.state !== 'PENDING') throw new TeamError(`INVITATION_${info.state}`, 'Ce lien n’est plus utilisable.', { state: info.state });
      if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 1024) throw new TeamError('PASSWORD_INVALID', `Choisissez un mot de passe d’au moins ${MIN_PASSWORD} caractères.`);
      let userId;
      if (info.accountExists) { // an existing account: the person proves it is theirs with its password (never a new password on someone else's account)
        const v = await auth.verifyPassword(info.email, password); if (!v?.ok) throw new TeamError('CREDENTIALS_INVALID', 'Mot de passe incorrect pour ce compte.');
        userId = v.userId;
      } else {
        const label = String(name ?? '').trim().slice(0, 80); const c = await auth.createUser({ email: info.email, password, name: label || null }); if (!c?.ok) throw new TeamError('ACCOUNT_FAILED', 'Le compte n’a pas pu être créé. Réessayez dans un instant.');
        userId = c.userId;
      }
      const r = await repo.inviteAccept({ tokenHash: hashToken(token), user: userId, now: at(), correlation: newId() });
      if (!r.ok) throw new TeamError(r.code, r.code === 'ALREADY_MEMBER' ? M.REFUSAL.ALREADY_MEMBER : 'Ce lien n’est plus utilisable.', { state: r.code });
      return { ok: true, merchantName: info.merchantName, roleLabel: info.roleLabel };
    },
  });
}
