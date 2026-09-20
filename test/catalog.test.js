import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCatalog } from '../src/sync/catalog.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { FAKE_SHOP, FAKE_LOCATION, FAKE_PRODUCTS_PAGE } from './fixtures/shopify-sample.js';

function fakeShopify() {
  return {
    async graphql(query) {
      if (query.includes('shop {')) return { shop: FAKE_SHOP };
      if (query.includes('locations(')) return { locations: { edges: [{ node: FAKE_LOCATION }] } };
      if (query.includes('products(')) return FAKE_PRODUCTS_PAGE;
      throw new Error('unexpected query in fake shopify client');
    },
  };
}

test('catalog sync creates exactly one merchant, one location, 3 products, 4 variants', async () => {
  const supabase = createFakeSupabase();
  const summary = await syncCatalog({ shopify: fakeShopify(), supabase });

  assert.deepEqual(summary.errors, []);
  assert.equal(supabase._tables.get('merchants').length, 1);
  assert.equal(summary.locationsUpserted, 1);
  assert.equal(summary.productsUpserted, 3);
  assert.equal(summary.variantsUpserted, 4);
});

test('merchant idempotency: running catalog sync twice does not duplicate the merchant', async () => {
  const supabase = createFakeSupabase();
  await syncCatalog({ shopify: fakeShopify(), supabase });
  await syncCatalog({ shopify: fakeShopify(), supabase });

  assert.equal(supabase._tables.get('merchants').length, 1);
});

test('location idempotency: running catalog sync twice does not duplicate locations', async () => {
  const supabase = createFakeSupabase();
  await syncCatalog({ shopify: fakeShopify(), supabase });
  await syncCatalog({ shopify: fakeShopify(), supabase });

  assert.equal(supabase._tables.get('locations').length, 1);
});

test('catalog idempotency: running catalog sync twice does not duplicate products or variants', async () => {
  const supabase = createFakeSupabase();
  await syncCatalog({ shopify: fakeShopify(), supabase });
  await syncCatalog({ shopify: fakeShopify(), supabase });

  assert.equal(supabase._tables.get('products').length, 3);
  assert.equal(supabase._tables.get('variants').length, 4);
});
