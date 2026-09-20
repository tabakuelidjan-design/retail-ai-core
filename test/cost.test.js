import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCatalog } from '../src/sync/catalog.js';
import { syncProductCosts } from '../src/sync/cost.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { FAKE_SHOP, FAKE_LOCATION, FAKE_PRODUCTS_PAGE, FAKE_INVENTORY_COST_PAGE } from './fixtures/shopify-sample.js';

function fakeShopify(invPage = FAKE_INVENTORY_COST_PAGE) {
  return {
    async graphql(query) {
      if (query.includes('shop {')) return { shop: FAKE_SHOP };
      if (query.includes('locations(')) return { locations: { edges: [{ node: FAKE_LOCATION }] } };
      if (query.includes('products(')) return FAKE_PRODUCTS_PAGE;
      if (query.includes('productVariants(')) return invPage;
      throw new Error('unexpected query in fake shopify client');
    },
  };
}

async function seedCatalog(supabase) {
  await syncCatalog({ shopify: fakeShopify(), supabase });
  const [merchant] = await supabase.select('merchants', { select: 'id', source_id: `eq.${FAKE_SHOP.id}` });
  return merchant.id;
}

test('product without unitCost gets no product_costs row (UNCLASSIFIED)', async () => {
  const supabase = createFakeSupabase();
  const merchantId = await seedCatalog(supabase);

  const summary = await syncProductCosts({ shopify: fakeShopify(), supabase }, { merchantId, now: new Date('2026-01-01T00:00:00Z') });

  assert.equal(summary.withoutCost, 1); // variant 2 has unitCost: null
  assert.equal(summary.withCost, 2);
  const [variant2] = await supabase.select('variants', { select: 'id', source_id: 'eq.gid://shopify/ProductVariant/2' });
  const costsForVariant2 = supabase._tables.get('product_costs').filter((c) => c.variant_id === variant2.id);
  assert.equal(costsForVariant2.length, 0);
});

test('unchanged unitCost does not create a duplicate history row on re-run', async () => {
  const supabase = createFakeSupabase();
  const merchantId = await seedCatalog(supabase);

  await syncProductCosts({ shopify: fakeShopify(), supabase }, { merchantId, now: new Date('2026-01-01T00:00:00Z') });
  const afterFirstRun = supabase._tables.get('product_costs').length;

  const secondSummary = await syncProductCosts({ shopify: fakeShopify(), supabase }, { merchantId, now: new Date('2026-01-02T00:00:00Z') });

  assert.equal(supabase._tables.get('product_costs').length, afterFirstRun);
  assert.equal(secondSummary.newCostRows, 0);
  assert.equal(secondSummary.unchangedSkipped, 2);
});

test('changed unitCost creates exactly one new history row, keeping the old one', async () => {
  const supabase = createFakeSupabase();
  const merchantId = await seedCatalog(supabase);

  await syncProductCosts({ shopify: fakeShopify(), supabase }, { merchantId, now: new Date('2026-01-01T00:00:00Z') });

  const changedPage = JSON.parse(JSON.stringify(FAKE_INVENTORY_COST_PAGE));
  changedPage.productVariants.edges[0].node.inventoryItem.unitCost.amount = '7.50';

  const summary = await syncProductCosts({ shopify: fakeShopify(changedPage), supabase }, { merchantId, now: new Date('2026-01-02T00:00:00Z') });

  assert.equal(summary.newCostRows, 1);
  const [variant1] = await supabase.select('variants', { select: 'id', source_id: 'eq.gid://shopify/ProductVariant/1' });
  const historyForVariant1 = supabase._tables.get('product_costs').filter((c) => c.variant_id === variant1.id);
  assert.equal(historyForVariant1.length, 2); // both old (5.00) and new (7.50) rows kept
});
