// Core C3 - modules enabled per merchant, session opening and session resolution (src/identity/{modules,provisioning,access}.js,
// migration 20260928150000). Synthetic merchants, users and addresses only; fake Supabase Auth through an injected fetch; the
// in-memory database mirrors the SQL functions (one body = one transaction under the per-merchant lock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createIdentityDb } from './fixtures/identity-db.js';
import { createFakeGoTrue } from './fixtures/fake-gotrue.js';
import { MODULES, MODULE_CODES, isModuleCode, moduleOf } from '../src/identity/modules.js';
import { createModuleProvisioning, ProvisioningError } from '../src/identity/provisioning.js';
import { createAccessService, PUBLIC_ERRORS } from '../src/identity/access.js';
import { createMemberService } from '../src/identity/members.js';
import { createGoTrueVerifier } from '../src/identity/gotrue.js';
import { createRateLimiter } from '../src/identity/rate-limit.js';
import { loadRateLimitConfig, loadIdentityConfig } from '../src/identity/config.js';
import { createEventLog } from '../src/identity/events.js';
import { createIdentityVerifier } from '../src/identity/verify.js';
import { hashSessionToken } from '../src/identity/sessions.js';

const A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const B = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';
const people = ['owner', 'admin', 'viewer', 'acct', 'collab', 'stranger'].map((k, i) => ({ key: k, id: `${String(i + 1).padStart(8, '0')}-2222-4222-8222-${String(i + 1).padStart(12, '0')}`, email: `${k}@nordla-test.example`, password: `synthetic passphrase for ${k}` }));
const P = Object.fromEntries(people.map((p) => [p.key, p]));
const T0 = new Date('2026-09-28T08:00:00.000Z');
const MIN = 60_000;

function world({ latencyMs = 0 } = {}) {
  const clock = { t: T0.getTime() };
  const now = () => new Date(clock.t);
  const db = createIdentityDb({ merchants: [A, B], users: people.map((p) => p.id), latencyMs });
  const auth = createFakeGoTrue({ users: people });
  const key = randomBytes(32);
  const service = (merchantId, moduleCode) => createAccessService({
    supabase: db.supabase, merchantId, moduleCode, now,
    verifier: createIdentityVerifier({
      gotrue: createGoTrueVerifier({ config: { baseUrl: 'https://ref.supabase.example', anonKey: `anon-${randomBytes(20).toString('hex')}` }, fetchImpl: auth.fetchImpl }),
      limiter: createRateLimiter({ supabase: db.supabase, key, config: loadRateLimitConfig({}), now }),
      events: createEventLog({ supabase: db.supabase, now }),
      service: { merchantId, module: moduleCode },
    }),
  });
  const members = (m) => createMemberService({ supabase: db.supabase, merchantId: m, now });
  const prov = createModuleProvisioning({ supabase: db.supabase, now });
  return { db, auth, now, service, members, prov, at: (ms) => { clock.t = T0.getTime() + ms; }, events: () => db.table('identity_events'), sessions: () => db.table('app_sessions') };
}
const login = (svc, p, extra = {}) => svc.authenticateAndOpenSession({ email: p.email, password: p.password, ipAddress: '203.0.113.9', ...extra });

/** A: owner OWNER, admin ADMIN, viewer VIEWER, acct ACCOUNTANT; finance + growth enabled on A. */
async function habbLike() {
  const w = world();
  const a = w.members(A);
  await a.bootstrapOwner({ userId: P.owner.id });
  for (const [k, role] of [['admin', 'ADMIN'], ['viewer', 'VIEWER'], ['acct', 'ACCOUNTANT'], ['collab', 'COLLABORATOR']]) await a.addMember({ actorUserId: P.owner.id, targetUserId: P[k].id, role });
  await w.prov.enableModule({ merchantId: A, moduleCode: 'finance', source: 'provisioning:manual' });
  await w.prov.enableModule({ merchantId: A, moduleCode: 'growth', source: 'provisioning:manual' });
  return w;
}

// ---------- registry ----------
test('module registry: finance, analytics, growth - closed, exact, no core; the same list as the SQL check', () => {
  assert.deepEqual(MODULES.map((m) => [m.code, m.name]), [['finance', 'Finances'], ['analytics', 'Analyses'], ['growth', 'Développement des ventes']]);
  assert.deepEqual(MODULE_CODES, ['finance', 'analytics', 'growth']);
  for (const bad of ['core', 'Finance', ' finance', 'finance ', 'stock', '', null, undefined, 42]) assert.equal(isModuleCode(bad), false, String(bad));
  assert.equal(moduleOf('core'), null);
  const sql = readFileSync(new URL('../supabase/migrations/20260928150000_identity_modules_sessions.sql', import.meta.url), 'utf8');
  for (const m of sql.matchAll(/in \('finance', 'analytics', 'growth'\)/g)) assert.ok(m);
  assert.equal((sql.match(/'finance', 'analytics', 'growth'/g) ?? []).length, 3, 'table check + both functions use exactly the registry');
});

// ---------- provisioning ----------
test('provisioning: enable / suspend a module, journalled atomically; no change, unknown module and core refused', async () => {
  const w = world();
  assert.deepEqual(await w.prov.enableModule({ merchantId: A, moduleCode: 'finance', source: 'provisioning:manual' }), { ok: true, code: 'MODULE_ENABLED' });
  const [row] = w.db.table('module_entitlements');
  assert.deepEqual([row.merchant_id, row.module_code, row.status, row.suspended_at, row.source], [A, 'finance', 'ACTIVE', null, 'provisioning:manual']);
  assert.equal(w.events().at(-1).event_type, 'MODULE_ENABLED'); assert.equal(w.events().at(-1).user_id, null); assert.equal(w.events().at(-1).correlation_id, row.last_operation_id);
  assert.deepEqual(await w.prov.enableModule({ merchantId: A, moduleCode: 'finance', source: 'provisioning:manual' }), { ok: false, code: 'NO_CHANGE' });
  assert.deepEqual(await w.prov.suspendModule({ merchantId: A, moduleCode: 'finance', source: 'billing:unpaid-2026-09' }), { ok: true, code: 'MODULE_SUSPENDED' });
  assert.equal(w.db.table('module_entitlements')[0].suspended_at, T0.toISOString());
  assert.deepEqual(await w.prov.suspendModule({ merchantId: A, moduleCode: 'growth', source: 'provisioning:manual' }), { ok: false, code: 'NOT_ENABLED' });
  for (const m of ['core', 'stock', 'Finance']) assert.deepEqual(await w.prov.enableModule({ merchantId: A, moduleCode: m, source: 'provisioning:manual' }), { ok: false, code: 'MODULE_UNKNOWN' });
  await assert.rejects(w.prov.enableModule({ merchantId: A, moduleCode: 'growth', source: 'free text!' }), ProvisioningError);
  // atomic: journal down -> nothing changes
  w.db.failEventsWith(new Error('journal down'));
  await assert.rejects(w.prov.enableModule({ merchantId: A, moduleCode: 'finance', source: 'provisioning:manual' }), (e) => e.code === 'PROVISIONING_STORE_FAILED');
  assert.equal(w.db.table('module_entitlements')[0].status, 'SUSPENDED');
});

test('no merchant role can enable a module: provisioning takes no actor and nothing a merchant uses can call it', async () => {
  const w = await habbLike();
  const a = w.members(A); const svc = w.service(A, 'finance');
  for (const api of [a, svc]) assert.ok(!Object.keys(api).some((k) => /enable|module|entitle|provision/i.test(k)), Object.keys(api).join(','));
  for (const f of ['access.js', 'members.js', 'verify.js', 'sessions.js']) {
    const code = readFileSync(new URL(`../src/identity/${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
    assert.ok(!/identity_module_set|provisioning\.js/.test(code), `${f} cannot change entitlements`);
  }
  const src = readFileSync(new URL('../src/identity/provisioning.js', import.meta.url), 'utf8');
  assert.ok(!/actor/i.test(src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')), 'provisioning has no actor parameter');
});

// ---------- identity -> membership -> module -> session ----------
test('pipeline: correct password + ACTIVE membership + ACTIVE module -> one session, token returned once, SESSION_OPENED in the same call', async () => {
  const w = await habbLike();
  const svc = w.service(A, 'finance');
  const r = await login(svc, P.acct);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r).sort(), ['ok', 'session', 'token']);
  assert.deepEqual({ ...r.session, sessionId: 'x', expiresAt: 'x' }, { sessionId: 'x', merchantId: A, userId: P.acct.id, role: 'ACCOUNTANT', module: 'finance', expiresAt: 'x' });
  assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
  const [row] = w.sessions();
  assert.deepEqual([row.id, row.user_id, row.merchant_id, row.module, row.token_hash], [r.session.sessionId, P.acct.id, A, 'finance', hashSessionToken(r.token)]);
  const opened = w.events().find((e) => e.event_type === 'SESSION_OPENED');
  assert.deepEqual([opened.session_id, opened.user_id, opened.module, opened.detail], [row.id, P.acct.id, 'finance', { role: 'ACCOUNTANT' }]);
  assert.ok(!w.db.calls.some((c) => c.op === 'insert' && c.table === 'app_sessions'), 'no direct insert: only through identity_open_session');
  const everything = JSON.stringify([w.sessions(), w.events(), w.db.table('identity_rate_limits'), r.session]);
  for (const secret of [r.token, P.acct.email, P.acct.password, '203.0.113.9', ...w.auth.issued]) assert.ok(!everything.includes(secret), 'secret stored or returned');
  assert.ok(!JSON.stringify(r).includes(row.token_hash), 'the hash is never returned');
});

test('no membership, suspended membership, module absent, module suspended: ONE public answer, precise code only in the journal, no session', async () => {
  const w = await habbLike();
  await w.members(A).suspendMember({ actorUserId: P.owner.id, targetUserId: P.collab.id });
  await w.prov.enableModule({ merchantId: A, moduleCode: 'analytics', source: 'provisioning:manual' });
  await w.prov.suspendModule({ merchantId: A, moduleCode: 'analytics', source: 'billing:unpaid' });
  const cases = [
    [w.service(A, 'finance'), P.stranger, 'SESSION_ACCESS_DENIED', 'NOT_MEMBER'],
    [w.service(A, 'finance'), P.collab, 'SESSION_ACCESS_DENIED', 'MEMBER_SUSPENDED'],
    [w.service(B, 'growth'), P.owner, 'SESSION_ACCESS_DENIED', 'NOT_MEMBER'],
    [w.service(A, 'analytics'), P.owner, 'MODULE_ACCESS_DENIED', 'MODULE_SUSPENDED'],
  ];
  const b = w.members(B); await b.bootstrapOwner({ userId: P.admin.id });
  cases.push([w.service(B, 'finance'), P.admin, 'MODULE_ACCESS_DENIED', 'MODULE_NOT_ENABLED']);
  for (const [svc, p, type, code] of cases) {
    assert.deepEqual(await login(svc, p), { ok: false, error: 'ACCESS_DENIED' }, `${p.key} ${code}`);
    const e = w.events().at(-1);
    assert.deepEqual([e.event_type, e.outcome, e.detail], [type, 'DENIED', { code }]);
  }
  assert.equal(w.sessions().length, 0);
  assert.deepEqual(await login(w.service(A, 'finance'), { ...P.owner, password: 'wrong password' }), { ok: false, error: 'INVALID_CREDENTIALS' });
  assert.deepEqual(PUBLIC_ERRORS, ['INVALID_CREDENTIALS', 'RATE_LIMITED', 'UNAVAILABLE', 'ACCESS_DENIED']);
});

test('the caller cannot choose the merchant or the module', async () => {
  const w = await habbLike();
  const svc = w.service(A, 'finance');
  await assert.rejects(login(svc, P.owner, { merchantId: B }), /does not accept "merchantId"/);
  await assert.rejects(login(svc, P.owner, { module: 'growth' }), /does not accept "module"/);
  assert.throws(() => w.service(A, 'core'), /registered module/);
  assert.throws(() => w.service('HABB', 'finance'), /merchant UUID|service context/); // refused by the C1b verifier or the access service
  const code = readFileSync(new URL('../src/identity/access.js', import.meta.url), 'utf8');
  assert.ok(!/shopify|source_id|source_system/i.test(code), 'Shopify never identifies the merchant');
});

// ---------- session -> access ----------
test('resolve: returns only merchant, user, current role and module - read from the session, re-checked in the database', async () => {
  const w = await habbLike();
  const svc = w.service(A, 'finance');
  const { token } = await login(svc, P.viewer);
  const r = await svc.resolveAccessSession(token, 'finance');
  assert.deepEqual(r, { ok: true, merchantId: A, userId: P.viewer.id, role: 'VIEWER', module: 'finance' });
  // an extra "merchant" argument is ignored; the default expected module is the service's
  assert.deepEqual(await svc.resolveAccessSession(token, 'finance', B), r);
  assert.deepEqual(await svc.resolveAccessSession(token), r);
  assert.deepEqual(await svc.resolveAccessSession(token, 'analytics'), { ok: false, error: 'ACCESS_DENIED' });
  for (const bad of ['', 'x', undefined, 'a'.repeat(43)]) assert.deepEqual(await svc.resolveAccessSession(bad), { ok: false, error: 'ACCESS_DENIED' });
});

test('changes apply at the next request: role change visible, suspension / module suspension / revocation refused; no cache', async () => {
  const w = await habbLike();
  const svc = w.service(A, 'finance'); const a = w.members(A);
  const { token } = await login(svc, P.collab);
  assert.equal((await svc.resolveAccessSession(token)).role, 'COLLABORATOR');
  await a.changeRole({ actorUserId: P.owner.id, targetUserId: P.collab.id, role: 'VIEWER' });
  assert.equal((await svc.resolveAccessSession(token)).role, 'VIEWER', 'new role at the very next request');
  w.db.reset();
  await svc.resolveAccessSession(token);
  const reads = w.db.calls.filter((c) => c.op === 'select').map((c) => c.table);
  assert.deepEqual(reads, ['app_sessions', 'merchant_members', 'module_entitlements'], 'every request re-reads session, membership and entitlement');
  // suspended member -> refused at once, session revoked and journalled
  await a.suspendMember({ actorUserId: P.owner.id, targetUserId: P.collab.id });
  assert.deepEqual(await svc.resolveAccessSession(token), { ok: false, error: 'ACCESS_DENIED' });
  assert.equal(w.sessions()[0].revoked_reason, 'REVOKED');
  assert.deepEqual(w.events().at(-1).detail, { code: 'MEMBER_SUSPENDED' });
  // module suspended -> refused at once
  const t2 = (await login(svc, P.viewer)).token;
  await w.prov.suspendModule({ merchantId: A, moduleCode: 'finance', source: 'billing:unpaid' });
  assert.deepEqual(await svc.resolveAccessSession(t2), { ok: false, error: 'ACCESS_DENIED' });
  assert.equal(w.events().at(-1).event_type, 'MODULE_ACCESS_DENIED');
  // revoked session -> refused
  await w.prov.enableModule({ merchantId: A, moduleCode: 'finance', source: 'provisioning:manual' });
  const t3 = (await login(svc, P.owner)).token;
  const sessions = (await import('../src/identity/sessions.js')).createSessionStore({ supabase: w.db.supabase, config: loadIdentityConfig({}), now: w.now });
  await sessions.logoutCurrent(t3, { merchantId: A, module: 'finance' });
  assert.deepEqual(await svc.resolveAccessSession(t3), { ok: false, error: 'ACCESS_DENIED' });
});

// ---------- module separation ----------
test('a session of one module never opens another; roles never bypass the module; VIEWER with the module is accepted', async () => {
  const w = await habbLike();
  await w.prov.enableModule({ merchantId: A, moduleCode: 'analytics', source: 'provisioning:manual' });
  const fin = w.service(A, 'finance'); const ana = w.service(A, 'analytics'); const gro = w.service(A, 'growth');
  const tf = (await login(fin, P.owner)).token; const ta = (await login(ana, P.owner)).token; const tg = (await login(gro, P.owner)).token;
  assert.equal((await ana.resolveAccessSession(tf)).ok, false, 'finance -> analytics');
  assert.equal((await gro.resolveAccessSession(ta)).ok, false, 'analytics -> growth');
  assert.equal((await fin.resolveAccessSession(tg)).ok, false, 'growth -> finance');
  for (const [svc, t] of [[fin, tf], [ana, ta], [gro, tg]]) assert.equal((await svc.resolveAccessSession(t)).ok, true);
  // OWNER does not bypass a suspended module
  await w.prov.suspendModule({ merchantId: A, moduleCode: 'analytics', source: 'billing:unpaid' });
  assert.deepEqual(await login(ana, P.owner), { ok: false, error: 'ACCESS_DENIED' });
  // ACCOUNTANT without Finances (merchant B has no finance) stays refused
  const b = w.members(B); await b.bootstrapOwner({ userId: P.admin.id }); await b.addMember({ actorUserId: P.admin.id, targetUserId: P.acct.id, role: 'ACCOUNTANT' });
  assert.deepEqual(await login(w.service(B, 'finance'), P.acct), { ok: false, error: 'ACCESS_DENIED' });
  // VIEWER with an active module is authenticated (in-module permissions come later)
  const v = await login(gro, P.viewer);
  assert.equal(v.ok, true); assert.equal(v.session.role, 'VIEWER');
});

// ---------- isolation between merchants ----------
test('two merchants: one person, two roles; Finances in A only, Growth in B only; a token never changes merchant', async () => {
  const w = await habbLike();
  await w.prov.suspendModule({ merchantId: A, moduleCode: 'growth', source: 'billing:unpaid' });
  const b = w.members(B); await b.bootstrapOwner({ userId: P.admin.id }); await b.addMember({ actorUserId: P.admin.id, targetUserId: P.owner.id, role: 'VIEWER' });
  await w.prov.enableModule({ merchantId: B, moduleCode: 'growth', source: 'provisioning:manual' });
  const aFin = w.service(A, 'finance'); const bFin = w.service(B, 'finance'); const aGro = w.service(A, 'growth'); const bGro = w.service(B, 'growth');
  const ta = await login(aFin, P.owner); const tb = await login(bGro, P.owner);
  assert.equal(ta.session.role, 'OWNER'); assert.equal(tb.session.role, 'VIEWER');
  assert.deepEqual(await login(bFin, P.owner), { ok: false, error: 'ACCESS_DENIED' }, 'no Finances in B');
  assert.deepEqual(await login(aGro, P.owner), { ok: false, error: 'ACCESS_DENIED' }, 'no Growth in A');
  assert.equal((await bFin.resolveAccessSession(ta.token)).ok, false, 'A token refused by a B service');
  assert.equal((await aGro.resolveAccessSession(tb.token)).ok, false, 'B token refused by an A service');
  assert.deepEqual(await bGro.resolveAccessSession(tb.token), { ok: true, merchantId: B, userId: P.owner.id, role: 'VIEWER', module: 'growth' });
  assert.equal(w.sessions().find((s) => s.token_hash === hashSessionToken(ta.token)).merchant_id, A);
});

// ---------- concurrency and failures ----------
test('opening a session while the membership or the module is being suspended: never a usable session afterwards', async () => {
  for (let run = 0; run < 10; run += 1) {
    const w = await habbLike();
    const svc = w.service(A, 'finance');
    const suspend = run % 2 === 0
      ? () => w.members(A).suspendMember({ actorUserId: P.owner.id, targetUserId: P.viewer.id })
      : () => w.prov.suspendModule({ merchantId: A, moduleCode: 'finance', source: 'billing:unpaid' });
    const [opened] = await Promise.all([login(svc, P.viewer), suspend()]);
    if (opened.ok) assert.deepEqual(await svc.resolveAccessSession(opened.token), { ok: false, error: 'ACCESS_DENIED' }, 'created just before: refused at the next request');
    else assert.deepEqual(opened, { ok: false, error: 'ACCESS_DENIED' });
  }
});

test('two simultaneous openings give two distinct valid sessions; a module suspended right after creation refuses the next request', async () => {
  const w = await habbLike();
  const svc = w.service(A, 'growth');
  const [x, y] = await Promise.all([login(svc, P.owner), login(svc, P.owner)]);
  assert.ok(x.ok && y.ok); assert.notEqual(x.token, y.token); assert.equal(w.sessions().length, 2);
  assert.equal((await svc.resolveAccessSession(x.token)).ok, true);
  await w.prov.suspendModule({ merchantId: A, moduleCode: 'growth', source: 'billing:unpaid' });
  for (const t of [x.token, y.token]) assert.deepEqual(await svc.resolveAccessSession(t), { ok: false, error: 'ACCESS_DENIED' });
});

test('session opening is atomic: a failing SESSION_OPENED entry or a failing insert leaves no session', async () => {
  const w = await habbLike();
  const svc = w.service(A, 'finance');
  w.db.failEventsWith(new Error('journal down'));
  assert.deepEqual(await login(svc, P.owner), { ok: false, error: 'UNAVAILABLE' });
  assert.equal(w.sessions().length, 0);
  w.db.failEventsWith(null);
  const orig = w.db.supabase.rpc;
  w.db.supabase.rpc = async (fn, args) => { if (fn === 'identity_open_session') throw new Error('insert failed'); return orig.call(w.db.supabase, fn, args); };
  assert.deepEqual(await login(svc, P.owner), { ok: false, error: 'UNAVAILABLE' });
  assert.equal(w.sessions().length, 0);
});
