import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, orderedPo, rejects, buyer, wh, key } from './procurement-fixtures.js';

const HASH = 'a'.repeat(64);

test('supplier visit: a prospect product with photo references, a quote with evidence, then a selection, all idempotent', async () => {
  const w = await makeWorld();
  const k = key('visit');
  const payload = { sku: 'CN-VISIT-01', name: 'Porte-clés acrylique 5 cm', status: 'PROSPECT', attachments: [{ kind: 'PHOTO', ref: 'sourcing://case-42/photo-1.jpg', sha256: HASH, note: 'stand 3B, hall 2' }] };
  const a = await w.c.createItem(buyer, k, payload); const again = await w.c.createItem(buyer, k, payload);
  assert.equal(a.item.status, 'PROSPECT'); assert.equal(again.replayed, true); assert.equal(again.item.id, a.item.id);
  assert.equal(a.item.attachments[0].ref, 'sourcing://case-42/photo-1.jpg');
  const q = (await w.mk(w.c.recordQuote, buyer, {
    supplierId: w.supplier.id, itemId: a.item.id, currency: 'USD', tiers: [{ minQty: 1000, unitPrice: '0.085' }, { minQty: 5000, unitPrice: '0.072' }], moq: 1000, incoterm: 'FOB',
    provenance: 'USER_PROVIDED', evidence: [{ kind: 'PHOTO', ref: 'sourcing://case-42/quote-photo.jpg' }], reason: 'quoted verbally on the stand',
  })).quote;
  assert.equal(q.provenance, 'USER_PROVIDED'); assert.equal(q.evidence.length, 1);
  assert.equal((await w.mk(w.c.selectQuote, buyer, { quoteId: q.id })).quote.status, 'SELECTED');
  // a prospect can be ordered, tracked and promoted once it is in the catalogue
  const promoted = await w.mk(w.c.updateItem, buyer, { itemId: a.item.id, patch: { status: 'ACTIVE' } });
  assert.equal(promoted.item.status, 'ACTIVE');
  await rejects(w.c.createItem(buyer, key(), { sku: 'X1', name: 'x', attachments: [{ kind: 'PHOTO', ref: 'r', sha256: 'nothex' }] }), 'INVALID_INPUT');
  await rejects(w.c.createItem(buyer, key(), { sku: 'X2', name: 'x', attachments: Array.from({ length: 21 }, () => ({ kind: 'PHOTO', ref: 'r' })) }), 'INVALID_INPUT');
  await rejects(w.c.createItem(buyer, key(), { sku: 'X3', name: 'x', attachments: [{ kind: 'VIDEO', ref: 'r' }] }), 'INVALID_INPUT');
});

test('supplier documents carry expiry dates; only real expiries are reported', async () => {
  const w = await makeWorld();
  await w.mk(w.c.addSupplierDocument, buyer, { supplierId: w.supplier.id, type: 'CERTIFICATE', name: 'CE declaration', ref: 'docs://ce.pdf', sha256: HASH, expiresOn: '2026-11-01' });
  await w.mk(w.c.addSupplierDocument, buyer, { supplierId: w.supplier.id, type: 'CERTIFICATE', name: 'Old audit', ref: 'docs://audit.pdf', expiresOn: '2026-09-01' });
  await w.mk(w.c.addSupplierDocument, buyer, { supplierId: w.supplier.id, type: 'CONTRACT', name: 'Framework', ref: 'docs://fw.pdf' }); // no expiry: never "expiring"
  await w.mk(w.c.addSupplierDocument, buyer, { supplierId: w.supplier.id, type: 'PRICE_LIST', name: 'Far away', ref: 'docs://pl.pdf', expiresOn: '2027-06-01' });
  const soon = w.q.expiringDocuments({ asOf: '2026-10-16', withinDays: 30 });
  assert.deepEqual(soon.map((d) => [d.name, d.expired]), [['Old audit', true], ['CE declaration', false]]);
  assert.equal(soon[1].daysLeft, 16);
  assert.equal(w.q.supplier(w.supplier.id).documents.length, 4);
  await rejects(w.mk(w.c.addSupplierDocument, buyer, { supplierId: w.supplier.id, type: 'MEMO', name: 'x', ref: 'r' }), 'INVALID_INPUT');
  await rejects(w.mk(w.c.addSupplierDocument, wh, { supplierId: w.supplier.id, type: 'OTHER', name: 'x', ref: 'r' }), 'FORBIDDEN');
  assert.equal(w.proc.assistant.call('expiring_supplier_documents', { asOf: '2026-10-16', withinDays: 30 }).documents.length, 2);
});

test('target price: the highest supplier price that still reaches the margin, found on the Finance engine', async () => {
  const w = await makeWorld();
  const inputs = { freight_total: '60', duty_rate_pct: '4', import_vat_rate_pct: '21' };
  const fx = { rate: '0.90', date: '2026-10-15', source: 'ECB reference' };
  const t = w.q.targetUnitPrice({ currency: 'USD', qty: 200, sellingPriceGross: '3.00', targetMarginPct: '60', costInputs: inputs, fx });
  assert.equal(t.status, 'ESTIMATED'); assert.ok(t.grossMarginBpAtMax >= 6000);
  // it IS the maximum: one more step of 0.0001 misses the target, the price itself reaches it
  const { analyzePurchase } = await import('../src/finance/purchase-analysis.js');
  const at = (p) => analyzePurchase({ supplier_unit_price: p, currency: 'USD', qty: 200, ...inputs, expected_selling_price_gross: '3.00', selling_vat_rate_pct: '21', fx: { rate: '0.90', provenance: 'USER_PROVIDED' } });
  const next = (Number(t.maxUnitPrice) + 0.0001).toFixed(4);
  assert.ok(at(t.maxUnitPrice).margin.gross_margin_bp >= 6000);
  assert.ok(at(next).margin.gross_margin_bp < 6000, `the next price step ${next} must miss the target`);
  assert.match(t.note, /not an offer/);
  // honest refusals
  assert.equal(w.q.targetUnitPrice({ currency: 'USD', qty: 200, sellingPriceGross: '3.00', targetMarginPct: '60', costInputs: inputs }).reason, 'FX_REQUIRED');
  assert.equal(w.q.targetUnitPrice({ currency: 'EUR', qty: 200, targetMarginPct: '60', costInputs: inputs }).reason, 'NO_SELLING_PRICE');
  assert.equal(w.q.targetUnitPrice({ currency: 'EUR', qty: 200, sellingPriceGross: '3.00', targetMarginPct: '60' }).reason, 'NO_COST_INPUTS');
  assert.equal(w.q.targetUnitPrice({ currency: 'EUR', qty: 1, sellingPriceGross: '0.50', targetMarginPct: '95', costInputs: { freight_total: '50', duty_rate_pct: '0', import_vat_rate_pct: '0' } }).status, 'NOT_ACHIEVABLE');
  assert.equal(w.proc.assistant.call('target_price', { currency: 'USD' }).status, 'NEED_CLARIFICATION');
  assert.equal(w.proc.assistant.call('target_price', { currency: 'USD', qty: 200, sellingPriceGross: '3.00', targetMarginPct: '60', costInputs: inputs, fx }).target.status, 'ESTIMATED');
});

test('tracking from order to shelf: ordered, confirmed with a new date, delayed, partially received, closed', async () => {
  const w = await makeWorld();
  const po = await orderedPo(w, { qty: 200, expectedDate: '2026-10-20' });
  assert.equal(w.q.inTransit().orderedNotReceived.lines[0].delayed, false);
  await w.mk(w.c.confirmOrder, buyer, { poId: po.id, confirmedDate: '2026-10-14' }); // supplier moved the date earlier than "today": already late
  assert.equal(w.q.delayedOrders('2026-10-16')[0].daysLate, 2);
  assert.equal(w.q.inTransit().orderedNotReceived.lines[0].delayed, true);
  assert.equal(w.q.purchaseOrder(po.id).dateChanges[0].from, '2026-10-20');
});
