// HOSTED China Sourcing behind the Core identity: no development token on a public server; sign-in with the Supabase Auth account of an
// ACTIVE member of THIS merchant with the 'sourcing' module ACTIVE; a Nordla session cookie; CSRF + same origin on every change; a
// suspended member or a logged-out session is refused at once. Synthetic people, in-memory identity tables (test/fixtures/identity-db.js,
// the same rules as the SQL functions), fake Supabase Auth, a real HTTP server, requests shaped as Railway forwards them.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentityDb } from './fixtures/identity-db.js';
import { createFakeGoTrue } from './fixtures/fake-gotrue.js';
import { createIdentityService } from '../src/identity/service.js';
import { createMemberService } from '../src/identity/members.js';
import { createModuleProvisioning } from '../src/identity/provisioning.js';
import { loadIdentityConfig, loadRateLimitConfig } from '../src/identity/config.js';
import { createHttpSecurity } from '../src/security/index.js';
import { hostedConfig } from '../src/sourcing/server/hosted.js';
import { startSourcingServer } from '../src/sourcing/server/index.js';
import { newCase } from '../src/sourcing/core/case.js';

const M = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'; const OTHER = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';
const people = ['owner', 'buyer', 'stranger'].map((k, i) => ({ key: k, id: `${String(i + 1).padStart(8, '0')}-2222-4222-8222-${String(i + 1).padStart(12, '0')}`, email: `${k}@nordla-test.example`, password: `synthetic passphrase for ${k}` }));
const P = Object.fromEntries(people.map((p) => [p.key, p]));
const HOST = 'sourcing.nordla-test.example'; const ORIGIN = `https://${HOST}`;
const ENV = { SOURCING_HOSTED: '1', NORDLA_MERCHANT_ID: M, SOURCING_PUBLIC_ORIGIN: ORIGIN, SUPABASE_URL: 'https://ref.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test', SUPABASE_ANON_KEY: 'anon-test',
  NORDLA_IDENTITY_RATE_LIMIT_KEY: randomBytes(32).toString('hex'), NORDLA_CSRF_KEY: randomBytes(32).toString('hex'), SOURCING_MERCHANT_ID: 'habb', SOURCING_HOST: '127.0.0.1' };

test('hosted configuration: every missing piece is refused with its own code; no development token is ever enough', () => {
  assert.deepEqual(hostedConfig(ENV), { host: '127.0.0.1', merchantId: M, origin: ORIGIN, allowedHosts: [HOST], dataDir: 'data/local/sourcing', supabaseRef: null }); // not pinned off Railway (test/sourcing-hosted-project-pin.test.js)
  assert.throws(() => hostedConfig({ ...ENV, NORDLA_MERCHANT_ID: 'habb' }), { code: 'HOSTED_MERCHANT_REQUIRED' });
  for (const o of ['http://x.example.com', 'https://x.example.com/app', 'https://x.example.com:8443', 'https://*.example.com', '']) assert.throws(() => hostedConfig({ ...ENV, SOURCING_PUBLIC_ORIGIN: o }), { code: 'HOSTED_ORIGIN_REQUIRED' }, o);
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'NORDLA_IDENTITY_RATE_LIMIT_KEY', 'NORDLA_CSRF_KEY']) assert.throws(() => hostedConfig({ ...ENV, [k]: '' }), { code: 'HOSTED_IDENTITY_REQUIRED' }, k);
  assert.throws(() => hostedConfig({ ...ENV, SOURCING_MERCHANT_ID: '' }), { code: 'HOSTED_PROFILE_REQUIRED' });
  assert.throws(() => hostedConfig({ ...ENV, NORDLA_MERCHANT_ID: '', SOURCING_TOKEN: 'x'.repeat(64) }), { code: 'HOSTED_MERCHANT_REQUIRED' }, 'a token does not replace the identity');
});

async function world({ sourcingEnabled = true } = {}) {
  const db = createIdentityDb({ merchants: [M, OTHER], users: people.map((p) => p.id) });
  const auth = createFakeGoTrue({ users: people });
  const identity = createIdentityService({ merchantId: M, moduleCode: 'sourcing', supabase: db.supabase, auth: { baseUrl: ENV.SUPABASE_URL, anonKey: ENV.SUPABASE_ANON_KEY }, sessions: loadIdentityConfig({}), rateLimits: loadRateLimitConfig({}), rateLimitKey: ENV.NORDLA_IDENTITY_RATE_LIMIT_KEY, fetchImpl: auth.fetchImpl });
  const security = createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: [HOST], allowedOrigins: [ORIGIN], moduleCode: 'sourcing', csrfKey: ENV.NORDLA_CSRF_KEY, rateLimitKey: ENV.NORDLA_IDENTITY_RATE_LIMIT_KEY, loginTiming: { minMs: 200, jitterMs: 0 } });
  const members = createMemberService({ supabase: db.supabase, merchantId: M });
  await members.bootstrapOwner({ userId: P.owner.id });
  await members.addMember({ actorUserId: P.owner.id, targetUserId: P.buyer.id, role: 'COLLABORATOR' });
  if (sourcingEnabled) await createModuleProvisioning({ supabase: db.supabase }).enableModule({ merchantId: M, moduleCode: 'sourcing', source: 'provisioning:manual' });
  const dir = await mkdtemp(join(tmpdir(), 'src-hosted-'));
  const srv = await startSourcingServer({ env: { ...ENV, SOURCING_DATA_DIR: dir }, log: () => {}, port: 0, services: { identity, security }, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}) });
  // requests as Railway forwards them: TLS ended by the proxy, the real client in X-Real-IP
  const call = (method, path, { body, cookie, csrf, origin = ORIGIN, token } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { host: HOST, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.7', 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-nordla-csrf': csrf } : {}), ...(token ? { 'x-sourcing-token': token } : {}), ...(data ? { 'content-length': data.length } : {}) };
    const req = http.request({ host: '127.0.0.1', port: srv.port, path, method, headers }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: t ? JSON.parse(t) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  const login = async (p, password = p.password) => {
    const r = await call('POST', '/api/auth/login', { body: { email: p.email, password } });
    const set = r.headers['set-cookie'] ?? []; const pick = (n) => set.find((c) => c.startsWith(n))?.split(';')[0];
    const sid = pick('__Host-nordla_sourcing_sid='); const csrfPair = pick('__Host-nordla_sourcing_csrf=');
    return { ...r, set, cookie: [sid, csrfPair].filter(Boolean).join('; '), csrf: csrfPair?.split('=')[1] };
  };
  return { db, members, srv, call, login, dir, close: async () => { await new Promise((r) => srv.server.close(r)); srv.server.closeAllConnections?.(); await rm(dir, { recursive: true, force: true }); } };
}

test('hosted server: no session = nothing; the development token opens nothing; no token file is written', async () => {
  const w = await world();
  try {
    assert.equal((await w.call('GET', '/api/cases')).status, 401);
    assert.equal((await w.call('GET', '/api/cases', { token: 'a'.repeat(48) })).status, 401, 'a development token is not a sign-in');
    assert.deepEqual((await w.call('GET', '/api/auth/session')).body, { mode: 'session', authenticated: false });
    assert.ok(!(await readdir(w.dir)).includes('token.txt'));
  } finally { await w.close(); }
});

test('sign-in: wrong password, a stranger and a member of another merchant all get the same LOGIN_FAILED; a member gets the two __Host- cookies', async () => {
  const w = await world();
  try {
    for (const r of [await w.login(P.owner, 'wrong password'), await w.login(P.stranger)]) { assert.equal(r.status, 401); assert.equal(r.body.error, 'LOGIN_FAILED'); assert.equal(r.set.length, 0); }
    const ok = await w.login(P.owner);
    assert.equal(ok.status, 200); assert.equal(ok.body.ok, true);
    const sid = ok.set.find((c) => c.startsWith('__Host-nordla_sourcing_sid=')); const csrf = ok.set.find((c) => c.startsWith('__Host-nordla_sourcing_csrf='));
    assert.match(sid, /HttpOnly/); assert.match(sid, /Secure/); assert.match(sid, /SameSite=Lax/); assert.match(sid, /Path=\//); assert.doesNotMatch(sid, /Domain=/);
    assert.doesNotMatch(csrf, /HttpOnly/, 'the page reads the CSRF cookie'); assert.match(csrf, /Secure/);
    assert.deepEqual((await w.call('GET', '/api/auth/session', { cookie: ok.cookie })).body, { mode: 'session', authenticated: true, role: 'OWNER' });
    assert.equal((await w.call('POST', '/api/auth/login', { body: { email: P.owner.email, password: P.owner.password }, origin: 'https://evil.example' })).status, 403, 'login only from the exact origin');
    assert.equal((await w.call('POST', '/api/auth/login', { body: { email: P.owner.email, password: P.owner.password, merchantId: OTHER } })).status, 400, 'no merchant from the client');
  } finally { await w.close(); }
});

test('a member of the merchant WITHOUT the sourcing module enabled cannot sign in (same LOGIN_FAILED)', async () => {
  const w = await world({ sourcingEnabled: false });
  try { const r = await w.login(P.owner); assert.equal(r.status, 401); assert.equal(r.body.error, 'LOGIN_FAILED'); } finally { await w.close(); }
});

test('with a session: reads work; a change needs the same origin AND the CSRF pair; cases and photos are stored', async () => {
  const w = await world();
  try {
    const s = await w.login(P.buyer);
    assert.equal((await w.call('GET', '/api/cases', { cookie: s.cookie })).status, 200);
    const c = newCase({ id: 'case-1', name: 'gourde', now: new Date('2026-10-15T08:00:00Z') });
    assert.equal((await w.call('PUT', '/api/cases/case-1', { body: c, cookie: s.cookie })).status, 403, 'no CSRF header');
    assert.equal((await w.call('PUT', '/api/cases/case-1', { body: c, cookie: s.cookie, csrf: 'A'.repeat(43) })).status, 403, 'a wrong CSRF token');
    assert.equal((await w.call('PUT', '/api/cases/case-1', { body: c, cookie: s.cookie, csrf: s.csrf, origin: 'https://evil.example' })).status, 403, 'another origin');
    assert.equal((await w.call('PUT', '/api/cases/case-1', { body: c, cookie: s.cookie, csrf: s.csrf })).status, 200);
    const photo = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 9, 9]).toString('base64')}`;
    assert.equal((await w.call('PUT', `/api/cases/case-1/photos/${encodeURIComponent('photo:case-1.0')}`, { body: { dataUrl: photo }, cookie: s.cookie, csrf: s.csrf })).body.status, 'STORED');
    assert.equal((await w.call('GET', `/api/cases/case-1/photos/${encodeURIComponent('photo:case-1.0')}`, { cookie: s.cookie })).body.dataUrl, photo);
  } finally { await w.close(); }
});

test('a suspended member is out at the next request; a logged-out session is revoked server-side', async () => {
  const w = await world();
  try {
    const b = await w.login(P.buyer); const o = await w.login(P.owner);
    assert.equal((await w.call('GET', '/api/cases', { cookie: b.cookie })).status, 200);
    await w.members.suspendMember({ actorUserId: P.owner.id, targetUserId: P.buyer.id });
    assert.equal((await w.call('GET', '/api/cases', { cookie: b.cookie })).status, 401, 'membership re-read on every request');
    const out = await w.call('POST', '/api/auth/logout', { cookie: o.cookie, csrf: o.csrf });
    assert.equal(out.status, 200); assert.ok((out.headers['set-cookie'] ?? []).every((c) => /Max-Age=0/.test(c)), 'both cookies cleared');
    assert.equal((await w.call('GET', '/api/cases', { cookie: o.cookie })).status, 401, 'the old cookie no longer opens anything');
    assert.ok(w.db.table('app_sessions').some((x) => x.user_id === P.owner.id && x.revoked_at), 'revoked in the session table');
  } finally { await w.close(); }
});

test('Railway health probe: /healthz answers for its own host name (healthcheck.railway.app) with no data; every other route keeps the Host allow-list', async () => {
  const w = await world();
  try {
    const probe = (host, path) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port: w.srv.port, path, method: 'GET', headers: { host } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t })); }); r.on('error', reject); r.end(); });
    const h = await probe('healthcheck.railway.app', '/healthz'); assert.equal(h.status, 200); assert.deepEqual(JSON.parse(h.body), { ok: true });
    for (const path of ['/', '/api/auth/session', '/api/cases', '/healthz/x']) assert.equal((await probe('healthcheck.railway.app', path)).status, 421, path);
  } finally { await w.close(); }
});
