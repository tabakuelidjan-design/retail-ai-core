// The batched syncs must write exactly what the one-request-per-row code (669096b, kept as a test oracle in
// fixtures/sync-reference-669096b.js) wrote, over a production-sized input, while sending far fewer
// Supabase requests. Each scenario runs the oracle and the batched code on two identical databases, then
// compares the tables row for row and the returned summaries.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { MERCHANT_ID, seedVolumeCatalog, variantPages, orderPages, volumeShopify, countRequests } from './fixtures/sync-volume.js';
import { referenceSyncProductCosts, referenceSyncInventory, referenceSyncOrders } from './fixtures/sync-reference-669096b.js';
import { syncProductCosts } from '../src/sync/cost.js';
import { syncInventory } from '../src/sync/inventory.js';
import { syncOrders } from '../src/sync/orders.js';

const withoutIds = (rows) => rows.map(({ id, ...rest }) => rest);

async function twoDatabases() {
  const reference = createFakeSupabase();
  const batched = createFakeSupabase();
  await seedVolumeCatalog(reference);
  await seedVolumeCatalog(batched);
  return { reference, batched };
}

/** Runs the same sync step on both databases; returns both summaries and the batched run's request count. */
async function runBoth(dbs, referenceFn, batchedFn, { shopify = volumeShopify, ...opts }) {
  const referenceCount = countRequests(dbs.reference);
  const batchedCount = countRequests(dbs.batched);
  const referenceSummary = await referenceFn({ shopify: shopify(), supabase: referenceCount.client }, { merchantId: MERCHANT_ID, ...opts });
  const batchedSummary = await batchedFn({ shopify: shopify(), supabase: batchedCount.client }, { merchantId: MERCHANT_ID, ...opts });
  assert.deepEqual(batchedSummary, referenceSummary);
  return { before: referenceCount.counts.total, after: batchedCount.counts.total, byCall: batchedCount.counts.byCall };
}

function report(label, { before, after }) {
  console.log(`# ${label}: ${before} -> ${after} Supabase requests`);
}

// --- product costs ---

test('costs: first run, steady run, changed costs and a failed page write the same rows with far fewer requests', async () => {
  const dbs = await twoDatabases();
  const costRows = (db) => withoutIds(db._tables.get('product_costs') ?? []);

  const first = await runBoth(dbs, referenceSyncProductCosts, syncProductCosts, { now: new Date('2026-09-26T08:00:00Z') });
  assert.equal(costRows(dbs.batched).length, 283);
  assert.deepEqual(costRows(dbs.batched), costRows(dbs.reference));
  report('costs, first run (283 new rows)', first);
  assert.deepEqual(first.byCall, { 'select variants': 1, 'selectAll product_costs': 1, 'insert product_costs': 1 });

  const steady = await runBoth(dbs, referenceSyncProductCosts, syncProductCosts, { now: new Date('2026-09-26T08:15:00Z') });
  assert.deepEqual(costRows(dbs.batched), costRows(dbs.reference));
  report('costs, steady cycle (nothing changed)', steady);
  assert.equal(steady.before, 284);
  assert.equal(steady.after, 2);

  // Three costs change, one of them back to a value it had before: only the latest row counts.
  const changed = { 3: '99.00', 40: '1.00', 41: '2.75' };
  const changedShopify = () => volumeShopify({ variants: variantPages({ costOverrides: changed }) });
  await runBoth(dbs, referenceSyncProductCosts, syncProductCosts, { shopify: changedShopify, now: new Date('2026-09-26T09:00:00Z') });
  const revert = { ...changed, 3: `${(3 % 40) + 1}.50` };
  const revertShopify = () => volumeShopify({ variants: variantPages({ costOverrides: revert }) });
  const reverted = await runBoth(dbs, referenceSyncProductCosts, syncProductCosts, { shopify: revertShopify, now: new Date('2026-09-26T09:15:00Z') });
  assert.equal(reverted.byCall['insert product_costs'], 1);
  assert.deepEqual(costRows(dbs.batched), costRows(dbs.reference));
  assert.equal(costRows(dbs.batched).length, 283 + 3 + 1);

  // Shopify fails on page 4: the rows decided on pages 1-3 (variants 5, 40 and 41 - the last two back to their
  // original cost) are still written, exactly as before; variant 290 is never reached.
  const failing = () => volumeShopify({ variants: variantPages({ costOverrides: { 5: '0.10', 290: '0.20' } }), failAtCursor: 'v3' });
  await runBoth(dbs, referenceSyncProductCosts, syncProductCosts, { shopify: failing, now: new Date('2026-09-26T10:00:00Z') });
  assert.deepEqual(costRows(dbs.batched), costRows(dbs.reference));
  assert.equal(costRows(dbs.batched).length, 283 + 3 + 1 + 3);
});

test('costs: the latest row is chosen by effective_from, whatever order the history comes back in', async () => {
  const dbs = await twoDatabases();
  for (const db of [dbs.reference, dbs.batched]) {
    // Newest row inserted first: a "last row wins" reading would compare against the stale 1.50.
    await db.insert('product_costs', [
      { variant_id: 'var-1', merchant_id: MERCHANT_ID, unit_cost: 2.5, currency: 'EUR', effective_from: '2026-09-01T00:00:00.000Z', source: 'shopify_unit_cost', validation_status: 'unverified' },
      { variant_id: 'var-1', merchant_id: MERCHANT_ID, unit_cost: 1.5, currency: 'EUR', effective_from: '2026-08-01T00:00:00.000Z', source: 'shopify_unit_cost', validation_status: 'unverified' },
      { variant_id: 'var-2', merchant_id: MERCHANT_ID, unit_cost: 3.5, currency: 'EUR', effective_from: '2026-08-01T00:00:00.000Z', source: 'shopify_unit_cost', validation_status: 'unverified' },
      { variant_id: 'var-2', merchant_id: MERCHANT_ID, unit_cost: 3.5, currency: 'EUR', effective_from: '2026-09-01T00:00:00.000Z', source: 'manual_entry', validation_status: 'verified' },
    ]);
  }
  await runBoth(dbs, referenceSyncProductCosts, syncProductCosts, { now: new Date('2026-09-26T08:00:00Z') });
  const rows = withoutIds(dbs.batched._tables.get('product_costs'));
  assert.deepEqual(rows, withoutIds(dbs.reference._tables.get('product_costs')));
  // var-1 (2.50 latest, unchanged) gets no row; var-2's latest is a manual entry, so a Shopify row is written.
  assert.equal(rows.filter((r) => r.variant_id === 'var-1').length, 2);
  assert.equal(rows.filter((r) => r.variant_id === 'var-2').length, 3);
});

test('costs: another merchant\'s history is never read', async () => {
  const supabase = createFakeSupabase();
  await seedVolumeCatalog(supabase);
  await supabase.insert('product_costs', [
    { variant_id: 'var-1', merchant_id: 'other-merchant', unit_cost: 2.5, currency: 'EUR', effective_from: '2026-09-01T00:00:00.000Z', source: 'shopify_unit_cost', validation_status: 'unverified' },
  ]);
  const summary = await syncProductCosts({ shopify: volumeShopify(), supabase }, { merchantId: MERCHANT_ID, now: new Date('2026-09-26T08:00:00Z') });
  assert.equal(summary.newCostRows, 283); // var-1's 2.50 belongs to another merchant: it does not count as history
});

// --- inventory snapshots ---

const snapshotRows = (db) => withoutIds(db._tables.get('inventory_snapshots') ?? []);

test('inventory: same snapshots as before across local-day boundaries, DST, gaps and a failed page', async () => {
  const dbs = await twoDatabases();
  const timeZone = 'Europe/Brussels';
  const run = async (iso, extra = {}) => {
    const r = await runBoth(dbs, referenceSyncInventory, syncInventory, { now: new Date(iso), timeZone, ...extra });
    assert.deepEqual(snapshotRows(dbs.batched), snapshotRows(dbs.reference), `after run at ${iso}`);
    return r;
  };

  const first = await run('2026-09-26T06:00:00Z');
  assert.equal(snapshotRows(dbs.batched).length, 344);
  report('inventory, first cycle of the day (344 snapshots)', first);
  assert.deepEqual(first.byCall, { 'select variants': 1, 'select locations': 1, 'selectAll inventory_snapshots': 1, 'insert inventory_snapshots': 1 });

  const steady = await run('2026-09-26T06:15:00Z');
  report('inventory, later cycle same day (nothing to write)', steady);
  assert.equal(steady.before, 346);
  assert.equal(steady.after, 3);

  const moved = (shift) => () => volumeShopify({ variants: variantPages({ quantityShift: shift }) });
  await run('2026-09-26T21:59:00Z', { shopify: moved(1) }); // 23:59 in Brussels: still the same local day
  await run('2026-09-26T22:01:00Z', { shopify: moved(2) }); // 00:01 on the 27th in Brussels: new snapshots
  assert.equal(snapshotRows(dbs.batched).length, 344 * 2);
  await run('2026-09-30T08:00:00Z', { shopify: moved(3) }); // after a gap longer than the lookback window
  assert.equal(snapshotRows(dbs.batched).length, 344 * 3);

  // DST ends on 2026-10-25 in Brussels: that local day lasts 25 h.
  await run('2026-10-24T22:30:00Z'); // 00:30 CEST on the 25th
  await run('2026-10-25T22:30:00Z'); // 23:30 CET on the 25th - same local day, nothing written
  assert.equal(snapshotRows(dbs.batched).length, 344 * 4);

  // Shopify fails on page 4: the snapshots decided on pages 1-3 are still written.
  await run('2026-10-27T08:00:00Z', { shopify: () => volumeShopify({ failAtCursor: 'v3' }) });
  assert.ok(snapshotRows(dbs.batched).length > 344 * 4);
});

test('inventory: a snapshot dated after now (clock skew) is still the latest one, as before', async () => {
  const dbs = await twoDatabases();
  for (const db of [dbs.reference, dbs.batched]) {
    await db.insert('inventory_snapshots', [
      { variant_id: 'var-6', location_id: 'loc-2', quantity: 1, synced_at: '2026-09-27T06:00:00.000Z', merchant_id: MERCHANT_ID }, // tomorrow
      { variant_id: 'var-6', location_id: 'loc-1', quantity: 1, synced_at: '2026-09-26T05:00:00.000Z', merchant_id: MERCHANT_ID }, // today
      { variant_id: 'var-12', location_id: 'loc-1', quantity: 1, synced_at: '2026-09-16T05:00:00.000Z', merchant_id: MERCHANT_ID }, // long ago
      { variant_id: 'var-18', location_id: 'loc-1', quantity: 1, synced_at: '2026-09-26T05:00:00.000Z', merchant_id: 'other-merchant' },
    ]);
  }
  const { after } = await runBoth(dbs, referenceSyncInventory, syncInventory, { now: new Date('2026-09-26T08:00:00Z') });
  assert.deepEqual(snapshotRows(dbs.batched), snapshotRows(dbs.reference));
  assert.equal(snapshotRows(dbs.batched).length, 4 + 343); // only var-6 / loc-1 already has today's snapshot
  assert.equal(after, 4);
});

test('inventory: the read stays one request however much history accumulates', async () => {
  const supabase = createFakeSupabase();
  await seedVolumeCatalog(supabase);
  for (let day = 1; day <= 5; day += 1) {
    await syncInventory({ shopify: volumeShopify(), supabase }, { merchantId: MERCHANT_ID, now: new Date(Date.UTC(2026, 8, day, 8)), timeZone: 'Europe/Brussels' });
  }
  assert.equal(snapshotRows(supabase).length, 344 * 5); // 1,720 rows: two pages if the whole history were read
  const { client, counts } = countRequests(supabase);
  await syncInventory({ shopify: volumeShopify(), supabase: client }, { merchantId: MERCHANT_ID, now: new Date('2026-09-05T08:15:00Z'), timeZone: 'Europe/Brussels' });
  assert.equal(counts.byCall['selectAll inventory_snapshots'], 1); // only the last 48 h (688 rows) are read
  assert.equal(counts.total, 3);
});

// --- orders, lines, visits, refunds, refund lines ---

/**
 * The order tables with every generated id replaced by the natural key of the row it points to: the batched
 * code inserts rows in a different order than the one-by-one code, so the generated ids differ by design.
 */
function orderTables(db) {
  const t = (name) => db._tables.get(name) ?? [];
  const orderKey = new Map(t('orders').map((o) => [o.id, o.source_id]));
  const lineKey = new Map(t('order_lines').map((l) => [l.id, `${orderKey.get(l.order_id)}|${l.source_id}`]));
  const refundKey = new Map(t('refunds').map((r) => [r.id, `${orderKey.get(r.order_id)}|${r.source_id}`]));
  const sorted = (rows) => rows.map((r) => JSON.stringify(r)).sort();
  return {
    orders: sorted(withoutIds(t('orders'))),
    order_attribution: sorted(withoutIds(t('order_attribution')).map((r) => ({ ...r, order_id: orderKey.get(r.order_id) }))),
    order_lines: sorted(withoutIds(t('order_lines')).map((r) => ({ ...r, order_id: orderKey.get(r.order_id) }))),
    refunds: sorted(withoutIds(t('refunds')).map((r) => ({ ...r, order_id: orderKey.get(r.order_id) }))),
    refund_lines: sorted(withoutIds(t('refund_lines')).map((r) => ({ ...r, refund_id: refundKey.get(r.refund_id), order_line_id: lineKey.get(r.order_line_id) }))),
  };
}

test('orders: same orders, lines, visits, refunds and refund lines as before, with far fewer requests', async () => {
  const dbs = await twoDatabases();
  const now = new Date('2026-09-26T08:00:00Z');
  const run = async (extra = {}) => {
    const r = await runBoth(dbs, referenceSyncOrders, syncOrders, { now, ...extra });
    assert.deepEqual(orderTables(dbs.batched), orderTables(dbs.reference));
    return r;
  };

  const first = await run();
  const tables = orderTables(dbs.batched);
  assert.equal(tables.orders.length, 80);
  assert.equal(tables.order_lines.length, 100);
  assert.equal(tables.refunds.length, 9);
  assert.equal(tables.refund_lines.length, 9); // 10 refund lines: two on one order line collapse to the last, one has no line
  assert.ok(tables.order_attribution.length > 0);
  report('orders, one cycle (80 orders, 100 lines)', first);
  assert.equal(first.before, 212);
  assert.equal(first.after, 2 + 4 * 5); // 2 lookups + 4 pages x (orders, visits, lines, refunds, refund lines)

  await run(); // steady cycle: same input again, nothing duplicated
  await run({ shopify: () => volumeShopify({ orders: orderPages({ refundAmountShift: 3 }) }) }); // refunds updated in place
  await run({ customerKeySecret: 'x'.repeat(64) }); // customer_key column appears on every order
  await run({ shopify: () => volumeShopify({ orders: orderPages({ refundAmountShift: 5 }), failAtCursor: 'o2' }) }); // Shopify fails on page 3
});

test('orders: rows with different columns never share a request (PostgREST would write NULL into the missing ones)', async () => {
  const { upsertInChunks } = await import('../src/sync/batch.js');
  const supabase = createFakeSupabase();
  const { client, counts } = countRequests(supabase);
  await upsertInChunks(client, 'orders', [
    { merchant_id: 'm', source_system: 's', source_id: '1', status: 'PAID' },
    { merchant_id: 'm', source_system: 's', source_id: '2', status: 'PAID', customer_key: 'k' },
    { merchant_id: 'm', source_system: 's', source_id: '1', status: 'REFUNDED' }, // same order again: the last row wins
  ], { onConflict: 'merchant_id,source_system,source_id' });
  assert.equal(counts.total, 2);
  assert.deepEqual(supabase._tables.get('orders').map(({ id, ...r }) => r), [
    { merchant_id: 'm', source_system: 's', source_id: '1', status: 'REFUNDED' },
    { merchant_id: 'm', source_system: 's', source_id: '2', status: 'PAID', customer_key: 'k' },
  ]);
});
