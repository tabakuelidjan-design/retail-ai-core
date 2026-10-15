// Core C3 - modules enabled per merchant, session opening and session resolution (src/identity/{modules,provisioning,access,service}.js,
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
import { createAccessService, PUBLIC_RESULTS, SESSION_REFUSED } from '../src/identity/access.js';
import { createIdentityService, IdentityServiceConfigError } from '../src/identity/service.js';
import { createMemberService } from '../src/identity/members.js';
import { createGoTrueVerifier } from '../src/identity/gotrue.js';
import { createRateLimiter } from '../src/identity/rate-limit.js';
import { loadRateLimitConfig, loadIdentityConfig } from '../src/identity/config.js';
import { createEventLog } from '../src/identity/events.js';
import { createIdentityVerifier } from '../src/identity/verify.js';
import { hashSessionToken, createSessionStore } from '../src/identity/sessions.js';

const A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const B = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';
const people = ['owner', 'admin', 'viewer', 'acct', 'collab', 'stranger'].map((k, i) => ({ key: k, id: `${String(i + 1).padStart(8, '0')}-2222-4222-8222-${String(i + 1).padStart(12, '0')}`, email: `${k}@nordla-test.example`, password: `synthetic passphrase for ${k}` }));
const P = Object.fromEntries(people.map((p) => [p.key, p]));
const T0 = new Date('2026-09-28T08:00:00.000Z');
const AUTH = { baseUrl: 'https://ref.supabase.example', anonKey: `anon-${randomBytes(20).toString('hex')}` };
const LOGIN_FAILED = PUBLIC_RESULTS.LOGIN_FAILED;

function world({ latencyMs = 0 } = {}) {
  const clock = { t: T0.getTime() };
  const now = () => new Date(clock.t);
  const db = createIdentityDb({ merchants: [A, B], users: people.map((p) => p.id), latencyMs });
  const auth = createFakeGoTrue({ users: people });
  const key = randomBytes(32);
  const base = { supabase: db.supabase, auth: AUTH, sessions: loadIdentityConfig({}), rateLimits: loadRateLimitConfig({}), rateLimitKey: key, fetchImpl: auth.fetchImpl, now };
  const service = (merchantId, moduleCode) => createIdentityService({ ...base, merchantId, moduleCode });
  const members = (m) => createMemberService({ supabase: db.supabase, merchantId: m, now });
  const prov = createModuleProvisioning({ supabase: db.supabase, now });
  return { db, auth, now, base, key, service, members, prov, at: (ms) => { clock.t = T0.getTime() + ms; }, events: () => db.table('identity_events'), sessions: () => db.table('app_sessions') };
}
const login = (svc, p, extra = {}) => svc.authenticateAndOpenSession({ email: p.email, password: p.password, ipAddress: '203.0.113.9', ...extra });

/** A: owner OWNER, admin ADMIN, viewer VIEWER, acct ACCOUNTANT, collab COLLABORATOR; finance + growth enabled on A. */
async function habbLike(opts) {
  const w = world(opts);
  const a = w.members(A);
  await a.bootstrapOwner({ userId: P.owner.id });
  for (const [k, role] of [['admin', 'ADMIN'], ['viewer', 'VIEWER'], ['acct', 'ACCOUNTANT'], ['collab', 'COLLABORATOR']]) await a.addMember({ actorUserId: P.owner.id, targetUserId: P[k].id, role });
  await w.prov.enableModule({ merchantId: A, moduleCode: 'finance', source: 'provisioning:manual' });
  await w.prov.enableModule({ merchantId: A, moduleCode: 'growth', source: 'provisioning:manual' });
  return w;
}

// ---------- registry ----------
test('module registry: finance, analytics, growth, sourcing - closed, exact, no core; the same list as the SQL check', () => {
  assert.deepEqual(MODULES.map((m) => [m.code, m.name]), [['finance', 'Finances'], ['analytics', 'Analyses'], ['growth', 'Développement des ventes'], ['sourcing', 'Sourcing Chine']]);
  assert.deepEqual(MODULE_CODES, ['finance', 'analytics', 'growth', 'sourcing']);
  for (const bad of ['core', 'Finance', ' finance', 'finance ', 'stock', '', null, undefined, 42]) assert.equal(isModuleCode(bad), false, String(bad));
  assert.equal(moduleOf('core'), null);
  const sql = readFileSync(new URL('../supabase/migrations/20260928150000_identity_modules_sessions.sql', import.meta.url), 'utf8');
  assert.equal((sql.match(/'finance', 'analytics', 'growth'/g) ?? []).length, 3, 'table check + both functions use exactly the registry');
  // 'sourcing' (China Sourcing) is added by the pending migration: the check and both functions there use exactly the full registry
  const next = readFileSync(new URL('../supabase/migrations-pending/20261015093000_identity_module_sourcing.sql', import.meta.url), 'utf8');
  assert.equal((next.match(/\('finance', 'analytics', 'growth', 'sourcing'\)/g) ?? []).length, 3, 'pending migration: table check + both functions use exactly the registry');
  assert.equal((next.match(/'finance', 'analytics', 'growth'\)/g) ?? []).length, 0, 'no three-value list left in the pending migration');
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
  w.db.failEventsWith(new Error('journal down'));
  await assert.rejects(w.prov.enableModule({ merchantId: A, moduleCode: 'finance', source: 'provisioning:manual' }), (e) => e.code === 'PROVISIONING_STORE_FAILED');
  assert.equal(w.db.table('module_entitlements')[0].status, 'SUSPENDED');
});

test('no merchant role can enable a module: provisioning takes no actor and nothing a merchant uses can call it', async () => {
  const w = await habbLike();
  const a = w.members(A); const svc = w.service(A, 'finance');
  for (const api of [a, svc]) assert.ok(!Object.keys(api).some((k) => /enable|entitle|provision/i.test(k)), Object.keys(api).join(','));
  for (const f of ['access.js', 'service.js', 'members.js', 'verify.js', 'sessions.js']) {
    const code = readFileSync(new URL(`../src/identity/${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
    assert.ok(!/identity_module_set|provisioning\.js/.test(code), `${f} cannot change entitlements`);
  }
  const src = readFileSync(new URL('../src/identity/provisioning.js', import.meta.url), 'utf8');
  assert.ok(!/actor/i.test(src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')), 'provisioning has no actor parameter');
});

// ---------- one public login failure ----------
test('login: unknown address, wrong password, refused account, no membership, suspended membership, no module, suspended module, other merchant -> the SAME public result', async () => {
  const w = await habbLike();
  await w.members(A).suspendMember({ actorUserId: P.owner.id, targetUserId: P.collab.id });
  await w.prov.enableModule({ merchantId: A, moduleCode: 'analytics', source: 'provisioning:manual' });
  await w.prov.suspendModule({ merchantId: A, moduleCode: 'analytics', source: 'billing:unpaid' });
  const b = w.members(B); await b.bootstrapOwner({ userId: P.admin.id });
  const results = [
    ['unknown address', await login(w.service(A, 'finance'), { ...P.owner, email: 'nobody@nordla-test.example' })],
    ['wrong password', await login(w.service(A, 'finance'), { ...P.owner, password: 'wrong password' })],
    ['refused / malformed account input', await login(w.service(A, 'finance'), { ...P.owner, email: 'not an address' })],
    ['correct password, no membership', await login(w.service(A, 'finance'), P.stranger)],
    ['correct password, suspended membership', await login(w.service(A, 'finance'), P.collab)],
    ['correct password, module not enabled', await login(w.service(B, 'finance'), P.admin)],
    ['correct password, module suspended', await login(w.service(A, 'analytics'), P.owner)],
    ['correct password, merchant the person is not in', await login(w.service(B, 'growth'), P.owner)],
  ];
  for (const [label, r] of results) {
    assert.deepEqual(r, LOGIN_FAILED, label);
    assert.equal(JSON.stringify(r), JSON.stringify(LOGIN_FAILED), `${label}: byte-identical public result`);
  }
  assert.deepEqual(LOGIN_FAILED, { ok: false, error: 'LOGIN_FAILED', status: 401, message: 'Impossible de vous connecter avec ces informations.' });
  assert.ok(Object.isFrozen(LOGIN_FAILED));
  // the journal keeps the real reasons
  const codes = w.events().filter((e) => ['SESSION_ACCESS_DENIED', 'MODULE_ACCESS_DENIED'].includes(e.event_type)).map((e) => e.detail.code).sort();
  assert.deepEqual(codes, ['MEMBER_SUSPENDED', 'MODULE_NOT_ENABLED', 'MODULE_SUSPENDED', 'NOT_MEMBER', 'NOT_MEMBER']);
  assert.equal(w.events().filter((e) => e.event_type === 'AUTH_FAILED' && !e.detail.reason).length, 3, 'invalid credentials: AUTH_FAILED');
  assert.equal(w.events().filter((e) => e.event_type === 'AUTH_FAILED' && e.detail.reason === 'ACCESS_DENIED').length, 5, 'correct password without access: AUTH_FAILED reason ACCESS_DENIED');
  assert.equal(w.sessions().length, 0);
});

test('a correct password without access counts against the limits exactly like a wrong password (no side channel through RATE_LIMITED)', async () => {
  const w = await habbLike();
  const svc = w.service(A, 'finance');
  const wrong = []; const noAccess = [];
  for (let i = 0; i < 6; i += 1) wrong.push((await login(svc, { ...P.owner, password: 'wrong password' })).error);
  for (let i = 0; i < 6; i += 1) noAccess.push((await login(svc, P.stranger)).error);
  assert.deepEqual(wrong, ['LOGIN_FAILED', 'LOGIN_FAILED', 'LOGIN_FAILED', 'LOGIN_FAILED', 'LOGIN_FAILED', 'RATE_LIMITED']);
  assert.deepEqual(noAccess, wrong, 'the same sequence of public answers');
  // both addresses are blocked on their own; the IP (10 counted failures < 20) still lets another member in
  assert.equal((await login(svc, P.viewer)).ok, true);
});

// ---------- one configuration for the whole stack ----------
test('createIdentityService: one validated, frozen configuration; unknown or missing settings refused', () => {
  const w = world();
  const svc = w.service(A, 'finance');
  assert.deepEqual(svc.context, { merchantId: A, module: 'finance' });
  assert.ok(Object.isFrozen(svc) && Object.isFrozen(svc.context));
  for (const [patch, field] of [[{ merchantId: 'HABB' }, 'merchantId'], [{ moduleCode: 'core' }, 'moduleCode'], [{ auth: {} }, 'auth'], [{ sessions: {} }, 'sessions'], [{ rateLimits: {} }, 'rateLimits'], [{ debug: true }, 'debug']]) {
    assert.throws(() => createIdentityService({ ...w.base, merchantId: A, moduleCode: 'finance', ...patch }), (e) => e instanceof IdentityServiceConfigError && e.field === field, field);
  }
  assert.throws(() => createIdentityService({ ...w.base, merchantId: A, moduleCode: 'finance', rateLimitKey: undefined }), /RATE_LIMIT_KEY/i);
  assert.equal(w.db.calls.length, 0, 'building never touches the database');
  assert.equal(w.auth.requests.length, 0, 'building never calls Supabase');
});

test('inconsistent assemblies are refused at construction, before any Supabase call or database write', () => {
  const w = world();
  const verifierFor = (merchantId, module) => createIdentityVerifier({
    gotrue: createGoTrueVerifier({ config: AUTH, fetchImpl: w.auth.fetchImpl }),
    limiter: createRateLimiter({ supabase: w.db.supabase, key: w.key, config: loadRateLimitConfig({}), now: w.now }),
    events: createEventLog({ supabase: w.db.supabase, now: w.now }),
    service: { merchantId, module },
  });
  const cases = [
    ['verifier of merchant A with an access service of B', verifierFor(A, 'finance'), B, 'finance'],
    ['Growth verifier with a Finances service', verifierFor(A, 'growth'), A, 'finance'],
    ['journal context of another merchant (the verifier journals as B)', verifierFor(B, 'finance'), A, 'finance'],
    ['a verifier without a checkable context', { verify: async () => ({ ok: true }) }, A, 'finance'],
  ];
  for (const [label, verifier, merchantId, moduleCode] of cases) {
    assert.throws(() => createAccessService({ supabase: w.db.supabase, merchantId, moduleCode, verifier, config: loadIdentityConfig({}), now: w.now }), /another merchant or module/, label);
  }
  // a session always uses the module of the service: the module is fixed at construction and cannot be passed later
  const svc = w.service(A, 'finance');
  assert.equal(svc.context.module, 'finance');
  assert.equal(w.db.calls.length, 0); assert.equal(w.auth.requests.length, 0);
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

test('the caller cannot choose the merchant or the module (extra fields throw)', async () => {
  const w = await habbLike();
  const svc = w.service(A, 'finance');
  for (const k of ['merchantId', 'module', 'expectedModule', 'moduleCode']) await assert.rejects(login(svc, P.owner, { [k]: k === 'merchantId' ? B : 'growth' }), new RegExp(`does not accept "${k}"`));
  assert.equal(w.sessions().length, 0);
  const code = readFileSync(new URL('../src/identity/access.js', import.meta.url), 'utf8') + readFileSync(new URL('../src/identity/service.js', import.meta.url), 'utf8');
  assert.ok(!/shopify|source_id|source_system/i.test(code), 'Shopify never identifies the merchant');
});

// ---------- session -> access ----------
test('resolveAccessSession(rawToken): only the token; merchant, module and expected module can never be passed', async () => {
  const w = await habbLike();
  const svc = w.service(A, 'finance');
  const { token } = await login(svc, P.viewer);
  const r = await svc.resolveAccessSession(token);
  assert.deepEqual(r, { ok: true, merchantId: A, userId: P.viewer.id, role: 'VIEWER', module: 'finance' });
  await assert.rejects(svc.resolveAccessSession(token, 'finance'), /takes only the session token/);
  await assert.rejects(svc.resolveAccessSession(token, 'analytics'), /takes only the session token/);
  await assert.rejects(svc.resolveAccessSession(token, { merchantId: B }), /takes only the session token/);
  await assert.rejects(svc.resolveAccessSession({ token, merchantId: B }), /token as a string/);
  await assert.rejects(svc.resolveAccessSession({ token, module: 'growth' }), /token as a string/);
  await assert.rejects(svc.resolveAccessSession({ token, expectedModule: 'growth' }), /token as a string/);
  for (const bad of ['', 'x', undefined, 'a'.repeat(43)]) assert.deepEqual(await svc.resolveAccessSession(bad), SESSION_REFUSED);
  assert.deepEqual(SESSION_REFUSED, { ok: false, error: 'SESSION_INVALID', status: 401, message: 'Votre session n\'est plus valide. Reconnectez-vous.' });
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
  assert.deepEqual(w.db.calls.filter((c) => c.op === 'select').map((c) => c.table), ['app_sessions', 'merchant_members', 'module_entitlements'], 'every request re-reads session, membership and entitlement');
  await a.suspendMember({ actorUserId: P.owner.id, targetUserId: P.collab.id });
  assert.deepEqual(await svc.resolveAccessSession(token), SESSION_REFUSED);
  assert.equal(w.sessions()[0].revoked_reason, 'REVOKED');
  assert.deepEqual(w.events().at(-1).detail, { code: 'MEMBER_SUSPENDED' });
  const t2 = (await login(svc, P.viewer)).token;
  await w.prov.suspendModule({ merchantId: A, moduleCode: 'finance', source: 'billing:unpaid' });
  assert.deepEqual(await svc.resolveAccessSession(t2), SESSION_REFUSED);
  assert.equal(w.events().at(-1).event_type, 'MODULE_ACCESS_DENIED');
  await w.prov.enableModule({ merchantId: A, moduleCode: 'finance', source: 'provisioning:manual' });
  const t3 = (await login(svc, P.owner)).token;
  await createSessionStore({ supabase: w.db.supabase, config: loadIdentityConfig({}), now: w.now }).logoutCurrent(t3, { merchantId: A, module: 'finance' });
  assert.deepEqual(await svc.resolveAccessSession(t3), SESSION_REFUSED);
});

// ---------- module separation ----------
test('a session of one module never opens another; roles never bypass the module; VIEWER with the module is accepted', async () => {
  const w = await habbLike();
  await w.prov.enableModule({ merchantId: A, moduleCode: 'analytics', source: 'provisioning:manual' });
  const fin = w.service(A, 'finance'); const ana = w.service(A, 'analytics'); const gro = w.service(A, 'growth');
  const tf = (await login(fin, P.owner)).token; const ta = (await login(ana, P.owner)).token; const tg = (await login(gro, P.owner)).token;
  assert.deepEqual(await ana.resolveAccessSession(tf), SESSION_REFUSED, 'Finances token presented to Analyses');
  assert.deepEqual(await gro.resolveAccessSession(ta), SESSION_REFUSED, 'analytics -> growth');
  assert.deepEqual(await fin.resolveAccessSession(tg), SESSION_REFUSED, 'growth -> finance');
  for (const [svc, t] of [[fin, tf], [ana, ta], [gro, tg]]) assert.equal((await svc.resolveAccessSession(t)).ok, true);
  await w.prov.suspendModule({ merchantId: A, moduleCode: 'analytics', source: 'billing:unpaid' });
  assert.deepEqual(await login(ana, P.owner), LOGIN_FAILED, 'OWNER does not bypass a suspended module');
  const b = w.members(B); await b.bootstrapOwner({ userId: P.admin.id }); await b.addMember({ actorUserId: P.admin.id, targetUserId: P.acct.id, role: 'ACCOUNTANT' });
  assert.deepEqual(await login(w.service(B, 'finance'), P.acct), LOGIN_FAILED, 'ACCOUNTANT without Finances');
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
  assert.deepEqual(await login(bFin, P.owner), LOGIN_FAILED, 'no Finances in B');
  assert.deepEqual(await login(aGro, P.owner), LOGIN_FAILED, 'no Growth in A');
  assert.deepEqual(await bFin.resolveAccessSession(ta.token), SESSION_REFUSED, 'A token refused by a B service');
  assert.deepEqual(await aGro.resolveAccessSession(tb.token), SESSION_REFUSED, 'B token refused by an A service');
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
    if (opened.ok) assert.deepEqual(await svc.resolveAccessSession(opened.token), SESSION_REFUSED, 'created just before: refused at the next request');
    else assert.deepEqual(opened, LOGIN_FAILED);
  }
});

test('two simultaneous openings give two distinct valid sessions; a module suspended right after creation refuses the next request', async () => {
  const w = await habbLike();
  const svc = w.service(A, 'growth');
  const [x, y] = await Promise.all([login(svc, P.owner), login(svc, P.owner)]);
  assert.ok(x.ok && y.ok); assert.notEqual(x.token, y.token); assert.equal(w.sessions().length, 2);
  assert.equal((await svc.resolveAccessSession(x.token)).ok, true);
  await w.prov.suspendModule({ merchantId: A, moduleCode: 'growth', source: 'billing:unpaid' });
  for (const t of [x.token, y.token]) assert.deepEqual(await svc.resolveAccessSession(t), SESSION_REFUSED);
});

test('session opening is atomic: a failing SESSION_OPENED entry or a failing insert leaves no session', async () => {
  const w = await habbLike();
  const svc = w.service(A, 'finance');
  const orig = w.db.supabase.rpc;
  w.db.supabase.rpc = async (fn, args) => { if (fn === 'identity_open_session') { w.db.failEventsWith(new Error('journal down')); try { return await orig.call(w.db.supabase, fn, args); } finally { w.db.failEventsWith(null); } } return orig.call(w.db.supabase, fn, args); };
  assert.deepEqual(await login(svc, P.owner), PUBLIC_RESULTS.UNAVAILABLE);
  assert.equal(w.sessions().length, 0);
  w.db.supabase.rpc = async (fn, args) => { if (fn === 'identity_open_session') throw new Error('insert failed'); return orig.call(w.db.supabase, fn, args); };
  assert.deepEqual(await login(svc, P.owner), PUBLIC_RESULTS.UNAVAILABLE);
  assert.equal(w.sessions().length, 0);
});
