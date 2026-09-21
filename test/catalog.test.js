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

test('category and age dimensions: product_type (empty -> null, never guessed), source_created_at and status are stored', async () => {
  const supabase = createFakeSupabase();
  await syncCatalog({ shopify: fakeShopify(), supabase });
  const byId = Object.fromEntries(supabase._tables.get('products').map((p) => [p.source_id, p]));
  assert.equal(byId['gid://shopify/Product/1'].product_type, 'Widgets');
  assert.equal(byId['gid://shopify/Product/2'].product_type, null);
  assert.equal(byId['gid://shopify/Product/1'].source_created_at, '2026-05-01T09:00:00Z');
  assert.equal(byId['gid://shopify/Product/3'].source_status, 'DRAFT');
});

test('collection memberships: keyed on the source collection id, idempotent, and a removed membership is retired, not deleted', async () => {
  const supabase = createFakeSupabase();
  const t1 = new Date('2026-09-21T08:00:00Z');
  const s1 = await syncCatalog({ shopify: fakeShopify(), supabase }, { now: t1 });
  assert.equal(s1.errors.length, 0);
  const rows = () => supabase._tables.get('product_collections');
  assert.equal(rows().length, 3); // product 1 in two collections, product 2 in one
  assert.ok(rows().every((r) => r.is_current));

  await syncCatalog({ shopify: fakeShopify(), supabase }, { now: new Date('2026-09-22T08:00:00Z') });
  assert.equal(rows().length, 3); // idempotent

  // Product 1 leaves the "Seasonal" collection in the source.
  const changed = JSON.parse(JSON.stringify(FAKE_PRODUCTS_PAGE));
  changed.products.edges[0].node.collections.edges.pop();
  const shopifyChanged = { async graphql(query) { return query.includes('products(') ? changed : fakeShopify().graphql(query); } };
  const s3 = await syncCatalog({ shopify: shopifyChanged, supabase }, { now: new Date('2026-09-23T08:00:00Z') });
  assert.equal(s3.collectionMembershipsRetired, 1);
  assert.equal(rows().length, 3); // kept
  assert.equal(rows().find((r) => r.source_id === 'gid://shopify/Collection/2').is_current, false);
  assert.equal(rows().filter((r) => r.is_current).length, 2);
});

test('collections beyond the fetched page are reported, never silently truncated', async () => {
  const supabase = createFakeSupabase();
  const big = JSON.parse(JSON.stringify(FAKE_PRODUCTS_PAGE));
  big.products.edges[0].node.collections.pageInfo.hasNextPage = true;
  const shopify = { async graphql(query) { return query.includes('products(') ? big : fakeShopify().graphql(query); } };
  const summary = await syncCatalog({ shopify, supabase });
  assert.ok(summary.errors.some((e) => e.includes('collections truncated')));
});
