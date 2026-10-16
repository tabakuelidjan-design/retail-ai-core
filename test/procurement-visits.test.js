import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, rejects, buyer, wh, key } from './procurement-fixtures.js';

const startNew = (w, over = {}) => w.c.startVisit(buyer, key('visit'), { supplierName: 'Yiwu Bright Gifts Ltd', currency: 'USD', date: '2026-10-20', place: 'Hall 2, stand B12', ...over });
const px = (n) => ({ name: `Acrylic keychain ${n}`, photos: [{ kind: 'PHOTO', ref: `upload://k${n}.jpg`, sha256: String(n).repeat(64).slice(0, 64) }] });

test('a visit creates (or reuses) the supplier; products are captured in one step with photo, quote and visit link', async () => {
  const w = await makeWorld();
  const v = await startNew(w);
  assert.equal(v.supplier.created, true); assert.equal(v.visit.status, 'OPEN');
  const v2 = await startNew(w, { supplierName: 'YIWU BRIGHT GIFTS', date: '2026-10-21' }); // normalised name: the same supplier
  assert.equal(v2.supplier.id, v.supplier.id); assert.equal(v2.supplier.created, false);
  const c1 = await w.c.captureProduct(buyer, key('cap'), { visitId: v.visit.id, product: px(1), quote: { unitPrice: '0.085', moq: 1000, incoterm: 'FOB', tiers: [{ minQty: 1000, unitPrice: '0.085' }, { minQty: 5000, unitPrice: '0.072' }], leadTimeDays: 25 } });
  assert.equal(c1.itemCreated, true); assert.equal(c1.item.status, 'PROSPECT'); assert.match(c1.item.sku, /^V20261020-[0-9A-F]{4}-1$/);
  assert.equal(c1.item.attachments[0].ref, 'upload://k1.jpg');
  assert.equal(c1.quote.currency, 'USD', 'the visit supplier currency is the default'); assert.equal(c1.quote.provenance, 'SUPPLIER_CLAIM'); assert.match(c1.quote.reason, /Hall 2, stand B12/);
  const c2 = await w.c.captureProduct(buyer, key('cap'), { visitId: v.visit.id, product: px(2) }); // photo first, price later
  assert.match(c2.item.sku, /-2$/); assert.equal(c2.quote, null);
  const later = await w.c.captureProduct(buyer, key('cap'), { visitId: v.visit.id, itemId: c2.item.id, quote: { unitPrice: '0.11', moq: 500 } });
  assert.equal(later.itemCreated, false); assert.equal(later.quote.tiers[0].unitPriceMicro, 110000);
  const cur = await w.q.visit(v.visit.id);
  assert.equal(cur.entries.length, 3); assert.deepEqual(cur.entries.map((e) => e.itemCreated), [true, true, false]);
  assert.equal(cur.version, 4);
  assert.equal((await w.q.events({ objectId: v.visit.id })).map((e) => e.type).join(','), 'VISIT_STARTED,VISIT_PRODUCT_CAPTURED,VISIT_PRODUCT_CAPTURED,VISIT_PRODUCT_CAPTURED');
});

test('a retry after a lost connection (same capture id) never duplicates the product, the quote or the entry', async () => {
  const w = await makeWorld();
  const v = await startNew(w); const k = key('cap'); const payload = { visitId: v.visit.id, product: px(3), quote: { unitPrice: '0.2', moq: 100 } };
  const a = await w.c.captureProduct(buyer, k, payload); const b = await w.c.captureProduct(buyer, k, payload);
  assert.equal(a.replayed, false); assert.equal(b.replayed, true); assert.equal(b.item.id, a.item.id);
  assert.equal((await w.q.visit(v.visit.id)).entries.length, 1);
  assert.equal((await w.q.quotes()).filter((q) => q.itemId === a.item.id).length, 1);
  assert.equal((await w.q.items()).filter((i) => i.name === 'Acrylic keychain 3').length, 1);
});

test('a failed capture leaves nothing behind; barcodes reuse the known item; new photos are appended once', async () => {
  const w = await makeWorld();
  const v = await startNew(w);
  const before = (await w.q.items()).length;
  await rejects(w.c.captureProduct(buyer, key('cap'), { visitId: v.visit.id, product: px(4), quote: { unitPrice: 'cheap', moq: 10 } }), 'INVALID_INPUT');
  assert.equal((await w.q.items()).length, before, 'the product was not created without its quote');
  assert.equal((await w.q.visit(v.visit.id)).entries.length, 0);
  const again = await w.c.captureProduct(buyer, key('cap'), { visitId: v.visit.id, product: { name: 'Round magnet again', barcode: '5400000000011', photos: [{ kind: 'PHOTO', ref: 'upload://new.jpg' }] } });
  assert.equal(again.item.id, w.itemA.id); assert.equal(again.itemCreated, false);
  assert.equal((await w.q.item(w.itemA.id)).attachments.length, 1);
  await w.c.captureProduct(buyer, key('cap'), { visitId: v.visit.id, itemId: w.itemA.id, product: { photos: [{ kind: 'PHOTO', ref: 'upload://new.jpg' }, { kind: 'PHOTO', ref: 'upload://other.jpg' }] } });
  assert.deepEqual((await w.q.item(w.itemA.id)).attachments.map((a) => a.ref), ['upload://new.jpg', 'upload://other.jpg']);
});

test('visit rules: one visit can be closed once, a closed visit takes no more products, ambiguous suppliers are refused', async () => {
  const w = await makeWorld();
  const v = await startNew(w);
  const done = await w.c.closeVisit(buyer, key(), { visitId: v.visit.id, note: 'back to the hotel' });
  assert.equal(done.visit.status, 'CLOSED'); assert.equal(done.visit.note, 'back to the hotel');
  await rejects(w.c.closeVisit(buyer, key(), { visitId: v.visit.id }), 'VISIT_CLOSED');
  await rejects(w.c.captureProduct(buyer, key(), { visitId: v.visit.id, product: px(5) }), 'VISIT_CLOSED');
  await rejects(w.c.captureProduct(buyer, key(), { visitId: '00000000-0000-0000-0000-000000000000', product: px(5) }), 'VISIT_NOT_FOUND');
  await rejects(startNew(w, { date: '2026-02-30' }), 'INVALID_INPUT');
  await rejects(startNew(w, { supplierName: undefined }), 'INVALID_INPUT');
  await rejects(w.c.startVisit(wh, key(), { supplierName: 'X', currency: 'USD', date: '2026-10-20' }), 'FORBIDDEN');
  await w.mk(w.c.createSupplier, buyer, { name: 'Acme Trading Co', currency: 'USD' }); await w.mk(w.c.createSupplier, buyer, { name: 'ACME Ltd', currency: 'USD' });
  await rejects(startNew(w, { supplierName: 'Acme' }), 'SUPPLIER_AMBIGUOUS');
});

test('many phones capturing into one visit at the same time lose nothing', async () => {
  const w = await makeWorld();
  const v = await startNew(w);
  const jobs = Array.from({ length: 8 }, (_, i) => w.c.captureProduct(buyer, key('par'), { visitId: v.visit.id, product: px(i + 10), quote: { unitPrice: '0.3', moq: 50 } }));
  const r = await Promise.allSettled(jobs);
  const ok = r.filter((x) => x.status === 'fulfilled').length;
  const cur = await w.q.visit(v.visit.id);
  assert.equal(cur.entries.length, ok, 'every acknowledged capture is in the visit');
  assert.ok(ok >= 1);
  // a conflict (if any) is reported as a coded error the client retries; it is never a silent loss
  assert.ok(r.filter((x) => x.status === 'rejected').every((x) => ['VERSION_CONFLICT', 'STORE_RETRYABLE'].includes(x.reason.code)), JSON.stringify(r.filter((x) => x.status === 'rejected').map((x) => x.reason.code)));
  assert.equal(new Set(cur.entries.map((e) => e.itemId)).size, cur.entries.length);
});
