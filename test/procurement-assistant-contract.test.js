// The contract of the 11 Stock / Achats tools that Parle à Nordla reads (src/core-pilot/procurement-*.js): names, authority, status and the exact top-level keys of every answer.
// Frozen on purpose: V1 adds routes, screens and permissions around the module, and none of it may change what Parle reads. A change here is a change of contract: coordinate with the
// Parle à Nordla workstream FIRST. (Adding a tool or a key elsewhere is fine; removing or renaming one of these is not.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, orderedPo, receive } from './procurement-fixtures.js';

const READ_BY_PARLE = {
  find_item: 'OK|authority,candidates,status,tool',
  find_supplier: 'OK|authority,candidates,status,tool',
  stock_position: 'OK|authority,position,status,tool',
  stock_overview: 'OK|authority,positions,status,tool,valuation',
  goods_in_transit: 'OK|authority,inTransitLocationUnits,orderedNotReceived,status,tool',
  open_purchase_orders: 'OK|authority,orders,status,tool',
  delayed_orders: 'OK|authority,delayed,status,tool',
  reorder_alerts: 'OK|alerts,authority,status,tool',
  best_landed_cost_supplier: 'OK|authority,comparison,status,tool',
  expiring_supplier_documents: 'OK|authority,documents,status,tool',
  supplier_reliability: 'OK|authority,metrics,status,tool',
};

test('the 11 tools Parle à Nordla reads still exist, are READ_ONLY and answer with exactly the same keys', async () => {
  const w = await makeWorld(); const po = await orderedPo(w, { qty: 100 }); await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 40 }]);
  const a = w.proc.assistant; const sku = w.itemA.sku;
  const args = { find_item: { text: sku }, find_supplier: { text: w.supplier.name }, stock_position: { sku }, best_landed_cost_supplier: { sku, qty: 100 }, supplier_reliability: { supplierId: w.supplier.id } };
  const byName = new Map(a.catalog.map((t) => [t.name, t]));
  for (const [name, shape] of Object.entries(READ_BY_PARLE)) {
    assert.equal(byName.get(name)?.authority, 'READ_ONLY', `${name} must stay a READ_ONLY tool`);
    const r = await a.call(name, args[name] ?? {});
    assert.equal(`${r.status}|${Object.keys(r).sort().join(',')}`, shape, name);
  }
  assert.equal(Object.keys((await a.call('stock_position', { sku })).position).sort().join(','), 'available,inTransit,incoming,itemId,locations,physical,quarantine,reserved,sellable,sku,valuation');
  assert.equal(Object.keys((await a.call('find_supplier', { text: w.supplier.name })).candidates[0]).sort().join(','), 'country,currency,incotermDefault,leadTimeDays,name,supplierId', 'find_supplier exposes identity and default terms only: no contact, no IBAN');
});

test('the V1 additions did not touch what Parle reads: a filed stock change, a transfer and an approved adjustment show up in the position exactly as plain movements', async () => {
  const w = await makeWorld(); const po = await orderedPo(w, { qty: 100 }); await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 100 }]);
  const A = w.itemA.id; const W = w.locs.warehouse.id; const S = w.locs.store.id; const owner = { id: 'u-owner', role: 'OWNER' }; const wh = { id: 'u-wh', role: 'WAREHOUSE' };
  const { request } = await w.c.requestStockChange(wh, 'contract-req-1', { type: 'ADJUST', itemId: A, locationId: W, delta: -5, reason: 'five damaged, found at the shelf' });
  assert.equal((await w.proc.assistant.call('stock_position', { sku: w.itemA.sku })).position.physical, 100, 'a pending request is not stock movement');
  await w.c.decideStockChange(owner, 'contract-dec-1', { requestId: request.requestId, decision: 'APPROVE', approval: { id: 'contract-ap-1', action: 'STOCK_SALES.adjust_on_hand', subject_ref: `nordla:product:${A}@${W}`, approver: { kind: 'HUMAN', id: 'elidjan', role: 'OWNER' }, approved_at: '2026-10-16T10:00:00.000Z' } });
  await w.c.transferStock(wh, 'contract-tr-1', { itemId: A, fromLocationId: W, toLocationId: S, qty: 10 });
  const p = (await w.proc.assistant.call('stock_position', { sku: w.itemA.sku })).position;
  assert.deepEqual([p.physical, p.sellable, p.available], [95, 95, 95]); assert.deepEqual(p.locations.map((l) => [l.type, l.onHand]).sort(), [['STORE', 10], ['WAREHOUSE', 85]]);
});
