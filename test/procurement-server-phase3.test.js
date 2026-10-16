// Phase 3 server features: stock consultation, goods receipt, secure display of China Sourcing photos (read-only, integrity-checked), the case-source interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createProcurement, createMemoryProcurementStore } from '../src/procurement/index.js';
import { createProcurementApp, listen } from '../src/procurement/server/app.js';
import { errText } from '../src/procurement/ui/logic.js';
import { createFileCaseSource, photoKeyOf, isCaseId } from '../src/procurement/server/case-source.js';

const OWNER = { id: 'owner', role: 'OWNER', canApprove: true, approverRole: 'OWNER', token: 'o'.repeat(32) };
const FIELD = { id: 'terrain', role: 'BUYER', canApprove: false, token: 'f'.repeat(32) };
const WAREHOUSE = { id: 'magasin', role: 'WAREHOUSE', canApprove: true, approverRole: 'AUTHORIZED_REVIEWER', token: 'w'.repeat(32) };
const REVIEWER = { id: 'reviewer', role: 'BUYER', canApprove: true, approverRole: 'AUTHORIZED_REVIEWER', token: 'r'.repeat(32) };
// minimal real image headers
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-a-png')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rest-of-a-jpeg')]);
const sha = (b) => createHash('sha256').update(b).digest('hex');
let n = 0; const idem = () => `p3-${Date.now()}-${++n}`;

async function boot({ photosDir = null, casesDir = null } = {}) {
  const procurement = createProcurement({ store: createMemoryProcurementStore(), merchantId: randomUUID(), now: () => '2026-10-20T09:00:00.000Z' });
  const sys = { id: 'system', role: 'OWNER' };
  await procurement.commands.createLocation(sys, 'b1', { name: 'Reception', type: 'WAREHOUSE' }); await procurement.commands.createLocation(sys, 'b2', { name: 'Quarantine', type: 'QUARANTINE' });
  const handler = createProcurementApp({ procurement, users: [OWNER, FIELD, WAREHOUSE, REVIEWER], sourcingDir: casesDir, sourcingPhotosDir: photosDir, uploadsDir: join(mkdtempSync(join(tmpdir(), 'nordla-p3-')), 'u'), now: () => new Date('2026-10-20T09:00:00Z') });
  const { server, port } = await listen(handler);
  const call = async (method, path, { user = OWNER, body, key } = {}) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(user ? { 'x-nordla-token': user.token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'idempotency-key': key ?? idem() } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString()); } catch { /* binary */ } return { status: r.status, json, buf, headers: r.headers }; };
  return { procurement, call, port, close: () => new Promise((r) => server.close(r)) };
}
/** one product, one order of 100 at 0.5 USD, ordered by the owner after the reviewer approved it */
async function orderedViaApi(s, qty = 100) {
  const v = (await s.call('POST', '/api/visits', { user: FIELD, body: { supplierName: 'Yiwu Co', currency: 'USD', date: '2026-10-20' } })).json;
  const c = (await s.call('POST', `/api/visits/${v.visit.id}/products`, { user: FIELD, body: { product: { name: 'Keychain' }, quote: { unitPrice: '0.5', moq: 10 } } })).json;
  const po = (await s.call('POST', '/api/purchase-orders', { user: FIELD, body: { lines: [{ quoteId: c.quoteId, qty }], expectedDate: '2026-12-01', fx: { from: 'USD', to: 'EUR', rate: '0.9', date: '2026-10-20', source: 'test' } } })).json.purchaseOrder;
  await s.call('POST', `/api/purchase-orders/${po.id}/submit`, { user: FIELD });
  await s.call('POST', `/api/purchase-orders/${po.id}/approve`, { user: REVIEWER });
  await s.call('POST', `/api/purchase-orders/${po.id}/order`, { user: OWNER, body: {} });
  return { po, itemId: c.itemId };
}

test('goods receipt over HTTP: only an authorized warehouse/owner access, partial then balance, defects to quarantine, over-receipt refused, retry is harmless', async () => {
  const s = await boot(); const { po } = await orderedViaApi(s);
  assert.equal((await s.call('GET', '/api/me', { user: WAREHOUSE })).json.canReceive, true); assert.equal((await s.call('GET', '/api/me', { user: FIELD })).json.canReceive, false);
  assert.equal((await s.call('GET', '/api/me', { user: REVIEWER })).json.canReceive, false, 'approving is not receiving');
  const lines = (a, d = 0) => ({ lines: [{ poLineId: 'L1', qtyAccepted: a, qtyDefective: d }], receivedAt: '2026-11-25' });
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: FIELD, body: lines(10) })).status, 403);
  const rev = await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: REVIEWER, body: lines(10) });
  assert.equal(rev.status, 403); assert.match(rev.json.message, /explicitly authorized/, 'refused by the server rule itself, not only by a deeper layer');
  const forged = await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: WAREHOUSE, body: { ...lines(1), approval: { id: 'forged-1', action: 'STOCK_SALES.receive_goods', subject_ref: `nordla:purchase:${po.id}`, approver: { kind: 'HUMAN', id: 'the-ceo', role: 'OWNER' }, approved_at: '2026-10-20T00:00:00Z' } } });
  assert.equal(forged.status, 200);
  assert.equal((await s.procurement.queries.events({ objectId: po.id })).find((e) => e.type === 'GOODS_RECEIVED').approval.approverId, 'magasin', 'an approval sent by the phone is ignored: the server builds it from the authenticated user');
  const k = idem(); const first = await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: WAREHOUSE, key: k, body: lines(57, 2) });
  assert.equal(first.status, 200); assert.equal(first.json.purchaseOrder.status, 'PARTIALLY_RECEIVED'); assert.equal(first.json.complete, false);
  const again = await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: WAREHOUSE, key: k, body: lines(57, 2) });
  assert.equal(again.status, 200); assert.equal(again.json.replayed, true);
  const stock = (await s.call('GET', '/api/stock', { user: FIELD })).json; const it = stock.items[0];
  assert.equal(it.available, 58, 'received once, not twice'); assert.equal(it.quarantine, 2); assert.equal(it.physical, 60); assert.equal(it.incoming.qty, 40);
  assert.deepEqual(it.perLocation.map((l) => [l.type, l.onHand]).sort(), [['QUARANTINE', 2], ['WAREHOUSE', 58]]);
  assert.equal(it.valuation.status, 'ESTIMATED'); assert.equal(it.valuation.unitCostEurMicro, 450000); // 0.50 USD x 0.9
  const over = await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: WAREHOUSE, body: lines(41) });
  assert.equal(over.status, 409); assert.equal(over.json.error, 'OVER_RECEIPT');
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: WAREHOUSE, body: { lines: [], receivedAt: '2026-11-25' } })).status, 400, 'nothing received is not a receipt');
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: WAREHOUSE, body: { ...lines(1), receivedAt: '2026-02-30' } })).status, 400);
  const done = await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: OWNER, body: lines(40) });
  assert.equal(done.json.purchaseOrder.status, 'RECEIVED'); assert.equal(done.json.complete, true);
  assert.equal((await s.call('GET', '/api/stock', { user: FIELD })).json.items[0].available, 98);
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: OWNER, body: lines(1) })).status, 409, 'a received order takes no more goods');
  const ev = await s.procurement.queries.events({ objectId: po.id });
  assert.equal(ev.filter((e) => e.type === 'GOODS_RECEIVED')[0].approval.approverId, 'magasin', 'the receipt records the authenticated human');
  await s.close();
});

test('stock consultation: locations, per-location quantities, incoming, valuation status, delayed orders; nothing for an empty catalogue', async () => {
  const s = await boot();
  const empty = (await s.call('GET', '/api/stock', { user: FIELD })).json; assert.deepEqual(empty.items, []); assert.equal(empty.locations.length, 2);
  const { po } = await orderedViaApi(s, 20); // expected 2026-12-01: not late on the pinned clock
  const st = (await s.call('GET', '/api/stock', { user: FIELD })).json;
  assert.equal(st.items[0].incoming.qty, 20); assert.equal(st.items[0].incoming.orders[0].delayed, false); assert.equal(st.items[0].available, 0); assert.equal(st.items[0].valuation.status, 'EMPTY');
  assert.equal((await s.call('GET', '/api/overview', { user: FIELD })).json.toReceive, 1);
  assert.equal((await s.call('GET', '/api/stock', { user: null })).status, 401);
  void po; await s.close();
});

function photoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'nordla-photos-')); const photosDir = join(root, 'photos'); const casesDir = join(root, 'cases');
  mkdirSync(join(photosDir, 'case-a1'), { recursive: true }); mkdirSync(casesDir, { recursive: true });
  const put = (caseId, key, mime, bytes, { metaSha = sha(bytes), file } = {}) => { const base = key.replace(':', '__'); const ext = { 'image/png': 'png', 'image/jpeg': 'jpg' }[mime]; const f = file ?? `${base}.${ext}`; mkdirSync(join(photosDir, caseId), { recursive: true }); writeFileSync(join(photosDir, caseId, f), bytes); writeFileSync(join(photosDir, caseId, `${base}.json`), JSON.stringify({ key, mime, sha256: metaSha, size: bytes.length, file: f })); };
  return { root, photosDir, casesDir, put };
}

test('China Sourcing photos: served only when stored, authenticated, the right type, untampered; never a path; honest when absent', async () => {
  const f = photoFixture();
  f.put('case-a1', 'photo:case-a1.0', 'image/png', PNG);
  f.put('case-a1', 'photo:case-a1.1', 'image/jpeg', JPG);
  f.put('case-a1', 'photo:case-a1.2', 'image/png', Buffer.concat([PNG, Buffer.from('X')]), { metaSha: sha(PNG) }); // modified after storing
  f.put('case-a1', 'photo:case-a1.3', 'image/png', JPG);                                                         // says PNG, is a JPEG
  f.put('case-a1', 'photo:case-a1.4', 'image/png', PNG, { file: '../escape.png' });                              // metadata pointing outside
  writeFileSync(join(f.photosDir, 'case-a1', 'x.png'), PNG); // a real, valid file ...
  writeFileSync(join(f.photosDir, 'case-a1', 'photo__case-a1.5.json'), JSON.stringify({ key: 'photo:other-case.5', mime: 'image/png', sha256: sha(PNG), size: PNG.length, file: 'x.png' })); // ... whose metadata names ANOTHER case's key
  writeFileSync(join(f.photosDir, 'case-a1', 'v.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(join(f.photosDir, 'case-a1', 'photo__case-a1.6.json'), JSON.stringify({ key: 'photo:case-a1.6', mime: 'image/svg+xml', sha256: sha(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), size: 10, file: 'v.svg' })); // an active format: never served
  const s = await boot({ photosDir: f.photosDir, casesDir: f.casesDir });
  const ok = await s.call('GET', '/api/sourcing/photos/case-a1/photo-0', { user: FIELD });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'image/png'); assert.deepEqual(ok.buf, PNG);
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff'); assert.match(ok.headers.get('content-security-policy'), /sandbox/); assert.equal(ok.headers.get('etag'), `"${sha(PNG)}"`);
  assert.equal((await s.call('GET', '/api/sourcing/photos/case-a1/photo-1', { user: FIELD })).headers.get('content-type'), 'image/jpeg');
  assert.equal((await s.call('GET', '/api/sourcing/photos/case-a1/photo-0', { user: null })).status, 401, 'photos need a token');
  for (const bad of ['photo-2', 'photo-3', 'photo-4', 'photo-5', 'photo-6', 'photo-9', 'docphoto-x', 'photo-0.png', '..%2F..%2Fsecret', 'photo-0%00', 'PHOTO-0']) {
    const r = await s.call('GET', `/api/sourcing/photos/case-a1/${bad}`, { user: FIELD });
    assert.ok([404, 400].includes(r.status), `${bad} -> ${r.status}`); assert.notEqual(r.buf.toString('latin1').slice(0, 4), '\x89PNG', `${bad} served an image`);
  }
  const absent = await s.call('GET', '/api/sourcing/photos/case-a1/photo-9', { user: FIELD });
  assert.equal(absent.status, 404); assert.equal(absent.json.error, 'PHOTO_NOT_AVAILABLE'); assert.match(absent.json.message, /only on the phone/);
  assert.equal((await s.call('GET', '/api/sourcing/photos/..%2Fcase-a1/photo-0', { user: FIELD })).status, 404);
  assert.equal((await s.call('GET', '/api/sourcing/photos/case-zz/photo-0', { user: FIELD })).status, 404, 'a case with no stored photos');
  await s.close();
  assert.equal(await createFileCaseSource({ casesDir: f.casesDir, photosDir: null }).photo('case-a1', 'photo-0'), null, 'no photo store configured -> nothing');
});

test('end to end: a real Sourcing reference (photo-0) becomes sourcing://<case>/photo-0 on the item and resolves through the server when the photo is stored', async () => {
  const f = photoFixture(); f.put('case-a1', 'photo:case-a1.0', 'image/png', PNG);
  writeFileSync(join(f.casesDir, 'case-a1.json'), JSON.stringify({ schema: 2, id: 'case-a1', updatedAt: '2026-10-20T08:00:00Z', identity: { workingName: 'Magnet', identifiers: {}, photos: [{ ref: 'photo-0', note: 'stand' }, { ref: 'photo-1' }] }, supplier: { name: 'Yiwu Co' }, quotes: [{ at: 't', currency: 'USD', unitPrice: '0.5', moq: 10 }] }));
  const s = await boot({ photosDir: f.photosDir, casesDir: f.casesDir });
  assert.equal((await s.call('POST', '/api/sourcing/import', { user: FIELD, body: { caseId: 'case-a1' } })).json.status, 'IMPORTED');
  const item = (await s.call('GET', '/api/items', { user: FIELD })).json.items[0];
  assert.deepEqual(item.photos, ['sourcing://case-a1/photo-0', 'sourcing://case-a1/photo-1']);
  const [, caseId, ref] = /^sourcing:\/\/([^/]+)\/(.+)$/.exec(item.photos[0]);
  assert.deepEqual((await s.call('GET', `/api/sourcing/photos/${caseId}/${ref}`, { user: FIELD })).buf, PNG);
  assert.equal((await s.call('GET', `/api/sourcing/photos/${caseId}/photo-1`, { user: FIELD })).status, 404, 'a photo that is only on the phone is reported as not available, not invented');
  await s.close();
});

test('case-source patterns: strict ids and references', () => {
  assert.equal(photoKeyOf('case-a1', 'photo-3'), 'photo:case-a1.3'); assert.equal(photoKeyOf('case-a1', 'docphoto-d7'), 'docphoto:case-a1.d7');
  for (const bad of [['case-a1', 'photo-'], ['case-a1', 'photo-1/x'], ['case/a1', 'photo-1'], ['', 'photo-1'], ['case-a1', '../photo-1'], ['case-a1', 'photo:case-b.1'], ['case-a1', undefined]]) assert.equal(photoKeyOf(...bad), null, JSON.stringify(bad));
  assert.ok(isCaseId('case_A-1')); assert.ok(!isCaseId('../x')); assert.ok(!isCaseId('a'.repeat(81)));
});

test('understandable errors: no refusal ever shows an internal name (collections, tables, codes, stack traces)', async (t) => {
  const s = await boot(); t.after(() => s.close()); const { po, itemId } = await orderedViaApi(s);
  const ghost = '00000000-0000-4000-8000-000000000000';
  const bad = [
    ['POST', `/api/purchase-orders/${po.id}/receive`, FIELD, { lines: [{ poLineId: 'L1', qtyAccepted: 5 }] }],      // not allowed to receive
    ['POST', `/api/purchase-orders/${po.id}/receive`, WAREHOUSE, { lines: [{ poLineId: 'L1', qtyAccepted: 100000 }] }], // over-receipt
    ['POST', `/api/purchase-orders/${po.id}/receive`, WAREHOUSE, { lines: [{ poLineId: 'L9', qtyAccepted: 1 }] }],      // unknown line
    ['POST', `/api/purchase-orders/${ghost}/receive`, WAREHOUSE, { lines: [{ poLineId: 'L1', qtyAccepted: 1 }] }],      // unknown order
    ['POST', `/api/purchase-orders/${ghost}/submit`, FIELD, {}], ['POST', `/api/purchase-orders/${po.id}/submit`, FIELD, {}], // unknown / wrong state
    ['POST', `/api/purchase-orders/${po.id}/approve`, FIELD, {}],                                                     // not an approver
    ['POST', '/api/purchase-orders', FIELD, { lines: [{ quoteId: ghost, qty: 1 }], expectedDate: '2026-12-01' }],      // unknown offer
    ['POST', `/api/visits/${ghost}/products`, FIELD, { product: { name: 'x' }, quote: { unitPrice: '1', moq: 1 } }], ['POST', `/api/visits/${ghost}/close`, FIELD, {}],
    ['GET', `/api/stock/${ghost}`, OWNER, undefined], ['GET', `/api/items/${ghost}`, OWNER, undefined],
  ];
  const seen = [];
  for (const [m, path, user, body] of bad) {
    const r = await s.call(m, path, { user, body, key: idem() });
    assert.ok(r.status >= 400 && r.status < 500, `${m} ${path} -> ${r.status}`);
    const text = errText(r); seen.push(`${r.json?.error} -> ${text}`); // exactly what the phone shows
    assert.doesNotMatch(text, /stockLocations|purchaseOrders|supplierItems|visits|quotes|proc_|[A-Z]{2,}_[A-Z_]{2,}|\b(DRAFT|ORDERED|PENDING_APPROVAL|APPROVED|CONFIRMED|CANCELLED)\b|at .*\.js:\d+|node_modules|Error:/, `internal detail leaked: ${text}`);
  }
  assert.ok(seen.every((t) => t.split(' -> ')[1].length > 5), 'every refusal carries a readable message');
  assert.ok(itemId);
});
