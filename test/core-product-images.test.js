// Step 8A: product images in the ONE canonical Core sync (src/sync). featuredImage present in a successful answer = the source's truth
// (object -> url + alt, explicit null -> no image any more); featuredImage absent from the node = columns not written (value kept).
// Everything goes through the validated identity (NORDLA_MERCHANT_ID + verified shopify connector) and the tenant write guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { FAKE_LOCATION, FAKE_PRODUCTS_PAGE, FAKE_INVENTORY_COST_PAGE } from './fixtures/shopify-sample.js';
import { referenceProductImage } from './fixtures/product-image-reference-e593475.js';
import { SHOP_QUERY, PRODUCTS_PAGE_QUERY } from '../src/shopify/queries.js';
import { normalizeProduct, normalizeProductImage } from '../src/sync/normalize.js';
import { syncCatalog } from '../src/sync/catalog.js';
import { runSync } from '../src/sync/index.js';

const A = '0f5a1c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b';
const B = '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0';
const SHOP_A = 'gid://shopify/Shop/SYN-A'; const SHOP_B = 'gid://shopify/Shop/SYN-B';
const ENV = { SHOPIFY_SHOP_DOMAIN: 'synthetic.myshopify.example', SHOPIFY_CLIENT_ID: 'synthetic-client', SHOPIFY_CLIENT_SECRET: 'synthetic-not-a-secret' };
const IMG = (n, alt = `Alt ${n}`) => ({ url: `https://cdn.example/products/${n}.jpg?v=1`, altText: alt });

/** The fixture products page with a featuredImage per product: `images` maps product index -> featuredImage value ('absent' = no key). */
function productsPage(images, { tag = '', distinctIds = false } = {}) {
  const page = JSON.parse(JSON.stringify(FAKE_PRODUCTS_PAGE));
  page.products.edges.forEach((e, i) => {
    // tag: titles only (two merchants may well share Shopify ids - their rows stay apart by merchant_id); distinctIds: another page of the SAME merchant
    if (tag) e.node.title = `${tag} ${e.node.title}`;
    if (distinctIds) { e.node.id = `${e.node.id}-${tag}`; e.node.variants.edges.forEach((v) => { v.node.id = `${v.node.id}-${tag}`; }); }
    if (images[i] !== 'absent') e.node.featuredImage = images[i] ?? null;
  });
  return page;
}
function catalogShopify(page) {
  return { async graphql(q) { if (q.includes('locations(')) return { locations: { edges: [{ node: FAKE_LOCATION }] } }; if (q.includes('products(')) return page; throw new Error('unexpected'); } };
}
const productsOf = (s) => Object.fromEntries((s._tables.get('products') ?? []).map((p) => [p.source_id, { image_url: p.image_url, image_alt_text: p.image_alt_text }]));
const seeded = () => { const s = createFakeSupabase(); s._tables.set('merchants', [{ id: A, name: 'A' }, { id: B, name: 'B' }]); return s; };

test('the products query asks Shopify for the featured image (url + altText)', () => {
  assert.match(PRODUCTS_PAGE_QUERY, /featuredImage\s*\{\s*url\s+altText\s*\}/);
});

test('product with image, alt present / absent; product without image; image changed; alt removed - stored exactly, no duplicate rows', async () => {
  const s = seeded();
  await syncCatalog({ shopify: catalogShopify(productsPage([IMG(1), IMG(2, null), null])), supabase: s }, { merchantId: A });
  let p = productsOf(s); const ids = Object.keys(p);
  assert.deepEqual(p[ids[0]], { image_url: IMG(1).url, image_alt_text: 'Alt 1' });
  assert.deepEqual(p[ids[1]], { image_url: IMG(2).url, image_alt_text: null }, 'alt absent -> null');
  assert.deepEqual(p[ids[2]], { image_url: null, image_alt_text: null }, 'no image -> null');
  // the merchant changes product 1's image, removes product 2's image, adds one to product 3
  await syncCatalog({ shopify: catalogShopify(productsPage([IMG(10, 'New alt'), null, IMG(3)])), supabase: s }, { merchantId: A });
  p = productsOf(s);
  assert.deepEqual(p[ids[0]], { image_url: IMG(10).url, image_alt_text: 'New alt' }, 'image changed');
  assert.deepEqual(p[ids[1]], { image_url: null, image_alt_text: null }, 'image removed in Shopify -> the stale URL is not kept');
  assert.deepEqual(p[ids[2]], { image_url: IMG(3).url, image_alt_text: 'Alt 3' });
  assert.equal(s._tables.get('products').length, 3, 'upserts, never duplicates');
});

test('featuredImage ABSENT from the answer (not requested / partial source): existing images are kept, never erased - also for a mixed page', async () => {
  const s = seeded();
  await syncCatalog({ shopify: catalogShopify(productsPage([IMG(1), IMG(2), IMG(3)])), supabase: s }, { merchantId: A });
  const before = productsOf(s);
  const r = await syncCatalog({ shopify: catalogShopify(productsPage(['absent', 'absent', 'absent'])), supabase: s }, { merchantId: A });
  assert.deepEqual(r.errors, []); assert.deepEqual(productsOf(s), before);
  const r2 = await syncCatalog({ shopify: catalogShopify(productsPage([null, 'absent', IMG(9)])), supabase: s }, { merchantId: A });
  assert.deepEqual(r2.errors, []); assert.deepEqual(productsOf(s), before, 'a page where one node lacks the field writes no image column at all');
});

test('a second identical sync causes no drift (products table byte-identical, same row count)', async () => {
  const s = seeded(); const page = productsPage([IMG(1), null, IMG(3, null)]);
  await syncCatalog({ shopify: catalogShopify(page), supabase: s }, { merchantId: A });
  const snap = JSON.stringify(s._tables.get('products'));
  await syncCatalog({ shopify: catalogShopify(page), supabase: s }, { merchantId: A });
  assert.equal(JSON.stringify(s._tables.get('products')), snap);
});

test('same image values as the historical Analytics-branch variant (e593475) for every node that carries featuredImage', () => {
  const nodes = [{ featuredImage: IMG(1) }, { featuredImage: IMG(2, null) }, { featuredImage: null }, { featuredImage: { url: 'https://cdn.example/x.png', altText: '' } }];
  for (const n of nodes) assert.deepEqual(normalizeProductImage(n), referenceProductImage(n), JSON.stringify(n));
  // the one deliberate difference: a node WITHOUT the field - the variant wrote nulls (erasing a stored image), canonical keeps the value
  assert.deepEqual(referenceProductImage({}), { image_url: null, image_alt_text: null });
  assert.deepEqual(normalizeProductImage({}), {});
  assert.deepEqual(Object.keys(normalizeProduct({ id: 'p', title: 't', handle: 'h' }, A)).filter((k) => k.startsWith('image')), []);
});

test('batching kept: one products upsert per Shopify page, images included', async () => {
  const s = seeded(); const calls = [];
  const orig = s.upsert.bind(s); s.upsert = async (t, rows, o) => { calls.push({ t, n: rows.length }); return orig(t, rows, o); };
  const p1 = productsPage([IMG(1), IMG(2), IMG(3)]); p1.products.pageInfo = { hasNextPage: true, endCursor: 'c1' };
  const p2 = productsPage([IMG(4), null, IMG(6)], { tag: 'P2', distinctIds: true }); p2.products.pageInfo = { hasNextPage: false, endCursor: null };
  const shopify = { async graphql(q, v) { if (q.includes('locations(')) return { locations: { edges: [{ node: FAKE_LOCATION }] } }; return v?.cursor === 'c1' ? p2 : p1; } };
  await syncCatalog({ shopify, supabase: s }, { merchantId: A });
  assert.deepEqual(calls.filter((c) => c.t === 'products').map((c) => c.n), [3, 3], 'one upsert per page of 3');
  assert.equal(s._tables.get('products').filter((p) => p.image_url).length, 5);
});

// ---------- through the full identity path: runSync (NORDLA_MERCHANT_ID + verified connector + write guard) ----------
function full(shopId, images, { tag = '', down = false } = {}) {
  const page = productsPage(images, { tag });
  const client = { async graphql(q) {
    if (down) throw new TypeError('fetch failed');
    if (q === SHOP_QUERY) return { shop: { id: shopId, name: 'S', myshopifyDomain: 'x' } };
    if (q.includes('locations(')) return { locations: { edges: [{ node: FAKE_LOCATION }] } };
    if (q.includes('productVariants(')) return FAKE_INVENTORY_COST_PAGE;
    if (q.includes('orders(')) return { orders: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    if (q.includes('products(')) return page;
    throw new Error('unexpected');
  } };
  return () => client;
}
function tenantDb() {
  const s = seeded();
  s._tables.set('merchant_connectors', [
    { id: 'c-a', merchant_id: A, kind: 'shopify', external_id: SHOP_A, status: 'CONFIGURED', config: {} },
    { id: 'c-b', merchant_id: B, kind: 'shopify', external_id: SHOP_B, status: 'CONFIGURED', config: {} }]);
  const writes = []; for (const m of ['insert', 'upsert', 'update', 'delete']) { const o = s[m].bind(s); s[m] = async (t, ...r) => { writes.push(t); return o(t, ...r); }; }
  s.writes = writes; return s;
}
const run = (s, merchant, createClient) => runSync({ mode: 'all', env: { MERCHANT_TIMEZONE: 'UTC', NORDLA_MERCHANT_ID: merchant, ...ENV }, supabase: s, createClient, log: () => {}, logError: () => {}, customerKeySecret: () => null, coverage: { read: async () => null, write: async () => {} } });

test('two merchants: each merchant\'s images land on its own products only (no leak), through the guarded runSync', async () => {
  const s = tenantDb();
  assert.equal((await run(s, A, full(SHOP_A, [IMG('a1'), IMG('a2'), null], { tag: 'A' }))).status, 'SUCCESS');
  assert.equal((await run(s, B, full(SHOP_B, [IMG('b1'), null, IMG('b3')], { tag: 'B' }))).status, 'SUCCESS');
  const products = s._tables.get('products');
  for (const p of products) {
    if (p.image_url) assert.equal(p.image_url.includes('/a') ? A : B, p.merchant_id, `${p.image_url} on the right merchant`);
    assert.equal(p.title.startsWith('A ') ? A : B, p.merchant_id);
  }
  assert.equal(products.filter((p) => p.merchant_id === A && p.image_url).length, 2); assert.equal(products.filter((p) => p.merchant_id === B && p.image_url).length, 2);
});

test('wrong shop (B\'s shop for A) -> MISCONFIGURED, zero data write (no image, no product); Shopify down -> UNAVAILABLE, no partial write', async () => {
  const s = tenantDb();
  const wrong = await run(s, A, full(SHOP_B, [IMG(1), IMG(2), IMG(3)]));
  assert.equal(wrong.state, 'MISCONFIGURED'); assert.deepEqual(s.writes.filter((t) => t !== 'sync_runs'), []);
  const down = await run(s, A, full(SHOP_A, [IMG(1), IMG(2), IMG(3)], { down: true }));
  assert.equal(down.state, 'UNAVAILABLE'); assert.deepEqual(s.writes.filter((t) => t !== 'sync_runs'), []);
  assert.equal((s._tables.get('products') ?? []).length, 0);
});

test('historical behaviour unchanged: with images, every other table (variants, inventory, costs, orders, refunds...) is identical to a sync without them', async () => {
  const withImg = tenantDb(); const without = tenantDb();
  assert.equal((await run(withImg, A, full(SHOP_A, [IMG(1), null, IMG(3)]))).status, 'SUCCESS');
  assert.equal((await run(without, A, full(SHOP_A, ['absent', 'absent', 'absent']))).status, 'SUCCESS');
  const proj = (s, t) => (s._tables.get(t) ?? []).map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id' && !/_id$/.test(k) && !/_at$/.test(k) && k !== 'effective_from' && !k.startsWith('image_'))))).sort();
  for (const t of ['locations', 'products', 'variants', 'inventory_snapshots', 'product_costs', 'orders', 'order_lines', 'refunds', 'refund_lines']) assert.deepEqual(proj(withImg, t), proj(without, t), t);
});

test('one canonical sync: only src/sync writes the commerce tables; no Analytics (or other) variant of the sync exists', () => {
  const ROOT = new URL('../', import.meta.url);
  const walk = (d) => readdirSync(new URL(d, ROOT), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}${e.name}/`) : /\.m?js$/.test(e.name) ? [`${d}${e.name}`] : []));
  const writers = walk('src/').filter((f) => /(upsert|insert|upsertInChunks|insertInChunks)\(\s*(supabase,\s*)?'(products|variants|inventory_snapshots|product_costs|orders|order_lines|refunds|refund_lines|product_collections|locations)'/.test(readFileSync(new URL(f, ROOT), 'utf8')));
  assert.deepEqual(writers.filter((f) => !f.startsWith('src/sync/')), [], 'commerce tables are written by src/sync only');
  const normalizers = walk('src/').filter((f) => /export function normalize(Product|Variant|Order|OrderLine|Refund|RefundLine|InventorySnapshot|ProductCost)\b/.test(readFileSync(new URL(f, ROOT), 'utf8')));
  assert.deepEqual(normalizers, ['src/sync/normalize.js'], 'one set of commerce normalizers');
  assert.deepEqual(walk('src/analytics-premium/').filter((f) => /\.featuredImage|featuredImage\s*\{|PRODUCTS_PAGE_QUERY|upsert\(/.test(readFileSync(new URL(f, ROOT), 'utf8'))), [], 'Analytics only reads what Core produced');
});
