import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildLedger } from '../src/metrics/ledger.js';
import { buildWindows } from '../src/metrics/windows.js';
import { buildExplorer, productEvolutionStatus } from '../src/report/explorer.js';
import { buildProductsWorkspace, productIdOf } from '../src/report/products-workspace.js';
import { loadProducts, loadProductDetail } from '../src/analytics-premium/server/products.js';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';
import { CONFIG, makeData } from './fixtures/metrics-sample.js';

const NOW = new Date('2026-09-21T09:00:00Z');
const UI = new URL('../src/analytics-premium/ui/', import.meta.url);
// Catalogue ids must look like the real ones (uuid) so the detail endpoint accepts them.
const ID = { p1: '00000000-0000-4000-8000-000000000001', p2: '00000000-0000-4000-8000-000000000002', p3: '00000000-0000-4000-8000-000000000003', p4: '00000000-0000-4000-8000-000000000004', p5: '00000000-0000-4000-8000-000000000005' };

/**
 * Fixture (current window = 2026-08-22 .. 2026-09-21, previous = 2026-07-23 .. 2026-08-22):
 *   p1 Widget   current (o1, o3) + previous o5 (1 unit @ 40)  -> compared, up
 *   p2 Gadget   current o1 (1 @ 10) + previous o5 (2 @ 30)    -> compared, down
 *   p3 Gizmo    current o2 only, created inside the window     -> new (no category)
 *   p4 Idle     previous o6 only                               -> absent ("plus de vente")
 *   p5 Old      current o7, existed long before, no previous   -> not_sold_before
 */
function build(mutate) {
  const data = makeData();
  for (const p of data.products) { p.image_url = `https://cdn.example/${p.id}.webp`; p.handle = `handle-${p.id}`; }
  const prod = (id) => data.products.find((p) => p.id === id);
  prod('p1').product_type = 'Widgets'; prod('p2').product_type = 'Widgets'; prod('p4').product_type = 'Idle';
  prod('p3').source_created_at = '2026-09-01T00:00:00Z';
  data.products.push({ id: 'p5', title: 'Fixture Old', product_type: 'Old', source_created_at: '2025-01-01T00:00:00Z', image_url: null, handle: 'fixture-old' });
  data.variants.push({ id: 'v5', product_id: 'p5', sku: 'O-1', title: 'Default' });
  const ord = (id, at, channel_name) => ({ id, ordered_at: at, status: 'PAID', currency: 'EUR', taxes_included: false, channel_name });
  data.orders.push(ord('o5', '2026-08-10T10:00:00Z', 'Online Store'), ord('o6', '2026-08-12T10:00:00Z', 'Point of Sale'), ord('o7', '2026-09-15T10:00:00Z', 'Point of Sale'));
  const line = (id, order_id, variant_id, quantity, unit_price, title) => ({ id, order_id, variant_id, title_snapshot: title, sku_snapshot: null, quantity, unit_price, discount_amount: 0, tax_amount: 0 });
  data.orderLines.push(line('l5', 'o5', 'v1', 1, 40, 'Fixture Widget'), line('l6', 'o5', 'v2', 2, 30, 'Fixture Gadget'), line('l7', 'o6', 'v4', 1, 12, 'Fixture Idle'), line('l8', 'o7', 'v5', 1, 9, 'Fixture Old'));
  // real-looking uuids everywhere (products + variant.product_id)
  const map = (x) => ID[x] ?? x;
  for (const p of data.products) p.id = map(p.id);
  for (const v of data.variants) v.product_id = map(v.product_id);
  if (mutate) mutate(data);
  const ledger = buildLedger(data, { config: CONFIG });
  const windows = buildWindows(NOW, 'UTC');
  const ws = buildProductsWorkspace({ ledger, data, windows, now: NOW, config: CONFIG, timeZone: 'UTC' });
  const ex = buildExplorer({ ledger, data, windows, now: NOW, config: CONFIG, dailySeries: [], timeZone: 'UTC' });
  return { ws, ex, data };
}
const row = (ws, id) => ws.list.find((r) => r.id === ID[id]);

test('produits: the list holds every product sold now or before, with Explorer\'s totals, shares and ranking', () => {
  const { ws, ex } = build();
  assert.deepEqual(ws.list.map((r) => r.id).sort(), [ID.p1, ID.p2, ID.p3, ID.p4, ID.p5].sort());
  assert.equal(ws.totals.net_sales_ex_tax, ex.products.total_revenue);
  for (const r of ex.products.ranking) {
    const w = ws.list.find((x) => x.id === productIdOf(r.product_key));
    assert.equal(w.net_sales_ex_tax, r.net_sales_ex_tax);
    assert.equal(w.units_sold, r.units_sold);
    assert.equal(w.share, r.share);
  }
  // default order: current revenue, highest first; a product with no current sale sits at the bottom
  assert.deepEqual(ws.list.map((r) => r.id).slice(0, 1), [productIdOf(ex.products.ranking[0].product_key)]);
  assert.equal(ws.list[ws.list.length - 1].id, ID.p4);
  assert.equal(ws.kpis.top3_share, ex.products.concentration.top3);
});

test('produits: current vs previous comparison and statuses follow Explorer\'s rule', () => {
  const { ws, ex } = build();
  const p1 = row(ws, 'p1'); const p2 = row(ws, 'p2');
  assert.equal(p1.status, 'compared'); assert.equal(p1.direction, 'up');
  assert.equal(p1.previous_net_sales_ex_tax, 40);
  assert.equal(p1.delta_pct, Math.round(((p1.net_sales_ex_tax - 40) / 40) * 10000) / 10000);
  assert.equal(p2.status, 'compared'); assert.equal(p2.direction, 'down'); assert.equal(p2.previous_units_sold, 2);
  for (const r of ex.products.ranking) assert.equal(ws.list.find((x) => x.id === productIdOf(r.product_key)).status, r.status);
  assert.equal(productEvolutionStatus(null, null, new Date()), 'no_previous');
  assert.equal(productEvolutionStatus(5, null, new Date()), 'compared');
});

test('produits: new products and zero previous revenue never get a percentage', () => {
  const { ws } = build();
  const p3 = row(ws, 'p3'); const p5 = row(ws, 'p5');
  assert.equal(p3.status, 'new'); assert.equal(p3.delta_pct, null); assert.equal(p3.direction, null);
  assert.equal(p5.status, 'not_sold_before'); assert.equal(p5.delta_pct, null); assert.equal(p5.direction, null);
  assert.deepEqual(ws.new_products.map((x) => x.id), [ID.p3]);
  // sold before, nothing now: a factual "no sale in the period", counted as declining
  const p4 = row(ws, 'p4');
  assert.equal(p4.status, 'absent'); assert.equal(p4.units_sold, 0); assert.equal(p4.share, null); assert.equal(p4.delta_pct, -1);
  assert.deepEqual(ws.watch.absent.map((x) => x.id), [ID.p4]);
  assert.equal(ws.kpis.declining, 2); // p2 (still sold, lower) + p4 (no sale)
  assert.equal(ws.kpis.declining_absent, 1);
  assert.deepEqual(ws.watch.lower.map((x) => x.id), [ID.p2]);
});

test('produits: without a previous window nothing is compared', () => {
  const { ws } = build((data) => { data.orders = data.orders.filter((o) => !['o5', 'o6'].includes(o.id)); });
  assert.equal(row(ws, 'p4'), undefined);
  assert.equal(row(ws, 'p1').delta_pct, null);
  assert.equal(ws.kpis.products_sold_pct, null); // previous window has no product sold -> no invented %
});

test('produits: category, image and catalogue-match states are reported, never filled in', () => {
  const { ws } = build();
  assert.equal(row(ws, 'p3').category, null);
  assert.equal(row(ws, 'p3').flags.uncategorised, true);
  assert.equal(row(ws, 'p1').category, 'Widgets');
  assert.equal(row(ws, 'p1').image_url, 'https://cdn.example/p1.webp'); // the catalogue's own image URL, unchanged
  assert.equal(row(ws, 'p5').image_url, null); // no catalogue image -> null, never another product's image
  assert.equal(ws.watch.catalogue.uncategorised_products, 1);
  // an order line whose variant no longer exists in the catalogue: partial data, stable u- id, no image/category
  const { ws: w2 } = build((data) => { data.orderLines.push({ id: 'l9', order_id: 'o7', variant_id: null, title_snapshot: 'Retired item', sku_snapshot: null, quantity: 1, unit_price: 5, discount_amount: 0, tax_amount: 0 }); });
  const u = w2.list.find((r) => r.title === 'Retired item');
  assert.match(u.id, /^u-[0-9a-f]{10}$/);
  assert.equal(u.flags.partial, true); assert.equal(u.image_url, null); assert.equal(u.category, null); assert.equal(u.flags.uncategorised, false);
  assert.equal(w2.watch.catalogue.unmatched_products, 1);
});

test('produits: product detail - period metrics, contribution, daily series and recent sales', () => {
  const { ws } = build();
  const d = ws.details[ID.p1];
  assert.equal(d.revenue_per_unit, Math.round((d.net_sales_ex_tax / d.units_sold) * 100) / 100);
  assert.equal(d.contribution.delta, d.delta);
  assert.equal(d.contribution.total_delta, ws.totals.delta);
  assert.equal(d.daily.length, 30);
  assert.equal(Math.round(d.daily.reduce((a, x) => a + x.net_sales_ex_tax, 0) * 100) / 100, d.net_sales_ex_tax);
  assert.equal(d.sale_days, 2);
  assert.ok(d.sale_days < d.min_trend_sale_days); // too sparse: the page lists sales instead of drawing a line
  assert.deepEqual(d.recent_sales.map((s) => s.date), ['2026-09-12', '2026-09-10', '2026-08-10']);
  assert.equal(d.recent_sales[1].refunded_units, 1); // o1 carries a refund of 1 unit
  assert.equal(d.recent_sales[2].in_period, false);
  assert.equal(d.last_sale_date, '2026-09-12');
  const absent = ws.details[ID.p4];
  assert.equal(absent.revenue_per_unit, null);
  assert.equal(absent.sale_days, 0);
});

async function reportDir() {
  const { ws, ex } = build();
  const dir = await mkdtemp(path.join(tmpdir(), 'ap-products-'));
  await writeFile(path.join(dir, 'report-2026-09-21.json'), JSON.stringify({ generated_at: '2026-09-21T09:00:00Z', currency: 'EUR', explorer: { last_30_days: ex }, products_workspace: { last_30_days: ws } }));
  return { dir, ex };
}

test('produits api: list reuses Explorer growth/decline/categories/concentration and ships no per-product detail', async () => {
  const { dir, ex } = await reportDir();
  const d = await loadProducts(dir);
  assert.equal(d.available, true);
  assert.equal('details' in d, false);
  assert.ok(!JSON.stringify(d).includes('recent_sales'));
  assert.deepEqual(d.categories, ex.categories);
  assert.deepEqual(d.concentration, ex.products.concentration);
  assert.deepEqual(d.growth.map((m) => m.product_key), ex.products.growth.map((m) => m.product_key));
  assert.deepEqual(d.decline.map((m) => m.id), ex.products.decline.map((m) => productIdOf(m.product_key))); // Explorer's own order
  assert.deepEqual(d.decline.map((m) => m.id), [ID.p2, ID.p4]);
  for (const m of [...d.growth, ...d.decline]) assert.ok(m.id); // every mover opens its detail
  // growth never includes a product without a previous base
  for (const m of d.growth) assert.ok(m.previous_net_sales_ex_tax > 0);
  // honesty: margin is only carried as coverage, never as a per-product figure
  assert.equal(d.margin.available, false);
  assert.ok(!d.list.some((r) => 'margin_pct' in r || 'stock_units' in r || 'price' in r));
});

test('produits api: detail loaded per product; invalid or unknown ids rejected', async () => {
  const { dir } = await reportDir();
  assert.equal((await loadProductDetail(dir, ID.p1)).product.title, 'Fixture Widget');
  assert.deepEqual(await loadProductDetail(dir, '../x'), { error: 'INVALID_PRODUCT_ID' });
  assert.deepEqual(await loadProductDetail(dir, '00000000-0000-4000-8000-00000000abcd'), { error: 'PRODUCT_NOT_FOUND' });
});

test('produits route: served by the app and reachable from the navigation', async () => {
  const { dir } = await reportDir();
  const server = http.createServer(createAnalyticsPremiumApp({ reportsDir: dir }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await fetch(`${base}/api/products`);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).list.length, 5);
    assert.equal((await fetch(`${base}/api/products/detail?id=${ID.p2}`)).status, 200);
    assert.equal((await fetch(`${base}/api/products/detail?id=nope`)).status, 400);
    assert.equal((await fetch(`${base}/products.js`)).status, 200);
    assert.equal((await fetch(`${base}/products.css`)).status, 200);
    assert.equal((await (await fetch(`${base}/api/customers`)).json()).available, false); // Clients API unchanged: no customer block in this report
  } finally { server.close(); }
  const app = await readFile(new URL('app.js', UI), 'utf8');
  assert.ok(app.includes("['products', 'produits', 'nav.products', '#/products']"));
  assert.match(app, /products: \{ key: 'products', load: loadProductsIfNeeded, render: renderProductsPage \}/);
  const html = await readFile(new URL('index.html', UI), 'utf8');
  assert.ok(html.includes('/products.js') && html.includes('/products.css'));
});

test('produits ui: sort/filter vocabulary is factual, every pr.* string exists in FR/NL/EN, no unsupported concept or icon', async () => {
  const src = await readFile(new URL('products.js', UI), 'utf8');
  const used = new Set([...src.matchAll(/'(pr\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]));
  for (const x of ['compared', 'new', 'not_sold_before', 'absent', 'no_previous']) used.add(`pr.evo.${x}`);
  for (const x of ['revenue', 'units', 'gain', 'loss', 'recent', 'name']) used.add(`pr.sort.${x}`);
  for (const x of ['all', 'up', 'down', 'new', 'absent', 'uncategorised']) used.add(`pr.filter.${x}`);
  for (const l of ['fr', 'nl', 'en']) {
    const dict = await readFile(new URL(`lang-${l}.js`, UI), 'utf8');
    const keys = new Set([...dict.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
    for (const k of used) assert.ok(keys.has(k), `${l} is missing ${k}`);
    const pr = dict.split('\n').filter((x) => /^\s*'pr\./.test(x)).join('\n');
    assert.ok(!/best.?seller|meilleure vente|star|mauvais|weak|à risque|at risk|à supprimer|to delete|trop (cher|concentr)|too (high|low|concentrated)|stock/i.test(pr), `${l}: judgemental or unsupported wording in pr.* copy`);
  }
  assert.ok(!/semantic\('stock'|semantic\('prix'|margin_pct|stock_units/.test(src));
});
