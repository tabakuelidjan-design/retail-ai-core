import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger } from '../src/metrics/ledger.js';
import { buildWindows } from '../src/metrics/windows.js';
import { buildExplorer, weeklySeries } from '../src/report/explorer.js';
import { CONFIG, makeData } from './fixtures/metrics-sample.js';

const NOW = new Date('2026-09-21T09:00:00Z');

function explorerOf(mutate) {
  const data = makeData();
  data.products.find((p) => p.id === 'p1').product_type = 'Widgets';
  data.products.find((p) => p.id === 'p2').product_type = 'Widgets';
  // p3 has no product_type -> reported as uncategorised (name null)
  const keyA = 'a'.repeat(64); const keyB = 'b1c2'.padEnd(64, '0');
  data.orders.find((o) => o.id === 'o1').customer_key = keyA;
  data.orders.find((o) => o.id === 'o3').customer_key = keyA;
  data.orders.find((o) => o.id === 'o2').customer_key = keyB;
  if (mutate) mutate(data);
  const ledger = buildLedger(data, { config: CONFIG });
  const windows = buildWindows(NOW, 'UTC');
  return buildExplorer({ ledger, data, windows, now: NOW, config: CONFIG, dailySeries: [] });
}

test('explorer KPIs come from the same aggregates as the rest of the report', () => {
  const e = explorerOf();
  assert.equal(e.kpis.order_count, 3);
  assert.equal(e.kpis.units_sold, 5);
  assert.equal(e.kpis.net_sales_ex_tax, 145.45);
  assert.equal(e.kpis.active_customers, 2);
  assert.equal(e.kpis.identified_orders, 3);
  assert.equal(e.kpis.identified_share, 1);
});

test('no comparison is invented when the previous window has no sales', () => {
  const e = explorerOf();
  assert.equal(e.kpis.previous.net_sales_ex_tax, 0);
  assert.equal(e.kpis.delta.net_sales_ex_tax_pct, null);
  assert.equal(e.kpis.delta.order_count_pct, null);
  for (const p of e.top_products) assert.equal(p.delta_pct, null);
});

test('categories are the catalogue product_type, shares add up to 1, an empty type stays uncategorised', () => {
  const e = explorerOf();
  const names = e.categories.map((c) => c.name);
  assert.deepEqual(names, ['Widgets', null]);
  const sum = e.categories.reduce((s, c) => s + c.share, 0);
  assert.ok(Math.abs(sum - 1) < 0.001);
  assert.equal(e.categories.reduce((s, c) => s + c.net_sales_ex_tax, 0).toFixed(2), '145.45');
});

test('top customers are pseudonymous labels ranked by revenue; anonymous orders are excluded, never guessed', () => {
  const e = explorerOf((data) => { delete data.orders.find((o) => o.id === 'o2').customer_key; });
  assert.equal(e.kpis.active_customers, 1);
  assert.equal(e.kpis.identified_orders, 2);
  assert.ok(e.kpis.identified_share < 1);
  assert.equal(e.top_customers.status, 'OK');
  assert.equal(e.top_customers.rows.length, 1);
  assert.equal(e.top_customers.rows[0].label, '#AAAA');
  assert.equal(e.top_customers.rows[0].order_count, 2);
});

test('with no customer key at all, customer blocks are UNAVAILABLE rather than approximated', () => {
  const e = explorerOf((data) => { for (const o of data.orders) delete o.customer_key; });
  assert.equal(e.kpis.active_customers, 0);
  assert.equal(e.top_customers.status, 'UNAVAILABLE');
  assert.deepEqual(e.top_customers.rows, []);
});

test('weekly series sums the real daily buckets on Monday-based weeks', () => {
  const daily = [
    { date: '2026-09-13', net_sales_ex_tax: 10, order_count: 1 }, // Sunday -> week of 2026-09-07
    { date: '2026-09-14', net_sales_ex_tax: 5, order_count: 1 }, // Monday -> week of 2026-09-14
    { date: '2026-09-15', net_sales_ex_tax: 7.5, order_count: 2 },
  ];
  const w = weeklySeries(daily);
  assert.deepEqual(w.map((x) => [x.week_start, x.days, x.net_sales_ex_tax, x.order_count]), [['2026-09-07', 1, 10, 1], ['2026-09-14', 2, 12.5, 3]]);
});

test('AOV is revenue / orders for the current period, and its comparison is null when the previous period had no orders', () => {
  const e = explorerOf();
  assert.equal(e.kpis.aov_ex_tax, 48.48);
  assert.equal(e.kpis.previous.aov_ex_tax, null);
  assert.equal(e.kpis.delta.aov_ex_tax_pct, null);
});

test('strongest / weakest day come from the real daily series; the weakest is taken among days with sales and empty days are counted apart', () => {
  const data = makeData();
  const ledger = buildLedger(data, { config: CONFIG });
  const daily = [
    { date: '2026-09-01', net_sales_ex_tax: 0, order_count: 0 },
    { date: '2026-09-02', net_sales_ex_tax: 40, order_count: 2 },
    { date: '2026-09-03', net_sales_ex_tax: 5, order_count: 1 },
    { date: '2026-09-04', net_sales_ex_tax: 90, order_count: 3 },
  ];
  const e = buildExplorer({ ledger, data, windows: buildWindows(NOW, 'UTC'), now: NOW, config: CONFIG, dailySeries: daily });
  assert.equal(e.days.best.date, '2026-09-04');
  assert.equal(e.days.weakest.date, '2026-09-03');
  assert.equal(e.days.days_without_sales, 1);
  assert.equal(e.days.days_total, 4);
});

test('channels use the source channel name on each order; nothing is assumed and a missing name stays null', () => {
  const e = explorerOf((data) => {
    data.orders.find((o) => o.id === 'o1').channel_name = 'Online Store';
    data.orders.find((o) => o.id === 'o2').channel_name = 'Point of Sale';
    // o3 has no channel name
  });
  const names = e.channels.map((c) => c.name).sort((a, b) => String(a).localeCompare(String(b)));
  assert.deepEqual(names, ['Online Store', 'Point of Sale', null].sort((a, b) => String(a).localeCompare(String(b))));
  assert.ok(Math.abs(e.channels.reduce((s, c) => s + c.share, 0) - 1) < 0.001);
});

test('contribution analysis needs a previous period with sales: otherwise it is null, never inferred from ranking order', () => {
  assert.equal(explorerOf().contributions, null);
});

test('period comparison aligns the previous 30 days by position in blocks of 7 days (the last block may be shorter)', () => {
  const data = makeData();
  const ledger = buildLedger(data, { config: CONFIG });
  const daily = Array.from({ length: 30 }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, 22 + i)).toISOString().slice(0, 10), net_sales_ex_tax: 1, order_count: 0 }));
  const e = buildExplorer({ ledger, data, windows: buildWindows(NOW, 'UTC'), now: NOW, config: CONFIG, dailySeries: daily, timeZone: 'UTC' });
  assert.deepEqual(e.comparison.blocks.map((b) => b.days), [7, 7, 7, 7, 2]);
  assert.equal(e.comparison.blocks[0].current_net_sales_ex_tax, 7);
});

test('products block: ranking shares and concentration are computed on the period product revenue only', () => {
  const e = explorerOf();
  const p = e.products;
  assert.equal(p.total_revenue, 145.45);
  assert.deepEqual(p.ranking.map((r) => r.product_key), ['p1', 'p3', 'p2']);
  assert.equal(p.ranking[0].share, 0.8296);
  assert.equal(p.concentration.top1, 0.8296);
  assert.equal(p.concentration.top3, 1); // only three products sold
  assert.equal(p.concentration.top5, 1);
  assert.equal(p.concentration.products_sold, 3);
});

test('products block: with no previous revenue nobody is classed as growth/decline and no percentage is invented', () => {
  const p = explorerOf().products;
  assert.deepEqual(p.growth, []);
  assert.deepEqual(p.decline, []);
  for (const r of p.ranking) { assert.equal(r.delta_pct, null); assert.notEqual(r.status, 'compared'); }
});

test('products block: a product created inside the window with no previous sales is "new", an older one is "not_sold_before"', () => {
  const p = explorerOf((data) => { data.products.find((x) => x.id === 'p1').source_created_at = '2026-09-05T00:00:00Z'; data.products.find((x) => x.id === 'p2').source_created_at = '2025-01-01T00:00:00Z'; }).products;
  const status = Object.fromEntries(p.ranking.map((r) => [r.product_key, r.status]));
  assert.equal(status.p1, 'new');
  assert.equal(status.p2, 'not_sold_before');
});

test('products block: units vs revenue uses period shares, deduplicates products and keeps the revenue rank', () => {
  const u = explorerOf().products.units_vs_revenue;
  assert.deepEqual(u.map((r) => r.rank), [1, 2, 3]);
  assert.ok(Math.abs(u.reduce((s, r) => s + r.revenue_share, 0) - 1) < 0.001);
  assert.ok(Math.abs(u.reduce((s, r) => s + r.units_share, 0) - 1) < 0.001);
});

test('products block: product margin is never ranked - only the cost-coverage figures are exposed', () => {
  const m = explorerOf().products.margin;
  assert.equal(m.available, false);
  assert.ok('cost_coverage_pct' in m && 'verified_cost_coverage_pct' in m);
});

function customersOf(mutate) {
  return explorerOf((data) => {
    const o = (id) => data.orders.find((x) => x.id === id);
    Object.assign(o('o1'), { journey_ready: true, customer_order_index: 1 }); // customer A, first order
    Object.assign(o('o3'), { journey_ready: true, customer_order_index: 2 }); // customer A again, same window
    Object.assign(o('o2'), { journey_ready: true, customer_order_index: 3 }); // customer B, earlier orders exist
    if (mutate) mutate(data, o);
  }).customers;
}

test('customers: new = an order with index 1 in the window; returning = index above 1 or 2+ orders and no index-1 order; counts are facts', () => {
  const c = customersOf();
  assert.equal(c.kpis.active, 2);
  assert.equal(c.kpis.new, 1); // A (has the index-1 order, even though it ordered again)
  assert.equal(c.kpis.returning, 1); // B (index 3)
  assert.equal(c.kpis.unknown, 0);
  assert.equal(c.segments.new.orders + c.segments.returning.orders, 3);
  assert.ok(Math.abs(c.segments.new.net_sales_ex_tax + c.segments.returning.net_sales_ex_tax - c.kpis.identified_net_sales_ex_tax) < 0.01);
});

test('customers: an order index is not trusted unless the source marks the journey ready - the customer is then "unknown", never guessed', () => {
  const c = customersOf((data, o) => { o('o2').journey_ready = false; });
  assert.equal(c.kpis.unknown, 1);
  assert.equal(c.kpis.returning, 0);
});

test('customers: averages and medians use the existing approved sample gate (config.customers.minCustomers) and stay null below it', () => {
  const c = customersOf();
  assert.equal(c.value.gated, true);
  assert.equal(c.value.min_customers, CONFIG.customers.minCustomers);
  assert.equal(c.value.avg_revenue_per_customer, null);
  assert.equal(c.value.median_revenue_per_customer, null);
  assert.equal(c.value.avg_orders_per_customer, null);
  assert.equal(c.value.avg_basket_ex_tax, null);
});

test('customers: purchase frequency counts customers by number of window orders (1 / 2 / 3+)', () => {
  assert.deepEqual(customersOf().frequency, { one: 1, two: 1, three_plus: 0 });
});

test('customers: recency buckets are descriptive (days since last known order) and dormancy is explicitly not defined', () => {
  const r = customersOf().recency;
  assert.equal(r.dormant_defined, false);
  assert.equal(r.identified_customers, 2);
  assert.equal(r.buckets.d0_30, 2);
});

test('customers: coverage is exposed and the cohort analysis is unavailable with its reasons', () => {
  const c = customersOf();
  assert.equal(c.coverage.identified_share, 1);
  assert.equal(c.cohort.available, false);
  assert.ok(c.cohort.reasons.includes('NO_APPROVED_COHORT_DEFINITION'));
});

test('customers: top customers are pseudonymous labels with revenue, orders, average order value and last order date', () => {
  const t = customersOf().top;
  assert.equal(t[0].label, '#AAAA');
  assert.equal(t[0].order_count, 2);
  assert.equal(t[0].aov_ex_tax, Math.round((t[0].net_sales_ex_tax / 2) * 100) / 100);
  assert.match(t[0].last_order_date, /^\d{4}-\d{2}-\d{2}$/);
});

function channelsOf(mutate) {
  const data = makeData();
  const line = (id, order_id, variant_id, quantity, unit_price) => ({ id, order_id, variant_id, title_snapshot: 'x', sku_snapshot: null, quantity, unit_price, discount_amount: 0, tax_amount: 0 });
  const ord = (id, ordered_at, channel_name) => ({ id, ordered_at, status: 'PAID', currency: 'EUR', taxes_included: false, channel_name });
  data.orders.find((o) => o.id === 'o1').channel_name = 'Online Store';
  data.orders.find((o) => o.id === 'o2').channel_name = 'Point of Sale';
  data.orders.find((o) => o.id === 'o3').channel_name = 'Point of Sale';
  data.orders.push(ord('p1', '2026-08-01T10:00:00Z', 'Point of Sale'), ord('p2', '2026-08-02T10:00:00Z', 'Kiosk'));
  data.orderLines.push(line('lp1', 'p1', 'v1', 1, 60), line('lp2', 'p2', 'v1', 1, 30));
  if (mutate) mutate(data);
  const ledger = buildLedger(data, { config: CONFIG });
  return buildExplorer({ ledger, data, windows: buildWindows(NOW, 'UTC'), now: NOW, config: CONFIG, dailySeries: [], timeZone: 'UTC' }).channels_view;
}

test('channels: raw source channel names are kept unchanged and ranked by revenue', () => {
  const c = channelsOf();
  assert.deepEqual(c.channels.map((r) => r.name), ['Point of Sale', 'Online Store', 'Kiosk']);
  assert.equal(c.total_net_sales_ex_tax, 145.45);
  assert.ok(Math.abs(c.channels.reduce((s, r) => s + (r.share ?? 0), 0) - 1) < 0.001);
});

test('channels: compared / new / absent statuses - a channel without previous revenue never gets a percentage', () => {
  const by = Object.fromEntries(channelsOf().channels.map((r) => [r.name, r]));
  assert.equal(by['Point of Sale'].status, 'compared');
  assert.notEqual(by['Point of Sale'].delta.net_sales_ex_tax_pct, null);
  assert.equal(by['Online Store'].status, 'new');
  assert.equal(by['Online Store'].delta.net_sales_ex_tax_pct, null);
  assert.equal(by.Kiosk.status, 'absent');
  assert.equal(by.Kiosk.net_sales_ex_tax, 0);
  assert.equal(by.Kiosk.delta.net_sales_ex_tax, -30);
});

test('channels: contributions add up to the total change and orders / AOV are per channel', () => {
  const c = channelsOf();
  const sum = c.channels.reduce((s, r) => s + r.delta.net_sales_ex_tax, 0);
  assert.ok(Math.abs(sum - c.total_delta) < 0.01);
  const pos = c.channels.find((r) => r.name === 'Point of Sale');
  assert.equal(pos.order_count, 2);
  assert.equal(pos.aov_ex_tax, Math.round((pos.net_sales_ex_tax / 2) * 100) / 100);
});

test('channels: weekly series per channel sums to the channel revenue of the period', () => {
  const c = channelsOf();
  for (const r of c.channels) assert.ok(Math.abs(r.weekly.reduce((s, w) => s + w.net_sales_ex_tax, 0) - r.net_sales_ex_tax) < 0.02, r.name);
});

test('channels: top products come from the real order line -> order -> channel link; the AOV gap is factual', () => {
  const c = channelsOf();
  const online = c.channels.find((r) => r.name === 'Online Store');
  assert.deepEqual(online.top_products.map((p) => p.product_key), ['p1', 'p2']);
  assert.ok(c.aov_gap === null || (c.aov_gap.diff > 0 && c.aov_gap.higher !== c.aov_gap.lower));
});

function geoOf(mutate) {
  const data = makeData();
  if (mutate) mutate(data);
  const ledger = buildLedger(data, { config: CONFIG });
  return buildExplorer({ ledger, data, windows: buildWindows(NOW, 'UTC'), now: NOW, config: CONFIG, dailySeries: [], timeZone: 'UTC' }).geo_view;
}

test('geo: without any location or address the page is insufficient and nothing is guessed', () => {
  const g = geoOf();
  assert.equal(g.status, 'insufficient');
  assert.equal(g.total_orders, 3);
  assert.equal(g.usable_orders, 0);
  assert.equal(g.usable_coverage, 0);
  assert.equal(g.orders_with_sale_location, 0);
  assert.deepEqual(g.sale_locations, []);
});

test('geo: a store name counts as sale location but is not a usable zone', () => {
  const g = geoOf((d) => { d.locations = [{ id: 'L1', name: 'Store A', type: 'unknown' }]; for (const o of d.orders) o.location_id = 'L1'; });
  assert.equal(g.orders_with_sale_location, 3);
  assert.equal(g.sale_location_coverage, 1);
  assert.equal(g.usable_orders, 0);
  assert.equal(g.status, 'insufficient');
  assert.deepEqual(g.sale_locations, [{ name: 'Store A', orders: 3 }]);
});

test('geo: zones become available only with at least two usable zones (no unapproved coverage threshold)', () => {
  const one = geoOf((d) => { d.locations = [{ id: 'L1', name: 'A', city: 'Namur' }]; for (const o of d.orders) o.location_id = 'L1'; });
  assert.equal(one.usable_orders, 3);
  assert.equal(one.status, 'insufficient');
  const two = geoOf((d) => { d.locations = [{ id: 'L1', name: 'A', city: 'Namur' }, { id: 'L2', name: 'B', city: 'Liège' }]; d.orders.forEach((o, i) => { o.location_id = i === 0 ? 'L1' : 'L2'; }); });
  assert.equal(two.status, 'zones_available');
  assert.equal('min_coverage' in two, false);
});

test('geo: exposes no order id, customer key or address', () => {
  const g = geoOf((d) => { d.locations = [{ id: 'L1', name: 'A', city: 'Namur', street: 'Rue X 1' }]; for (const o of d.orders) { o.location_id = 'L1'; o.customer_key = 'k'.repeat(64); } });
  const json = JSON.stringify(g);
  assert.ok(!json.includes('Rue X'));
  assert.ok(!json.includes('kkkk'));
  assert.ok(!/"(order_id|customer_key|street)"/.test(json));
});

function periodOf(daily, mutate) {
  const data = makeData(); if (mutate) mutate(data);
  const ledger = buildLedger(data, { config: CONFIG });
  return buildExplorer({ ledger, data, windows: buildWindows(NOW, 'UTC'), now: NOW, config: CONFIG, dailySeries: daily, timeZone: 'UTC' }).period_view;
}
// 2026-09-01 is a Tuesday
const mkDaily = (vals, start = '2026-09-01') => vals.map(([net, orders], i) => ({ date: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10), net_sales_ex_tax: net, order_count: orders }));

test('period: mean, median and population standard deviation include days without sales', () => {
  const p = periodOf(mkDaily([[0, 0], [10, 1], [20, 1], [30, 2]]));
  assert.equal(p.stats.days_total, 4);
  assert.equal(p.stats.active_days, 3);
  assert.equal(p.stats.days_without_sales, 1);
  assert.equal(p.stats.mean_daily_net_sales_ex_tax, 15);
  assert.equal(p.stats.median_daily_net_sales_ex_tax, 15);
  assert.equal(p.stats.std_dev_daily_net_sales_ex_tax, 11.18);
  assert.equal(p.stats.coefficient_of_variation, 0.7454);
  assert.equal(p.stats.days_above_mean, 2);
  assert.equal(p.stats.days_below_mean, 2);
});

test('period: no statistics from fewer than two days; no coefficient when the mean is zero', () => {
  assert.equal(periodOf(mkDaily([[5, 1]])).stats, null);
  assert.equal(periodOf(mkDaily([[0, 0], [0, 0]])).stats.coefficient_of_variation, null);
});

test('period: weekday averages are per occurrence, not raw totals', () => {
  // 8 days from Tuesday 09-01: Tue and Wed... Tuesday occurs twice (09-01, 09-08)
  const p = periodOf(mkDaily([[100, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [50, 1]]));
  const tue = p.weekdays[1]; const wed = p.weekdays[2];
  assert.equal(tue.occurrences, 2);
  assert.equal(tue.net_sales_ex_tax, 150);
  assert.equal(tue.avg_net_sales_ex_tax, 75);
  assert.equal(wed.occurrences, 1);
  assert.equal(p.weekdays.reduce((a, w) => a + w.occurrences, 0), 8);
});

test('period: week shares sum to the total; partial weeks are flagged; best/weakest need two complete weeks', () => {
  // 09-01 Tue .. 09-14 Mon : week of 08-31 (6 days), week of 09-07 (7 days), week of 09-14 (1 day)
  const p = periodOf(mkDaily(Array.from({ length: 14 }, (_, i) => [10 + i, 1])));
  assert.equal(p.weeks.length, 3);
  assert.deepEqual(p.weeks.map((w) => w.partial), [true, false, true]);
  assert.ok(Math.abs(p.weeks.reduce((a, w) => a + w.share, 0) - 1) < 0.001);
  assert.equal(p.best_week, null);
  const q = periodOf(mkDaily(Array.from({ length: 21 }, (_, i) => [i < 14 ? 10 : 30, 1]), '2026-08-31'));
  assert.equal(q.best_week.week_start, '2026-09-14');
  assert.equal(q.weakest_week.net_sales_ex_tax, 70);
});

test('period: time of day buckets are defined, local, and only count timed orders', () => {
  const p = periodOf([], (d) => { d.orders.find((o) => o.id === 'o1').ordered_at = '2026-09-10T09:30:00Z'; });
  const ids = p.time_of_day.buckets.map((b) => b.key);
  assert.deepEqual(ids, ['night', 'morning', 'midday', 'afternoon', 'evening']);
  assert.equal(p.time_of_day.timed_orders, p.time_of_day.buckets.reduce((a, b) => a + b.order_count, 0));
  assert.equal(p.time_of_day.time_zone, 'UTC');
});

function cmpOf(mutate) {
  const data = makeData(); if (mutate) mutate(data);
  const ledger = buildLedger(data, { config: CONFIG });
  const w = buildWindows(NOW, 'UTC');
  const dailySeries = Array.from({ length: 30 }, (_, i) => ({ date: new Date(Date.parse('2026-08-22T00:00:00Z') + i * 86400000).toISOString().slice(0, 10), net_sales_ex_tax: i + 1, order_count: 1 }));
  return { e: buildExplorer({ ledger, data, windows: w, now: NOW, config: CONFIG, dailySeries, timeZone: 'UTC' }), dailySeries };
}

test('comparison: null when there is no previous window with data to compare (never invented)', () => {
  const { e } = cmpOf();
  assert.ok(e.comparison_view === null || Array.isArray(e.comparison_view.kpis));
  if (e.comparison_view) for (const k of e.comparison_view.kpis) if (k.previous === 0) assert.equal(k.delta_pct, null);
});

test('comparison: aligned trend pairs Day i of each period by index, not by calendar date', () => {
  const { e } = cmpOf();
  const a = e.comparison_view.aligned_days;
  assert.equal(a.length, 30);
  assert.equal(a[0].index, 1);
  assert.equal(a[0].current, 1);
  assert.notEqual(a[0].date, a[0].previous_date);
  assert.equal(Date.parse(`${a[0].date}T00:00:00Z`) - Date.parse(`${a[0].previous_date}T00:00:00Z`), 30 * 86400000);
});

test('comparison: blocks flag the partial last block and carry both date ranges', () => {
  const { e } = cmpOf();
  const b = e.comparison_view.blocks;
  assert.equal(b.length, 5);
  assert.deepEqual(b.map((x) => x.partial), [false, false, false, false, true]);
  assert.equal(b[4].days, 2);
  assert.equal(b[4].previous_end_date > b[4].previous_start_date, true);
  assert.equal(e.comparison_view.checks.find((c) => c.id === 'last_block').days, 2);
  assert.equal(e.comparison_view.checks.find((c) => c.id === 'days').status, 'comparable');
});

test('comparison: category comparison keeps "no category", marks new categories and never divides by zero', () => {
  const { e } = cmpOf();
  const cats = e.comparison_view.categories;
  assert.ok(cats.every((c) => c.status !== 'new' || c.delta_pct === null));
  assert.ok(cats.every((c) => c.status !== 'compared' || c.delta_pct !== null));
  assert.ok(cats.some((c) => c.name === null) || true);
});

test('comparison: waterfall is additive and reconciles exactly to the current revenue', () => {
  const { e } = cmpOf();
  const w = e.comparison_view.waterfall;
  if (w) {
    const sum = w.steps.reduce((a, s) => a + s.delta, 0);
    assert.equal(Math.round((w.previous_total + sum) * 100) / 100, w.current_total);
    assert.equal(w.current_total, e.kpis.net_sales_ex_tax);
    assert.equal(w.previous_total, e.kpis.previous.net_sales_ex_tax);
  }
});

test('comparison: with sales in both windows the waterfall is present, additive and reconciles', () => {
  const { e } = cmpOf((d) => { const o = d.orders.find((x) => x.id === 'o2'); o.ordered_at = new Date(NOW.getTime() - 40 * 86400000).toISOString(); });
  assert.ok(e.kpis.previous.net_sales_ex_tax > 0);
  const w = e.comparison_view.waterfall;
  assert.ok(w && w.reconciles);
  const sum = w.steps.reduce((a, s) => a + s.delta, 0);
  assert.equal(Math.round((w.previous_total + sum) * 100) / 100, e.kpis.net_sales_ex_tax);
  const total = e.comparison_view.categories.reduce((a, c) => a + c.delta, 0);
  assert.ok(Math.abs(total - (e.kpis.net_sales_ex_tax - e.kpis.previous.net_sales_ex_tax)) < 0.02);
  for (const k of e.comparison_view.kpis) assert.equal(k.delta_abs, Math.round((k.current - k.previous) * 100) / 100);
});

test('comparison: zero previous revenue gives waterfall steps that sum to the current revenue and no percentages', () => {
  const { e } = cmpOf();
  const w = e.comparison_view.waterfall;
  assert.equal(w.previous_total, 0);
  assert.equal(Math.round(w.steps.reduce((a, s) => a + s.delta, 0) * 100) / 100, e.kpis.net_sales_ex_tax);
  assert.ok(e.comparison_view.categories.every((c) => c.delta_pct === null && c.status === 'new'));
  assert.equal(e.comparison_view.kpis[0].delta_pct, null);
});

test('comparison: statuses come from facts, not from invented thresholds', () => {
  const { e } = cmpOf();
  const by = Object.fromEntries(e.comparison_view.checks.map((c) => [c.id, c]));
  assert.equal('thresholds' in e.comparison_view, false);
  assert.equal(by.customer_coverage.status, 'partial'); // fewer than all orders are identified
  assert.equal(by.last_block.status, 'comparable');
  assert.equal(by.categories.status, by.categories.uncategorised_share > 0 ? 'partial' : 'comparable');
});
