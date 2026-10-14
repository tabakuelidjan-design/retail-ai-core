// In-memory stand-in for the two Core C1a tables (app_sessions, identity_events) with the SAME rules as the migration
// supabase/migrations/20260928120000_identity_sessions_events.sql: unique token hash, 12-hour maximum lifetime, immutable session
// identity, last_seen_at never moving backwards, final revocations, append-only journal, no e-mail in the journal. Every call is
// recorded so tests can count reads and writes exactly. Synthetic data only; the real SQL is checked by the contract tests.
import { randomUUID } from 'node:crypto';
import { roleRuleRefusal } from '../../src/identity/members.js';

const ms = (v) => new Date(v).getTime();
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i;
const dbError = (msg) => new Error(`Supabase REST -> HTTP 409: ${msg}`);

function matches(row, filters) {
  return Object.entries(filters).every(([k, v]) => {
    if (['select', 'order', 'limit', 'offset'].includes(k)) return true;
    if (v === 'is.null') return row[k] === null || row[k] === undefined;
    const inList = /^in\.\((.*)\)$/.exec(v);
    if (inList) return inList[1].split(',').includes(String(row[k]));
    const m = /^eq\.(.*)$/.exec(v);
    if (!m) throw new Error(`fake identity db: unsupported filter ${k}=${v}`);
    return String(row[k]) === m[1];
  });
}

/** @param {{ merchants?: string[], users?: string[], latencyMs?: number }} [o] merchant ids and auth.users ids that exist (foreign keys) */
export function createIdentityDb({ merchants = [], users = [], latencyMs = 0 } = {}) {
  const tables = { app_sessions: [], identity_events: [], identity_rate_limits: [], identity_auth_reservations: [], merchant_members: [], module_entitlements: [] };
  let failEvents = null; // simulates an identity_events insert failing INSIDE a membership function
  const calls = [];
  let failNext = null;
  let eventSeq = 0;
  const copy = (r) => JSON.parse(JSON.stringify(r));
  // Each call first waits (a network round trip), then runs its body without interruption - like one PostgREST request = one
  // statement / one function call in one transaction, with the rows it locks.
  const hop = () => new Promise((r) => (latencyMs ? setTimeout(r, latencyMs) : setImmediate(r)));
  const maybeFail = () => { if (failNext) { const e = failNext; failNext = null; throw e; } };

  // Mirror of the C2 SQL functions (migration 20260928140000; verified for real in PGlite): one uninterrupted body = one transaction
  // under the per-merchant lock. The membership change and its identity_events row are built first and committed together: if the
  // event cannot be written, nothing changes.
  function memberFn(fn, a) {
    const members = tables.merchant_members;
    if (!merchants.includes(a.p_merchant)) return { ok: false, code: 'MERCHANT_UNKNOWN' };
    const event = (userId, type, outcome, target, detail) => ({ occurred_at: a.p_now, merchant_id: a.p_merchant, user_id: userId, session_id: null, module: a.p_module, event_type: type, outcome, correlation_id: a.p_correlation, entity_type: 'user', entity_id: target, detail });
    const commit = (ev, change) => {
      if (!/^[a-z][a-z0-9_-]{1,39}$/.test(ev.module)) throw dbError('check violation (identity_events.module)');
      if (failEvents) { const e = failEvents; throw e; }
      if (change) change();
      eventSeq += 1; tables.identity_events.push({ id: eventSeq, ...ev });
    };
    const find = (u) => members.find((m) => m.merchant_id === a.p_merchant && m.user_id === u);
    if (fn === 'identity_member_bootstrap_owner') {
      if (members.some((m) => m.merchant_id === a.p_merchant)) { commit(event(null, 'MEMBER_ACTION_DENIED', 'DENIED', a.p_user, { action: 'BOOTSTRAP', code: 'ALREADY_INITIALIZED' })); return { ok: false, code: 'ALREADY_INITIALIZED' }; }
      if (!users.includes(a.p_user)) return { ok: false, code: 'USER_UNKNOWN' };
      commit(event(null, 'MEMBER_BOOTSTRAPPED', 'SUCCESS', a.p_user, { toRole: 'OWNER', toStatus: 'ACTIVE' }), () => members.push({ merchant_id: a.p_merchant, user_id: a.p_user, role: 'OWNER', status: 'ACTIVE', created_at: a.p_now, updated_at: a.p_now, suspended_at: null, created_by: null, updated_by: null }));
      return { ok: true, code: 'BOOTSTRAPPED' };
    }
    const actor = find(a.p_actor); const target = find(a.p_target);
    const ROLES = ['OWNER', 'ADMIN', 'COLLABORATOR', 'VIEWER', 'ACCOUNTANT'];
    let deny = null;
    if (!['ADD', 'CHANGE_ROLE', 'SUSPEND', 'REACTIVATE'].includes(a.p_action)) deny = 'ACTION_INVALID';
    else if (['ADD', 'CHANGE_ROLE'].includes(a.p_action) && !ROLES.includes(a.p_role)) deny = 'ROLE_INVALID';
    else if (!actor) deny = 'ACTOR_NOT_MEMBER';
    else if (actor.status !== 'ACTIVE') deny = 'ACTOR_SUSPENDED';
    else if (!['OWNER', 'ADMIN'].includes(actor.role)) deny = 'FORBIDDEN';
    else if (a.p_action === 'ADD' && target) deny = 'TARGET_ALREADY_MEMBER';
    else if (a.p_action === 'ADD' && !users.includes(a.p_target)) deny = 'USER_UNKNOWN';
    else if (a.p_action !== 'ADD' && !target) deny = 'TARGET_NOT_MEMBER';
    else deny = roleRuleRefusal({ actorRole: actor.role, targetRole: target ? target.role : null, newRole: a.p_role, action: a.p_action, self: a.p_actor === a.p_target });
    if (!deny && a.p_action === 'SUSPEND' && target.status !== 'ACTIVE') deny = 'ALREADY_SUSPENDED';
    if (!deny && a.p_action === 'REACTIVATE' && target.status !== 'SUSPENDED') deny = 'ALREADY_ACTIVE';
    if (!deny && a.p_action === 'CHANGE_ROLE' && target.role === a.p_role) deny = 'NO_CHANGE';
    if (!deny && target && target.role === 'OWNER' && target.status === 'ACTIVE' && (a.p_action === 'SUSPEND' || (a.p_action === 'CHANGE_ROLE' && a.p_role !== 'OWNER'))) {
      if (!members.some((m) => m.merchant_id === a.p_merchant && m.role === 'OWNER' && m.status === 'ACTIVE' && m.user_id !== a.p_target)) deny = 'LAST_OWNER';
    }
    if (deny) { commit(event(a.p_actor, 'MEMBER_ACTION_DENIED', 'DENIED', a.p_target, { action: a.p_action, code: deny })); return { ok: false, code: deny }; }
    const upd = (patch) => () => Object.assign(target, patch, { updated_at: a.p_now, updated_by: a.p_actor });
    if (a.p_action === 'ADD') commit(event(a.p_actor, 'MEMBER_ADDED', 'SUCCESS', a.p_target, { toRole: a.p_role, toStatus: 'ACTIVE' }), () => members.push({ merchant_id: a.p_merchant, user_id: a.p_target, role: a.p_role, status: 'ACTIVE', created_at: a.p_now, updated_at: a.p_now, suspended_at: null, created_by: a.p_actor, updated_by: a.p_actor }));
    else if (a.p_action === 'CHANGE_ROLE') commit(event(a.p_actor, 'MEMBER_ROLE_CHANGED', 'SUCCESS', a.p_target, { fromRole: target.role, toRole: a.p_role }), upd({ role: a.p_role }));
    else if (a.p_action === 'SUSPEND') commit(event(a.p_actor, 'MEMBER_SUSPENDED', 'SUCCESS', a.p_target, { role: target.role, fromStatus: 'ACTIVE', toStatus: 'SUSPENDED' }), upd({ status: 'SUSPENDED', suspended_at: a.p_now }));
    else commit(event(a.p_actor, 'MEMBER_REACTIVATED', 'SUCCESS', a.p_target, { role: target.role, fromStatus: 'SUSPENDED', toStatus: 'ACTIVE' }), upd({ status: 'ACTIVE', suspended_at: null }));
    return { ok: true, code: { ADD: 'MEMBER_ADDED', CHANGE_ROLE: 'MEMBER_ROLE_CHANGED', SUSPEND: 'MEMBER_SUSPENDED', REACTIVATE: 'MEMBER_REACTIVATED' }[a.p_action] };
  }

  // Mirror of the C3 SQL functions (migration 20260928150000; verified for real in PGlite): one uninterrupted body = one
  // transaction under the per-merchant lock; the change and its journal entry are committed together or not at all.
  const MODULE_CODES = ['finance', 'analytics', 'growth'];
  function accessFn(fn, a) {
    const commitAll = (events, change) => {
      for (const ev of events) if (!/^[a-z][a-z0-9_-]{1,39}$/.test(ev.module)) throw dbError('check violation (identity_events.module)');
      if (failEvents) { const e = failEvents; throw e; }
      if (change) change();
      for (const ev of events) { eventSeq += 1; tables.identity_events.push({ id: eventSeq, ...ev }); }
    };
    if (fn === 'identity_module_set') {
      if (!MODULE_CODES.includes(a.p_module)) return { ok: false, code: 'MODULE_UNKNOWN' };
      if (!['ACTIVE', 'SUSPENDED'].includes(a.p_status)) return { ok: false, code: 'STATUS_INVALID' };
      if (!merchants.includes(a.p_merchant)) return { ok: false, code: 'MERCHANT_UNKNOWN' };
      if (!/^[a-z][a-z0-9_]{1,31}:[a-z0-9_-]{1,64}$/.test(a.p_source)) throw dbError('check violation (source)');
      const cur = tables.module_entitlements.find((e) => e.merchant_id === a.p_merchant && e.module_code === a.p_module);
      if (!cur && a.p_status === 'SUSPENDED') return { ok: false, code: 'NOT_ENABLED' };
      if (cur && cur.status === a.p_status) return { ok: false, code: 'NO_CHANGE' };
      const kind = a.p_status === 'ACTIVE' ? 'MODULE_ENABLED' : 'MODULE_SUSPENDED';
      const ev = { occurred_at: a.p_now, merchant_id: a.p_merchant, user_id: null, session_id: null, module: 'core', event_type: kind, outcome: 'SUCCESS', correlation_id: a.p_correlation, entity_type: 'module', entity_id: a.p_module, detail: { fromStatus: cur ? cur.status : 'NONE', toStatus: a.p_status, source: a.p_source } };
      commitAll([ev], () => {
        if (!cur) tables.module_entitlements.push({ merchant_id: a.p_merchant, module_code: a.p_module, status: 'ACTIVE', enabled_at: a.p_now, suspended_at: null, created_at: a.p_now, updated_at: a.p_now, source: a.p_source, last_operation_id: a.p_correlation });
        else Object.assign(cur, { status: a.p_status, suspended_at: a.p_status === 'SUSPENDED' ? a.p_now : null, updated_at: a.p_now, source: a.p_source, last_operation_id: a.p_correlation });
      });
      return { ok: true, code: kind };
    }
    // identity_open_session
    if (!MODULE_CODES.includes(a.p_module)) return { ok: false, code: 'MODULE_UNKNOWN' };
    if (!merchants.includes(a.p_merchant)) return { ok: false, code: 'MERCHANT_UNKNOWN' };
    const m = tables.merchant_members.find((x) => x.merchant_id === a.p_merchant && x.user_id === a.p_user);
    const e = tables.module_entitlements.find((x) => x.merchant_id === a.p_merchant && x.module_code === a.p_module);
    let deny = null; let kind = null;
    if (!m) { deny = 'NOT_MEMBER'; kind = 'SESSION_ACCESS_DENIED'; }
    else if (m.status !== 'ACTIVE') { deny = 'MEMBER_SUSPENDED'; kind = 'SESSION_ACCESS_DENIED'; }
    else if (!e) { deny = 'MODULE_NOT_ENABLED'; kind = 'MODULE_ACCESS_DENIED'; }
    else if (e.status !== 'ACTIVE') { deny = 'MODULE_SUSPENDED'; kind = 'MODULE_ACCESS_DENIED'; }
    if (deny) {
      commitAll([{ occurred_at: a.p_now, merchant_id: a.p_merchant, user_id: a.p_user, session_id: null, module: a.p_module, event_type: kind, outcome: 'DENIED', correlation_id: a.p_correlation, entity_type: 'module', entity_id: a.p_module, detail: { code: deny } }]);
      return { ok: false, code: deny };
    }
    if (!/^[0-9a-f]{64}$/.test(a.p_token_hash)) throw dbError('check violation (token_hash)');
    if (tables.app_sessions.some((s) => s.token_hash === a.p_token_hash)) throw dbError('unique violation (token_hash)');
    if (!(ms(a.p_expires_at) > ms(a.p_now) && ms(a.p_expires_at) <= ms(a.p_now) + 12 * 3_600_000)) throw dbError('check violation (expiry)');
    const sid = randomUUID();
    commitAll([{ occurred_at: a.p_now, merchant_id: a.p_merchant, user_id: a.p_user, session_id: sid, module: a.p_module, event_type: 'SESSION_OPENED', outcome: 'SUCCESS', correlation_id: a.p_correlation, entity_type: 'session', entity_id: sid, detail: { role: m.role } }],
      () => tables.app_sessions.push({ id: sid, merchant_id: a.p_merchant, user_id: a.p_user, module: a.p_module, token_hash: a.p_token_hash, created_at: a.p_now, last_seen_at: a.p_now, expires_at: a.p_expires_at, revoked_at: null, revoked_reason: null }));
    return { ok: true, code: 'SESSION_OPENED', session_id: sid, role: m.role };
  }

  const api = {
    async select(table, params) {
      await hop(); calls.push({ op: 'select', table }); maybeFail();
      let rows = (tables[table] ?? []).filter((r) => matches(r, params));
      if (params.limit) rows = rows.slice(0, Number(params.limit));
      return rows.map(copy);
    },
    async insert(table, rows) {
      await hop(); calls.push({ op: 'insert', table, count: rows.length }); maybeFail();
      const out = [];
      for (const r of rows) {
        if (!merchants.includes(r.merchant_id)) throw dbError('foreign key violation (merchant_id)');
        if (table === 'app_sessions') {
          if (!/^[0-9a-f]{64}$/.test(r.token_hash)) throw dbError('check violation (token_hash)');
          if (tables.app_sessions.some((s) => s.token_hash === r.token_hash)) throw dbError('unique violation (token_hash)');
          if (!(ms(r.expires_at) > ms(r.created_at) && ms(r.expires_at) <= ms(r.created_at) + 12 * 3_600_000)) throw dbError('check violation (expiry)');
          if (ms(r.last_seen_at) < ms(r.created_at)) throw dbError('check violation (last_seen_at)');
          const row = { id: randomUUID(), revoked_at: null, revoked_reason: null, ...r };
          tables.app_sessions.push(row); out.push(copy(row));
        } else if (table === 'identity_events') {
          const text = JSON.stringify(r.detail ?? {});
          if (EMAIL.test(text) || (r.entity_id && EMAIL.test(r.entity_id))) throw dbError('check violation (no e-mail)');
          if ((r.entity_type == null) !== (r.entity_id == null)) throw dbError('check violation (entity)');
          eventSeq += 1;
          const row = { id: eventSeq, ...r };
          tables.identity_events.push(row); out.push(copy(row));
        } else throw new Error(`fake identity db: unknown table ${table}`);
      }
      return out;
    },
    async update(table, filters, patch) {
      await hop(); calls.push({ op: 'update', table, keys: Object.keys(patch) }); maybeFail();
      if (table === 'identity_events') throw dbError('identity_events is append-only: UPDATE is not allowed');
      const hit = tables[table].filter((r) => matches(r, filters));
      for (const r of hit) {
        const next = { ...r, ...patch };
        for (const k of ['id', 'merchant_id', 'user_id', 'module', 'token_hash', 'created_at', 'expires_at']) if (next[k] !== r[k]) throw dbError('identity and expiry of a session are immutable');
        if (ms(next.last_seen_at) < ms(r.last_seen_at)) throw dbError('last_seen_at cannot move backwards');
        if (r.revoked_at && (next.revoked_at !== r.revoked_at || next.revoked_reason !== r.revoked_reason)) throw dbError('a revocation is final');
        if ((next.revoked_at == null) !== (next.revoked_reason == null)) throw dbError('check violation (revocation)');
      }
      for (const r of hit) Object.assign(r, patch);
      return hit.map(copy);
    },
    // Same rules as the SQL functions identity_auth_reserve / identity_auth_settle (C1b migration, verified for real in PGlite). The
    // body after hop() runs without interruption, like one function call in one transaction holding its row locks.
    async rpc(fn, a) {
      await hop(); calls.push({ op: 'rpc', fn }); maybeFail();
      if (fn === 'identity_member_bootstrap_owner' || fn === 'identity_member_apply') return memberFn(fn, a);
      if (fn === 'identity_module_set' || fn === 'identity_open_session') return accessFn(fn, a);
      const hex = (v) => /^[0-9a-f]{64}$/.test(v);
      if (!(a.p_window_seconds >= 60 && a.p_window_seconds <= 86400 && a.p_max_email >= 1 && a.p_max_email <= 1000 && a.p_max_ip >= 1 && a.p_max_ip <= 1000 && a.p_block_seconds >= 60 && a.p_block_seconds <= 86400)) throw dbError('invalid limits');
      const now = ms(a.p_now);
      const counter = (dimension, subject) => {
        let r = tables.identity_rate_limits.find((x) => x.dimension === dimension && x.subject_hmac === subject);
        if (!r) { r = { dimension, subject_hmac: subject, window_started_at: a.p_now, failures: 0, blocked_until: null, updated_at: a.p_now }; tables.identity_rate_limits.push(r); }
        return r;
      };
      const windowExpired = (r) => ms(r.window_started_at) <= now - a.p_window_seconds * 1000;
      if (fn === 'identity_auth_reserve') {
        if (!hex(a.p_email_subject) || !hex(a.p_ip_subject)) throw dbError('check violation (subject)');
        if (!(a.p_lease_seconds >= 5 && a.p_lease_seconds <= 300)) throw dbError('invalid lease');
        const e = counter('email', a.p_email_subject); const i = counter('ip', a.p_ip_subject);
        for (const c of [e, i]) if (c.blocked_until && ms(c.blocked_until) <= now) { c.failures = 0; c.window_started_at = a.p_now; c.blocked_until = null; c.updated_at = new Date(Math.max(ms(c.updated_at), now)).toISOString(); }
        tables.identity_auth_reservations = tables.identity_auth_reservations.filter((x) => !(ms(x.expires_at) <= now && (x.email_subject === a.p_email_subject || x.ip_subject === a.p_ip_subject)));
        if ((e.blocked_until && ms(e.blocked_until) > now) || (i.blocked_until && ms(i.blocked_until) > now)) return null;
        const live = tables.identity_auth_reservations.filter((x) => ms(x.expires_at) > now);
        const flightE = live.filter((x) => x.email_subject === a.p_email_subject).length;
        const flightI = live.filter((x) => x.ip_subject === a.p_ip_subject).length;
        if ((windowExpired(e) ? 0 : e.failures) + flightE >= a.p_max_email || (windowExpired(i) ? 0 : i.failures) + flightI >= a.p_max_ip) return null;
        const id = randomUUID();
        tables.identity_auth_reservations.push({ id, email_subject: a.p_email_subject, ip_subject: a.p_ip_subject, reserved_at: a.p_now, expires_at: new Date(now + a.p_lease_seconds * 1000).toISOString() });
        return id;
      }
      if (fn === 'identity_auth_settle') {
        if (!['FAILURE', 'SUCCESS', 'RELEASE'].includes(a.p_outcome)) throw dbError('invalid outcome');
        const idx = tables.identity_auth_reservations.findIndex((x) => x.id === a.p_reservation);
        if (idx < 0) return null;
        const [r] = tables.identity_auth_reservations.splice(idx, 1);
        if (a.p_outcome === 'RELEASE') return null;
        const e = counter('email', r.email_subject); const i = counter('ip', r.ip_subject);
        const bump = (c) => { c.updated_at = new Date(Math.max(ms(c.updated_at), now)).toISOString(); };
        if (a.p_outcome === 'SUCCESS') { e.failures = 0; e.window_started_at = a.p_now; e.blocked_until = null; bump(e); return null; }
        for (const [c, max] of [[e, a.p_max_email], [i, a.p_max_ip]]) {
          if (windowExpired(c)) { c.failures = 1; c.window_started_at = a.p_now; } else c.failures += 1;
          bump(c);
          if (c.failures >= max) c.blocked_until = new Date(Math.max(c.blocked_until ? ms(c.blocked_until) : now, now + a.p_block_seconds * 1000)).toISOString();
        }
        const until = [e, i].map((c) => (c.blocked_until && ms(c.blocked_until) > now ? ms(c.blocked_until) : 0));
        return Math.max(...until) ? new Date(Math.max(...until)).toISOString() : null;
      }
      throw new Error(`fake identity db: unknown function ${fn}`);
    },
    async delete(table) {
      await hop(); calls.push({ op: 'delete', table }); maybeFail();
      if (table === 'identity_events') throw dbError('identity_events is append-only: DELETE is not allowed');
      throw new Error('fake identity db: delete not used in C1a');
    },
  };
  return {
    supabase: api,
    calls,
    table: (name) => tables[name],
    writes: () => calls.filter((c) => c.op !== 'select').length,
    reset: () => { calls.length = 0; },
    failNextWith: (err) => { failNext = err; },
    failEventsWith: (err) => { failEvents = err; },
  };
}
