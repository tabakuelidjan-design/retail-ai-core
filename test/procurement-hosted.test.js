// Stock / Achats MOUNTED on the Nordla server (hosted.js): roles and explicit grants from the Core identity, the phone screens served under /procurement/, the UI network
// layer in hosted mode (cookie session + CSRF, API under /api/procurement), persistence across a restart, and failure isolation.
// src/sourcing/server/app.js (another workstream's file) is NOT modified by this branch: the small wrapper below stands in for its mount, line for line
// (static -> handleStatic; /api/procurement/* -> procurementUserFor(actor) -> handleApi), and docs/integration/stock-achats-v1-patch-sourcing-app.md carries the exact patch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildHostedProcurement, procurementUserFor, parseGrants } from '../src/procurement/server/hosted.js';

const MERCHANT = randomUUID();
const actors = { owner: { userId: 'u-owner', role: 'OWNER' }, admin: { userId: 'u-admin', role: 'ADMIN' }, collab: { userId: 'u-collab', role: 'COLLABORATOR' }, viewer: { userId: 'u-view', role: 'VIEWER' }, accountant: { userId: 'u-acc', role: 'ACCOUNTANT' }, ghost: { userId: 'u-x', role: 'STRANGER' } };
const GRANTS = JSON.stringify({ 'u-collab': ['RECEIVE'], 'u-admin': ['RECEIVE', 'ADJUST'], 'u-view': ['RECEIVE', 'ADJUST'] });
let n = 0; const idem = () => `host-${Date.now()}-${++n}`;

async function mount(dir, env = {}) {
  const proc = await buildHostedProcurement({ dir, merchantId: MERCHANT, env: { PROCUREMENT_GRANTS: GRANTS, ...env } });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'); const raw = req.headers['x-test-actor']; const actor = raw ? actors[raw] : null; // stands in for the session gate
    if (url.pathname.startsWith('/procurement')) return proc.handler.handleStatic(req, res, url);
    if (url.pathname.startsWith('/api/procurement/')) { if (!actor) { res.writeHead(401); return res.end('{}'); } const user = procurementUserFor(actor); if (!user) { res.writeHead(403); return res.end('{"error":"FORBIDDEN"}'); } return proc.handler.handleApi(req, res, url, user); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  const call = async (method, path, { as = 'owner', body, key } = {}) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: 'manual', headers: { ...(as ? { 'x-test-actor': as } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'idempotency-key': key ?? idem() } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text, headers: r.headers }; };
  return { proc, call, close: async () => { await new Promise((r) => server.close(r)); await proc.close?.(); } };
}

test('roles and grants: Core roles map to the least privilege; explicit grants add exactly what they name; a viewer, an accountant and an unknown role gain nothing', async () => {
  await buildHostedProcurement({ dir: mkdtempSync(join(tmpdir(), 'nordla-h-')), merchantId: MERCHANT, env: { PROCUREMENT_GRANTS: GRANTS } }); // configures the grants as the real start does
  const u = (k) => procurementUserFor(actors[k]);
  assert.deepEqual([u('owner').role, u('owner').canApprove, u('owner').approverRole], ['OWNER', true, 'OWNER']);
  assert.deepEqual([u('admin').role, u('admin').canApprove, u('admin').grants.sort()], ['BUYER', false, ['ADJUST', 'RECEIVE']], 'an admin buys; the grants make them a receiver/adjuster, not an approver of orders');
  assert.deepEqual([u('collab').role, u('collab').grants], ['WAREHOUSE', ['RECEIVE']]);
  assert.deepEqual([u('viewer').role, u('accountant').role], ['VIEWER', 'VIEWER']); assert.equal(u('ghost'), null); assert.equal(procurementUserFor({ role: 'OWNER' }), null, 'no identity, no access');
  assert.equal(procurementUserFor(actors.collab, new Map()).grants.length, 0, 'without configuration nobody holds a grant');
});

test('grants configuration: malformed or unknown values are refused (the module stays OFF, never half-configured)', async () => {
  assert.equal(parseGrants('').size, 0); assert.equal(parseGrants(undefined).size, 0); assert.deepEqual([...parseGrants('{"a":["RECEIVE"]}').get('a')], ['RECEIVE']);
  for (const bad of ['{', '[]', '"x"', '{"a":"RECEIVE"}', '{"a":["SUPERUSER"]}', '{"a":["receive"]}']) assert.throws(() => parseGrants(bad), (e) => e.code === 'GRANTS_INVALID', bad);
  const off = await buildHostedProcurement({ dir: mkdtempSync(join(tmpdir(), 'nordla-h-')), merchantId: MERCHANT, env: { PROCUREMENT_GRANTS: '{"a":["SUPERUSER"]}' } });
  assert.equal(off.handler, null); assert.equal(off.assistant, null); assert.match(off.status, /OFF \(GRANTS_INVALID\)/);
});

test('the phone screens are served under /procurement/ (static only), with relative asset URLs; nothing else leaks', async (t) => {
  const m = await mount(mkdtempSync(join(tmpdir(), 'nordla-h-'))); t.after(() => m.close());
  const bare = await m.call('GET', '/procurement', { as: null }); assert.equal(bare.status, 301); assert.equal(bare.headers.get('location'), '/procurement/');
  const idx = await m.call('GET', '/procurement/', { as: null }); assert.equal(idx.status, 200); assert.match(idx.headers.get('content-type'), /text\/html/); assert.match(idx.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(idx.headers.get('x-frame-options'), 'DENY');
  assert.doesNotMatch(idx.text, /(?:src|href)="\//, 'no absolute asset URL: the page works from /procurement/ as well as from /'); assert.match(idx.text, /src="app\.js"/);
  for (const f of ['app.js', 'api.js', 'logic.js', 'screens-v1.js', 'outbox.js', 'app.css', 'sw.js', 'manifest.webmanifest', 'icon.svg']) assert.equal((await m.call('GET', `/procurement/${f}`, { as: null })).status, 200, f);
  const man = JSON.parse((await m.call('GET', '/procurement/manifest.webmanifest', { as: null })).text); assert.equal(man.start_url, '.'); assert.equal(man.scope, '.');
  for (const bad of ['/procurement/../package.json', '/procurement/%2e%2e/package.json', '/procurement/data.json', '/procurement/..%5Cx.js', '/procurement/a/b.js']) assert.equal((await m.call('GET', bad, { as: null })).status, 404, bad);
  assert.equal((await m.call('POST', '/procurement/', { as: null, body: {} })).status, 405);
  assert.equal((await m.call('GET', '/api/procurement/stock', { as: null })).status, 401, 'the data stays behind the session');
});

test('the UI network layer in hosted mode: the API prefix, the CSRF header, no pairing token; standalone mode is unchanged', async () => {
  const keep = { location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch };
  const seen = []; globalThis.fetch = async (url, opts) => { seen.push({ url, headers: opts.headers, credentials: opts.credentials }); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    globalThis.location = { pathname: '/procurement/', hash: '' }; globalThis.document = { cookie: 'a=1; __Host-nordla_sourcing_csrf=tok123; b=2' };
    const hosted = await import(`../src/procurement/ui/api.js?hosted=${Date.now()}`);
    assert.equal(hosted.HOSTED, true); assert.equal(hosted.apiPath('/api/stock'), '/api/procurement/stock'); assert.equal(hosted.apiPath('/api/uploads/abc.jpg'), '/api/procurement/uploads/abc.jpg'); assert.equal(hosted.apiPath('/elsewhere'), '/elsewhere');
    await hosted.request('POST', '/api/stock/transfers', { key: 'k-12345678', body: { a: 1 } });
    assert.equal(seen[0].url, '/api/procurement/stock/transfers'); assert.equal(seen[0].headers['x-nordla-csrf'], 'tok123'); assert.equal(seen[0].headers['x-nordla-token'], undefined, 'no development token in hosted mode'); assert.equal(seen[0].headers['idempotency-key'], 'k-12345678'); assert.equal(seen[0].credentials, 'same-origin');
    globalThis.location = { pathname: '/', hash: '' }; globalThis.document = { cookie: '' };
    const local = await import(`../src/procurement/ui/api.js?local=${Date.now()}`);
    assert.equal(local.HOSTED, false); assert.equal(local.apiPath('/api/stock'), '/api/stock'); await local.request('GET', '/api/stock'); assert.equal(seen[1].url, '/api/stock'); assert.ok('x-nordla-token' in seen[1].headers); assert.equal(seen[1].headers['x-nordla-csrf'], undefined);
  } finally { Object.assign(globalThis, keep); for (const k of ['location', 'document']) if (keep[k] === undefined) delete globalThis[k]; }
});

test('through the mount: the owner buys and orders, a granted collaborator receives, an ungranted one and a viewer cannot; everything survives a restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nordla-h-')); let m = await mount(dir); t.after(() => m.close());
  assert.equal((await m.call('GET', '/api/procurement/me', { as: 'collab' })).json.canReceive, true); assert.equal((await m.call('GET', '/api/procurement/me', { as: 'viewer' })).json.canReceive, false, 'a viewer\'s grant is ignored');
  assert.equal((await m.call('GET', '/api/procurement/me', { as: 'admin' })).json.canAdjust, true);
  assert.equal((await m.call('GET', '/api/procurement/stock', { as: 'ghost' })).status, 403); assert.equal((await m.call('GET', '/api/procurement/stock', { as: 'accountant' })).status, 200, 'an accountant reads');
  assert.equal((await m.call('POST', '/api/procurement/suppliers', { as: 'accountant', body: { name: 'X', currency: 'USD' } })).status, 403);
  const sup = (await m.call('POST', '/api/procurement/suppliers', { as: 'admin', body: { name: 'Yiwu Co', country: 'CN', currency: 'USD' } })).json.supplier;
  const v = (await m.call('POST', '/api/procurement/visits', { as: 'admin', body: { supplierName: 'Yiwu Co', currency: 'USD', date: '2026-10-20' } })).json;
  const c = (await m.call('POST', `/api/procurement/visits/${v.visit.id}/products`, { as: 'admin', body: { product: { name: 'Keychain' }, quote: { unitPrice: '0.5', moq: 10 } } })).json;
  const po = (await m.call('POST', '/api/procurement/purchase-orders', { as: 'admin', body: { lines: [{ quoteId: c.quoteId, qty: 60 }], expectedDate: '2026-12-01', fx: { from: 'USD', to: 'EUR', rate: '0.9', date: '2026-10-20', source: 'test' } } })).json.purchaseOrder;
  await m.call('POST', `/api/procurement/purchase-orders/${po.id}/submit`, { as: 'admin' });
  assert.equal((await m.call('POST', `/api/procurement/purchase-orders/${po.id}/approve`, { as: 'admin' })).status, 403, 'only the owner (or an APPROVE_PO grant) approves orders');
  assert.equal((await m.call('POST', `/api/procurement/purchase-orders/${po.id}/approve`, { as: 'owner' })).status, 200); assert.equal((await m.call('POST', `/api/procurement/purchase-orders/${po.id}/order`, { as: 'owner', body: {} })).status, 200);
  const body = { lines: [{ poLineId: po.lines[0].id, qtyAccepted: 60 }] };
  assert.equal((await m.call('POST', `/api/procurement/purchase-orders/${po.id}/receive`, { as: 'viewer', body })).status, 403);
  assert.equal((await m.call('POST', `/api/procurement/purchase-orders/${po.id}/receive`, { as: 'collab', body })).status, 200);
  const before = (await m.call('GET', '/api/procurement/stock')).json; assert.equal(before.items[0].physical, 60);
  assert.ok(existsSync(join(dir, 'procurement', 'procurement.json')), 'the file store of this phase is in the data volume');
  await m.close(); m = await mount(dir); // restart
  const after = (await m.call('GET', '/api/procurement/stock')).json; assert.deepEqual(after.items.map((i) => [i.sku, i.physical]), before.items.map((i) => [i.sku, i.physical]));
  assert.equal((await m.call('GET', `/api/procurement/suppliers/${sup.id}`, { as: 'viewer' })).json.supplier.name, 'Yiwu Co');
  assert.equal((await m.call('POST', `/api/procurement/purchase-orders/${po.id}/receive`, { as: 'collab', body })).status, 409, 'received once: a second receipt of the same goods is refused after the restart');
});

test('PostgreSQL is used only when asked; asking without the driver turns the module OFF and never falls back to the file', async () => {
  const have = (() => { try { createRequire(import.meta.url).resolve('pg'); return true; } catch { return false; } })();
  if (have) return; // with the driver installed this would try a real connection: that proof lives in the PostgreSQL smoke tests
  const dir = mkdtempSync(join(tmpdir(), 'nordla-h-')); const logs = [];
  const off = await buildHostedProcurement({ dir, merchantId: MERCHANT, env: { PROCUREMENT_PG_URL: 'postgres://nobody@127.0.0.1:1/none' }, log: (l) => logs.push(l) });
  assert.equal(off.handler, null); assert.match(off.status, /OFF \(PG_DRIVER_MISSING\)/); assert.ok(!existsSync(join(dir, 'procurement', 'procurement.json')), 'no file store was opened behind the operator\'s back'); assert.match(logs.join('\n'), /rest of Nordla is unaffected/);
  assert.ok(readFileSync(new URL('../src/procurement/server/hosted.js', import.meta.url), 'utf8').includes('never falls back'));
});

// ---------------------------------------------------------------- the same mount on a REAL PostgreSQL (PROCUREMENT_STORE=pg, test/postgres/procurement-parity.mjs)
import { STORE_KIND, pgPool, ensureMerchant } from './procurement-fixtures.js';
test('hosted on PostgreSQL: the mount, the grants, a receipt and a filed stock change survive a restart (a new store on the same database)', { skip: STORE_KIND !== 'pg' ? 'needs PROCUREMENT_STORE=pg (real PostgreSQL)' : false }, async (t) => {
  const merchant = randomUUID(); await ensureMerchant(merchant); const dir = mkdtempSync(join(tmpdir(), 'nordla-hpg-'));
  const boot = async () => {
    const proc = await buildHostedProcurement({ dir, merchantId: merchant, env: { PROCUREMENT_GRANTS: GRANTS }, pgPool: pgPool() });
    assert.match(proc.status, /ON \(PostgreSQL;/);
    const server = http.createServer((req, res) => { const url = new URL(req.url, 'http://x'); const actor = actors[req.headers['x-test-actor']]; if (!actor) { res.writeHead(401); return res.end('{}'); } return proc.handler.handleApi(req, res, url, procurementUserFor(actor)); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
    const call = async (method, path, { as = 'owner', body } = {}) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-test-actor': as, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); let json = null; try { json = await r.json(); } catch { /* none */ } return { status: r.status, json }; };
    return { call, close: () => new Promise((r) => server.close(r)) };
  };
  let m = await boot(); t.after(() => m.close());
  assert.ok(!existsSync(join(dir, 'procurement', 'procurement.json')), 'nothing is written to the file store when PostgreSQL is the store');
  const v = (await m.call('POST', '/api/procurement/visits', { as: 'admin', body: { supplierName: 'Yiwu Co', currency: 'USD', date: '2026-10-20' } })).json;
  const c = (await m.call('POST', `/api/procurement/visits/${v.visit.id}/products`, { as: 'admin', body: { product: { name: 'Keychain' }, quote: { unitPrice: '0.5', moq: 10 } } })).json;
  const po = (await m.call('POST', '/api/procurement/purchase-orders', { as: 'admin', body: { lines: [{ quoteId: c.quoteId, qty: 40 }], expectedDate: '2026-12-01', fx: { from: 'USD', to: 'EUR', rate: '0.9', date: '2026-10-20', source: 'test' } } })).json.purchaseOrder;
  await m.call('POST', `/api/procurement/purchase-orders/${po.id}/submit`, { as: 'admin' }); await m.call('POST', `/api/procurement/purchase-orders/${po.id}/approve`, { as: 'owner' }); await m.call('POST', `/api/procurement/purchase-orders/${po.id}/order`, { as: 'owner', body: {} });
  assert.equal((await m.call('POST', `/api/procurement/purchase-orders/${po.id}/receive`, { as: 'collab', body: { lines: [{ poLineId: po.lines[0].id, qtyAccepted: 40 }] } })).status, 200);
  const stock = (await m.call('GET', '/api/procurement/stock')).json; const itemId = stock.items[0].itemId; const W = stock.locations.find((l) => l.type === 'WAREHOUSE').id;
  const filed = await m.call('POST', '/api/procurement/stock/requests', { as: 'collab', body: { type: 'ADJUST', itemId, locationId: W, delta: -2, reason: 'two units crushed in the delivery' } }); assert.equal(filed.status, 200, JSON.stringify(filed.json));
  await m.close(); m = await boot(); // restart: a fresh store over the same database
  assert.equal((await m.call('GET', '/api/procurement/stock')).json.items[0].physical, 40);
  const pending = (await m.call('GET', '/api/procurement/stock/requests?status=PENDING')).json.requests; assert.equal(pending.length, 1); assert.equal(pending[0].delta, -2);
  assert.equal((await m.call('POST', `/api/procurement/stock/requests/${pending[0].requestId}/decision`, { as: 'collab', body: { decision: 'APPROVE' } })).status, 403, 'RECEIVE does not approve');
  const rs = await Promise.all(['owner', 'admin', 'owner'].map((as) => m.call('POST', `/api/procurement/stock/requests/${pending[0].requestId}/decision`, { as, body: { decision: 'APPROVE' } })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status))); assert.equal((await m.call('GET', '/api/procurement/stock')).json.items[0].physical, 38);
  assert.equal((await m.call('GET', `/api/procurement/stock/${itemId}/history`)).json.movements.map((x) => x.kind).join(), 'RECEIPT,ADJUSTMENT');
});
