// Network faults and real concurrency against PostgreSQL. Runs only with PROCUREMENT_STORE=pg (test/postgres/procurement-parity.mjs); skipped on the memory store,
// because only a real database can lose a connection or race two sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE_KIND, pgPool, makeWorld, orderedPo, receive, rejects, approval, productApproval, key, buyer, wh } from './procurement-fixtures.js';
import { createPgProcurementStore, StoreError } from '../src/procurement/index.js';

const skip = STORE_KIND !== 'pg' ? 'needs PROCUREMENT_STORE=pg (real PostgreSQL)' : false;

/** A pool that fails on demand: refused connections, a connection dropped at BEGIN, a COMMIT that lands but whose acknowledgement is lost. */
function faultyPool(real, plan) {
  const reset = () => Object.assign(new Error('Connection terminated unexpectedly'), { code: undefined });
  return {
    query: (t, p) => real.query(t, p),
    async connect() {
      if (plan.failConnect > 0) { plan.failConnect -= 1; throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }); }
      const c = await real.connect();
      return {
        async query(text, params) {
          if (text === 'begin' && plan.failBegin > 0) { plan.failBegin -= 1; throw reset(); }
          if (text === 'commit' && plan.ackLost > 0) { plan.ackLost -= 1; await c.query('commit'); throw reset(); }
          return c.query(text, params);
        },
        release: () => c.release(),
      };
    },
  };
}
const faulty = async () => {
  const plan = { failConnect: 0, failBegin: 0, ackLost: 0 };
  const store = createPgProcurementStore({ pool: faultyPool(pgPool(), plan) });
  const w = await makeWorld({ store });
  return { w, plan };
};

test('a refused connection is retried with the same key and takes effect exactly once', { skip }, async () => {
  const { w, plan } = await faulty();
  plan.failConnect = 2;
  const r = await w.c.createItem(buyer, key(), { sku: 'NET-1', name: 'after two refused connections' });
  assert.equal(r.replayed, false); assert.equal((await w.q.items()).filter((i) => i.sku === 'NET-1').length, 1);
});

test('a connection dropped at BEGIN is retried and takes effect once', { skip }, async () => {
  const { w, plan } = await faulty();
  plan.failBegin = 1;
  await w.c.createItem(buyer, key(), { sku: 'NET-2', name: 'dropped at begin' });
  assert.equal((await w.q.items()).filter((i) => i.sku === 'NET-2').length, 1);
});

test('a database that stays down fails with STORE_UNAVAILABLE and leaves nothing behind', { skip }, async () => {
  const { w, plan } = await faulty();
  plan.failConnect = 99;
  const e = await rejects(w.c.createItem(buyer, key(), { sku: 'NET-3', name: 'never written' }), 'STORE_UNAVAILABLE');
  assert.ok(e.message);
  plan.failConnect = 0;
  assert.equal((await w.q.items()).filter((i) => i.sku === 'NET-3').length, 0);
});

test('a COMMIT that landed but whose acknowledgement was lost is NOT repeated: the retry replays the stored result', { skip }, async () => {
  const { w, plan } = await faulty();
  plan.ackLost = 1;
  const r = await w.c.createItem(buyer, key(), { sku: 'NET-4', name: 'ack lost' });
  assert.equal(r.replayed, true, 'the first attempt had committed: the second one found its result');
  assert.equal((await w.q.items()).filter((i) => i.sku === 'NET-4').length, 1);
  assert.equal((await w.q.events({})).filter((e) => e.type === 'ITEM_CREATED' && e.detail.sku === 'NET-4').length, 1, 'one audit event, not two');
});

test('a goods receipt whose COMMIT acknowledgement is lost does not double the stock', { skip }, async () => {
  const { w, plan } = await faulty();
  const po = await orderedPo(w, { qty: 50 });
  plan.ackLost = 1;
  const r = await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 30 }]);
  assert.equal(r.replayed, true);
  assert.equal((await w.q.stockPosition(w.itemA.id)).available, 30);
  assert.equal((await w.q.purchaseOrder(po.id)).lines[0].qtyReceived, 30);
});

test('two concurrent identical commands: one runs, the other waits and replays (advisory lock on the key)', { skip }, async () => {
  const w = await makeWorld();
  const k = key('same'); const payload = { sku: 'RACE-1', name: 'raced' };
  const [a, b] = await Promise.all([w.c.createItem(buyer, k, payload), w.c.createItem(buyer, k, payload)]);
  assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
  assert.equal(a.item.id, b.item.id);
  assert.equal((await w.q.items()).filter((i) => i.sku === 'RACE-1').length, 1);
});

test('two concurrent withdrawals of 6 from 6: exactly one wins, the balance ends at 0 (database rule, mapped to a stable code)', { skip }, async () => {
  const w = await makeWorld();
  const po = await orderedPo(w, { qty: 10 });
  await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 6 }]);
  const A = w.itemA.id; const W = w.locs.warehouse.id;
  const take = () => w.c.adjustStock(wh, key(), { itemId: A, locationId: W, delta: -6, reason: 'racing withdrawal of six units', approval: productApproval('STOCK_SALES.adjust_on_hand', `${A}@${W}`) });
  const r = await Promise.allSettled([take(), take()]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(r.find((x) => x.status === 'rejected').reason.code, 'INSUFFICIENT_STOCK');
  assert.equal((await w.q.stockPosition(A)).physical, 0);
});

test('the database itself refuses what the service would have refused (a bypass attempt through the store)', { skip }, async () => {
  const w = await makeWorld();
  const mv = (over) => ({ id: w.store.newId(), merchantId: w.merchantId, idempotencyKey: key('bypass'), groupId: null, at: '2026-10-16T10:00:00.000Z', itemId: w.itemA.id, locationId: w.locs.warehouse.id, bucket: 'ON_HAND', delta: 5, kind: 'ADJUSTMENT', reason: 'x', reference: null, costStatus: 'UNKNOWN', unitCostEurMicro: null, actorId: 'u', approvalId: null, ...over });
  await rejects(w.store.transaction((tx) => tx.appendMovement(mv({ delta: -5 }))), 'INSUFFICIENT_STOCK');
  await w.store.transaction((tx) => tx.appendMovement(mv({ delta: 5 })));
  await rejects(w.store.transaction((tx) => tx.appendMovement(mv({ bucket: 'RESERVED', delta: 6, kind: 'RESERVE' }))), 'RESERVED_STOCK');
  await rejects(w.store.transaction((tx) => tx.appendMovement(mv({ delta: 1, idempotencyKey: 'dup-key' })).then(() => tx.appendMovement(mv({ delta: 1, idempotencyKey: 'dup-key' })))), 'UNIQUE_VIOLATION');
  assert.equal((await w.store.balanceOf(w.merchantId, w.itemA.id, w.locs.warehouse.id)).onHand, 5, 'every refused attempt rolled back');
});

test('an approval is single-use even under concurrency', { skip }, async () => {
  const w = await makeWorld();
  const id = key('ap');
  const use = () => w.store.transaction((tx) => tx.consumeApproval(w.merchantId, id));
  const r = await Promise.allSettled([use(), use(), use()]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.ok(r.filter((x) => x.status === 'rejected').every((x) => x.reason instanceof StoreError && x.reason.code === 'APPROVAL_ALREADY_USED'));
});

test('concurrent receipts on one order serialise on the order row: the ordered quantity is never exceeded', { skip }, async () => {
  const w = await makeWorld();
  const po = await orderedPo(w, { qty: 10 });
  const r = await Promise.allSettled(Array.from({ length: 6 }, () => receive(w, po, [{ poLineId: 'L1', qtyAccepted: 3 }])));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 3);
  assert.ok(r.filter((x) => x.status === 'rejected').every((x) => ['OVER_RECEIPT', 'INVALID_TRANSITION'].includes(x.reason.code)), JSON.stringify(r.filter((x) => x.status === 'rejected').map((x) => x.reason.code)));
  assert.equal((await w.q.purchaseOrder(po.id)).lines[0].qtyReceived, 9);
  assert.equal((await w.q.stockPosition(w.itemA.id)).physical, 9);
});

test('parallel orders for the same item get distinct, gapless numbers', { skip }, async () => {
  const w = await makeWorld();
  const mk = () => w.c.createPurchaseOrder(buyer, key(), { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-11-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty: 100, quoteId: w.quote.id }] });
  const all = await Promise.all(Array.from({ length: 6 }, mk));
  const nums = all.map((x) => x.purchaseOrder.number).sort();
  assert.deepEqual(nums, ['PO-2026-0001', 'PO-2026-0002', 'PO-2026-0003', 'PO-2026-0004', 'PO-2026-0005', 'PO-2026-0006']);
});
