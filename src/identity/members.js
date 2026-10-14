// Nordla identity - merchant memberships and roles (ADR 0004, Core C2; table merchant_members).
//
// Answers only: does this person belong to THIS merchant, is the membership active, which role, may they manage members.
// It opens no module (C3: no role gives access to any module yet, ACCOUNTANT included) and never creates a Nordla session.
//
// The merchant is bound when the service is created, by a trusted server layer (the tenant resolver today, the session later):
// no function takes a merchant id from a caller's request. Mutations are NOT decided here: they go to the database functions
// identity_member_bootstrap_owner / identity_member_apply, which re-check the actor and the rules under a per-merchant lock and
// write the change and its identity_events entry in one transaction (no change without its journal entry). MEMBER_RULES below is
// the documented copy of the rules those functions apply; tests keep the two in agreement.

import { randomUUID } from 'node:crypto';

export const TABLE = 'merchant_members';
export const BOOTSTRAP_FN = 'identity_member_bootstrap_owner';
export const APPLY_FN = 'identity_member_apply';
export const ROLES = Object.freeze(['OWNER', 'ADMIN', 'COLLABORATOR', 'VIEWER', 'ACCOUNTANT']);
export const STATUSES = Object.freeze(['ACTIVE', 'SUSPENDED']);
export const ACTIONS = Object.freeze(['ADD', 'CHANGE_ROLE', 'SUSPEND', 'REACTIVATE']);
const MANAGED_BY_ADMIN = Object.freeze(['COLLABORATOR', 'VIEWER', 'ACCOUNTANT']);

/**
 * Who may manage whom (the last-owner rule applies on top of this, in the database).
 *   manages: roles whose memberships this role may add / change / suspend / reactivate
 *   assigns: roles this role may give (on ADD or CHANGE_ROLE)
 *   self:    whether this role may act on its own membership (OWNER: yes, never above itself; others: no)
 */
export const MEMBER_RULES = Object.freeze({
  OWNER: Object.freeze({ manages: ROLES, assigns: ROLES, self: true }),
  ADMIN: Object.freeze({ manages: MANAGED_BY_ADMIN, assigns: MANAGED_BY_ADMIN, self: false }),
  COLLABORATOR: Object.freeze({ manages: Object.freeze([]), assigns: Object.freeze([]), self: false }),
  VIEWER: Object.freeze({ manages: Object.freeze([]), assigns: Object.freeze([]), self: false }),
  ACCOUNTANT: Object.freeze({ manages: Object.freeze([]), assigns: Object.freeze([]), self: false }),
});
/** Order used for "self-promotion" (a member may never give themself a higher role). */
export const ROLE_RANK = Object.freeze({ OWNER: 5, ADMIN: 4, ACCOUNTANT: 3, COLLABORATOR: 2, VIEWER: 1 });

/** True when an active member with `actorRole` may manage members at all. */
export const canManageMembers = (actorRole) => Boolean(MEMBER_RULES[actorRole]?.manages.length);

/**
 * The role rule alone (no last-owner check, no membership lookups): may `actorRole` do `action` on a member whose current role is
 * `targetRole` (null for ADD), giving `newRole` (ADD / CHANGE_ROLE)? Returns null when allowed, else the refusal code.
 */
export function roleRuleRefusal({ actorRole, targetRole = null, newRole = null, action, self = false }) {
  const rule = MEMBER_RULES[actorRole];
  if (!rule || !rule.manages.length) return 'FORBIDDEN';
  if (self && action === 'CHANGE_ROLE' && ROLE_RANK[newRole] > ROLE_RANK[actorRole]) return 'SELF_PROMOTION';
  if (self && !rule.self) return 'FORBIDDEN';
  if (targetRole && !rule.manages.includes(targetRole)) return 'FORBIDDEN';
  if ((action === 'ADD' || action === 'CHANGE_ROLE') && !rule.assigns.includes(newRole)) return 'FORBIDDEN';
  return null;
}

export class MemberError extends Error {
  constructor(code, message) { super(message); this.name = 'MemberError'; this.code = code; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v, field) => { if (typeof v === 'string' && UUID.test(v)) return v.toLowerCase(); throw new MemberError('INVALID_ARGUMENT', `${field} is invalid.`); };
const onlyKeys = (input, allowed, fn) => { for (const k of Object.keys(input ?? {})) if (!allowed.includes(k)) throw new TypeError(`${fn}() does not accept "${k}"`); };

const view = (r) => Object.freeze({ merchantId: r.merchant_id, userId: r.user_id, role: r.role, status: r.status, suspendedAt: r.suspended_at ?? null });

/**
 * The active merchants of a user (for a later merchant choice, C3 / C15). Cross-merchant by nature: it takes a user id only.
 * @returns {Promise<Array<{ merchantId: string, role: string }>>}
 */
export async function listActiveMerchants({ supabase }, userId) {
  const id = uuid(userId, 'userId');
  let rows;
  try { rows = await supabase.select(TABLE, { select: 'merchant_id,role', user_id: `eq.${id}`, status: 'eq.ACTIVE', order: 'merchant_id.asc' }); } catch {
    throw new MemberError('MEMBER_STORE_FAILED', 'The memberships could not be read.');
  }
  return (rows ?? []).map((r) => Object.freeze({ merchantId: r.merchant_id, role: r.role }));
}

/**
 * Membership service for ONE merchant.
 * @param {{ supabase: { select: Function, rpc: Function }, merchantId: string, module?: string, now?: () => Date, newId?: () => string }} deps
 *   merchantId: from a trusted server layer (tenant resolver / session) - never from a request.
 */
export function createMemberService({ supabase, merchantId, module = 'core', now = () => new Date(), newId = randomUUID } = {}) {
  if (!supabase || typeof supabase.select !== 'function' || typeof supabase.rpc !== 'function') throw new TypeError('createMemberService needs a Supabase client with select() and rpc()');
  const merchant = uuid(merchantId, 'merchantId');
  if (typeof module !== 'string' || !/^[a-z][a-z0-9_-]{1,39}$/.test(module)) throw new MemberError('INVALID_ARGUMENT', 'module is invalid.');

  /** This merchant's membership of a user, or null. Never looks at another merchant. */
  async function getMembership(userId) {
    const id = uuid(userId, 'userId');
    let rows;
    try { rows = await supabase.select(TABLE, { select: '*', merchant_id: `eq.${merchant}`, user_id: `eq.${id}`, limit: '1' }); } catch {
      throw new MemberError('MEMBER_STORE_FAILED', 'The membership could not be read.');
    }
    const row = (rows ?? []).find((r) => String(r.merchant_id).toLowerCase() === merchant && String(r.user_id).toLowerCase() === id);
    return row ? view(row) : null;
  }

  /**
   * Requires an ACTIVE membership in this merchant. Returns { ok: true, userId, merchantId, role } or { ok: false, code } with
   * code NOT_MEMBER (also for a user unknown here) or SUSPENDED. Creates nothing - in particular no session.
   */
  async function requireActiveMembership(userId) {
    const m = await getMembership(userId);
    if (!m) return { ok: false, code: 'NOT_MEMBER' };
    if (m.status !== 'ACTIVE') return { ok: false, code: 'SUSPENDED' };
    return { ok: true, userId: m.userId, merchantId: m.merchantId, role: m.role };
  }

  /** The active role in this merchant, or null. */
  async function getActiveRole(userId) {
    const r = await requireActiveMembership(userId);
    return r.ok ? r.role : null;
  }

  const call = async (fn, args) => {
    let out;
    try { out = await supabase.rpc(fn, args); } catch { throw new MemberError('MEMBER_STORE_FAILED', 'The membership change could not be recorded; nothing was changed.'); }
    if (!out || typeof out.ok !== 'boolean' || typeof out.code !== 'string') throw new MemberError('MEMBER_STORE_FAILED', 'Unexpected answer from the membership store.');
    return Object.freeze({ ok: out.ok, code: out.code });
  };
  const correlation = (c) => (c === undefined || c === null ? newId() : uuid(c, 'correlationId'));

  /** First OWNER of this merchant (only when it has no membership at all). Server-side provisioning only. */
  async function bootstrapOwner(input = {}) {
    onlyKeys(input, ['userId', 'correlationId'], 'bootstrapOwner');
    return call(BOOTSTRAP_FN, { p_merchant: merchant, p_user: uuid(input.userId, 'userId'), p_now: now().toISOString(), p_correlation: correlation(input.correlationId), p_module: module });
  }

  const apply = (action, fields) => async (input = {}) => {
    onlyKeys(input, ['actorUserId', 'targetUserId', 'correlationId', ...fields], action);
    if (fields.includes('role') && !ROLES.includes(input.role)) return Object.freeze({ ok: false, code: 'ROLE_INVALID' });
    return call(APPLY_FN, {
      p_merchant: merchant, p_actor: uuid(input.actorUserId, 'actorUserId'), p_target: uuid(input.targetUserId, 'targetUserId'), p_action: action,
      p_role: fields.includes('role') ? input.role : null, p_now: now().toISOString(), p_correlation: correlation(input.correlationId), p_module: module,
    });
  };

  return Object.freeze({
    getMembership, requireActiveMembership, getActiveRole, bootstrapOwner,
    addMember: apply('ADD', ['role']),
    changeRole: apply('CHANGE_ROLE', ['role']),
    suspendMember: apply('SUSPEND', []),
    reactivateMember: apply('REACTIVATE', []),
  });
}
