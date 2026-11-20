// Sécurité V3: "require the second factor for owners and administrators" - decided per REQUEST by the HTTP gate (open sessions, role changes), stored per merchant, OFF by default.
// The SQL itself is exercised in a rolled-back transaction on staging (delivery report); here the Node layers with a fake database mirroring those functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMfaRule } from '../src/settings-security/mfa-rule.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';
import { createSecurityService, SecurityError } from '../src/settings-security/service.js';

const M = '11111111-1111-4111-8111-111111111111'; const U = { own: 'a0000000-0000-4000-8000-000000000001', adm: 'a0000000-0000-4000-8000-000000000002', view: 'a0000000-0000-4000-8000-000000000003' };
function fakeDb() {
  const db = { at:Date.now()-1000, required: false, roles: { [U.own]: 'OWNER', [U.adm]: 'ADMIN', [U.view]: 'VIEWER' }, factors: new Set(), proven: new Set(), failing: false, calls: 0, events: [] };
  db.supabase = { async select(table,q={}) {
    const user=String(q.user_id??q.id??q.session_id??q.correlation_id??'').replace(/^eq\./,'');const at=db.at;
    if(table==='app_sessions')return db.roles[user]?[{id:user,merchant_id:M,user_id:user,module:'sourcing',created_at:new Date(at).toISOString(),last_seen_at:new Date(at).toISOString(),expires_at:new Date(at+3600000).toISOString(),revoked_at:null}]:[];
    if(table==='merchant_members')return db.roles[user]?[{merchant_id:M,user_id:user,status:'ACTIVE',removed_at:null}]:[];
    if(table==='module_entitlements')return [{merchant_id:M,module_code:'sourcing',status:'ACTIVE'}];
    if(table==='identity_events')return [{merchant_id:M,user_id:user,module:'sourcing',event_type:q.event_type.slice(3),outcome:'SUCCESS',session_id:user,correlation_id:user,occurred_at:new Date(at-1).toISOString(),detail:db.proven.has(user)?{mfa:'TOTP'}:{}}];
    return [{ require_mfa_privileged: db.required }];
  }, async rpc(fn, a) {
    db.calls += 1; if (db.failing) throw new Error('db down');
    if (fn === 'security_mfa_status') return { required: db.required, privileged: ['OWNER', 'ADMIN'].includes(db.roles[a.p_user]), compliant: db.factors.has(a.p_user) };
    if (fn === 'security_mfa_noncompliant') return Object.entries(db.roles).filter(([u, r]) => ['OWNER', 'ADMIN'].includes(r) && !db.factors.has(u)).map(([u, r]) => ({ user_id: u, role: r, label: u }));
    if (fn === 'security_set_require_mfa') { if (db.roles[a.p_actor] !== 'OWNER') return { ok: false, code: 'FORBIDDEN' }; if (a.p_enabled && !db.factors.has(a.p_actor)) return { ok: false, code: 'ACTOR_NO_MFA' }; db.required = a.p_enabled; db.events.push(a.p_enabled); return { ok: true, code: 'MFA_RULE_CHANGED', enabled: a.p_enabled }; }
    throw new Error('unexpected ' + fn); } };
  return db;
}
const gateFor = (db, rule) => {
  const identity = { context: { module: 'sourcing' }, resolveAccessSession: async (t) => (db.roles[t] ? { ok: true, merchantId: M, userId: t, role: db.roles[t], module: 'sourcing', sessionId:t } : { ok: false }), authenticateAndOpenSession: async () => ({ ok: false }) };
  const security = { module: 'sourcing', cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }) }, guardRead: () => ({ ok: true }), guardMutation: async () => ({ ok: false, code: 'SESSION_INVALID' }) };
  return createSessionGate({ identity, security, mfaRule: rule });
};
const as = (u, url) => ({ method: 'GET', url, headers: { cookie: `sid=${u}` } });

test('V3-1 the rule is OFF by default: nobody is blocked, whatever the role or the factor', async () => {
  const db = fakeDb(); const gate = gateFor(db, createMfaRule({ supabase: db.supabase, ttlMs: 0 }));
  for (const u of Object.values(U)) assert.equal((await gate.authorize(as(u, '/api/general'))).ok, true);
});

test('V3-2 ON: an owner/admin WITHOUT a verified factor is refused everywhere except Sécurité and sign-in; a viewer and a protected admin are not touched', async () => {
  const db = fakeDb(); db.required = true; db.factors.add(U.adm); db.proven.add(U.adm); const gate = gateFor(db, createMfaRule({ supabase: db.supabase, ttlMs: 0 }));
  const r = await gate.authorize(as(U.own, '/api/general')); assert.equal(r.ok, false); assert.equal(r.status, 403); assert.equal(r.body.error.code, 'MFA_REQUIRED_FOR_ROLE');
  for (const p of ['/api/cases', '/api/team/members', '/api/connections', '/api/procurement/x', '/api/core/ask']) assert.equal((await gate.authorize(as(U.own, p))).status, 403, p);
  for (const p of ['/api/security', '/api/security/mfa/enroll', '/api/auth/session']) assert.equal((await gate.authorize(as(U.own, p))).ok, true, p + ' stays reachable (to enrol)');
  assert.equal((await gate.authorize(as(U.adm, '/api/general'))).ok, true, 'protected admin'); assert.equal((await gate.authorize(as(U.view, '/api/general'))).ok, true, 'viewer is not privileged');
});

test('V3-3 effect on an ALREADY OPEN session and on role changes: switching the rule, enrolling, promoting, demoting take effect on the very next request', async () => {
  const db = fakeDb(); const rule = createMfaRule({ supabase: db.supabase, ttlMs: 0 }); const gate = gateFor(db, rule);
  assert.equal((await gate.authorize(as(U.adm, '/api/general'))).ok, true);
  db.required = true; assert.equal((await gate.authorize(as(U.adm, '/api/general'))).status, 403, 'rule turned on: the open session is blocked');
  db.factors.add(U.adm); assert.equal((await gate.authorize(as(U.adm, '/api/general'))).status, 403, 'enrollment alone does not restore the session'); db.proven.add(U.adm); assert.equal((await gate.authorize(as(U.adm, '/api/general'))).ok, true, 'fresh session proof restores access');
  db.factors.delete(U.adm); assert.equal((await gate.authorize(as(U.adm, '/api/general'))).status, 403, 'factor removed: blocked again');
  assert.equal((await gate.authorize(as(U.view, '/api/general'))).ok, true); db.roles[U.view] = 'ADMIN'; assert.equal((await gate.authorize(as(U.view, '/api/general'))).status, 403, 'promoted to administrator without a factor');
  db.roles[U.view] = 'VIEWER'; assert.equal((await gate.authorize(as(U.view, '/api/general'))).ok, true, 'demoted: free again');
  db.required = false; assert.equal((await gate.authorize(as(U.adm, '/api/general'))).ok, true, 'rule off');
});

test('V3-4 cached answers expire and database failures cannot disable the MFA rule', async () => {
  const db = fakeDb(); db.required = true; let t = 0; const rule = createMfaRule({ supabase: db.supabase, ttlMs: 8000, now: () => t });
  assert.equal(await rule.blocked({ merchantId: M, userId: U.own }), true); await rule.blocked({ merchantId: M, userId: U.own }); assert.equal(db.calls, 1, 'cached');
  db.factors.add(U.own); rule.forget(M, U.own); assert.equal(await rule.blocked({ merchantId: M, userId: U.own }), true, 'factor cache refreshed, but no session proof was supplied'); t = 9000; db.factors.delete(U.own);
  assert.equal(await rule.blocked({ merchantId: M, userId: U.own }), true, 'expired cache re-read'); db.failing = true; t = 20000;
  await assert.rejects(rule.blocked({ merchantId: M, userId: U.own }), { code: 'MFA_POLICY_UNAVAILABLE' });
});

test('MFA policy outage closes business routes but keeps enrolment and authentication reachable', async () => {
  const db = fakeDb(); db.failing = true;
  const gate = gateFor(db, createMfaRule({ supabase: db.supabase, ttlMs: 0 }));
  for (const path of ['/api/general', '/api/core/finance/open', '/api/core/analytics/open', '/api/core/ask']) {
    const result = await gate.authorize(as(U.own, path));
    assert.equal(result.status, 503, path);
    assert.equal(result.body.error.code, 'MFA_POLICY_UNAVAILABLE');
  }
  for (const path of ['/api/security/mfa/enroll', '/api/auth/session']) {
    assert.equal((await gate.authorize(as(U.own, path))).ok, true, path);
  }
});

test('incomplete, null and incorrectly typed MFA policy answers are refused', async () => {
  for (const value of [null, {}, { required: false }, { required: false, privileged: false }, { required: false, privileged: false, compliant: 'true' }]) {
    const rule = createMfaRule({ supabase: { rpc: async () => value }, ttlMs: 0 });
    await assert.rejects(rule.blocked({ merchantId: M, userId: U.own }), { code: 'MFA_POLICY_UNAVAILABLE' });
  }
});

test('the rules screen cannot report MFA disabled when its database read fails', async () => {
  const rule = createMfaRule({ supabase: { rpc: async () => null, select: async () => { throw new Error('read failed'); } } });
  await assert.rejects(rule.enabled(M), { code: 'MFA_POLICY_UNAVAILABLE' });
});

test('V3-5 changing the rule: OWNER only, never without own second factor (no lock-out), listed non-compliant members, a viewer/admin refused', async () => {
  const db = fakeDb(); const rule = createMfaRule({ supabase: db.supabase, ttlMs: 0 });
  const mk = (mfa) => createSecurityService({ supabase: db.supabase, events: { record: async () => ({}) }, sessions: {}, rules: { absoluteHours: 12, idleMinutes: 120, maxEmailFailures: 5, maxIpFailures: 20, blockSeconds: 900 }, context: { merchantId: M, module: 'sourcing' }, features: { mfa }, mfaRule: rule });
  const svc = mk(true); const me = (u) => ({ userId: u, merchantId: M, role: db.roles[u], module: 'sourcing', sessionId:u });
  const code = async (p) => { try { await p; return 'OK'; } catch (e) { assert.ok(e instanceof SecurityError); return e.code; } };
  let t = await svc.teamRules(me(U.own)); assert.deepEqual([t.requireMfa.available, t.requireMfa.enabled, t.requireMfa.editable], [true, false, true]); assert.equal(t.requireMfa.nonCompliant.length, 2);
  assert.equal((await svc.teamRules(me(U.adm))).requireMfa.editable, false); assert.equal((await svc.teamRules(me(U.view))).requireMfa.nonCompliant, null, 'the list is for managers');
  assert.equal(await code(svc.saveTeamRules(me(U.view), { requireMfa: true })), 'FORBIDDEN_ROLE'); assert.equal(await code(svc.saveTeamRules(me(U.adm), { requireMfa: true })), 'FORBIDDEN_ROLE');
  assert.equal(await code(svc.saveTeamRules(me(U.own), { requireMfa: true })), 'VALIDATION', 'owner without its own factor cannot turn it on'); assert.equal(db.required, false);
  assert.equal(await code(svc.saveTeamRules(me(U.own), { requireMfa: 'yes' })), 'VALIDATION');
  db.factors.add(U.own); assert.equal(await code(svc.saveTeamRules(me(U.own), { requireMfa: true })), 'REAUTHENTICATION_REQUIRED'); db.proven.add(U.own); assert.equal(await code(svc.saveTeamRules(me(U.own), { requireMfa: true })), 'OK'); assert.equal(db.required, true); t = await svc.teamRules(me(U.own)); assert.equal(t.requireMfa.enabled, true); assert.deepEqual(t.requireMfa.nonCompliant.map((x) => x.id), [U.adm]);
  assert.equal(await code(svc.saveTeamRules(me(U.own), { requireMfa: false })), 'OK'); assert.equal(db.required, false);
  const off = mk(false); assert.equal((await off.teamRules(me(U.own))).requireMfa.available, false); assert.equal(await code(off.saveTeamRules(me(U.own), { requireMfa: true })), 'FEATURE_UNAVAILABLE');
});
