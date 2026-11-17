// Storage of Paramètres -> Équipe et accès. ONE interface, two implementations: Supabase (service role: reads + the SECURITY DEFINER functions of
// migration 20261118090000, which decide and journal in one transaction) and memory (tests; mirrors those functions' rules, documented in the SQL).
// Every method takes the merchant explicitly; the service always passes the SESSION's merchant. No method reads another merchant's rows.
import { randomUUID } from 'node:crypto';

const eq = (v) => `eq.${v}`;
const MANAGED_BY_ADMIN = ['COLLABORATOR', 'VIEWER', 'ACCOUNTANT'];
const HISTORY_TYPES = ['INVITATION_CREATED', 'INVITATION_RESENT', 'INVITATION_CANCELLED', 'INVITATION_ACCEPTED', 'INVITATION_DENIED', 'MEMBER_ADDED', 'MEMBER_ROLE_CHANGED', 'MEMBER_SUSPENDED', 'MEMBER_REACTIVATED', 'MEMBER_REMOVED', 'MEMBER_ACTION_DENIED', 'MEMBER_BOOTSTRAPPED'];
const INVITE_ROLES = ['OWNER', 'ADMIN', 'VIEWER'];
const MAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const out = (r) => { if (!r || typeof r.ok !== 'boolean' || typeof r.code !== 'string') throw new Error('TEAM_STORE_UNEXPECTED'); return r; };

export function createSupabaseTeamRepository({ supabase, module = 'team' }) {
  const rpc = async (fn, args) => out(await supabase.rpc(fn, { ...args, p_module: module }));
  return Object.freeze({
    async merchantName(merchantId) { const r = await supabase.select('merchants', { id: eq(merchantId), select: 'name', limit: '1' }); return r?.[0]?.name ?? null; },
    async listMembers(merchantId) { return (await supabase.rpc('team_list_members', { p_merchant: merchantId })) ?? []; },
    async listInvitations(merchantId) { return (await supabase.select('merchant_invitations', { merchant_id: eq(merchantId), select: 'id,email,role,status,created_at,sent_at,expires_at,send_count,invited_by,accepted_at,cancelled_at', order: 'created_at.desc', limit: '200' })) ?? []; },
    async events(merchantId, { limit = 100, beforeId = null } = {}) {
      const q = { merchant_id: eq(merchantId), event_type: `in.(${HISTORY_TYPES.join(',')})`, select: 'id,occurred_at,user_id,event_type,outcome,entity_type,entity_id,detail', order: 'occurred_at.desc,id.desc', limit: String(limit) };
      if (beforeId) q.id = `lt.${beforeId}`;
      return (await supabase.select('identity_events', q)) ?? [];
    },
    member: (a) => rpc('identity_member_apply', { p_merchant: a.merchantId, p_actor: a.actor, p_target: a.target, p_action: a.action, p_role: a.role ?? null, p_now: a.now, p_correlation: a.correlation }),
    remove: (a) => rpc('team_member_remove', { p_merchant: a.merchantId, p_actor: a.actor, p_target: a.target, p_now: a.now, p_correlation: a.correlation }),
    inviteCreate: (a) => rpc('team_invitation_create', { p_merchant: a.merchantId, p_actor: a.actor, p_email: a.email, p_role: a.role, p_token_hash: a.tokenHash, p_now: a.now, p_expires: a.expires, p_correlation: a.correlation }),
    inviteResend: (a) => rpc('team_invitation_resend', { p_merchant: a.merchantId, p_actor: a.actor, p_invitation: a.invitation, p_token_hash: a.tokenHash, p_now: a.now, p_expires: a.expires, p_correlation: a.correlation }),
    inviteCancel: (a) => rpc('team_invitation_cancel', { p_merchant: a.merchantId, p_actor: a.actor, p_invitation: a.invitation, p_now: a.now, p_correlation: a.correlation }),
    async lookupInvitation(tokenHash, now) { const r = await supabase.rpc('team_invitation_lookup', { p_token_hash: tokenHash, p_now: now }); return r?.[0] ?? null; },
    async userByEmail(email) { const r = await supabase.rpc('team_user_by_email', { p_email: email }); return typeof r === 'string' ? r : (r?.[0] ?? null); },
    inviteAccept: (a) => rpc('team_invitation_accept', { p_token_hash: a.tokenHash, p_user: a.user, p_now: a.now, p_correlation: a.correlation }),
  });
}

/** Memory implementation (tests). `users`: [{ id, email, name }]. Each merchant is isolated; the rules mirror the SQL functions line by line. */
export function createMemoryTeamRepository({ merchants = {}, users = [], members = [], invitations = [], now = () => new Date() } = {}) {
  const U = new Map(users.map((u) => [u.id, { ...u, email: String(u.email).toLowerCase() }]));
  const M = members.map((m) => ({ removed_at: null, suspended_at: null, ...m })); const I = invitations.map((i) => ({ ...i })); const E = []; let seq = 0;
  const lock = Promise.resolve();
  const journal = (merchant_id, user_id, event_type, outcome, entity_type, entity_id, detail, at) => E.push({ id: String(++seq).padStart(8, '0'), occurred_at: at, merchant_id, user_id, event_type, outcome, entity_type, entity_id, detail });
  const mem = (mid, uid) => M.find((m) => m.merchant_id === mid && m.user_id === uid);
  const actorRole = (mid, uid) => { const m = mem(mid, uid); return m && m.status === 'ACTIVE' && ['OWNER', 'ADMIN'].includes(m.role) ? m.role : null; };
  const owners = (mid, except) => M.filter((m) => m.merchant_id === mid && m.role === 'OWNER' && m.status === 'ACTIVE' && m.user_id !== except).length;
  const deny = (mid, actor, type, entity, code, extra, at) => { journal(mid, actor, type, 'DENIED', entity.id ? entity.type : null, entity.id ?? null, { ...extra, code }, at); return { ok: false, code }; };
  const sweep = (mid, at) => { for (const i of I) if (i.merchant_id === mid && i.status === 'PENDING' && new Date(i.expires_at) <= new Date(at)) i.status = 'EXPIRED'; };
  const hasMember = (mid, email) => M.some((m) => m.merchant_id === mid && !m.removed_at && U.get(m.user_id)?.email === email);
  const api = {
    _state: { members: M, invitations: I, events: E, users: U },
    async merchantName(id) { return merchants[id] ?? null; },
    async listMembers(mid) { return M.filter((m) => m.merchant_id === mid).map((m) => ({ user_id: m.user_id, email: U.get(m.user_id)?.email ?? null, display_name: U.get(m.user_id)?.name ?? null, role: m.role, status: m.status, created_at: m.created_at, suspended_at: m.suspended_at, removed_at: m.removed_at })); },
    async listInvitations(mid) { return I.filter((i) => i.merchant_id === mid).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map((i) => ({ ...i })); },
    async events(mid, { limit = 100, beforeId = null } = {}) { return E.filter((e) => e.merchant_id === mid && HISTORY_TYPES.includes(e.event_type) && (!beforeId || e.id < beforeId)).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, limit).map((e) => ({ ...e })); },
    async member({ merchantId: mid, actor, target, action, role, now: at, correlation }) {
      await lock; if (!(mid in merchants)) return { ok: false, code: 'MERCHANT_UNKNOWN' };
      const a = mem(mid, actor); const t = mem(mid, target); let d = null; const ent = { type: 'user', id: target };
      if (!['ADD', 'CHANGE_ROLE', 'SUSPEND', 'REACTIVATE'].includes(action)) d = 'ACTION_INVALID';
      else if (action === 'CHANGE_ROLE' && !['OWNER', 'ADMIN', 'COLLABORATOR', 'VIEWER', 'ACCOUNTANT'].includes(role)) d = 'ROLE_INVALID';
      else if (!a) d = 'ACTOR_NOT_MEMBER'; else if (a.status !== 'ACTIVE') d = 'ACTOR_SUSPENDED'; else if (!['OWNER', 'ADMIN'].includes(a.role)) d = 'FORBIDDEN';
      else if (!t) d = 'TARGET_NOT_MEMBER';
      else if (action === 'CHANGE_ROLE' && actor === target && ({ OWNER: 5, ADMIN: 4, ACCOUNTANT: 3, COLLABORATOR: 2, VIEWER: 1 })[role] > ({ OWNER: 5, ADMIN: 4, ACCOUNTANT: 3, COLLABORATOR: 2, VIEWER: 1 })[a.role]) d = 'SELF_PROMOTION';
      else if (a.role === 'ADMIN' && (actor === target || !MANAGED_BY_ADMIN.includes(t.role) || (action === 'CHANGE_ROLE' && !MANAGED_BY_ADMIN.includes(role)))) d = 'FORBIDDEN';
      else if (t.removed_at) d = 'MEMBER_REMOVED';   // database: the guard trigger / check constraint refuses; the service maps it to the same code
      else if (action === 'SUSPEND' && t.status !== 'ACTIVE') d = 'ALREADY_SUSPENDED'; else if (action === 'REACTIVATE' && t.status !== 'SUSPENDED') d = 'ALREADY_ACTIVE'; else if (action === 'CHANGE_ROLE' && t.role === role) d = 'NO_CHANGE';
      else if (t.role === 'OWNER' && t.status === 'ACTIVE' && (action === 'SUSPEND' || (action === 'CHANGE_ROLE' && role !== 'OWNER')) && owners(mid, target) === 0) d = 'LAST_OWNER';
      if (d) return deny(mid, actor, 'MEMBER_ACTION_DENIED', ent, d, { action }, at);
      if (action === 'CHANGE_ROLE') { const from = t.role; t.role = role; t.updated_at = at; journal(mid, actor, 'MEMBER_ROLE_CHANGED', 'SUCCESS', 'user', target, { fromRole: from, toRole: role }, at); return { ok: true, code: 'MEMBER_ROLE_CHANGED' }; }
      if (action === 'SUSPEND') { t.status = 'SUSPENDED'; t.suspended_at = at; journal(mid, actor, 'MEMBER_SUSPENDED', 'SUCCESS', 'user', target, { role: t.role, fromStatus: 'ACTIVE', toStatus: 'SUSPENDED' }, at); return { ok: true, code: 'MEMBER_SUSPENDED' }; }
      t.status = 'ACTIVE'; t.suspended_at = null; journal(mid, actor, 'MEMBER_REACTIVATED', 'SUCCESS', 'user', target, { role: t.role, fromStatus: 'SUSPENDED', toStatus: 'ACTIVE' }, at); return { ok: true, code: 'MEMBER_REACTIVATED' };
    },
    async remove({ merchantId: mid, actor, target, now: at }) {
      await lock; if (!(mid in merchants)) return { ok: false, code: 'MERCHANT_UNKNOWN' };
      const ar = actorRole(mid, actor); const t = mem(mid, target); let d = null; const ent = { type: 'user', id: target };
      if (!ar) d = 'FORBIDDEN'; else if (!t) d = 'TARGET_NOT_MEMBER'; else if (t.removed_at) d = 'ALREADY_REMOVED';
      else if (ar === 'ADMIN' && (actor === target || !MANAGED_BY_ADMIN.includes(t.role))) d = 'FORBIDDEN';
      else if (t.role === 'OWNER' && t.status === 'ACTIVE' && owners(mid, target) === 0) d = 'LAST_OWNER';
      if (d) return deny(mid, actor, 'MEMBER_ACTION_DENIED', ent, d, { action: 'REMOVE' }, at);
      const from = t.status; t.status = 'SUSPENDED'; t.suspended_at ??= at; t.removed_at = at; t.removed_by = actor;
      journal(mid, actor, 'MEMBER_REMOVED', 'SUCCESS', 'user', target, { role: t.role, fromStatus: from }, at); return { ok: true, code: 'MEMBER_REMOVED' };
    },
    async inviteCreate({ merchantId: mid, actor, email, role, tokenHash, now: at, expires }) {
      await lock; if (!(mid in merchants)) return { ok: false, code: 'MERCHANT_UNKNOWN' };
      const ar = actorRole(mid, actor); const mail = String(email).trim().toLowerCase(); sweep(mid, at); let d = null;
      if (!ar) d = 'FORBIDDEN'; else if (!INVITE_ROLES.includes(role)) d = 'ROLE_INVALID'; else if (!MAIL_RE.test(mail) || mail.length > 254) d = 'EMAIL_INVALID'; else if (ar === 'ADMIN' && role !== 'VIEWER') d = 'FORBIDDEN'; else if (hasMember(mid, mail)) d = 'ALREADY_MEMBER';
      else { const ex = I.find((i) => i.merchant_id === mid && i.email === mail && i.status === 'PENDING'); if (ex) { journal(mid, actor, 'INVITATION_DENIED', 'DENIED', 'invitation', ex.id, { code: 'DUPLICATE_PENDING' }, at); return { ok: false, code: 'DUPLICATE_PENDING', invitation_id: ex.id }; } }
      if (d) return deny(mid, actor, 'INVITATION_DENIED', { type: 'invitation', id: null }, d, {}, at);
      const id = randomUUID(); I.push({ id, merchant_id: mid, email: mail, role, token_hash: tokenHash, status: 'PENDING', created_at: at, sent_at: at, expires_at: expires, send_count: 1, invited_by: actor, accepted_at: null, cancelled_at: null });
      journal(mid, actor, 'INVITATION_CREATED', 'SUCCESS', 'invitation', id, { role }, at); return { ok: true, code: 'INVITATION_CREATED', invitation_id: id };
    },
    async inviteResend({ merchantId: mid, actor, invitation, tokenHash, now: at, expires }) {
      await lock; const ar = actorRole(mid, actor); const inv = I.find((i) => i.id === invitation && i.merchant_id === mid); let d = null;
      if (!ar) d = 'FORBIDDEN'; else if (!inv) d = 'NOT_FOUND'; else if (ar === 'ADMIN' && inv.role !== 'VIEWER') d = 'FORBIDDEN'; else if (!['PENDING', 'EXPIRED'].includes(inv.status)) d = 'NOT_RESENDABLE'; else if (hasMember(mid, inv.email)) d = 'ALREADY_MEMBER';
      if (d) return deny(mid, actor, 'INVITATION_DENIED', { type: 'invitation', id: invitation }, d, { action: 'RESEND' }, at);
      Object.assign(inv, { token_hash: tokenHash, status: 'PENDING', sent_at: at, expires_at: expires, send_count: inv.send_count + 1 });
      journal(mid, actor, 'INVITATION_RESENT', 'SUCCESS', 'invitation', invitation, { role: inv.role }, at); return { ok: true, code: 'INVITATION_RESENT', invitation_id: invitation };
    },
    async inviteCancel({ merchantId: mid, actor, invitation, now: at }) {
      await lock; const ar = actorRole(mid, actor); const inv = I.find((i) => i.id === invitation && i.merchant_id === mid); let d = null;
      if (!ar) d = 'FORBIDDEN'; else if (!inv) d = 'NOT_FOUND'; else if (ar === 'ADMIN' && inv.role !== 'VIEWER') d = 'FORBIDDEN'; else if (inv.status !== 'PENDING') d = 'NOT_CANCELLABLE';
      if (d) return deny(mid, actor, 'INVITATION_DENIED', { type: 'invitation', id: invitation }, d, { action: 'CANCEL' }, at);
      inv.status = 'CANCELLED'; inv.cancelled_at = at; journal(mid, actor, 'INVITATION_CANCELLED', 'SUCCESS', 'invitation', invitation, { role: inv.role }, at); return { ok: true, code: 'INVITATION_CANCELLED', invitation_id: invitation };
    },
    async lookupInvitation(tokenHash, at) {
      const i = I.find((x) => x.token_hash === tokenHash); if (!i) return null;
      return { invitation_id: i.id, merchant_id: i.merchant_id, merchant_name: merchants[i.merchant_id] ?? null, email: i.email, role: i.role, status: i.status === 'PENDING' && new Date(i.expires_at) <= new Date(at) ? 'EXPIRED' : i.status, expires_at: i.expires_at, account_exists: [...U.values()].some((u) => u.email === i.email) };
    },
    async userByEmail(email) { return [...U.values()].find((u) => u.email === String(email).trim().toLowerCase())?.id ?? null; },
    async inviteAccept({ tokenHash, user, now: at }) {
      await lock; const inv = I.find((i) => i.token_hash === tokenHash); if (!inv) return { ok: false, code: 'INVITATION_INVALID' };
      const cur = mem(inv.merchant_id, user); let d = null;
      if (inv.status !== 'PENDING') d = `INVITATION_${inv.status}`; else if (new Date(inv.expires_at) <= new Date(at)) { inv.status = 'EXPIRED'; d = 'INVITATION_EXPIRED'; } else if (U.get(user)?.email !== inv.email) d = 'EMAIL_MISMATCH'; else if (cur && !cur.removed_at) d = 'ALREADY_MEMBER';
      if (d) return deny(inv.merchant_id, user, 'INVITATION_DENIED', { type: 'invitation', id: inv.id }, d, { action: 'ACCEPT' }, at);
      if (!cur) M.push({ merchant_id: inv.merchant_id, user_id: user, role: inv.role, status: 'ACTIVE', created_at: at, updated_at: at, suspended_at: null, removed_at: null, created_by: inv.invited_by });
      else Object.assign(cur, { role: inv.role, status: 'ACTIVE', suspended_at: null, removed_at: null, removed_by: null, updated_at: at });
      inv.status = 'ACCEPTED'; inv.accepted_at = at; inv.accepted_by = user;
      journal(inv.merchant_id, user, 'INVITATION_ACCEPTED', 'SUCCESS', 'invitation', inv.id, { role: inv.role }, at); journal(inv.merchant_id, inv.invited_by, 'MEMBER_ADDED', 'SUCCESS', 'user', user, { toRole: inv.role, toStatus: 'ACTIVE', via: 'invitation' }, at);
      return { ok: true, code: 'INVITATION_ACCEPTED', merchant_id: inv.merchant_id, role: inv.role };
    },
  };
  return Object.freeze(api);
}
