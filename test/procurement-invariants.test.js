import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, productApproval, approval, key, wh, buyer, owner } from './procurement-fixtures.js';
import { balancesFrom } from '../src/procurement/stock.js';
import { lineTotalMinor, microOf, microToString, shareMinor, pctToBps } from '../src/procurement/util.js';

// mulberry32: a fixed seed makes any failure reproducible
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

function checkLedger(w, label) {
  const mvs = w.store.listMovements(w.merchantId);
  for (const b of balancesFrom(mvs).values()) {
    assert.ok(b.onHand >= 0, `${label}: negative on-hand ${JSON.stringify(b)}`);
    assert.ok(b.reserved >= 0, `${label}: negative reserved ${JSON.stringify(b)}`);
    assert.ok(b.reserved <= b.onHand, `${label}: reserved above on-hand ${JSON.stringify(b)}`);
  }
  assert.equal(new Set(mvs.map((m) => m.id)).size, mvs.length, `${label}: movement ids are unique`);
  assert.equal(new Set(mvs.map((m) => m.idempotencyKey)).size, mvs.length, `${label}: movement idempotency keys are unique`);
  assert.ok(mvs.every((m) => Number.isInteger(m.delta) && m.delta !== 0), `${label}: every movement is a non-zero integer`);
  // groups (transfers, quarantines) net to zero on-hand
  const groups = new Map();
  for (const m of mvs) if (m.groupId && /^(TRANSFER|DEFECT_QUARANTINE)/.test(m.kind)) groups.set(m.groupId, (groups.get(m.groupId) ?? 0) + m.delta);
  for (const [g, sum] of groups) assert.equal(sum, 0, `${label}: group ${g} does not net to zero`);
  // order lines agree with the ledger: received = sum of RECEIPT movements for that line, and never above ordered
  for (const po of w.q.purchaseOrders()) for (const l of po.lines) {
    const got = mvs.filter((m) => m.kind === 'RECEIPT' && m.reference?.id === po.id && m.reference.lineId === l.id).reduce((s, m) => s + m.delta, 0);
    assert.equal(l.qtyReceived, got, `${label}: ${po.number}/${l.id} received quantity disagrees with the ledger`);
    assert.ok(l.qtyReceived <= l.qty, `${label}: over-received`);
  }
}

test('random operations, valid and invalid, never break a ledger invariant', async () => {
  const w = await makeWorld();
  const r = rng(20261016);
  const A = w.itemA.id; const B = w.itemB.id; const L = Object.values(w.locs).map((l) => l.id);
  const sellable = [w.locs.store.id, w.locs.warehouse.id];
  const pos = [];
  for (let i = 0; i < 3; i++) {
    const { purchaseOrder: po } = await w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-12-01', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: A, qty: 100 + i * 50, quoteId: w.quote.id }, { itemId: B, qty: 30, unitPrice: '0.9' }] });
    await w.mk(w.c.submitPurchaseOrder, buyer, { poId: po.id });
    await w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id) });
    await w.mk(w.c.placeOrder, buyer, { poId: po.id, approval: approval('BUYING.place_order', po.id) });
    pos.push(po);
  }
  const pick = (a) => a[Math.floor(r() * a.length)];
  const qty = (m) => 1 + Math.floor(r() * m);
  let accepted = 0; let refused = 0;
  for (let step = 0; step < 400; step++) {
    const item = pick([A, B]); const kind = Math.floor(r() * 7);
    const attempt = async () => {
      if (kind === 0) { const po = pick(pos); const lineId = item === A ? 'L1' : 'L2'; const cur = w.q.purchaseOrder(po.id); await w.c.receiveGoods(wh, key(), { poId: po.id, receivedAt: '2026-11-20', lines: [{ poLineId: lineId, qtyAccepted: qty(80), qtyDefective: r() < 0.3 ? qty(3) : 0 }], quarantineLocationId: w.locs.quarantine.id, approval: approval('STOCK_SALES.receive_goods', cur.id) }); }
      else if (kind === 1) { const loc = pick(L); await w.c.adjustStock(wh, key(), { itemId: item, locationId: loc, delta: (r() < 0.5 ? -1 : 1) * qty(40), reason: 'random adjustment for the invariant test', approval: productApproval('STOCK_SALES.adjust_on_hand', `${item}@${loc}`) }); }
      else if (kind === 2) await w.c.transferStock(wh, key(), { itemId: item, fromLocationId: pick(L), toLocationId: pick(L), qty: qty(60) });
      else if (kind === 3) await w.c.reserveStock(wh, key(), { itemId: item, locationId: pick(sellable), qty: qty(30), reference: { type: 'order', id: `o-${step}` } });
      else if (kind === 4) await w.c.releaseStock(wh, key(), { itemId: item, locationId: pick(sellable), qty: qty(30), reference: { type: 'order', id: `o-${step}` } });
      else if (kind === 5) await w.c.quarantineDefect(wh, key(), { itemId: item, fromLocationId: pick(sellable), quarantineLocationId: w.locs.quarantine.id, qty: qty(10), reason: 'random defect found on shelf' });
      else { const loc = pick(sellable); const cur = balancesFrom(w.store.listMovements(w.merchantId)).get(`${item}|${loc}`)?.onHand ?? 0; const countId = key('c'); await w.c.recordCount(wh, key(), { locationId: loc, countId, counts: [{ itemId: item, counted: Math.max(0, cur + Math.floor(r() * 7) - 3), reason: 'random count variance' }], approval: productApproval('STOCK_SALES.adjust_on_hand', `count:${countId}`) }); }
    };
    try { await attempt(); accepted++; } catch (e) {
      assert.ok(e.code && e.name === 'ProcurementError', `step ${step}: a refusal must be a coded ProcurementError, got ${e.stack}`);
      refused++;
    }
    checkLedger(w, `step ${step}`);
  }
  assert.ok(accepted > 60 && refused > 40, `the run exercised both paths (accepted ${accepted}, refused ${refused})`);
  // read side agrees with the ledger
  for (const id of [A, B]) {
    const p = w.q.stockPosition(id);
    const sum = w.store.listMovements(w.merchantId, { itemId: id }).filter((m) => m.bucket === 'ON_HAND' && w.q.locations().find((l) => l.id === m.locationId).type !== 'TRANSIT').reduce((s, m) => s + m.delta, 0);
    assert.equal(p.physical, sum);
    assert.equal(p.available, p.sellable - p.reserved);
  }
});

test('the ledger offers no way to change history', async () => {
  const w = await makeWorld();
  assert.equal(typeof w.store.updateMovement, 'undefined'); assert.equal(typeof w.store.deleteMovement, 'undefined');
  assert.throws(() => w.store.update('movements', w.merchantId, 'x', {}, 1), /never updated/);
  assert.throws(() => w.store.update('receipts', w.merchantId, 'x', {}, 1), /never updated/);
  const po = (await import('./procurement-fixtures.js')).orderedPo;
  await po(w, { qty: 100 });
  const view = w.store.listMovements(w.merchantId); view.push({ fake: true });
  assert.equal(w.store.listMovements(w.merchantId).length, 0, 'a caller cannot mutate the store through what it read');
  const out = w.q.purchaseOrder(w.q.purchaseOrders()[0].id);
  out.status = 'RECEIVED';
  assert.equal(w.q.purchaseOrders()[0].status, 'ORDERED');
});

test('money arithmetic is exact: micro prices, rounding half away from zero, shares that add up', () => {
  assert.equal(microOf('0.035'), 35000); assert.equal(microToString(35000), '0.035'); assert.equal(microToString(500000), '0.5'); assert.equal(microToString(2000000), '2.0');
  assert.equal(lineTotalMinor(1000, 35000), 3500); // 1000 x 0.035 = 35.00
  assert.equal(lineTotalMinor(1, 5000), 1); // 0.005 -> rounds up to 0.01
  assert.equal(lineTotalMinor(1, 4999), 0);
  assert.equal(lineTotalMinor(3, 333333), 100); // 0.999999 -> 1.00
  for (const bad of ['0', '-1', '1.2345678', 'abc', '', 1.5, null, undefined, '1e3']) assert.throws(() => microOf(bad), /INVALID|must/, String(bad));
  assert.equal(pctToBps('12.5'), 1250); assert.throws(() => pctToBps('100.01')); assert.throws(() => pctToBps('120'));
  // a deposit and its balance always add up to the total, whatever the rounding
  const r = rng(7);
  for (let i = 0; i < 2000; i++) {
    const total = 1 + Math.floor(r() * 5e7); const bps = Math.floor(r() * 10001);
    const dep = shareMinor(total, bps);
    assert.ok(dep >= 0 && dep <= total);
    assert.equal(dep + (total - dep), total);
  }
  // line totals equal the exact rational value rounded once
  for (let i = 0; i < 2000; i++) {
    const q = 1 + Math.floor(r() * 1e5); const m = 1 + Math.floor(r() * 5e6);
    const exact = (BigInt(q) * BigInt(m) * 2n + 10000n) / 20000n;
    assert.equal(BigInt(lineTotalMinor(q, m)), exact);
  }
});
