// The batched syncs must write exactly what the one-request-per-row code (669096b, kept as a test oracle in
// fixtures/sync-reference-669096b.js) wrote, over a production-sized input, while sending far fewer
// Supabase requests. Each scenario runs the oracle and the batched code on two identical databases, then
// compares the tables row for row and the returned summaries.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { MERCHANT_ID, seedVolumeCatalog, variantPages, volumeShopify, countRequests } from './fixtures/sync-volume.js';
import { referenceSyncProductCosts } from './fixtures/sync-reference-669096b.js';
import { syncProductCosts } from '../src/sync/cost.js';

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
