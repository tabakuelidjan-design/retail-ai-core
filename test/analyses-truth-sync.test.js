import test from 'node:test';
import assert from 'node:assert/strict';
import { syncOrders, refundCatchUpQuery } from '../src/sync/orders.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { FAKE_ORDER_1, orderWithPartialLineRefund, ordersPage } from './fixtures/shopify-orders-sample.js';

// Analyses Phase 0, defect A (sync side): the default sync only re-reads orders CREATED in the last 60 days, so a refund issued later on an
// older order (reachable only with read_all_orders) was never ingested. A catch-up pass reads orders UPDATED in the window but created before it.
// SYNTHETIC data; the Shopify client is a fake. Behaviour against live Shopify is not exercised here.
const NOW = new Date('2026-10-03T10:00:00Z');
const MERCHANT = 'merchant-1';

async function seedCatalog(supabase) {
  await supabase.upsert('locations', [{ merchant_id: MERCHANT, source_id: 'gid://shopify/Location/1', name: 'Fixture Store' }], { onConflict: 'merchant_id,source_system,source_id' });
  await supabase.upsert('variants', [1, 2, 3].map((n) => ({ merchant_id: MERCHANT, source_id: `gid://shopify/ProductVariant/${n}` })), { onConflict: 'merchant_id,source_system,source_id' });
}
const recordingShopify = (byQuery) => { const seen = []; return { seen, async graphql(query, vars) { seen.push(vars.searchQuery); return ordersPage(byQuery(vars.searchQuery)); } }; };

test('S1. the default sync adds a catch-up pass for orders updated in the window but created before it', async () => {
  const supabase = createFakeSupabase(); await seedCatalog(supabase);
  const shop = recordingShopify((q) => (q.includes('created_at:<') ? [] : [FAKE_ORDER_1]));
  await syncOrders({ shopify: shop, supabase }, { merchantId: MERCHANT, now: NOW, refundCatchUp: true });
  assert.equal(shop.seen[0], 'created_at:>=2026-08-04');
  assert.equal(shop.seen[1], 'updated_at:>=2026-08-04 AND created_at:<2026-08-04');
  assert.equal(shop.seen[1], refundCatchUpQuery(NOW));
});

test('S2. an old order with a NEW refund found by the catch-up pass is stored with its refund (the refund is not lost)', async () => {
  const supabase = createFakeSupabase(); await seedCatalog(supabase);
  const old = orderWithPartialLineRefund(); old.createdAt = '2026-06-01T10:00:00Z';
  const shop = recordingShopify((q) => (q.includes('created_at:<') ? [old] : []));
  await syncOrders({ shopify: shop, supabase }, { merchantId: MERCHANT, now: NOW, refundCatchUp: true });
  assert.equal(supabase._tables.get('orders').length, 1, 'the old order is ingested');
  assert.ok(supabase._tables.get('refunds').length >= 1, 'its refund is ingested');
});

test('S3. catch-up counters never inflate the main-pass counters', async () => {
  const supabase = createFakeSupabase(); await seedCatalog(supabase);
  const shop = recordingShopify(() => [FAKE_ORDER_1]);
  const summary = await syncOrders({ shopify: shop, supabase }, { merchantId: MERCHANT, now: NOW, refundCatchUp: true });
  assert.equal(summary.ordersFetched, 1, 'main pass only');
  assert.equal(summary.orderLinesFetched, 2);
  assert.equal(summary.catchUp.ordersFetched, 1);
});

test('S4. a catch-up failure is SURFACED in the summary errors and never breaks the main sync', async () => {
  const supabase = createFakeSupabase(); await seedCatalog(supabase);
  const shop = { async graphql(query, vars) { if (vars.searchQuery.includes('created_at:<')) throw new Error('boom'); return ordersPage([FAKE_ORDER_1]); } };
  const summary = await syncOrders({ shopify: shop, supabase }, { merchantId: MERCHANT, now: NOW, refundCatchUp: true });
  assert.equal(summary.ordersUpserted, 1);
  assert.ok(summary.errors.some((e) => e.startsWith('catch-up: ') && e.includes('boom')));
});

test('S5. a backfill (opts.since) does not run the catch-up pass; the library default is off; the production runner turns it on', async () => {
  const a = recordingShopify(() => [FAKE_ORDER_1]); await syncOrders({ shopify: a, supabase: createFakeSupabase() }, { merchantId: MERCHANT, since: '2026-05-11', now: NOW, refundCatchUp: true });
  assert.equal(a.seen.length, 1);
  const b = recordingShopify(() => [FAKE_ORDER_1]); await syncOrders({ shopify: b, supabase: createFakeSupabase() }, { merchantId: MERCHANT, now: NOW });
  assert.equal(b.seen.length, 1);
  const { readFileSync } = await import('node:fs'); assert.match(readFileSync(new URL('../src/sync/index.js', import.meta.url), 'utf8'), /refundCatchUp: true/);
});
