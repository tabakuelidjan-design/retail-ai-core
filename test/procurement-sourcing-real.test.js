// China Sourcing -> Buying with REAL Sourcing cases: built by the real Sourcing reducer (newCase / dispatch), saved by the real Sourcing file store, read from disk by the
// procurement server, imported over HTTP, then the server is stopped and restarted: nothing lost, nothing duplicated. Needs Node 24 (src/sourcing requires it); skipped below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const NODE24 = Number(process.versions.node.split('.')[0]) >= 24;
const skip = NODE24 ? false : 'src/sourcing needs Node 24';

async function realCases(dir) {
  const { newCase, dispatch } = await import('../src/sourcing/core/case.js');
  const { createFileStore } = await import('../src/sourcing/store/file-store.js');
  const store = createFileStore(dir);
  const at = (n) => new Date(Date.UTC(2026, 9, 20, 8, n));
  let a = newCase({ id: 'case-yiwu-keychain', name: '', now: at(0) });
  a = dispatch(a, { type: 'NAME', name: 'Acrylic keychain 5 cm' }, at(1));
  a = dispatch(a, { type: 'SUPPLIER', supplier: { name: 'Yiwu Bright Gifts Co., Ltd' } }, at(2));
  a = dispatch(a, { type: 'PHOTO', ref: 'photo://case-yiwu-keychain/1.jpg', note: 'stand B12' }, at(3));
  a = dispatch(a, { type: 'QUOTE', quote: { unitPrice: '0.085', currency: 'USD', moq: 1000, incoterm: 'FOB', port: 'Ningbo', leadTimeDays: 25, payment: { depositPct: '30' }, tiers: [{ minQty: 1000, unitPrice: '0.085' }, { minQty: 5000, unitPrice: '0.072' }] } }, at(4));
  a = dispatch(a, { type: 'QUOTE', quote: { unitPrice: '0.080', currency: 'USD', moq: 1000, incoterm: 'FOB', leadTimeDays: 25, payment: { depositPct: '30' }, tiers: [{ minQty: 1000, unitPrice: '0.080' }, { minQty: 5000, unitPrice: '0.069' }] } }, at(5)); // a renegotiation
  await store.save(a);
  let b = newCase({ id: 'case-ningbo-magnet', name: 'Magnet frigo rond', now: at(10) });
  b = dispatch(b, { type: 'SUPPLIER', supplier: { name: 'Ningbo Souvenir Co' } }, at(11));
  b = dispatch(b, { type: 'QUOTE', quote: { unitPrice: '0,55', currency: 'CNY', moq: 2000, incoterm: 'EXW' } }, at(12)); // decimal comma typed on the phone
  await store.save(b);
  return { a, b };
}

test('real Sourcing cases -> procurement over HTTP, then restart: everything is found again, re-importing creates nothing new', { skip }, async (t) => {
  const { startProcurementServer } = await import('../src/procurement/server/index.js');
  const root = mkdtempSync(join(tmpdir(), 'nordla-real-')); const casesDir = join(root, 'sourcing', 'cases'); const dataDir = join(root, 'procurement');
  const { a } = await realCases(casesDir);
  assert.equal(a.quotes.length, 2, 'the real reducer kept both quote revisions');
  const env = { PROCUREMENT_DATA_DIR: dataDir, NORDLA_MERCHANT_ID: randomUUID(), SOURCING_CASES_DIR: casesDir };
  let s = await startProcurementServer({ env, port: 0, log: () => {}, dataDir });
  t.after(async () => { await s.stop().catch(() => {}); }); // a failing assertion must not leave a server running
  const terrain = s.users.find((u) => u.id === 'terrain').token;
  const call = (port) => async (method, path, body) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-nordla-token': terrain, ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'idempotency-key': `real-${Math.random().toString(36).slice(2)}-${Date.now()}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  let api = call(s.port);

  const list = (await api('GET', '/api/sourcing/cases')).json;
  assert.equal(list.available, true); assert.deepEqual(list.cases.map((c) => [c.id, c.supplier, c.quotes]).sort(), [['case-ningbo-magnet', 'Ningbo Souvenir Co', 1], ['case-yiwu-keychain', 'Yiwu Bright Gifts Co., Ltd', 2]]);

  // import 1: product, supplier, photo, TWO quote revisions (the renegotiation is kept as history), then a draft order of 5000
  const draft = (await api('POST', '/api/sourcing/import', { caseId: 'case-yiwu-keychain', qty: 5000, expectedDate: '2026-12-10', fxRate: '0.92' })).json;
  assert.equal(draft.status, 'IMPORTED', JSON.stringify(draft.issues)); assert.deepEqual(draft.quotes.map((q) => q.status), ['CREATED', 'CREATED']);
  assert.equal(draft.supplier.created, true); assert.equal(draft.item.attachments, 1);
  assert.equal(draft.purchaseOrder.status, 'DRAFT'); assert.equal(draft.purchaseOrder.reused, false);
  const po = (await api('GET', `/api/purchase-orders/${draft.purchaseOrder.id}`)).json;
  assert.equal(po.lines[0].unitPriceMicro, 69000, 'the 5000+ tier of the LATEST quote (0.069), not the first one');
  assert.equal(po.totalMinor, 34500); assert.equal(po.currency, 'USD'); assert.equal(po.fx.rate, '0.92');
  // import 2: a decimal comma and a different currency
  const imp2 = (await api('POST', '/api/sourcing/import', { caseId: 'case-ningbo-magnet' })).json;
  assert.equal(imp2.status, 'IMPORTED'); assert.equal(imp2.item.created, true);
  const items = (await api('GET', '/api/items')).json.items; const mag = items.find((i) => i.name === 'Magnet frigo rond');
  assert.equal(mag.quotes[0].tiers[0].unitPriceMicro, 550000); assert.equal(mag.quotes[0].currency, 'CNY');
  const before = { items: items.length, pos: (await api('GET', '/api/purchase-orders')).json.purchaseOrders.length, ov: (await api('GET', '/api/overview')).json.locations.length };

  await s.stop(); // restart
  s = await startProcurementServer({ env, port: 0, log: () => {}, dataDir }); api = call(s.port);
  const after = (await api('GET', `/api/purchase-orders/${draft.purchaseOrder.id}`)).json;
  assert.deepEqual(after, po, 'the draft order is identical after the restart');
  const kc = (await api('GET', '/api/items')).json.items.find((i) => i.name === 'Acrylic keychain 5 cm');
  assert.equal(kc.quotes.length, 2); assert.deepEqual(kc.quotes.map((q) => q.status).sort(), ['RECEIVED', 'SUPERSEDED']); assert.deepEqual(kc.photos, ['photo://case-yiwu-keychain/1.jpg']); // kept as a REFERENCE to the Sourcing photo (not an uploaded file: the phone screen shows no thumbnail for it)
  assert.equal((await api('GET', '/api/items')).json.items.length, before.items);

  // re-import after the restart: no new supplier, item, quote or order
  const again = (await api('POST', '/api/sourcing/import', { caseId: 'case-yiwu-keychain', qty: 5000, expectedDate: '2026-12-10', fxRate: '0.92' })).json;
  assert.equal(again.supplier.created, false); assert.equal(again.item.created, false); assert.deepEqual(again.quotes.map((q) => q.status), ['UNCHANGED', 'UNCHANGED']);
  assert.equal(again.purchaseOrder.id, draft.purchaseOrder.id); assert.equal(again.purchaseOrder.reused, true);
  assert.equal((await api('GET', '/api/items')).json.items.length, before.items);
  assert.equal((await api('GET', '/api/purchase-orders')).json.purchaseOrders.length, before.pos);
  assert.equal((await api('GET', '/api/overview')).json.locations.length, before.ov);
  await s.stop();
});

test('a case that changes in Sourcing after a first import adds exactly the new revision (after a restart too)', { skip }, async (t) => {
  const { startProcurementServer } = await import('../src/procurement/server/index.js');
  const { dispatch } = await import('../src/sourcing/core/case.js');
  const { createFileStore } = await import('../src/sourcing/store/file-store.js');
  const root = mkdtempSync(join(tmpdir(), 'nordla-real2-')); const casesDir = join(root, 'sourcing', 'cases'); const dataDir = join(root, 'procurement');
  const { a } = await realCases(casesDir);
  const env = { PROCUREMENT_DATA_DIR: dataDir, NORDLA_MERCHANT_ID: randomUUID(), SOURCING_CASES_DIR: casesDir };
  let s = await startProcurementServer({ env, port: 0, log: () => {}, dataDir });
  t.after(async () => { await s.stop().catch(() => {}); });
  const tok = s.users.find((u) => u.id === 'terrain').token;
  const imp = async (port) => (await (await fetch(`http://127.0.0.1:${port}/api/sourcing/import`, { method: 'POST', headers: { 'x-nordla-token': tok, 'content-type': 'application/json', 'idempotency-key': `chg-${Math.random().toString(36).slice(2)}-${Date.now()}` }, body: JSON.stringify({ caseId: 'case-yiwu-keychain' }) })).json());
  assert.deepEqual((await imp(s.port)).quotes.map((q) => q.status), ['CREATED', 'CREATED']);
  await s.stop();
  // the supplier moves again in Sourcing
  const store = createFileStore(casesDir); const cur = await store.get('case-yiwu-keychain');
  await store.save(dispatch(cur, { type: 'QUOTE', quote: { unitPrice: '0.075', currency: 'USD', moq: 1000, incoterm: 'FOB', leadTimeDays: 20, payment: { depositPct: '30' }, tiers: [{ minQty: 1000, unitPrice: '0.075' }, { minQty: 5000, unitPrice: '0.064' }] } }, new Date(Date.UTC(2026, 9, 21))));
  s = await startProcurementServer({ env, port: 0, log: () => {}, dataDir });
  assert.deepEqual((await imp(s.port)).quotes.map((q) => q.status), ['UNCHANGED', 'UNCHANGED', 'CREATED']);
  const item = (await (await fetch(`http://127.0.0.1:${s.port}/api/items`, { headers: { 'x-nordla-token': tok } })).json()).items.find((i) => i.name === 'Acrylic keychain 5 cm');
  assert.deepEqual(item.quotes.map((q) => q.revision), [3, 2, 1]); assert.equal(item.quotes[0].leadTimeDays, 20);
  await s.stop();
});
