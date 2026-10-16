// CONVERGENCE wave 1: the owner's journey on ONE Nordla server (identity -> Sourcing -> Buying -> Parle a Nordla -> approvals -> restart).
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
  return { db, members, srv, call, login, dir, close: async () => { await new Promise((r) => srv.server.close(r)); srv.server.closeAllConnections?.(); if (!keep) await rm(dir, { recursive: true, force: true }); } };
}


const NODE24 = Number(process.versions.node.split('.')[0]) >= 24;
const at = (n) => new Date(Date.UTC(2026, 9, 20, 8, n));
async function sourcingCase() {
  const { newCase, dispatch } = await import('../src/sourcing/core/case.js');
  let a = newCase({ id: 'case-yiwu-keychain', name: '', now: at(0) });
  a = dispatch(a, { type: 'NAME', name: 'Acrylic keychain 5 cm' }, at(1));
  a = dispatch(a, { type: 'SUPPLIER', supplier: { name: 'Yiwu Bright Gifts Co., Ltd' } }, at(2));
  a = dispatch(a, { type: 'QUOTE', quote: { unitPrice: '0.085', currency: 'USD', moq: 1000, incoterm: 'FOB', port: 'Ningbo', leadTimeDays: 25, payment: { depositPct: '30' }, tiers: [{ minQty: 1000, unitPrice: '0.085' }, { minQty: 5000, unitPrice: '0.072' }] } }, at(4));
  return a;
}

// THE JOURNEY, on ONE hosted Nordla server (real HTTP, real session + CSRF, file persistence), no module faked:
// sign in -> a China Sourcing case saved on the server -> imported into Buying (twice: no duplicate) -> a draft purchase order from the case ->
// Parle à Nordla finds the order from the SAME persistent store -> sensitive steps refused to the wrong roles and need the owner's named approval
// -> the server is stopped and started again: order, approval and answers are still there.
test('journey: sign-in -> Sourcing case -> Buying draft -> Parle à Nordla -> approvals -> restart', { skip: NODE24 ? false : 'src/sourcing needs Node 24' }, async () => {
  const keepDir = await mkdtemp(join(tmpdir(), 'nordla-journey-'));
  let w = await world({ dir: keepDir, keep: true });
  try {
    const owner = await w.login(P.owner); const admin = await w.login(P.admin); const coll = await w.login(P.buyer);
    for (const s of [owner, admin, coll]) assert.equal(s.status, 200);
    const api = (s) => (method, path, body) => w.call(method, path, { body, cookie: s.cookie, csrf: s.csrf });
    const asOwner = api(owner); const asAdmin = api(admin);
    // procurement writes need an Idempotency-Key header, which w.call does not set: thin wrapper with the same Railway-shaped headers
    const write = (s, method, path, body, key) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const headers = { host: HOST, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.7', 'content-type': 'application/json', origin: ORIGIN, cookie: s.cookie, 'x-nordla-csrf': s.csrf, 'idempotency-key': key, ...(data ? { 'content-length': String(data.length) } : {}) };
      const req = http.request({ host: '127.0.0.1', port: w.srv.port, path, method, headers }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null })); });
      req.on('error', reject); if (data) req.write(data); req.end();
    });

    // identity: nothing without a session; a development token opens nothing; a change without CSRF is refused by the host
    assert.equal((await w.call('GET', '/api/procurement/purchase-orders')).status, 401);
    assert.equal((await w.call('GET', '/api/procurement/purchase-orders', { token: 'a'.repeat(48) })).status, 401);
    assert.equal((await w.call('GET', '/api/procurement/purchase-orders', { cookie: owner.cookie })).status, 200, 'a signed-in read needs no CSRF');
    assert.equal((await w.call('POST', '/api/procurement/sourcing/import', { body: { caseId: 'x' }, cookie: owner.cookie })).status, 403);
    assert.equal((await w.login(P.stranger)).status, 401);

    // 1. the field case is saved on the server (the phone's normal sync)
    const c = await sourcingCase();
    assert.equal((await asAdmin('PUT', `/api/cases/${c.id}`, c)).status, 200);

    // 2. Sourcing -> Buying: imported; importing again creates nothing new
    const first = await asAdmin('POST', '/api/procurement/sourcing/import', { caseId: c.id });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((await asAdmin('POST', '/api/procurement/sourcing/import', { caseId: c.id })).status, 200);
    assert.equal((await asOwner('GET', '/api/procurement/items')).body.items.length, 1, 'one prospect item, not two');

    // 3. a DRAFT purchase order from the case, by the buyer (ADMIN); a repeated request creates no second order
    const draft = await asAdmin('POST', '/api/procurement/sourcing/import', { caseId: c.id, qty: 1000, fxRate: '0.92', expectedDate: '2026-12-15' });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    await asAdmin('POST', '/api/procurement/sourcing/import', { caseId: c.id, qty: 1000, fxRate: '0.92', expectedDate: '2026-12-15' });
    const pos = (await asOwner('GET', '/api/procurement/purchase-orders')).body.purchaseOrders;
    assert.equal(pos.length, 1, 'no duplicate order');
    const po = pos[0]; assert.equal(po.status, 'DRAFT');

    // 4. Parle à Nordla reads the SAME store
    const ask = async (s, text) => (await w.call('POST', '/api/core/ask', { body: { text }, cookie: s.cookie, csrf: s.csrf })).body;
    const a1 = await ask(owner, 'Quelles commandes d’achat sont en cours ?');
    assert.equal(a1.status, 'ANSWERED', JSON.stringify(a1)); assert.match(a1.answer, new RegExp(po.number)); assert.match(a1.answer, /DRAFT/);
    assert.equal(a1.sources[0].kind, 'procurement');
    assert.match((await ask(owner, `Où en est la commande ${po.number} ?`)).answer, new RegExp(po.number));
    assert.equal((await ask(owner, 'Quel est mon stock ?')).status, 'ANSWERED');
    assert.equal((await ask(owner, 'Commande 1000 porte-clés maintenant')).status, 'ACTION_REFUSED', 'Parle never orders');
    const mods = (await w.call('GET', '/api/core/modules', { cookie: owner.cookie })).body.modules;
    assert.equal(mods.find((m) => m.key === 'procurement').state, 'DISPONIBLE');

    // 5. authorizations: a warehouse-level member cannot submit; a buyer cannot approve; only the owner approves, with a named approval
    assert.equal((await write(coll, 'POST', `/api/procurement/purchase-orders/${po.id}/submit`, {}, 'j-submit-coll-0001')).status, 403);
    assert.equal((await write(admin, 'POST', `/api/procurement/purchase-orders/${po.id}/submit`, {}, 'j-submit-admin-001')).status, 200);
    assert.equal((await write(admin, 'POST', `/api/procurement/purchase-orders/${po.id}/approve`, {}, 'j-approve-admin-01')).status, 403);
    const ap = await write(owner, 'POST', `/api/procurement/purchase-orders/${po.id}/approve`, {}, 'j-approve-owner-01');
    assert.equal(ap.status, 200, JSON.stringify(ap.body)); assert.equal(ap.body.purchaseOrder.status, 'APPROVED');
    assert.equal((await write(owner, 'POST', `/api/procurement/purchase-orders/${po.id}/approve`, {}, 'j-approve-owner-01')).body.replayed, true, 'a retry does not approve twice');
    assert.match((await ask(owner, 'Quelles commandes sont en cours ?')).answer, /APPROVED/);

    // 6. stop the server, start a new one on the same volume: everything is still there
    await w.close(); w = await world({ dir: keepDir, keep: true });
    const owner2 = await w.login(P.owner);
    const pos2 = (await w.call('GET', '/api/procurement/purchase-orders', { cookie: owner2.cookie })).body.purchaseOrders;
    assert.equal(pos2.length, 1); assert.equal(pos2[0].number, po.number); assert.equal(pos2[0].status, 'APPROVED');
    const a6 = (await w.call('POST', '/api/core/ask', { body: { text: 'Quelles commandes d’achat sont en cours ?' }, cookie: owner2.cookie, csrf: owner2.csrf })).body;
    assert.match(a6.answer, new RegExp(po.number)); assert.match(a6.answer, /APPROVED/);
    assert.equal((await w.call('GET', '/api/procurement/items', { cookie: owner2.cookie })).body.items.length, 1);
    assert.ok(JSON.stringify(JSON.parse(await readFile(join(keepDir, 'procurement', 'procurement.json'), 'utf8'))).includes(P.owner.id), 'the named owner is recorded as approver');
  } finally { await w.close(); await rm(keepDir, { recursive: true, force: true }); }
});
