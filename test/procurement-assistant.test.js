import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeWorld, orderedPo, receive, buyer, wh, key } from './procurement-fixtures.js';

test('every assistant tool, called with any arguments, changes nothing', async () => {
  const w = await makeWorld();
  const po = await orderedPo(w, { qty: 200 });
  await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 50 }]);
  const before = JSON.stringify(w.store.snapshot());
  const a = w.proc.assistant;
  const args = [{}, { sku: 'MAG-001' }, { sku: 'MAG-001', qty: 100 }, { supplierId: w.supplier.id, sku: 'MAG-001', lines: [{ sku: 'MAG-001', qty: 150 }] }, { poId: po.id }, { sku: 'MAG-001', locationId: w.locs.warehouse.id, delta: -5, reason: 'broken' }, { text: 'aimant' }, { status: 'ORDERED' }, null];
  for (const t of a.catalog) for (const x of args) a.call(t.name, x ?? undefined);
  assert.equal(JSON.stringify(w.store.snapshot()), before, 'no tool wrote anything');
  assert.ok(a.catalog.length >= 12);
  assert.ok(a.catalog.every((t) => ['READ_ONLY', 'PROPOSE_ONLY'].includes(t.authority)), 'no tool has execute authority');
});

test('the assistant is built from the read side only: it holds no command service, store or approval', () => {
  const src = readFileSync(new URL('../src/procurement/assistant.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./errors.js', './service.js', './util.js'].sort(), 'only pure helpers are imported (resolveTierPrice, errors, util)');
  assert.doesNotMatch(src, /\b(commands|store\.|createProcurementService|approval\b.*consume|appendMovement|insert\()/);
});

test('ambiguous or incomplete requests ask for clarification and never act', async () => {
  const w = await makeWorld();
  await w.mk(w.c.createItem, buyer, { sku: 'MAG-003', name: 'Aimant rond XL' });
  const a = w.proc.assistant;
  assert.equal(a.call('find_item', { text: 'aimant rond' }).status, 'AMBIGUOUS');
  assert.equal(a.call('find_item', { text: '5400000000011' }).status, 'OK');
  const s = a.call('stock_position', { sku: 'aimant' });
  assert.equal(s.status, 'NEED_CLARIFICATION'); assert.equal(s.executed, false); assert.ok(s.candidates.length >= 2);
  assert.equal(a.call('propose_stock_adjustment', { sku: 'MAG-001' }).status, 'NEED_CLARIFICATION');
  assert.equal(a.call('propose_purchase_order', { supplierId: w.supplier.id }).status, 'NEED_CLARIFICATION');
  assert.equal(a.call('buy_now', { sku: 'MAG-001', qty: 1000 }).status, 'UNKNOWN_TOOL');
  assert.equal(a.call('pay_supplier', {}).executed, false);
});

test('proposals describe the action and the approval it needs, with executed:false', async () => {
  const w = await makeWorld();
  const po = await orderedPo(w, { qty: 100 });
  await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 10 }]);
  const a = w.proc.assistant;
  const p = a.call('propose_purchase_order', { supplierId: w.supplier.id, lines: [{ sku: 'MAG-001', qty: 150 }] });
  assert.equal(p.status, 'PROPOSED'); assert.equal(p.executed, false); assert.equal(p.lines[0].unitPrice, '0.5');
  assert.ok(p.requires_approval.includes('BUYING.place_order'));
  const low = a.call('propose_purchase_order', { supplierId: w.supplier.id, lines: [{ sku: 'MAG-001', qty: 20 }] });
  assert.equal(low.status, 'PROPOSAL_HAS_ISSUES'); assert.equal(low.lines[0].code, 'BELOW_MOQ');
  const adj = a.call('propose_stock_adjustment', { sku: 'MAG-001', locationId: w.locs.warehouse.id, delta: -50, reason: 'inventory loss' });
  assert.equal(adj.status, 'WOULD_BE_REFUSED'); assert.equal(adj.code, 'INSUFFICIENT_STOCK'); assert.equal(adj.executed, false);
  const ok = a.call('propose_stock_adjustment', { sku: 'MAG-001', locationId: w.locs.warehouse.id, delta: -3, reason: 'inventory loss' });
  assert.equal(ok.status, 'PROPOSED'); assert.deepEqual(ok.requires_approval, ['STOCK_SALES.adjust_on_hand']);
  assert.equal(w.q.stockPosition(w.itemA.id).available, 10, 'nothing happened');
});

test('the questions the mandate names can be answered from the data', async () => {
  const w = await makeWorld();
  const eur = (await w.mk(w.c.createSupplier, buyer, { name: 'Lyon Goodies', currency: 'EUR' })).supplier;
  await w.mk(w.c.recordQuote, buyer, { supplierId: eur.id, itemId: w.itemA.id, currency: 'EUR', tiers: [{ minQty: 50, unitPrice: '0.52' }], moq: 50 });
  await orderedPo(w, { qty: 200 });
  const a = w.proc.assistant;
  const best = a.call('best_landed_cost_supplier', { sku: 'MAG-001', qty: 200, fx: { USD: { rate: '0.90', date: '2026-10-15', source: 'ECB reference' } } });
  assert.equal(best.status, 'OK'); assert.equal(best.comparison.ranking.length, 2);
  const transit = a.call('goods_in_transit', {});
  assert.equal(transit.orderedNotReceived.units, 200);
  assert.equal(a.call('open_purchase_orders', { status: 'ORDERED' }).orders.length, 1);
  assert.equal(a.call('supplier_reliability', { supplierId: w.supplier.id }).metrics.onTimeReceipts.status, 'NOT_MEASURABLE');
  assert.equal(a.call('price_history', { supplierId: w.supplier.id, sku: 'MAG-001' }).history.length, 1);
});
