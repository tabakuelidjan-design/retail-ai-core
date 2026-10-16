// The mobile server over real HTTP (loopback, ephemeral ports, throw-away data directories). Memory store for the API tests; the FILE store for the restart test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProcurement, createMemoryProcurementStore } from '../src/procurement/index.js';
import { createProcurementApp, listen } from '../src/procurement/server/app.js';
import { startProcurementServer } from '../src/procurement/server/index.js';

const OWNER = { id: 'owner', name: 'Owner', role: 'OWNER', canApprove: true, approverRole: 'OWNER', token: 'o'.repeat(32) };
const FIELD = { id: 'terrain', name: 'Field', role: 'BUYER', canApprove: false, token: 'f'.repeat(32) };
const REVIEWER = { id: 'reviewer', name: 'Reviewer', role: 'BUYER', canApprove: true, approverRole: 'AUTHORIZED_REVIEWER', token: 'r'.repeat(32) };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let n = 0; const idem = () => `test-key-${Date.now()}-${++n}`;

async function boot({ sourcingDir = null, now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nordla-srv-'));
  const store = createMemoryProcurementStore();
  const procurement = createProcurement({ store, merchantId: randomUUID(), now: now ? () => now().toISOString() : () => '2026-10-20T09:00:00.000Z' });
  await procurement.commands.createLocation({ id: 'system', role: 'OWNER' }, 'boot-1', { name: 'Reception', type: 'WAREHOUSE' });
  await procurement.commands.createLocation({ id: 'system', role: 'OWNER' }, 'boot-2', { name: 'Quarantine', type: 'QUARANTINE' });
  const handler = createProcurementApp({ procurement, users: [OWNER, FIELD, REVIEWER], sourcingDir, uploadsDir: join(dir, 'uploads'), ...(now ? { now } : {}) });
  const { server, port } = await listen(handler);
  const call = async (method, path, { user = OWNER, body, key, headers = {}, raw } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(user ? { 'x-nordla-token': user.token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' && key !== false ? { 'idempotency-key': key ?? idem() } : {}), ...headers }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers, raw: res };
  };
  return { port, server, call, procurement, close: () => new Promise((r) => server.close(r)) };
}

test('access: no token, a wrong token, lockout after 8 failures, host allow-list, security headers', async () => {
  let t = Date.parse('2026-10-20T09:00:00Z'); const now = () => new Date(t);
  const s = await boot({ now });
  assert.equal((await s.call('GET', '/api/me', { user: null })).status, 401);
  assert.equal((await s.call('GET', '/api/me', { user: { token: 'x'.repeat(32) } })).status, 401);
  const me = await s.call('GET', '/api/me', { user: FIELD });
  assert.deepEqual(me.json, { id: 'terrain', name: 'Field', role: 'BUYER', read: true, prepare: true, canApprove: false, canReceive: false, canAdjust: false, canSelfApprove: false, grants: [] });
  assert.match(me.headers.get('content-security-policy'), /default-src 'self'/); assert.equal(me.headers.get('cache-control'), 'no-store'); assert.equal(me.headers.get('x-frame-options'), 'DENY');
  const bad = await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port: s.port, path: '/api/me', headers: { host: 'evil.example', 'x-nordla-token': OWNER.token } }, (res) => { res.resume(); resolve(res.statusCode); }); r.end(); });
  assert.equal(bad, 421, 'a foreign Host header is refused');
  for (let i = 0; i < 8; i++) await s.call('GET', '/api/me', { user: { token: `bad-${i}`.padEnd(32, 'x') } });
  assert.equal((await s.call('GET', '/api/me', { user: OWNER })).status, 429, 'even a valid token is refused while locked out');
  t += 61_000;
  assert.equal((await s.call('GET', '/api/me', { user: OWNER })).status, 200, 'the lockout expires after a minute');
  assert.throws(() => createProcurementApp({ procurement: s.procurement, users: [{ ...OWNER, token: 'short' }], uploadsDir: 'x' }), /24 characters/);
  await s.close();
});

test('a write without an Idempotency-Key is refused; unknown ids are 404; bad input is 400', async () => {
  const s = await boot();
  assert.equal((await s.call('POST', '/api/visits', { body: { supplierName: 'X', currency: 'USD', date: '2026-10-20' }, key: false })).status, 400);
  assert.equal((await s.call('GET', '/api/visits/00000000-0000-0000-0000-000000000000')).status, 404);
  assert.equal((await s.call('GET', '/api/purchase-orders/00000000-0000-0000-0000-000000000000')).status, 404);
  const bad = await s.call('POST', '/api/visits', { body: { supplierName: 'X', currency: 'dollars', date: '2026-10-20' } });
  assert.equal(bad.status, 400); assert.equal(bad.json.error, 'INVALID_INPUT');
  assert.equal((await s.call('POST', '/api/visits', { raw: '{not json', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await s.call('GET', '/nope.txt', { user: null })).status, 404);
  await s.close();
});

test('the whole field journey over HTTP: visit, photo, products, comparison, draft purchase, approval with separation of duties, order', async () => {
  const s = await boot();
  const { call } = s;
  // photo
  const up = await call('POST', '/api/uploads', { user: FIELD, raw: PNG, headers: { 'content-type': 'image/png' } });
  assert.equal(up.status, 201); assert.match(up.json.ref, /^upload:\/\/[0-9a-f]{64}\.png$/);
  const img = await fetch(`http://127.0.0.1:${s.port}/api/uploads/${up.json.ref.slice(9)}`, { headers: { 'x-nordla-token': FIELD.token } });
  assert.equal(img.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/uploads/${up.json.ref.slice(9)}`)).status, 401, 'photos are private too');
  // two suppliers, the same product category
  const v1 = (await call('POST', '/api/visits', { user: FIELD, body: { supplierName: 'Yiwu Bright Gifts Ltd', currency: 'USD', date: '2026-10-20', place: 'Hall 2 B12' } })).json;
  const v2 = (await call('POST', '/api/visits', { user: FIELD, body: { supplierName: 'Ningbo Souvenir Co', currency: 'CNY', date: '2026-10-21', place: 'Factory' } })).json;
  const k1 = idem();
  const c1 = await call('POST', `/api/visits/${v1.visit.id}/products`, { user: FIELD, key: k1, body: { product: { name: 'Acrylic keychain 5cm', photos: [{ kind: 'PHOTO', ref: up.json.ref, sha256: up.json.sha256 }] }, quote: { unitPrice: '0.085', moq: 1000, incoterm: 'FOB', tiers: [{ minQty: 1000, unitPrice: '0.085' }, { minQty: 5000, unitPrice: '0.072' }], leadTimeDays: 25 } } });
  assert.equal(c1.status, 201); assert.equal(c1.json.itemCreated, true);
  const retry = await call('POST', `/api/visits/${v1.visit.id}/products`, { user: FIELD, key: k1, body: { product: { name: 'Acrylic keychain 5cm', photos: [{ kind: 'PHOTO', ref: up.json.ref, sha256: up.json.sha256 }] }, quote: { unitPrice: '0.085', moq: 1000, incoterm: 'FOB', tiers: [{ minQty: 1000, unitPrice: '0.085' }, { minQty: 5000, unitPrice: '0.072' }], leadTimeDays: 25 } } });
  assert.equal(retry.status, 200); assert.equal(retry.json.replayed, true); assert.equal(retry.json.itemId, c1.json.itemId);
  const c2 = await call('POST', `/api/visits/${v2.visit.id}/products`, { user: FIELD, body: { itemId: c1.json.itemId, quote: { unitPrice: '0.55', moq: 1000, incoterm: 'EXW' } } }); // same product, other supplier, priced in CNY
  assert.equal(c2.status, 201);
  const visit = (await call('GET', `/api/visits/${v1.visit.id}`, { user: FIELD })).json;
  assert.equal(visit.entries.length, 1); assert.equal(visit.entries[0].photo, up.json.ref); assert.equal(visit.entries[0].quote.tiers.length, 2);
  // compare: CNY has no rate -> listed, not ranked; with rates both rank, landed when costs are given
  const item = (await call('GET', `/api/items/${c1.json.itemId}`, { user: FIELD })).json;
  assert.equal(item.quotes.length, 2); assert.deepEqual(item.photos, [up.json.ref]);
  const noFx = (await call('GET', `/api/compare?itemId=${item.id}&qty=5000`, { user: FIELD })).json;
  assert.equal(noFx.offers.find((o) => o.currency === 'CNY').reason, 'FX_REQUIRED');
  const fx = encodeURIComponent(JSON.stringify({ USD: { rate: '0.92', date: '2026-10-20', source: 'saisie' }, CNY: { rate: '0.128', date: '2026-10-20', source: 'saisie' } }));
  const withFx = (await call('GET', `/api/compare?itemId=${item.id}&qty=5000&fx=${fx}`, { user: FIELD })).json;
  assert.equal(withFx.ranking.length, 2); assert.equal(withFx.basis, 'GOODS_PRICE_ONLY');
  const landed = (await call('GET', `/api/compare?itemId=${item.id}&qty=5000&fx=${fx}&freight=120&dutyPct=4&sellPrice=2.5`, { user: FIELD })).json;
  assert.equal(landed.basis, 'LANDED_COST', JSON.stringify(landed.offers.map((o) => [o.supplier, o.status, o.reason])));
  // prepare the purchase from the best quote
  const best = landed.ranking[0].quoteId; const bq = item.quotes.find((x) => x.id === best);
  const draft = await call('POST', '/api/purchase-orders', { user: FIELD, body: { lines: [{ quoteId: best, qty: 5000 }], expectedDate: '2026-12-10', ...(bq.currency === 'EUR' ? {} : { fx: { from: bq.currency, to: 'EUR', rate: bq.currency === 'USD' ? '0.92' : '0.128', date: '2026-10-20', source: 'saisie' } }) } });
  assert.equal(draft.status, 201); assert.equal(draft.json.purchaseOrder.status, 'DRAFT'); assert.match(draft.json.purchaseOrder.number, /^PO-2026-0001$/);
  const po = draft.json.purchaseOrder;
  assert.equal(po.lines[0].name, 'Acrylic keychain 5cm');
  assert.deepEqual((await call('GET', '/api/purchase-orders', { user: FIELD })).json.purchaseOrders.map((x) => x.number), ['PO-2026-0001']);
  assert.equal((await call('POST', '/api/overview'.replace('overview', 'purchase-orders/' + po.id + '/approve'), { user: FIELD })).status, 403, 'a field buyer cannot approve');
  const sub = await call('POST', `/api/purchase-orders/${po.id}/submit`, { user: FIELD });
  assert.equal(sub.json.purchaseOrder.status, 'PENDING_APPROVAL'); assert.equal(sub.json.purchaseOrder.submittedBy, 'terrain');
  // the owner approves what someone else prepared
  const k2 = idem();
  const ok = await call('POST', `/api/purchase-orders/${po.id}/approve`, { user: OWNER, key: k2 });
  assert.equal(ok.json.purchaseOrder.status, 'APPROVED');
  const again = await call('POST', `/api/purchase-orders/${po.id}/approve`, { user: OWNER, key: k2 });
  assert.equal(again.status, 200); assert.equal(again.json.replayed, true, 'a retried approval a few seconds later is the same request');
  const ordered = await call('POST', `/api/purchase-orders/${po.id}/order`, { user: OWNER, body: { supplierReference: 'YBG-77' } });
  assert.equal(ordered.json.purchaseOrder.status, 'ORDERED');
  const ov = (await call('GET', '/api/overview', { user: FIELD })).json;
  assert.equal(ov.purchases.ORDERED, 1); assert.equal(ov.openVisits, 2);
  const events = await s.procurement.queries.events({ objectId: po.id });
  assert.equal(events.find((e) => e.type === 'PO_APPROVED').approval.approverId, 'owner', 'the approval records the authenticated human, not anything the phone sent');
  await s.close();
});

test('separation of duties holds over HTTP: the person who prepared and submitted an order cannot approve it', async () => {
  const s = await boot();
  const v = (await s.call('POST', '/api/visits', { user: OWNER, body: { supplierName: 'Solo Supplier', currency: 'USD', date: '2026-10-20' } })).json;
  const c = (await s.call('POST', `/api/visits/${v.visit.id}/products`, { user: OWNER, body: { product: { name: 'Thing' }, quote: { unitPrice: '1', moq: 10 } } })).json;
  const po = (await s.call('POST', '/api/purchase-orders', { user: OWNER, body: { lines: [{ quoteId: c.quoteId, qty: 10 }], expectedDate: '2026-12-10', fx: { from: 'USD', to: 'EUR', rate: '0.9', date: '2026-10-20', source: 'x' } } })).json.purchaseOrder;
  await s.call('POST', `/api/purchase-orders/${po.id}/submit`, { user: OWNER });
  const own = await s.call('POST', `/api/purchase-orders/${po.id}/approve`, { user: OWNER });
  assert.equal(own.status, 403); assert.equal(own.json.error, 'SEPARATION_OF_DUTIES');
  const other = await s.call('POST', `/api/purchase-orders/${po.id}/approve`, { user: REVIEWER });
  assert.equal(other.json.purchaseOrder.status, 'APPROVED');
  const wrong = await s.call('POST', `/api/purchase-orders/${po.id}/cancel`, { user: FIELD, body: { reason: 'x' } });
  assert.equal(wrong.status, 400, 'a cancellation needs a real reason');
  await s.close();
});

test('uploads: only images, size-capped, stored under their own hash', async () => {
  const s = await boot();
  assert.equal((await s.call('POST', '/api/uploads', { raw: Buffer.from('MZ-not-an-image'), headers: { 'content-type': 'application/x-msdownload' } })).status, 415);
  assert.equal((await s.call('POST', '/api/uploads', { raw: Buffer.alloc(0), headers: { 'content-type': 'image/png' } })).status, 400);
  const small = createProcurementApp({ procurement: s.procurement, users: [OWNER], uploadsDir: join(tmpdir(), 'nordla-srv-small'), maxUpload: 100 });
  const l = await listen(small);
  const r = await fetch(`http://127.0.0.1:${l.port}/api/uploads`, { method: 'POST', headers: { 'x-nordla-token': OWNER.token, 'content-type': 'image/png' }, body: Buffer.alloc(500) });
  assert.equal(r.status, 413); await new Promise((x) => l.server.close(x));
  const a = await s.call('POST', '/api/uploads', { raw: PNG, headers: { 'content-type': 'image/png' } }); const b = await s.call('POST', '/api/uploads', { raw: PNG, headers: { 'content-type': 'image/png' } });
  assert.equal(a.json.ref, b.json.ref, 'the same photo is stored once');
  await s.close();
});

test('China Sourcing over HTTP: list the cases on disk, import one without retyping, prepare a draft order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nordla-cases-')); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'case-a1.json'), JSON.stringify({ schema: 2, id: 'case-a1', updatedAt: '2026-10-20T08:00:00Z', identity: { workingName: 'Magnet round', identifiers: {}, photos: [{ ref: 'upload://p.jpg' }] }, supplier: { name: 'Yiwu Sunshine Crafts' }, quotes: [{ at: 't', currency: 'USD', unitPrice: '0.5', moq: 100, tiers: [{ minQty: 100, unitPrice: '0.5' }] }] }));
  writeFileSync(join(dir, 'broken.json'), '{ nope');
  const s = await boot({ sourcingDir: dir });
  const list = (await s.call('GET', '/api/sourcing/cases', { user: FIELD })).json;
  assert.equal(list.available, true); assert.deepEqual(list.cases.map((c) => [c.id, c.supplier, c.quotes, c.photos]), [['case-a1', 'Yiwu Sunshine Crafts', 1, 1]]);
  const imp = (await s.call('POST', '/api/sourcing/import', { user: FIELD, body: { caseId: 'case-a1' } })).json;
  assert.equal(imp.status, 'IMPORTED'); assert.equal(imp.item.created, true);
  const again = (await s.call('POST', '/api/sourcing/import', { user: FIELD, body: { caseId: 'case-a1' } })).json;
  assert.equal(again.item.created, false); assert.deepEqual(again.quotes.map((q) => q.status), ['UNCHANGED']);
  const draft = (await s.call('POST', '/api/sourcing/import', { user: FIELD, body: { caseId: 'case-a1', qty: 200, expectedDate: '2026-12-01', fx: { from: 'USD', to: 'EUR', rate: '0.9', date: '2026-10-20', source: 'x' } } })).json;
  assert.equal(draft.purchaseOrder.status, 'DRAFT');
  assert.equal((await s.call('POST', '/api/sourcing/import', { user: FIELD, body: { caseId: '../../etc/passwd' } })).status, 400, 'a case id can never be a path');
  const none = await boot();
  assert.equal((await none.call('GET', '/api/sourcing/cases')).json.available, false);
  await s.close(); await none.close();
});

test('FOUND AGAIN AFTER A RESTART: what was captured on the phone is there when the server comes back, with the same tokens, nothing lost', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'nordla-restart-'));
  const env = { PROCUREMENT_DATA_DIR: dataDir, NORDLA_MERCHANT_ID: randomUUID() };
  let s1 = await startProcurementServer({ env, port: 0, log: () => {}, dataDir });
  const token = s1.users.find((u) => u.id === 'terrain').token; const ownerToken = s1.users.find((u) => u.id === 'owner').token;
  const api = (port, tok) => async (method, path, body, key = idem()) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-nordla-token': tok, ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  let field = api(s1.port, token);
  const up = await fetch(`http://127.0.0.1:${s1.port}/api/uploads`, { method: 'POST', headers: { 'x-nordla-token': token, 'content-type': 'image/png' }, body: PNG }).then((r) => r.json());
  const v = (await field('POST', '/api/visits', { supplierName: 'Yiwu Bright Gifts Ltd', currency: 'USD', date: '2026-10-20', place: 'Hall 2' })).json;
  const cap = (await field('POST', `/api/visits/${v.visit.id}/products`, { product: { name: 'Acrylic keychain', photos: [{ kind: 'PHOTO', ref: up.ref, sha256: up.sha256 }] }, quote: { unitPrice: '0.085', moq: 1000, tiers: [{ minQty: 1000, unitPrice: '0.085' }, { minQty: 5000, unitPrice: '0.072' }] } })).json;
  const po = (await field('POST', '/api/purchase-orders', { lines: [{ quoteId: cap.quoteId, qty: 5000 }], expectedDate: '2026-12-10', fx: { from: 'USD', to: 'EUR', rate: '0.92', date: '2026-10-20', source: 'saisie' } })).json.purchaseOrder;
  await field('POST', `/api/purchase-orders/${po.id}/submit`);
  const beforeView = (await field('GET', `/api/purchase-orders/${po.id}`)).json;
  await s1.stop(); // the server goes down

  const s2 = await startProcurementServer({ env, port: 0, log: () => {}, dataDir }); // ... and comes back
  assert.deepEqual(s2.users.map((u) => u.token), s1.users.map((u) => u.token), 'the same people keep the same access');
  field = api(s2.port, token);
  const after = (await field('GET', `/api/purchase-orders/${po.id}`)).json;
  assert.deepEqual(after, beforeView, 'the purchase order is byte-for-byte what it was');
  assert.equal(after.status, 'PENDING_APPROVAL'); assert.equal(after.lines[0].totalMinor, 36000);
  const visit = (await field('GET', `/api/visits/${v.visit.id}`)).json;
  assert.equal(visit.entries.length, 1); assert.equal(visit.entries[0].name, 'Acrylic keychain'); assert.equal(visit.entries[0].quote.tiers.length, 2);
  const photo = await fetch(`http://127.0.0.1:${s2.port}/api/uploads/${up.ref.slice(9)}`, { headers: { 'x-nordla-token': token } });
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), PNG, 'the photo is still there');
  assert.equal((await field('GET', '/api/overview')).json.locations.length, 2, 'the default locations were not created twice');
  // work simply continues: the owner approves what was waiting
  const approved = await api(s2.port, ownerToken)('POST', `/api/purchase-orders/${po.id}/approve`);
  assert.equal(approved.json.purchaseOrder.status, 'APPROVED');
  await s2.stop();
  const s3 = await startProcurementServer({ env, port: 0, log: () => {}, dataDir });
  assert.equal((await api(s3.port, token)('GET', `/api/purchase-orders/${po.id}`)).json.status, 'APPROVED', 'and that, too, survives the next restart');
  await s3.stop();
});
