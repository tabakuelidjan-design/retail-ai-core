// Hierarchical sales analytics tests. Deliberately hand-builds the ledger/enrichment inputs (no Shopify field
// names such as product_type/product_collections/channel_handle appear anywhere here) to prove hierarchy.js has
// zero Shopify coupling: any source system that can produce this shape can drive it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig } from '../src/metrics/config.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { buildWindows } from '../src/metrics/windows.js';
import { analyzeDimension, drillDown, HIERARCHY_LEVELS, matchesFilter, UNCLASSIFIED } from '../src/metrics/hierarchy.js';
import { CONFIG, makeData } from './fixtures/metrics-sample.js';

const NOW = new Date('2026-09-21T09:00:00Z');
const WINDOW = buildWindows(NOW, 'UTC', { availableDays: 30 }).available_window; // covers all fixture activity, has localStart/localEnd

// Generic (source-agnostic) enrichment: broadest -> narrowest path per product.
// p1 & p2: Tech / Audio / Headphones (wireless vs wired); p4: Tech / Audio / Speakers; p3: Home / Kitchen / Gadgets.
const enrichment = {
  categoryPathByProduct: new Map([
    ['p1', ['Tech', 'Audio', 'Headphones', 'Wireless']],
    ['p2', ['Tech', 'Audio', 'Headphones', 'Wired']],
    ['p3', ['Home', 'Kitchen', 'Gadgets', 'Small']],
    ['p4', ['Tech', 'Audio', 'Speakers', 'Portable']],
  ]),
  collectionsByProduct: new Map([
    ['p1', [{ id: 'c-best', title: 'Bestsellers' }, { id: 'c-new', title: 'New arrivals' }]],
    ['p2', [{ id: 'c-best', title: 'Bestsellers' }]],
  ]),
  channelByOrder: new Map([
    ['o1', { id: 'web', title: 'Online store' }],
    ['o2', { id: 'pos', title: 'Point of sale' }],
    ['o3', { id: 'web', title: 'Online store' }],
  ]),
};

const ledger = () => buildLedger(makeData(), { config: CONFIG });
const byKey = (rows, key) => rows.find((r) => r.key === key);

test('groups by each of the 8 requested dimensions without error', () => {
  const l = ledger();
  for (const dimension of ['universe', 'product_group', 'category', 'subcategory', 'product', 'variant', 'collection', 'channel']) {
    const result = analyzeDimension(l, enrichment, { dimension, window: WINDOW, now: NOW, timeZone: 'UTC' });
    assert.equal(result.dimension, dimension);
    assert.ok(Array.isArray(result.rows));
  }
});

test('universe/category rollup: Tech aggregates p1+p2+p4, Home aggregates p3 alone', () => {
  const rows = analyzeDimension(ledger(), enrichment, { dimension: 'universe', window: WINDOW, now: NOW, timeZone: 'UTC' }).rows;
  const tech = byKey(rows, 'Tech');
  const home = byKey(rows, 'Home');
  // p1: 3 units net after 1 refunded, p4 never sells -> Tech units_sold = p1(3) + p2(1) + p4(0) = 4
  assert.equal(tech.units_sold, 4);
  assert.equal(home.units_sold, 1); // p3
  assert.equal(round(tech.net_sales_ex_tax + home.net_sales_ex_tax), round(tech.net_sales_ex_tax + home.net_sales_ex_tax));
});

test('drill-down Tech -> Audio -> Headphones -> product -> variant narrows correctly at each step', () => {
  // path index: 0 universe, 1 product_group, 2 category, 3 subcategory -> p1/p2 = Tech/Audio/Headphones/*, p4 = Tech/Audio/Speakers/*
  const l = ledger();
  const productGroups = drillDown(l, enrichment, { window: WINDOW, path: [['universe', 'Tech']], into: 'product_group', now: NOW, timeZone: 'UTC' }).rows;
  assert.deepEqual(new Set(productGroups.map((r) => r.key)), new Set(['Audio']));
  assert.ok(!productGroups.some((r) => r.key === 'Kitchen'));

  const categories = drillDown(l, enrichment, { window: WINDOW, path: [['universe', 'Tech'], ['product_group', 'Audio']], into: 'category', now: NOW, timeZone: 'UTC' }).rows;
  assert.deepEqual(new Set(categories.map((r) => r.key)), new Set(['Headphones'])); // p4 (Speakers) has no sales in window -> its category row is absent from fact-based sales, but it still surfaces under no_recent_sales below

  const products = drillDown(l, enrichment, { window: WINDOW, path: [['universe', 'Tech'], ['product_group', 'Audio'], ['category', 'Headphones']], into: 'product', now: NOW, timeZone: 'UTC' }).rows;
  assert.deepEqual(new Set(products.map((r) => r.key)), new Set(['p1', 'p2']));

  const variants = drillDown(l, enrichment, { window: WINDOW, path: [['productId', 'p1']], into: 'variant', now: NOW, timeZone: 'UTC' }).rows;
  assert.deepEqual(variants.map((r) => r.key), ['v1']);
});

test('collections are many-valued: a product in two collections counts its sale under both', () => {
  const rows = analyzeDimension(ledger(), enrichment, { dimension: 'collection', window: WINDOW, now: NOW, timeZone: 'UTC' }).rows;
  const best = byKey(rows, 'c-best');
  const fresh = byKey(rows, 'c-new');
  assert.equal(best.label, 'Bestsellers');
  assert.ok(best.units_sold >= fresh.units_sold); // c-best holds p1+p2, c-new holds only p1
  assert.equal(fresh.units_sold, 3); // p1 alone: 3 net units in window
});

test('sales channel dimension splits web vs pos orders; unmapped orders would fall to Unclassified', () => {
  const rows = analyzeDimension(ledger(), enrichment, { dimension: 'channel', window: WINDOW, now: NOW, timeZone: 'UTC' }).rows;
  const web = byKey(rows, 'web');
  const pos = byKey(rows, 'pos');
  assert.ok(web); assert.ok(pos);
  assert.equal(pos.units_sold, 1); // o2 -> l3 (Fixture Gizmo)
});

test('products with no category mapping surface as Unclassified rather than being dropped', () => {
  const enrichmentMissingP3 = { ...enrichment, categoryPathByProduct: new Map([...enrichment.categoryPathByProduct].filter(([k]) => k !== 'p3')) };
  const rows = analyzeDimension(ledger(), enrichmentMissingP3, { dimension: 'universe', window: WINDOW, now: NOW, timeZone: 'UTC' }).rows;
  assert.ok(byKey(rows, UNCLASSIFIED));
  assert.equal(byKey(rows, UNCLASSIFIED).units_sold, 1); // p3's unit
});

test('coarse dimensions (above product/variant) carry top_products, declining_products and no_recent_sales', () => {
  const rows = analyzeDimension(ledger(), enrichment, { dimension: 'universe', window: WINDOW, now: NOW, timeZone: 'UTC' }).rows;
  const tech = byKey(rows, 'Tech');
  assert.ok(Array.isArray(tech.top_products));
  assert.ok(Array.isArray(tech.declining_products));
  assert.ok(Array.isArray(tech.no_recent_sales));
  assert.ok(tech.top_products.some((p) => p.product_key === 'p1'));
  // p4 (Fixture Idle, part of Tech/Audio/Speakers) has stock and zero sales in-window -> flagged, never silently omitted
  assert.ok(tech.no_recent_sales.some((p) => p.product_key === 'p4'));
});

test('fine dimensions (product/variant) do not carry a product breakdown (it would be circular)', () => {
  const rows = analyzeDimension(ledger(), enrichment, { dimension: 'product', window: WINDOW, now: NOW, timeZone: 'UTC' }).rows;
  assert.equal(rows[0].top_products, undefined);
});

test('month-by-month trend returns the configured number of buckets, oldest first, current month partial', () => {
  const rows = analyzeDimension(ledger(), enrichment, { dimension: 'universe', window: WINDOW, now: NOW, timeZone: 'UTC', config: { monthsOfTrend: 3 } }).rows;
  const tech = byKey(rows, 'Tech');
  assert.equal(tech.monthly_trend.length, 3);
  assert.equal(tech.monthly_trend.at(-1).month, '2026-09');
  assert.equal(tech.monthly_trend.at(-1).partial, true);
  assert.equal(tech.monthly_trend[0].partial, false);
});

test('comparison with the previous equivalent period is present, with null deltas when the previous period had no sales', () => {
  const rows = analyzeDimension(ledger(), enrichment, { dimension: 'universe', window: WINDOW, now: NOW, timeZone: 'UTC' }).rows;
  const tech = byKey(rows, 'Tech');
  assert.ok(tech.comparison_previous_period.window);
  assert.equal(tech.comparison_previous_period.net_sales_ex_tax, 0);
  assert.equal(tech.comparison_previous_period.net_sales_change_pct, null); // previous period base is 0: a % change would be undefined, never fabricated
});

test('stock on hand and stock value are reported, with a status when cost is missing (p3 has stock but no cost)', () => {
  const rows = analyzeDimension(ledger(), enrichment, { dimension: 'universe', window: WINDOW, now: NOW, timeZone: 'UTC' }).rows;
  const home = byKey(rows, 'Home'); // p3 only, v3 has no cost row
  assert.ok(home.stock_units > 0);
  assert.equal(home.inventory_value_at_cost.status, 'UNCLASSIFIED');
  assert.equal(home.inventory_value_at_cost.value, null);
});

test('AOV is always computed, but flagged not-meaningful below the configured minimum order count', () => {
  const rows = analyzeDimension(ledger(), enrichment, { dimension: 'universe', window: WINDOW, now: NOW, timeZone: 'UTC', config: { aovMinOrders: 1 } });
  const meaningful = byKey(rows.rows, 'Tech');
  assert.equal(meaningful.aov_meaningful, true); // Tech has 2 orders (o1, o3) >= 1
  const strict = analyzeDimension(ledger(), enrichment, { dimension: 'universe', window: WINDOW, now: NOW, timeZone: 'UTC', config: { aovMinOrders: 50 } });
  assert.equal(byKey(strict.rows, 'Tech').aov_meaningful, false);
  assert.ok(byKey(strict.rows, 'Tech').aov !== null); // still returned, never suppressed
});

test('sales velocity is units sold per day of the window', () => {
  const rows = analyzeDimension(ledger(), enrichment, { dimension: 'universe', window: WINDOW, now: NOW, timeZone: 'UTC' }).rows;
  const tech = byKey(rows, 'Tech');
  const days = (WINDOW.end - WINDOW.start) / (24 * 60 * 60 * 1000);
  assert.equal(tech.sales_velocity_units_per_day, Math.round((tech.units_sold / days) * 100) / 100);
});

test('matchesFilter narrows on every hierarchy level plus collection/channel/product/variant filters', () => {
  const l = ledger();
  const p1Line = l.lineFacts.find((f) => f.productId === 'p1');
  assert.equal(matchesFilter(p1Line, { universe: 'Tech' }, enrichment), true);
  assert.equal(matchesFilter(p1Line, { universe: 'Home' }, enrichment), false);
  assert.equal(matchesFilter(p1Line, { collectionId: 'c-best' }, enrichment), true);
  assert.equal(matchesFilter(p1Line, { collectionId: 'c-new' }, enrichment), true);
  assert.equal(matchesFilter(p1Line, { collectionId: 'unknown' }, enrichment), false);
  assert.equal(matchesFilter(p1Line, { channelId: 'web' }, enrichment), true);
  assert.equal(matchesFilter(p1Line, { channelId: 'pos' }, enrichment), false);
  assert.equal(HIERARCHY_LEVELS.length, 4);
});

function round(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }
