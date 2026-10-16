// File store -> PostgreSQL import, proven on a REAL PostgreSQL (PROCUREMENT_STORE=pg, test/postgres/procurement-parity.mjs): a rich field history is built on the file
// store, imported, and the two stores must answer every question identically; retries, approvals and numbering must survive the move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { STORE_KIND, pgPool, ensureMerchant, makeWorld, orderedPo, receive, rejects, approval, productApproval, key, buyer, wh, owner } from './procurement-fixtures.js';
import { openFileProcurementStore, createPgProcurementStore, createProcurement, importSourcingCase } from '../src/procurement/index.js';
import { importFileState, compareStores, ImportError } from '../src/procurement/import-file-to-pg.js';

const skip = STORE_KIND !== 'pg' ? 'needs PROCUREMENT_STORE=pg (real PostgreSQL)' : false;

async function fieldHistory() {
  const merchantId = randomUUID();
  const store = await openFileProcurementStore({ path: join(mkdtempSync(join(tmpdir(), 'nordla-imp-')), 'procurement.json') });
  const w = await makeWorld({ merchantId, store });
  const A = w.itemA.id; const W = w.locs.warehouse.id;
  const po = await orderedPo(w, { qty: 200 });
  const rcvKey = key('rcv-fixed'); const rcvApproval = approval('STOCK_SALES.receive_goods', po.id);
  const rcvPayload = { poId: po.id, receivedAt: '2026-11-18', lines: [{ poLineId: 'L1', qtyAccepted: 118, qtyDefective: 2, landedUnitCostEurMicro: 610000 }], quarantineLocationId: w.locs.quarantine.id, approval: rcvApproval };
  await w.c.receiveGoods(wh, rcvKey, rcvPayload);
  await receive(w, await w.q.purchaseOrder(po.id), [{ poLineId: 'L1', qtyAccepted: 40 }]); // partial: 160 of 200 received
  await w.c.transferStock(wh, key(), { itemId: A, fromLocationId: W, toLocationId: w.locs.store.id, qty: 50 });
  await w.c.reserveStock(wh, key(), { itemId: A, locationId: w.locs.store.id, qty: 10, reference: { type: 'order', id: 'o-1' } });
  await w.c.adjustStock(wh, key(), { itemId: A, locationId: W, delta: -3, reason: 'three damaged in handling', approval: productApproval('STOCK_SALES.adjust_on_hand', `${A}@${W}`) });
  await w.c.recordIncident(buyer, key(), { supplierId: w.supplier.id, poId: po.id, type: 'QUALITY', severity: 'HIGH', description: 'two cracked units in the first lot' });
  await w.c.addSupplierDocument(buyer, key(), { supplierId: w.supplier.id, type: 'CERTIFICATE', name: 'CE', ref: 'docs://ce.pdf', expiresOn: '2027-01-01' });
  const v = (await w.c.startVisit(buyer, key(), { supplierName: 'Ningbo Souvenir Co', currency: 'CNY', date: '2026-10-21', place: 'factory' })).visit;
  await w.c.captureProduct(buyer, key(), { visitId: v.id, product: { name: 'Magnet', photos: [{ kind: 'PHOTO', ref: 'sourcing://case-x/photo-0' }] }, quote: { unitPrice: '0.55', moq: 1000, tiers: [{ minQty: 1000, unitPrice: '0.55' }, { minQty: 5000, unitPrice: '0.5' }] } });
  await importSourcingCase({ commands: w.c, queries: w.q, actor: buyer, caseState: { schema: 2, id: 'case-y', identity: { workingName: 'Keychain', photos: [{ ref: 'photo-0' }] }, supplier: { name: 'Yiwu Co' }, quotes: [{ at: 't', currency: 'USD', unitPrice: '0.1', moq: 100 }] } });
  const cancelled = (await w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-12-01', destinationLocationId: W, lines: [{ itemId: A, qty: 100, quoteId: w.quote.id }] })).purchaseOrder;
  await w.mk(w.c.cancelPurchaseOrder, owner, { poId: cancelled.id, reason: 'no longer needed' });
  return { w, store, merchantId, po, rcvKey, rcvPayload, rcvApproval };
}

test('import: the PostgreSQL store answers every question exactly like the file store, and nothing is lost', { skip }, async () => {
  const h = await fieldHistory();
  await ensureMerchant(h.merchantId);
  const target = createPgProcurementStore({ pool: pgPool() });
  const dry = await importFileState({ state: h.store.exportState(), target, merchantId: h.merchantId, dryRun: true });
  assert.equal(dry.imported, false); assert.ok(dry.counts.movements >= 6 && dry.counts.purchaseOrders === 2 && dry.counts.events > 15, JSON.stringify(dry.counts));
  assert.equal((await target.list('items', h.merchantId)).length, 0, 'a dry run writes nothing');
  const done = await importFileState({ state: h.store.exportState(), target, merchantId: h.merchantId, dryRun: false });
  assert.equal(done.imported, true);
  const diffs = await compareStores({ source: h.store, target, merchantId: h.merchantId });
  assert.deepEqual(diffs, [], JSON.stringify(diffs).slice(0, 800));

  const pg = createProcurement({ store: target, merchantId: h.merchantId, now: () => '2026-10-16T10:00:00.000Z', retryDelayMs: 1 });
  const pos = await pg.queries.stockPosition(h.w.itemA.id);
  assert.equal(pos.physical, 157, '118 + 40 accepted + 2 quarantined - 3 adjusted'); assert.equal(pos.reserved, 10); assert.equal(pos.quarantine, 2); assert.equal(pos.incoming.qty, 40);
  assert.equal(JSON.stringify((await h.w.q.stockPosition(h.w.itemA.id)).valuation), JSON.stringify(pos.valuation));

  // a command retried AFTER the move is still recognised (idempotency records moved), and an approval stays single-use
  const replay = await pg.commands.receiveGoods(wh, h.rcvKey, h.rcvPayload);
  assert.equal(replay.replayed, true); assert.equal((await pg.queries.stockPosition(h.w.itemA.id)).physical, 157, 'not received twice');
  await rejects(pg.commands.receiveGoods(wh, key(), { ...h.rcvPayload, lines: [{ poLineId: 'L1', qtyAccepted: 1 }] }), 'APPROVAL_ALREADY_USED');
  // numbering continues where it stopped
  const next = await pg.commands.createPurchaseOrder(buyer, key(), { supplierId: h.w.supplier.id, currency: 'USD', expectedDate: '2026-12-01', destinationLocationId: h.w.locs.warehouse.id, lines: [{ itemId: h.w.itemA.id, qty: 100, quoteId: h.w.quote.id }] });
  assert.equal(next.purchaseOrder.number, 'PO-2026-0003');
  // the history of the original order is intact
  assert.deepEqual((await pg.queries.events({ objectId: h.po.id })).map((e) => e.type), (await h.w.q.events({ objectId: h.po.id })).map((e) => e.type));
});

test('import refuses: a target that already holds data, rows of another merchant, an unknown format - and leaves the target untouched', { skip }, async () => {
  const h = await fieldHistory(); await ensureMerchant(h.merchantId);
  const target = createPgProcurementStore({ pool: pgPool() });
  await importFileState({ state: h.store.exportState(), target, merchantId: h.merchantId, dryRun: false });
  await assert.rejects(importFileState({ state: h.store.exportState(), target, merchantId: h.merchantId, dryRun: false }), (e) => e instanceof ImportError && e.code === 'TARGET_NOT_EMPTY');
  await assert.rejects(importFileState({ state: h.store.exportState(), target, merchantId: randomUUID() }), (e) => e.code === 'FOREIGN_MERCHANT');
  await assert.rejects(importFileState({ state: { format: 99 }, target, merchantId: h.merchantId }), /unknown format/);
  assert.deepEqual(await compareStores({ source: h.store, target, merchantId: h.merchantId }), [], 'the failed attempts changed nothing');
});

test('import is all-or-nothing: a failure in the middle leaves the target empty', { skip }, async () => {
  const h = await fieldHistory(); await ensureMerchant(h.merchantId);
  const target = createPgProcurementStore({ pool: pgPool() });
  const state = h.store.exportState();
  state.movements = [...state.movements, { ...state.movements.at(-1), id: randomUUID(), idempotencyKey: 'broken-last-movement', delta: -100000 }]; // drives a balance below zero: the database refuses it
  await assert.rejects(importFileState({ state, target, merchantId: h.merchantId, dryRun: false }), (e) => e.code === 'INSUFFICIENT_STOCK' || /negative|INSUFFICIENT/.test(e.message));
  for (const c of ['items', 'suppliers', 'purchaseOrders', 'stockLocations', 'visits']) assert.equal((await target.list(c, h.merchantId)).length, 0, `${c} rolled back`);
  assert.equal((await target.listMovements(h.merchantId)).length, 0);
});
