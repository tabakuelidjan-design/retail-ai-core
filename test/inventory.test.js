import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCatalog } from '../src/sync/catalog.js';
import { syncInventory } from '../src/sync/inventory.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { FAKE_SHOP, FAKE_LOCATION, FAKE_PRODUCTS_PAGE, FAKE_INVENTORY_COST_PAGE } from './fixtures/shopify-sample.js';

function fakeShopify() {
  return {
    async graphql(query) {
      if (query.includes('shop {')) return { shop: FAKE_SHOP };
      if (query.includes('locations(')) return { locations: { edges: [{ node: FAKE_LOCATION }] } };
      if (query.includes('products(')) return FAKE_PRODUCTS_PAGE;
      if (query.includes('productVariants(')) return FAKE_INVENTORY_COST_PAGE;
      throw new Error('unexpected query in fake shopify client');
    },
  };
}

async function seedCatalog(supabase) {
  await syncCatalog({ shopify: fakeShopify(), supabase });
  const [merchant] = await supabase.select('merchants', { select: 'id', source_id: `eq.${FAKE_SHOP.id}` });
  return merchant.id;
}

test('inventory sync writes one snapshot per tracked variant on first run', async () => {
  const supabase = createFakeSupabase();
  const merchantId = await seedCatalog(supabase);

  const summary = await syncInventory({ shopify: fakeShopify(), supabase }, { merchantId, now: new Date('2026-01-01T08:00:00Z') });

  assert.equal(summary.snapshotsWritten, 3); // 3 variants in the fixture, all have an inventory level
  assert.equal(supabase._tables.get('inventory_snapshots').length, 3);
});

test('inventory sync: a same-day retry does not distort history (0 new rows)', async () => {
  const supabase = createFakeSupabase();
  const merchantId = await seedCatalog(supabase);

  await syncInventory({ shopify: fakeShopify(), supabase }, { merchantId, now: new Date('2026-01-01T08:00:00Z') });
  const summary = await syncInventory({ shopify: fakeShopify(), supabase }, { merchantId, now: new Date('2026-01-01T20:00:00Z') });

  assert.equal(summary.snapshotsWritten, 0);
  assert.equal(summary.snapshotsSkippedSameDay, 3);
  assert.equal(supabase._tables.get('inventory_snapshots').length, 3);
});

test('inventory sync: a run on the next UTC day writes a fresh snapshot', async () => {
  const supabase = createFakeSupabase();
  const merchantId = await seedCatalog(supabase);

  await syncInventory({ shopify: fakeShopify(), supabase }, { merchantId, now: new Date('2026-01-01T08:00:00Z') });
  const summary = await syncInventory({ shopify: fakeShopify(), supabase }, { merchantId, now: new Date('2026-01-02T08:00:00Z') });

  assert.equal(summary.snapshotsWritten, 3);
  assert.equal(supabase._tables.get('inventory_snapshots').length, 6);
});

test('zero stock is recorded as quantity 0, not skipped or treated as missing', async () => {
  const supabase = createFakeSupabase();
  const merchantId = await seedCatalog(supabase);
  await syncInventory({ shopify: fakeShopify(), supabase }, { merchantId, now: new Date('2026-01-01T08:00:00Z') });

  const [variant3] = await supabase.select('variants', { select: 'id', source_id: 'eq.gid://shopify/ProductVariant/3' });
  const snapshot = supabase._tables.get('inventory_snapshots').find((s) => s.variant_id === variant3.id);
  assert.equal(snapshot.quantity, 0);
});
