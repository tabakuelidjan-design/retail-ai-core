import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, orderedPo, receive, rejects, approval, key, owner, buyer, wh } from './procurement-fixtures.js';

test('quotes: every revision is kept (negotiated-price history); the older one is superseded; tiers and validity are enforced', async () => {
  const w = await makeWorld();
  const second = (await w.mk(w.c.recordQuote, buyer, {
    supplierId: w.supplier.id, itemId: w.itemA.id, currency: 'USD', tiers: [{ minQty: 100, unitPrice: '0.470' }, { minQty: 500, unitPrice: '0.400' }], moq: 100, reason: 'volume discount after negotiation', provenance: 'USER_PROVIDED',
  })).quote;
  assert.equal(second.revision, 2);
  const h = (await w.q.priceHistory({ supplierId: w.supplier.id, itemId: w.itemA.id }));
  assert.deepEqual(h.map((x) => [x.revision, x.status]), [[1, 'SUPERSEDED'], [2, 'RECEIVED']]);
  assert.equal(h[0].tiers[0].unitPrice, '0.5'); assert.equal(h[1].tiers[0].unitPrice, '0.47'); assert.equal(h[1].reason, 'volume discount after negotiation');
  // the superseded quote cannot be ordered against
  await rejects(w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-11-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty: 100, quoteId: w.quote.id }] }), 'QUOTE_NOT_USABLE');
  await rejects(w.mk(w.c.recordQuote, buyer, { supplierId: w.supplier.id, itemId: w.itemA.id, currency: 'USD', tiers: [{ minQty: 10, unitPrice: '0.40' }, { minQty: 5, unitPrice: '0.30' }] }), 'TIER_ORDER');
  await rejects(w.mk(w.c.recordQuote, buyer, { supplierId: w.supplier.id, itemId: w.itemA.id, currency: 'USD', tiers: [{ minQty: 10, unitPrice: '0.40' }, { minQty: 50, unitPrice: '0.45' }] }), 'TIER_PRICE_INCREASES');
  await rejects(w.mk(w.c.recordQuote, buyer, { supplierId: w.supplier.id, itemId: w.itemA.id, currency: 'USD', tiers: [{ minQty: 10, unitPrice: 0.4 }] }), 'INVALID_INPUT'); // a float is never money
  // MOQ / first tier fail closed, tier boundary picks the right price
  const mk = (qty) => w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-11-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty, quoteId: second.id }] });
  await rejects(mk(99), 'BELOW_MOQ');
  assert.equal((await mk(499)).purchaseOrder.lines[0].unitPriceMicro, 470000);
  assert.equal((await mk(500)).purchaseOrder.lines[0].unitPriceMicro, 400000);
  assert.equal((await mk(500)).purchaseOrder.totalMinor, 20000);
});

test('an expired quote cannot be selected or ordered', async () => {
  const late = () => '2027-01-15T10:00:00.000Z';
  const w = await makeWorld({ now: late });
  const exp = (await w.mk(w.c.recordQuote, buyer, { supplierId: w.supplier.id, itemId: w.itemB.id, currency: 'USD', tiers: [{ minQty: 1, unitPrice: '1' }], validUntil: '2027-01-01' })).quote;
  await rejects(w.mk(w.c.selectQuote, buyer, { quoteId: exp.id }), 'QUOTE_EXPIRED');
  await rejects(w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2027-02-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemB.id, qty: 5, quoteId: exp.id }] }), 'QUOTE_EXPIRED');
});

test('selecting a quote keeps one selected quote per item', async () => {
  const w = await makeWorld();
  const s2 = (await w.mk(w.c.createSupplier, buyer, { name: 'Yiwu Trading', currency: 'EUR' })).supplier;
  const q2 = (await w.mk(w.c.recordQuote, buyer, { supplierId: s2.id, itemId: w.itemA.id, currency: 'EUR', tiers: [{ minQty: 1, unitPrice: '0.55' }] })).quote;
  await w.mk(w.c.selectQuote, buyer, { quoteId: w.quote.id });
  await w.mk(w.c.selectQuote, buyer, { quoteId: q2.id });
  assert.equal((await w.store.get('quotes', w.merchantId, w.quote.id)).status, 'RECEIVED');
  assert.equal((await w.store.get('quotes', w.merchantId, q2.id)).status, 'SELECTED');
});

test('purchase orders: confirmation records date slippage, delay is derived, payments link to the schedule without paying', async () => {
  const w = await makeWorld();
  const po = await orderedPo(w, { expectedDate: '2026-10-30' });
  assert.deepEqual((await w.q.delayedOrders('2026-10-30')), []);
  const late = (await w.q.delayedOrders('2026-11-05'));
  assert.equal(late.length, 1); assert.equal(late[0].daysLate, 6); assert.equal(late[0].outstanding[0].qty, 200);
  await w.mk(w.c.confirmOrder, buyer, { poId: po.id, confirmedDate: '2026-11-10', supplierReference: 'SG-OK' });
  const cur = (await w.q.purchaseOrder(po.id));
  assert.equal(cur.status, 'CONFIRMED'); assert.equal(cur.originalExpectedDate, '2026-10-30'); assert.equal(cur.dateChanges.length, 1);
  assert.equal((await w.q.delayedOrders('2026-11-11'))[0].slippedDays, 11);
  const p = await w.mk(w.c.linkPayment, buyer, { poId: po.id, kind: 'DEPOSIT', paymentRef: 'fin-pay-123', amountMinor: 3000, paidAt: '2026-10-17' });
  assert.equal(p.matchesSchedule, true);
  await rejects(w.mk(w.c.linkPayment, buyer, { poId: po.id, kind: 'DEPOSIT', paymentRef: 'fin-pay-124', amountMinor: 3000, paidAt: '2026-10-17' }), 'ALREADY_LINKED');
  const off = await w.mk(w.c.linkPayment, buyer, { poId: po.id, kind: 'BALANCE', paymentRef: 'fin-pay-200', amountMinor: 6500, paidAt: '2026-11-18' });
  assert.equal(off.matchesSchedule, false, 'a payment that differs from the schedule is flagged, not silently accepted');
  const c = await w.mk(w.c.cancelPurchaseOrder, owner, { poId: po.id, reason: 'supplier lost the mould' });
  assert.equal(c.paymentsToReview.length, 2, 'cancelling after payments surfaces refund review instead of hiding it');
});

test('incoming never counts as available; transit and reorder alerts are distinct facts', async () => {
  const w = await makeWorld();
  await w.mk(w.c.updateItem, buyer, { itemId: w.itemA.id, patch: { reorderPoint: 150, reorderQty: 300 } });
  assert.deepEqual((await w.q.reorderAlerts()).map((a) => [a.sku, a.level]), [['MAG-001', 'STOCKOUT']]);
  const po = await orderedPo(w, { qty: 200 });
  const tr = (await w.q.inTransit());
  assert.equal(tr.orderedNotReceived.units, 200); assert.equal(tr.orderedNotReceived.goodsValueMinorByCurrency.USD, 10000);
  assert.equal((await w.q.stockPosition(w.itemA.id)).available, 0);
  assert.equal((await w.q.reorderAlerts())[0].level, 'STOCKOUT', 'still a stock-out: incoming is not on the shelf');
  await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 100 }]);
  assert.deepEqual((await w.q.reorderAlerts()), [], '100 available + 100 incoming is above the point of 150');
  await w.mk(w.c.updateItem, buyer, { itemId: w.itemA.id, patch: { reorderPoint: 250 } });
  assert.equal((await w.q.reorderAlerts())[0].level, 'REORDER'); // 100 available + 100 incoming <= 250
  assert.equal((await w.q.reorderAlerts())[0].suggestedQty, 300);
  await receive(w, (await w.q.purchaseOrder(po.id)), [{ poLineId: 'L1', qtyAccepted: 100 }]);
  await w.mk(w.c.updateItem, buyer, { itemId: w.itemA.id, patch: { reorderPoint: 150 } });
  assert.deepEqual((await w.q.reorderAlerts()), []);
  // goods physically in a TRANSIT location
  await w.c.transferStock(wh, key(), { itemId: w.itemA.id, fromLocationId: w.locs.warehouse.id, toLocationId: w.locs.transit.id, qty: 40 });
  assert.equal((await w.q.inTransit()).inTransitLocationUnits[w.itemA.id], 40);
  assert.equal((await w.q.stockPosition(w.itemA.id)).available, 160, 'units in transit are not sellable');
  assert.equal((await w.q.stockPosition(w.itemA.id)).physical, 160);
});

test('supplier reliability is derived from receipts and incidents only, and says NOT_MEASURABLE below the sample', async () => {
  const w = await makeWorld();
  assert.equal((await w.q.supplierMetrics(w.supplier.id)).onTimeReceipts.status, 'NOT_MEASURABLE');
  const po = await orderedPo(w, { qty: 300, expectedDate: '2026-11-20' });
  await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 95, qtyDefective: 5 }], { receivedAt: '2026-11-19' }); // on time
  await receive(w, (await w.q.purchaseOrder(po.id)), [{ poLineId: 'L1', qtyAccepted: 100 }], { receivedAt: '2026-11-20' }); // on time (same day)
  let m = (await w.q.supplierMetrics(w.supplier.id));
  assert.equal(m.onTimeReceipts.status, 'NOT_MEASURABLE'); assert.equal(m.onTimeReceipts.denominator, 2);
  await receive(w, (await w.q.purchaseOrder(po.id)), [{ poLineId: 'L1', qtyAccepted: 100 }], { receivedAt: '2026-11-27' }); // late
  m = (await w.q.supplierMetrics(w.supplier.id));
  assert.equal(m.onTimeReceipts.status, 'MEASURED'); assert.equal(m.onTimeReceipts.numerator, 2); assert.equal(m.onTimeReceipts.denominator, 3);
  assert.equal(m.onTimeReceipts.refs.length, 3, 'every ratio carries the ids behind it');
  assert.equal(m.defectRateUnits.numerator, 5); assert.equal(m.defectRateUnits.denominator, 300);
  assert.equal('score' in m, false, 'no opaque composite score');
  await w.mk(w.c.recordIncident, buyer, { supplierId: w.supplier.id, poId: po.id, type: 'QUALITY', severity: 'HIGH', description: 'colour mismatch on 5 units' });
  assert.equal((await w.q.supplierMetrics(w.supplier.id)).incidents.high, 1);
  const other = (await w.mk(w.c.createSupplier, buyer, { name: 'Other', currency: 'EUR' })).supplier;
  await rejects(w.mk(w.c.recordIncident, buyer, { supplierId: other.id, poId: po.id, type: 'QUALITY', severity: 'LOW', description: 'not their order' }), 'PO_MISMATCH');
});

test('compareSuppliers: only comparable, current, MOQ-respecting offers are ranked; foreign currency needs an explicit rate; nothing is selected', async () => {
  const w = await makeWorld();
  const eur = (await w.mk(w.c.createSupplier, buyer, { name: 'Lyon Goodies', currency: 'EUR' })).supplier;
  await w.mk(w.c.recordQuote, buyer, { supplierId: eur.id, itemId: w.itemA.id, currency: 'EUR', tiers: [{ minQty: 50, unitPrice: '0.52' }], moq: 50 });
  const hi = (await w.mk(w.c.createSupplier, buyer, { name: 'Big MOQ Ltd', currency: 'EUR' })).supplier;
  await w.mk(w.c.recordQuote, buyer, { supplierId: hi.id, itemId: w.itemA.id, currency: 'EUR', tiers: [{ minQty: 5000, unitPrice: '0.10' }], moq: 5000 });
  const before = (await w.store.snapshot());
  let r = (await w.q.compareSuppliers({ itemId: w.itemA.id, qty: 200 }));
  assert.equal((await w.store.snapshot()).movements.length, before.movements.length);
  assert.equal(r.basis, 'GOODS_PRICE_ONLY'); assert.match(r.decision, /never selects/);
  const bySupplier = Object.fromEntries(r.offers.map((o) => [o.supplier, o]));
  assert.equal(bySupplier['Shenzhen Gifts Co'].status, 'NOT_COMPARABLE'); assert.equal(bySupplier['Shenzhen Gifts Co'].reason, 'FX_REQUIRED');
  assert.equal(bySupplier['Big MOQ Ltd'].status, 'NOT_ELIGIBLE'); assert.equal(bySupplier['Big MOQ Ltd'].reason, 'BELOW_MOQ');
  assert.deepEqual(r.ranking.length, 1);
  // with an explicit rate the USD offer joins the goods-price ranking (0.50 USD x 0.90 = 0.45 EUR < 0.52)
  r = (await w.q.compareSuppliers({ itemId: w.itemA.id, qty: 200, fx: { USD: { rate: '0.90', date: '2026-10-15', source: 'ECB reference' } } }));
  assert.equal(r.offers.find((o) => o.supplier === 'Shenzhen Gifts Co').goodsUnitEur, 0.45);
  assert.equal(r.offers.find((o) => o.supplier === 'Shenzhen Gifts Co').landed, 'NOT_COMPUTED');
  assert.equal(r.ranking[0].quoteId, w.quote.id);
});

test('compareSuppliers and plannedMargin use the Finance engine; landed cost can reverse the goods-price ranking', async () => {
  const w = await makeWorld();
  const eur = (await w.mk(w.c.createSupplier, buyer, { name: 'Lyon Goodies', currency: 'EUR' })).supplier;
  await w.mk(w.c.recordQuote, buyer, { supplierId: eur.id, itemId: w.itemA.id, currency: 'EUR', tiers: [{ minQty: 50, unitPrice: '0.52' }], moq: 50 });
  const fx = { USD: { rate: '0.90', date: '2026-10-15', source: 'ECB reference' } };
  const r = (await w.q.compareSuppliers({
    itemId: w.itemA.id, qty: 200, fx, expectedSellingPriceGross: '3.00',
    costInputs: { [w.supplier.id]: { freight_total: '60', duty_rate_pct: '4', import_vat_rate_pct: '21' }, [eur.id]: { freight_total: '2', duty_rate_pct: '0', import_vat_rate_pct: '0' } },
  }));
  assert.equal(r.basis, 'LANDED_COST', JSON.stringify(r.offers.map((o) => [o.supplier, o.status, o.reason])));
  const cn = r.offers.find((o) => o.supplier === 'Shenzhen Gifts Co'); const be = r.offers.find((o) => o.supplier === 'Lyon Goodies');
  assert.equal(cn.status, 'LANDED'); assert.equal(cn.estimated, true, 'converted figures are flagged ESTIMATED');
  assert.ok(cn.fx.date && cn.fx.source, 'the rate and its date travel with the answer');
  assert.ok(Number(cn.landedPerUnit) > Number(be.landedPerUnit), 'freight and duty make the cheaper-on-paper USD offer the dearer one');
  assert.equal(r.ranking[0].quoteId, be.quoteId);
  // planned margin of an actual order
  const po = await orderedPo(w, { qty: 200 });
  const m = (await w.q.plannedMargin({ poId: po.id, sellingPricesGross: { [w.itemA.id]: '3.00' }, costInputs: { [w.itemA.id]: { freight_total: '60', duty_rate_pct: '4', import_vat_rate_pct: '21' } } }));
  assert.equal(m.lines[0].status, 'NOT_COMPUTED', 'the order has no fx: Finance refuses to convert');
  const { purchaseOrder: po2 } = await w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-11-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty: 200, quoteId: w.quote.id }], fx: { from: 'USD', to: 'EUR', rate: '0.90', date: '2026-10-15', source: 'ECB reference' } });
  const m2 = (await w.q.plannedMargin({ poId: po2.id, sellingPricesGross: { [w.itemA.id]: '3.00' }, costInputs: { [w.itemA.id]: { freight_total: '60', duty_rate_pct: '4', import_vat_rate_pct: '21' } } }));
  assert.equal(m2.lines[0].status, 'ESTIMATED'); assert.ok(m2.lines[0].margin);
  assert.match(m2.note, /not definitive/);
  assert.equal((await w.q.plannedMargin({ poId: po2.id })).lines[0].reason, 'NO_SELLING_PRICE');
});
