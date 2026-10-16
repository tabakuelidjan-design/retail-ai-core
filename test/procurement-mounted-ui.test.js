// Stock / Achats phone screens MOUNTED on the real hosted Nordla server (session + CSRF + module access). Same boot as test/convergence-journey.test.js.
// Runs only when src/sourcing/server/app.js carries the one-line static mount (docs/integration/stock-achats-v1-patch-sourcing-app.patch); until then it is skipped, on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
const people = ['owner', 'buyer', 'admin', 'stranger'].map((k, i) => ({ key: k, id: `${String(i + 1).padStart(8, '0')}-2222-4222-8222-${String(i + 1).padStart(12, '0')}`, email: `${k}@nordla-test.example`, password: `synthetic passphrase for ${k}` }));
const P = Object.fromEntries(people.map((p) => [p.key, p]));
const HOST = 'sourcing.nordla-test.example'; const ORIGIN = `https://${HOST}`;
const ENV = { SOURCING_HOSTED: '1', NORDLA_MERCHANT_ID: M, SOURCING_PUBLIC_ORIGIN: ORIGIN, SUPABASE_URL: 'https://ref.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test', SUPABASE_ANON_KEY: 'anon-test',
  NORDLA_IDENTITY_RATE_LIMIT_KEY: randomBytes(32).toString('hex'), NORDLA_CSRF_KEY: randomBytes(32).toString('hex'), SOURCING_MERCHANT_ID: 'habb', SOURCING_HOST: '127.0.0.1' };

async function world({ sourcingEnabled = true, dir: given = null, keep = false } = {}) {
  const db = createIdentityDb({ merchants: [M, OTHER], users: people.map((p) => p.id) });
  const auth = createFakeGoTrue({ users: people });
  const identity = createIdentityService({ merchantId: M, moduleCode: 'sourcing', supabase: db.supabase, auth: { baseUrl: ENV.SUPABASE_URL, anonKey: ENV.SUPABASE_ANON_KEY }, sessions: loadIdentityConfig({}), rateLimits: loadRateLimitConfig({}), rateLimitKey: ENV.NORDLA_IDENTITY_RATE_LIMIT_KEY, fetchImpl: auth.fetchImpl });
  const security = createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: [HOST], allowedOrigins: [ORIGIN], moduleCode: 'sourcing', csrfKey: ENV.NORDLA_CSRF_KEY, rateLimitKey: ENV.NORDLA_IDENTITY_RATE_LIMIT_KEY, loginTiming: { minMs: 200, jitterMs: 0 } });
  const members = createMemberService({ supabase: db.supabase, merchantId: M });
  await members.bootstrapOwner({ userId: P.owner.id });
  await members.addMember({ actorUserId: P.owner.id, targetUserId: P.buyer.id, role: 'COLLABORATOR' });
  await members.addMember({ actorUserId: P.owner.id, targetUserId: P.admin.id, role: 'ADMIN' });
  if (sourcingEnabled) await createModuleProvisioning({ supabase: db.supabase }).enableModule({ merchantId: M, moduleCode: 'sourcing', source: 'provisioning:manual' });
  const dir = given ?? await mkdtemp(join(tmpdir(), 'src-hosted-'));
  const srv = await startSourcingServer({ env: { ...ENV, SOURCING_DATA_DIR: dir }, log: () => {}, port: 0, services: { identity, security }, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}) });
  // requests as Railway forwards them: TLS ended by the proxy, the real client in X-Real-IP
  const call = (method, path, { body, cookie, csrf, origin = ORIGIN, token, idem } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { host: HOST, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.7', 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-nordla-csrf': csrf } : {}), ...(token ? { 'x-sourcing-token': token } : {}), ...(idem ? { 'idempotency-key': idem } : {}), ...(data ? { 'content-length': data.length } : {}) };
    const req = http.request({ host: '127.0.0.1', port: srv.port, path, method, headers }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: t ? JSON.parse(t) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  const login = async (p, password = p.password) => {
    const r = await call('POST', '/api/auth/login', { body: { email: p.email, password } });
    const set = r.headers['set-cookie'] ?? []; const pick = (n) => set.find((c) => c.startsWith(n))?.split(';')[0];
    const sid = pick('__Host-nordla_sourcing_sid='); const csrfPair = pick('__Host-nordla_sourcing_csrf=');
    return { ...r, set, cookie: [sid, csrfPair].filter(Boolean).join('; '), csrf: csrfPair?.split('=')[1] };
  };
  return { db, members, srv, call, login, dir, close: async () => { await new Promise((r) => srv.server.close(r)); srv.server.closeAllConnections?.(); if (!keep) await rm(dir, { recursive: true, force: true }); } };
}

import { readFileSync } from 'node:fs';
const MOUNTED = readFileSync(new URL('../src/sourcing/server/app.js', import.meta.url), 'utf8').includes('procurement.handleStatic');
const skip = MOUNTED ? false : 'needs the one-line mount in src/sourcing/server/app.js (docs/integration/stock-achats-v1-patch-sourcing-app.patch, chantier 3)';
/** a GET that keeps the raw text (the screens are HTML / JS, not JSON), with the headers Railway forwards */
const raw = (w, path) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port: w.srv.port, path, method: 'GET', headers: { host: HOST, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.7' } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t })); }); r.on('error', reject); r.end(); });

test('the phone screens are served at /procurement/ by the hosted server; the data stays behind the session, the CSRF check and the role', { skip }, async (t) => {
  const w = await world(); t.after(() => w.close());
  const page = await raw(w, '/procurement/');
  assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/); assert.match(page.text, /src="app\.js"/); assert.match(page.headers['content-security-policy'] ?? '', /script-src 'self'/);
  assert.equal((await raw(w, '/procurement/app.js')).status, 200); assert.equal((await raw(w, '/procurement/screens-v1.js')).status, 200); assert.equal((await raw(w, '/procurement')).status, 301);
  assert.equal((await raw(w, '/procurement/..%2fpackage.json')).status, 404);
  assert.equal((await w.call('GET', '/api/procurement/stock')).status, 401, 'no session, no data');
  const owner = await w.login(P.owner); assert.equal(owner.status, 200);
  const me = await w.call('GET', '/api/procurement/me', { cookie: owner.cookie }); assert.equal(me.status, 200); assert.equal(me.body.role, 'OWNER'); assert.equal(me.body.canAdjust, true); assert.equal(me.body.canSelfApprove, true);
  assert.equal((await w.call('GET', '/api/procurement/stock', { cookie: owner.cookie })).status, 200);
  const noCsrf = await w.call('POST', '/api/procurement/suppliers', { cookie: owner.cookie, body: { name: 'Yiwu Co', currency: 'USD' } }); assert.equal(noCsrf.status, 403, 'a change without the CSRF token is refused by the host');
  const mk = await w.call('POST', '/api/procurement/suppliers', { cookie: owner.cookie, csrf: owner.csrf, body: { name: 'Yiwu Co', country: 'CN', currency: 'USD' }, idem: 'mount-test-0001' });
  assert.equal(mk.status, 200, JSON.stringify(mk.body)); assert.equal(mk.body.supplier.name, 'Yiwu Co');
  const again = await w.call('POST', '/api/procurement/suppliers', { cookie: owner.cookie, csrf: owner.csrf, body: { name: 'Yiwu Co', country: 'CN', currency: 'USD' }, idem: 'mount-test-0001' }); assert.equal(again.body.replayed, true, 'a retried change through the host is harmless');
  const buyer = await w.login(P.buyer); const bme = (await w.call('GET', '/api/procurement/me', { cookie: buyer.cookie })).body;
  assert.deepEqual([bme.role, bme.canReceive, bme.canAdjust, bme.canApprove], ['WAREHOUSE', false, false, false], 'a collaborator reads; without an explicit grant they cannot receive, adjust or approve');
  const stranger = await w.login(P.stranger); assert.ok([401, 403].includes((await w.call('GET', '/api/procurement/stock', { cookie: stranger.cookie })).status));
});
