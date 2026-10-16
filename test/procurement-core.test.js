import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, orderedPo, receive, rejects, approval, productApproval, key, owner, buyer, wh, viewer, NOW } from './procurement-fixtures.js';
import { createMemoryProcurementStore } from '../src/procurement/index.js';

test('vertical slice: supplier -> item -> quote -> PO -> approval -> order -> partial receipt -> balance receipt -> stock', async () => {
  const w = await makeWorld();
  const { purchaseOrder: po } = await w.mk(w.c.createPurchaseOrder, buyer, {
    supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-11-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty: 200, quoteId: w.quote.id }],
  });
  assert.equal(po.status, 'DRAFT');
  assert.match(po.number, /^PO-2026-0001$/);
  assert.equal(po.totalMinor, 10000); // 200 x 0.50 USD = 100.00 USD
  assert.deepEqual(po.schedule.map((s) => [s.kind, s.amountMinor]), [['DEPOSIT', 3000], ['BALANCE', 7000]]); // supplier default 30/70
  await w.mk(w.c.submitPurchaseOrder, buyer, { poId: po.id });
  await w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id) });
  await w.mk(w.c.placeOrder, buyer, { poId: po.id, approval: approval('BUYING.place_order', po.id) });
  assert.equal(w.q.purchaseOrder(po.id).status, 'ORDERED');
  assert.equal(w.q.purchaseOrder(po.id).schedule[0].status, 'DUE');
  assert.equal(w.q.stockPosition(w.itemA.id).physical, 0, 'ordering moves no stock');
  assert.equal(w.q.stockPosition(w.itemA.id).incoming.qty, 200);
  assert.equal(w.q.stockPosition(w.itemA.id).available, 0, 'incoming is never available');

  const r1 = await receive(w, w.q.purchaseOrder(po.id), [{ poLineId: 'L1', qtyAccepted: 118, qtyDefective: 2 }]);
  assert.equal(r1.complete, false);
  assert.equal(r1.purchaseOrder.status, 'PARTIALLY_RECEIVED');
  let pos = w.q.stockPosition(w.itemA.id);
  assert.equal(pos.available, 118); assert.equal(pos.quarantine, 2); assert.equal(pos.physical, 120); assert.equal(pos.incoming.qty, 80);

  const r2 = await receive(w, w.q.purchaseOrder(po.id), [{ poLineId: 'L1', qtyAccepted: 80 }]);
  assert.equal(r2.complete, true); assert.equal(r2.purchaseOrder.status, 'RECEIVED');
  pos = w.q.stockPosition(w.itemA.id);
  assert.equal(pos.available, 198); assert.equal(pos.incoming.qty, 0);
  assert.equal(pos.valuation.status, 'UNKNOWN'); // USD order, no explicit fx: the cost in EUR is unknown, never guessed
  assert.equal(pos.valuation.valueEurMinor, null);
  assert.equal(w.q.purchaseOrder(po.id).lines[0].qtyDefective, 2);
  const types = w.q.events({ objectId: po.id }).map((e) => e.type);
  assert.deepEqual(types, ['PO_CREATED', 'PO_SUBMITTED', 'PO_APPROVED', 'PO_ORDERED', 'GOODS_RECEIVED', 'GOODS_RECEIVED']);
  assert.ok(w.audited.length >= types.length, 'events mirrored to the audit hook');
});

test('a confirmed landed cost makes the valuation CONFIRMED; unknown cost stays UNKNOWN, never zero', async () => {
  const w = await makeWorld();
  const po = await orderedPo(w);
  await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 100, landedUnitCostEurMicro: 610000 }]);
  let v = w.q.stockPosition(w.itemA.id).valuation;
  assert.equal(v.status, 'CONFIRMED'); assert.equal(v.unitCostEurMicro, 610000); assert.equal(v.valueEurMinor, 6100);
  // a USD order with no fx -> cost unknown (no invented conversion)
  const w2 = await makeWorld();
  const po2 = await orderedPo(w2);
  await receive(w2, po2, [{ poLineId: 'L1', qtyAccepted: 10 }]);
  v = w2.q.stockPosition(w2.itemA.id).valuation;
  assert.equal(v.status, 'UNKNOWN'); assert.equal(v.valueEurMinor, null);
  assert.equal(w2.q.stockPositions().valuation.itemsWithUnknownCost, 1);
});

test('foreign-currency order with an explicit fx values stock as ESTIMATED with the stated rate', async () => {
  const w = await makeWorld();
  const { purchaseOrder: po } = await w.mk(w.c.createPurchaseOrder, buyer, {
    supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-11-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty: 200, quoteId: w.quote.id }],
    fx: { from: 'USD', to: 'EUR', rate: '0.92', date: '2026-10-15', source: 'ECB reference' },
  });
  await w.mk(w.c.submitPurchaseOrder, buyer, { poId: po.id });
  await w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id) });
  await w.mk(w.c.placeOrder, buyer, { poId: po.id, approval: approval('BUYING.place_order', po.id) });
  await receive(w, w.q.purchaseOrder(po.id), [{ poLineId: 'L1', qtyAccepted: 200 }]);
  const v = w.q.stockPosition(w.itemA.id).valuation;
  assert.equal(v.status, 'ESTIMATED'); assert.equal(v.unitCostEurMicro, 460000); // 0.50 x 0.92
  await rejects(w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-11-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty: 200, quoteId: w.quote.id }], fx: { from: 'GBP', to: 'EUR', rate: '1.1', date: '2026-10-15', source: 's' } }), 'FX_MISMATCH');
});

test('consequential steps need a named human approval that names the action and the subject, and an approval is single-use', async () => {
  const w = await makeWorld();
  const { purchaseOrder: po } = await w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-11-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty: 100, quoteId: w.quote.id }] });
  await w.mk(w.c.submitPurchaseOrder, buyer, { poId: po.id });
  await rejects(w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id }), 'APPROVAL_REQUIRED');
  await rejects(w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id, { approver: { kind: 'HUMAN', id: 'llm', role: 'OWNER' } }) }), 'APPROVER_NOT_HUMAN');
  await rejects(w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id, { approver: { kind: 'SYSTEM', id: 'x' } }) }), 'APPROVER_NOT_HUMAN');
  await rejects(w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.place_order', po.id) }), 'APPROVAL_REQUIRED'); // wrong action
  await rejects(w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', 'some-other-po') }), 'APPROVAL_REQUIRED'); // wrong subject
  await rejects(w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id, { id: undefined }) }), 'INVALID_INPUT'); // no approval id
  assert.equal(w.q.purchaseOrder(po.id).status, 'PENDING_APPROVAL', 'every refusal left the order untouched');
  const ap = approval('BUYING.approve_purchase_plan', po.id);
  await w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: ap });
  // the same approval cannot authorise a second consequential step
  await rejects(w.c.placeOrder(buyer, key(), { poId: po.id, approval: { ...ap, action: 'BUYING.place_order' } }), 'APPROVAL_ALREADY_USED');
  assert.equal(w.q.purchaseOrder(po.id).status, 'APPROVED');
});

test('state machine: no skipping, no going back, cancel only before any receipt', async () => {
  const w = await makeWorld();
  const { purchaseOrder: po } = await w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-11-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty: 100, quoteId: w.quote.id }] });
  await rejects(w.mk(w.c.placeOrder, buyer, { poId: po.id, approval: approval('BUYING.place_order', po.id) }), 'INVALID_TRANSITION'); // DRAFT cannot be ordered
  await rejects(w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id) }), 'INVALID_TRANSITION'); // not submitted
  await rejects(receive(w, po, [{ poLineId: 'L1', qtyAccepted: 1 }]), 'INVALID_TRANSITION'); // cannot receive an unordered PO
  const ordered = await orderedPo(w, { qty: 100 });
  await receive(w, ordered, [{ poLineId: 'L1', qtyAccepted: 40 }]);
  await rejects(w.mk(w.c.cancelPurchaseOrder, owner, { poId: ordered.id, reason: 'changed my mind' }), 'HAS_RECEIPTS');
  const closed = await w.mk(w.c.closePurchaseOrder, buyer, { poId: ordered.id, reason: 'supplier cannot deliver the remaining 60' });
  assert.equal(closed.closedShort, true); assert.deepEqual(closed.abandoned, [{ lineId: 'L1', itemId: w.itemA.id, qty: 60 }]);
  assert.equal(w.q.stockPosition(w.itemA.id).incoming.qty, 0, 'a short-closed order stops being incoming');
  await rejects(w.mk(w.c.closePurchaseOrder, buyer, { poId: ordered.id }), 'INVALID_TRANSITION');
  // closing short needs a reason
  const o2 = await orderedPo(w, { qty: 100 });
  await receive(w, o2, [{ poLineId: 'L1', qtyAccepted: 10 }]);
  await rejects(w.mk(w.c.closePurchaseOrder, buyer, { poId: o2.id }), 'INVALID_INPUT');
  // cancelling an order already placed with the supplier is the owner's call
  const o3 = await orderedPo(w, { qty: 100 });
  await rejects(w.mk(w.c.cancelPurchaseOrder, buyer, { poId: o3.id, reason: 'duplicate order' }), 'FORBIDDEN');
  const c = await w.mk(w.c.cancelPurchaseOrder, owner, { poId: o3.id, reason: 'duplicate order' });
  assert.equal(c.purchaseOrder.status, 'CANCELLED');
});

test('receipts: over-receipt refused and rolled back, defective goods need a quarantine location, partial receipts are normal', async () => {
  const w = await makeWorld();
  const po = await orderedPo(w, { qty: 10 });
  await rejects(receive(w, po, [{ poLineId: 'L1', qtyAccepted: 11 }]), 'OVER_RECEIPT');
  await rejects(receive(w, po, [{ poLineId: 'L1', qtyAccepted: 5, qtyDefective: 6 }]), 'OVER_RECEIPT');
  await rejects(receive(w, po, [{ poLineId: 'L9', qtyAccepted: 1 }]), 'PO_LINE_NOT_FOUND');
  await rejects(receive(w, po, [{ poLineId: 'L1', qtyAccepted: 0 }]), 'INVALID_INPUT');
  await rejects(receive(w, po, [{ poLineId: 'L1', qtyAccepted: 3, qtyDefective: 1 }], { quarantineLocationId: w.locs.warehouse.id }), 'INVALID_DESTINATION');
  await rejects(receive(w, po, [{ poLineId: 'L1', qtyAccepted: 3 }], { locationId: w.locs.quarantine.id }), 'INVALID_DESTINATION');
  assert.equal(w.store.listMovements(w.merchantId).length, 0, 'no refused receipt left a trace in the ledger');
  assert.equal(w.q.purchaseOrder(po.id).status, 'ORDERED');
  assert.equal(w.q.events({ objectId: po.id }).filter((e) => e.type === 'GOODS_RECEIVED').length, 0);
  await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 4 }]);
  await receive(w, w.q.purchaseOrder(po.id), [{ poLineId: 'L1', qtyAccepted: 6 }]);
  assert.equal(w.q.purchaseOrder(po.id).status, 'RECEIVED');
  await rejects(receive(w, w.q.purchaseOrder(po.id), [{ poLineId: 'L1', qtyAccepted: 1 }]), 'INVALID_TRANSITION');
});

test('idempotency: a replayed command has no second effect; the same key with another payload is refused', async () => {
  const w = await makeWorld();
  const po = await orderedPo(w, { qty: 50 });
  const k = key('rcv'); const ap = approval('STOCK_SALES.receive_goods', po.id);
  const payload = { poId: po.id, receivedAt: '2026-11-18', lines: [{ poLineId: 'L1', qtyAccepted: 20 }], approval: ap };
  const first = await w.c.receiveGoods(wh, k, payload);
  const again = await w.c.receiveGoods(wh, k, payload);
  assert.equal(first.replayed, false); assert.equal(again.replayed, true);
  assert.equal(again.receipt.id, first.receipt.id);
  assert.equal(w.q.stockPosition(w.itemA.id).available, 20, 'received once');
  assert.equal(w.store.listMovements(w.merchantId).filter((m) => m.kind === 'RECEIPT').length, 1);
  assert.equal(w.q.events({ objectId: po.id }).filter((e) => e.type === 'GOODS_RECEIVED').length, 1);
  await rejects(w.c.receiveGoods(wh, k, { ...payload, lines: [{ poLineId: 'L1', qtyAccepted: 25 }] }), 'IDEMPOTENCY_KEY_REUSED');
  // a command that failed can be retried with the same key once the cause is fixed
  const k2 = key('adj'); const bad = { itemId: w.itemA.id, locationId: w.locs.warehouse.id, delta: -999, reason: 'broken box found', approval: productApproval('STOCK_SALES.adjust_on_hand', `${w.itemA.id}@${w.locs.warehouse.id}`) };
  await rejects(w.c.adjustStock(wh, k2, bad), 'INSUFFICIENT_STOCK');
  const ok = await w.c.adjustStock(wh, k2, { ...bad, delta: -1, approval: productApproval('STOCK_SALES.adjust_on_hand', `${w.itemA.id}@${w.locs.warehouse.id}`) });
  assert.equal(ok.replayed, false);
});

test('a failed command rolls back everything, including the consumed approval', async () => {
  const w = await makeWorld();
  const po = await orderedPo(w, { qty: 10 });
  const ap = approval('STOCK_SALES.receive_goods', po.id);
  await rejects(w.c.receiveGoods(wh, key(), { poId: po.id, receivedAt: '2026-11-18', lines: [{ poLineId: 'L1', qtyAccepted: 99 }], approval: ap }), 'OVER_RECEIPT');
  // the approval was not burnt by the failed attempt
  const ok = await w.c.receiveGoods(wh, key(), { poId: po.id, receivedAt: '2026-11-18', lines: [{ poLineId: 'L1', qtyAccepted: 10 }], approval: ap });
  assert.equal(ok.complete, true);
});

test('stock operations: justified adjustment, atomic transfer, quarantine, reservation limits', async () => {
  const w = await makeWorld();
  const po = await orderedPo(w, { qty: 100 });
  await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 100 }]);
  const A = w.itemA.id; const W = w.locs.warehouse.id; const S = w.locs.store.id;
  const adj = (over) => w.c.adjustStock(wh, key(), { itemId: A, locationId: W, delta: -2, reason: 'two units damaged in handling', approval: productApproval('STOCK_SALES.adjust_on_hand', `${A}@${W}`), ...over });
  await rejects(adj({ approval: undefined }), 'APPROVAL_REQUIRED');
  await rejects(adj({ reason: 'x' }), 'INVALID_INPUT');
  await rejects(adj({ delta: 0 }), 'INVALID_INPUT');
  await rejects(adj({ delta: -101 }), 'INSUFFICIENT_STOCK');
  await adj({});
  assert.equal(w.q.stockPosition(A).available, 98);
  // transfer: both legs or neither
  await rejects(w.c.transferStock(wh, key(), { itemId: A, fromLocationId: W, toLocationId: S, qty: 99 }), 'INSUFFICIENT_STOCK');
  const before = w.store.listMovements(w.merchantId).length;
  const t = await w.c.transferStock(wh, key(), { itemId: A, fromLocationId: W, toLocationId: S, qty: 30 });
  assert.equal(t.movements.length, 2); assert.equal(w.store.listMovements(w.merchantId).length, before + 2);
  assert.equal(w.q.stockPosition(A).locations.find((l) => l.locationId === S).onHand, 30);
  await rejects(w.c.transferStock(wh, key(), { itemId: A, fromLocationId: W, toLocationId: W, qty: 1 }), 'INVALID_INPUT');
  // quarantine a defect found later
  await w.c.quarantineDefect(wh, key(), { itemId: A, fromLocationId: S, quarantineLocationId: w.locs.quarantine.id, qty: 3, reason: 'cracked magnets found on shelf' });
  let pos = w.q.stockPosition(A);
  assert.equal(pos.quarantine, 3); assert.equal(pos.available, 95); assert.equal(pos.physical, 98);
  // reservation: never more than on hand; reserved units cannot leave
  await rejects(w.c.reserveStock(wh, key(), { itemId: A, locationId: S, qty: 28, reference: { type: 'order', id: 'o-1' } }), 'RESERVED_STOCK');
  await w.c.reserveStock(wh, key(), { itemId: A, locationId: S, qty: 27, reference: { type: 'order', id: 'o-1' } });
  assert.equal(w.q.stockPosition(A).available, 68);
  await rejects(w.c.transferStock(wh, key(), { itemId: A, fromLocationId: S, toLocationId: W, qty: 1 }), 'RESERVED_STOCK');
  await rejects(w.c.releaseStock(wh, key(), { itemId: A, locationId: S, qty: 28, reference: { type: 'order', id: 'o-1' } }), 'INSUFFICIENT_RESERVED');
  await w.c.releaseStock(wh, key(), { itemId: A, locationId: S, qty: 27, reference: { type: 'order', id: 'o-1' } });
  pos = w.q.stockPosition(A);
  assert.equal(pos.reserved, 0); assert.equal(pos.available, 95);
  await rejects(w.c.reserveStock(wh, key(), { itemId: A, locationId: w.locs.quarantine.id, qty: 1, reference: { type: 'order', id: 'o-2' } }), 'INVALID_DESTINATION');
});

test('physical count: variance needs reasons and one approval; a clean count needs none', async () => {
  const w = await makeWorld();
  const po = await orderedPo(w, { qty: 50 });
  await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 50 }]);
  const A = w.itemA.id; const W = w.locs.warehouse.id;
  const clean = await w.c.recordCount(wh, key(), { locationId: W, countId: 'count-1', counts: [{ itemId: A, counted: 50 }] });
  assert.equal(clean.adjusted, 0);
  await rejects(w.c.recordCount(wh, key(), { locationId: W, countId: 'count-2', counts: [{ itemId: A, counted: 47 }] }), 'INVALID_INPUT'); // no reason
  await rejects(w.c.recordCount(wh, key(), { locationId: W, countId: 'count-2', counts: [{ itemId: A, counted: 47, reason: 'three missing after the event' }] }), 'APPROVAL_REQUIRED');
  const r = await w.c.recordCount(wh, key(), { locationId: W, countId: 'count-2', counts: [{ itemId: A, counted: 47, reason: 'three missing after the event' }], approval: productApproval('STOCK_SALES.adjust_on_hand', 'count:count-2') });
  assert.equal(r.adjusted, 1); assert.equal(r.lines[0].variance, -3);
  assert.equal(w.q.stockPosition(A).available, 47);
  const mv = w.store.listMovements(w.merchantId).find((m) => m.kind === 'COUNT_ADJUST');
  assert.equal(mv.delta, -3); assert.equal(mv.reason, 'three missing after the event'); assert.ok(mv.approvalId);
});

test('roles: a viewer cannot write, a warehouse user cannot order, an anonymous caller is refused', async () => {
  const w = await makeWorld();
  await rejects(w.c.createItem(viewer, key(), { sku: 'X', name: 'x' }), 'FORBIDDEN');
  await rejects(w.c.createPurchaseOrder(wh, key(), {}), 'FORBIDDEN');
  await rejects(w.c.createItem(null, key(), { sku: 'X', name: 'x' }), 'ACTOR_REQUIRED');
  await rejects(w.c.createItem({ id: 'u', role: 'ROOT' }, key(), { sku: 'X', name: 'x' }), 'ACTOR_REQUIRED');
  await rejects(w.c.createItem(buyer, '', { sku: 'X', name: 'x' }), 'INVALID_INPUT'); // idempotency key mandatory
  await rejects(w.c.receiveGoods(buyer, key(), {}), 'FORBIDDEN'); // a buyer does not book stock
});

test('catalogue and supplier uniqueness, input validation', async () => {
  const w = await makeWorld();
  await rejects(w.mk(w.c.createItem, buyer, { sku: 'MAG-001', name: 'dup' }), 'UNIQUE_VIOLATION');
  await rejects(w.mk(w.c.createItem, buyer, { sku: 'NEW', name: 'dup barcode', barcode: '5400000000011' }), 'UNIQUE_VIOLATION');
  await rejects(w.mk(w.c.createSupplier, buyer, { name: 'shenzhen gifts co', currency: 'USD' }), 'UNIQUE_VIOLATION');
  await rejects(w.mk(w.c.createSupplier, buyer, { name: 'Bad Pay', currency: 'USD', payment: { depositPct: '30', balancePct: '60' } }), 'INVALID_INPUT');
  await rejects(w.mk(w.c.createSupplier, buyer, { name: 'Bad Cur', currency: 'dollars' }), 'INVALID_INPUT');
  await rejects(w.mk(w.c.createItem, buyer, { sku: '', name: 'x' }), 'INVALID_INPUT');
  await rejects(w.mk(w.c.createLocation, owner, { name: 'Boutique', type: 'STORE' }), 'UNIQUE_VIOLATION');
  await rejects(w.mk(w.c.createLocation, owner, { name: 'Cave', type: 'CELLAR' }), 'INVALID_INPUT');
  const i = await w.mk(w.c.updateItem, buyer, { itemId: w.itemB.id, patch: { reorderPoint: 5, reorderQty: 50 } });
  assert.equal(i.item.version, 2);
  await rejects(w.mk(w.c.updateItem, buyer, { itemId: w.itemB.id, expectedVersion: 1, patch: { name: 'stale write' } }), 'VERSION_CONFLICT');
  const arch = await w.mk(w.c.updateItem, buyer, { itemId: w.itemB.id, patch: { status: 'ARCHIVED' } });
  assert.equal(arch.item.status, 'ARCHIVED');
  await rejects(w.mk(w.c.adjustStock, wh, { itemId: w.itemB.id, locationId: w.locs.store.id, delta: 1, reason: 'archived item test', approval: productApproval('STOCK_SALES.adjust_on_hand', `${w.itemB.id}@${w.locs.store.id}`) }), 'ITEM_ARCHIVED');
});

test('tenant isolation: another merchant sees and touches nothing', async () => {
  const store = createMemoryProcurementStore();
  const a = await makeWorld({ merchantId: 'm-A', store });
  const b = await makeWorld({ merchantId: 'm-B', store });
  assert.equal(a.q.items().length, 2); assert.equal(b.q.items().length, 2);
  assert.notEqual(a.itemA.id, b.itemA.id);
  assert.equal(b.q.item(a.itemA.id), null);
  assert.equal(b.q.purchaseOrder('anything'), null);
  const po = await orderedPo(a);
  assert.equal(b.q.purchaseOrder(po.id), null);
  await rejects(b.c.submitPurchaseOrder(buyer, key(), { poId: po.id }), 'PO_NOT_FOUND');
  await rejects(b.c.adjustStock(wh, key(), { itemId: a.itemA.id, locationId: a.locs.warehouse.id, delta: 1, reason: 'cross tenant attempt', approval: productApproval('STOCK_SALES.adjust_on_hand', `${a.itemA.id}@${a.locs.warehouse.id}`) }), 'ITEM_NOT_FOUND');
  // both tenants use the SAME idempotency key without colliding
  const k = key('shared');
  await a.c.createItem(buyer, k, { sku: 'S-1', name: 's' }); await b.c.createItem(buyer, k, { sku: 'S-1', name: 's' });
  assert.equal(a.q.items().length, 3); assert.equal(b.q.items().length, 3);
});

test('concurrent receipts are serialised: the ordered quantity can never be exceeded', async () => {
  const w = await makeWorld();
  const po = await orderedPo(w, { qty: 10 });
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => receive(w, po, [{ poLineId: 'L1', qtyAccepted: 3 }])));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => ['OVER_RECEIPT', 'INVALID_TRANSITION'].includes(r.reason.code)));
  assert.equal(w.q.stockPosition(w.itemA.id).physical, 9);
  assert.equal(w.q.purchaseOrder(po.id).lines[0].qtyReceived, 9);
});
