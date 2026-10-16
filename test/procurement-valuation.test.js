// Stock valuation: moving weighted average (owner decision, V1), no invented cost, receipt lots kept for a later FIFO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, orderedPo, receive, productApproval, key, wh, buyer } from './procurement-fixtures.js';

const eur = async (w, qty, unit) => { // a EUR purchase order so receipts are ESTIMATED at the goods price unless a landed cost is given
  const { purchaseOrder: po } = await w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'EUR', expectedDate: '2026-11-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty, unitPrice: unit }] });
  return po;
};
import { approval } from './procurement-fixtures.js';
const order = async (w, po) => {
  await w.mk(w.c.submitPurchaseOrder, buyer, { poId: po.id });
  await w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id) });
  await w.mk(w.c.placeOrder, buyer, { poId: po.id, approval: approval('BUYING.place_order', po.id) });
  return w.q.purchaseOrder(po.id);
};
const take = (w, qty, loc) => w.c.adjustStock(wh, key(), { itemId: w.itemA.id, locationId: loc ?? w.locs.warehouse.id, delta: -qty, reason: 'units sold or lost for the test', approval: productApproval('STOCK_SALES.adjust_on_hand', `${w.itemA.id}@${loc ?? w.locs.warehouse.id}`) });
const val = async (w) => (await w.q.stockPosition(w.itemA.id)).valuation;

test('the average MOVES with each receipt and ignores the history of units already gone', async () => {
  const w = await makeWorld();
  const p1 = await order(w, await eur(w, 100, '1.00')); await receive(w, p1, [{ poLineId: 'L1', qtyAccepted: 100, landedUnitCostEurMicro: 1_000_000 }]);
  let v = await val(w); assert.equal(v.status, 'CONFIRMED'); assert.equal(v.unitCostEurMicro, 1_000_000); assert.equal(v.valueEurMinor, 10000); assert.equal(v.valuedUnits, 100);
  await take(w, 100);
  assert.equal((await val(w)).status, 'EMPTY');
  const p2 = await order(w, await eur(w, 100, '2.00')); await receive(w, p2, [{ poLineId: 'L1', qtyAccepted: 100, landedUnitCostEurMicro: 2_000_000 }]);
  v = await val(w); assert.equal(v.unitCostEurMicro, 2_000_000, 'the first lot is gone: a plain average of all receipts (1.50) would be wrong');
  // 100 left at 2.00, sell 50 (they leave at the average), then 100 more at 3.00: (50 x 2 + 100 x 3) / 150 = 2.6667
  await take(w, 50);
  const p3 = await order(w, await eur(w, 100, '3.00')); await receive(w, p3, [{ poLineId: 'L1', qtyAccepted: 100, landedUnitCostEurMicro: 3_000_000 }]);
  v = await val(w); assert.equal(v.valuedUnits, 150); assert.equal(v.unitCostEurMicro, 2_666_667); assert.equal(v.valueEurMinor, 40000);
});

test('moves between locations and quarantine do not change the average or the value', async () => {
  const w = await makeWorld();
  const p = await order(w, await eur(w, 90, '1.50')); await receive(w, p, [{ poLineId: 'L1', qtyAccepted: 90, landedUnitCostEurMicro: 1_500_000 }]);
  const before = await val(w);
  await w.c.transferStock(wh, key(), { itemId: w.itemA.id, fromLocationId: w.locs.warehouse.id, toLocationId: w.locs.store.id, qty: 40 });
  await w.c.quarantineDefect(wh, key(), { itemId: w.itemA.id, fromLocationId: w.locs.store.id, quarantineLocationId: w.locs.quarantine.id, qty: 7, reason: 'cracked units found on the shelf' });
  const after = await val(w);
  assert.equal(after.unitCostEurMicro, before.unitCostEurMicro); assert.equal(after.valueEurMinor, before.valueEurMinor); assert.equal(after.valuedUnits, 90);
  // goods in TRANSIT are not physical stock: they leave the valuation and come back at the average
  await w.c.transferStock(wh, key(), { itemId: w.itemA.id, fromLocationId: w.locs.warehouse.id, toLocationId: w.locs.transit.id, qty: 20 });
  assert.equal((await val(w)).valuedUnits, 70);
  await w.c.transferStock(wh, key(), { itemId: w.itemA.id, fromLocationId: w.locs.transit.id, toLocationId: w.locs.warehouse.id, qty: 20 });
  const back = await val(w); assert.equal(back.valuedUnits, 90); assert.ok(Math.abs(back.unitCostEurMicro - 1_500_000) <= 1);
});

test('statuses are honest: ESTIMATED when a lot has only the goods price, PARTIAL when some units have no cost, UNKNOWN when none does', async () => {
  const w = await makeWorld();
  const a = await order(w, await eur(w, 100, '1.00')); await receive(w, a, [{ poLineId: 'L1', qtyAccepted: 100 }]); // EUR order, no landed cost -> ESTIMATED at 1.00
  let v = await val(w); assert.equal(v.status, 'ESTIMATED'); assert.equal(v.goodsOnly, true); assert.equal(v.unitCostEurMicro, 1_000_000);
  const { purchaseOrder: usd } = await w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-11-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty: 100, unitPrice: '0.50' }] }); // no fx
  await receive(w, await order(w, usd), [{ poLineId: 'L1', qtyAccepted: 100 }]);
  v = await val(w); assert.equal(v.status, 'PARTIAL'); assert.equal(v.valuedUnits, 100); assert.equal(v.unknownUnits, 100);
  assert.equal(v.valueEurMinor, 10000, 'only the units with a known cost are valued; the other 100 are not given an invented cost');
  const all = await w.q.stockPositions(); assert.equal(all.valuation.itemsWithUnknownCost, 1); assert.equal(all.valuation.unknownUnits, 100); assert.equal(all.valuation.estimatedEurMinor, 10000);
  // a second item with no cost at all
  const w2 = await makeWorld(); await receive(w2, await order(w2, (await w2.mk(w2.c.createPurchaseOrder, buyer, { supplierId: w2.supplier.id, currency: 'USD', expectedDate: '2026-11-20', destinationLocationId: w2.locs.warehouse.id, lines: [{ itemId: w2.itemA.id, qty: 10, unitPrice: '1' }] })).purchaseOrder), [{ poLineId: 'L1', qtyAccepted: 10 }]);
  const u = await val(w2); assert.equal(u.status, 'UNKNOWN'); assert.equal(u.valueEurMinor, null); assert.equal(u.unknownUnits, 10);
});

test('units leave proportionally from costed and uncosted stock; the value never goes negative', async () => {
  const w = await makeWorld();
  const a = await order(w, await eur(w, 100, '2.00')); await receive(w, a, [{ poLineId: 'L1', qtyAccepted: 100, landedUnitCostEurMicro: 2_000_000 }]);
  const { purchaseOrder: usd } = await w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-11-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty: 100, unitPrice: '0.50' }] });
  await receive(w, await order(w, usd), [{ poLineId: 'L1', qtyAccepted: 100 }]);
  await take(w, 100); // half of everything: 50 costed + 50 unknown
  let v = await val(w); assert.equal(v.valuedUnits, 50); assert.equal(v.unknownUnits, 50); assert.equal(v.unitCostEurMicro, 2_000_000);
  await take(w, 100);
  v = await val(w); assert.equal(v.status, 'EMPTY'); assert.equal(v.valueEurMinor, 0);
});

test('receipt lots keep what a FIFO needs: date, quantity, unit cost, cost status, order line', async () => {
  const w = await makeWorld();
  const a = await order(w, await eur(w, 100, '1.00')); await receive(w, a, [{ poLineId: 'L1', qtyAccepted: 60, qtyDefective: 5, landedUnitCostEurMicro: 1_100_000 }]);
  await receive(w, await w.q.purchaseOrder(a.id), [{ poLineId: 'L1', qtyAccepted: 35 }], { receivedAt: '2026-11-25' });
  const lots = await w.q.receiptLots(w.itemA.id);
  assert.deepEqual(lots.map((l) => [l.qty, l.unitCostEurMicro, l.costStatus, l.locationType]), [[60, 1_100_000, 'CONFIRMED', 'WAREHOUSE'], [5, 1_100_000, 'CONFIRMED', 'QUARANTINE'], [35, 1_000_000, 'ESTIMATED', 'WAREHOUSE']]);
  assert.ok(lots.every((l) => l.reference.type === 'purchase_order' && l.reference.id === a.id && l.reference.lineId === 'L1' && l.at));
  const mv = await w.store.listMovements(w.merchantId); assert.ok(mv.filter((m) => m.kind === 'RECEIPT').every((m) => m.groupId), 'the lots of one receipt share a group id');
});
