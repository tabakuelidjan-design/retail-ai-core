import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemandFacts } from '../src/demand/build.js';
import { classifyPattern, classifyTrend, computeCover, sellThrough } from '../src/demand/classify.js';
import { concentrationOf } from '../src/demand/categories.js';
import { mergeConfig } from '../src/metrics/config.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { buildWeekBuckets } from '../src/metrics/windows.js';
import { CONFIG, NOW, TZ, makeDemandData, todaysOrder } from './fixtures/demand-sample.js';

function facts(mutate, { config = CONFIG, salesReconciled = true } = {}) {
  const data = makeDemandData();
  if (mutate) mutate(data);
  const ledger = buildLedger(data, { config });
  return buildDemandFacts({ ledger, data, now: NOW, timeZone: TZ, config, salesReconciled });
}
const product = (f, id) => f.products.find((p) => p.product_key === id);
const variant = (f, id) => f.variants.find((v) => v.variant_id === id);

test('week buckets: 8 contiguous local-midnight weeks ending at today, DST-safe', () => {
  const b = buildWeekBuckets(NOW, TZ, 8);
  assert.equal(b.length, 8);
  assert.equal(b[0].start.toISOString(), '2026-07-27T00:00:00.000Z');
  assert.equal(b[7].end.toISOString(), '2026-09-21T00:00:00.000Z');
  for (let i = 1; i < b.length; i += 1) assert.equal(b[i].start.getTime(), b[i - 1].end.getTime());

  const dst = buildWeekBuckets(new Date('2026-10-30T12:00:00Z'), 'Europe/Brussels', 8);
  for (let i = 1; i < dst.length; i += 1) assert.equal(dst[i].start.getTime(), dst[i - 1].end.getTime());
  assert.equal(dst[7].end.toISOString(), '2026-10-29T23:00:00.000Z'); // 30 Oct 00:00 CET
  assert.ok(dst.some((w) => w.end - w.start === 7 * 86400000 + 3600000)); // the week containing the DST change is 169h
});

test('sales pattern: single order, one-off spike, intermittent, consistent, insufficient history, no sales', () => {
  const f = facts();
  assert.equal(product(f, 'pA').demand.pattern, 'CONSISTENT');
  assert.equal(product(f, 'pB').demand.pattern, 'SINGLE_ORDER'); // 5 units but one order
  assert.equal(product(f, 'pC').demand.pattern, 'ONE_OFF_SPIKE'); // two orders, one week
  assert.equal(product(f, 'pD').demand.pattern, 'INTERMITTENT');
  assert.equal(product(f, 'pE').demand.pattern, 'INSUFFICIENT_HISTORY'); // added 2 weeks ago
  assert.equal(product(f, 'pF').demand.pattern, 'NO_SALES');
  assert.equal(product(f, 'pA').demand.pattern_evidence.active_weeks, 6);
});

test('velocity, units per order and weekly series are exact', () => {
  const a = product(facts(), 'pA').demand;
  assert.deepEqual(a.weekly_units, [1, 1, 0, 1, 1, 0, 1, 1]);
  assert.equal(a.units_8w, 6);
  assert.equal(a.velocity_8w, 0.75);
  assert.equal(a.velocity_4w, 0.75); // weeks 4..7 hold 3 units
  assert.deepEqual(product(facts(), 'pB').demand.units_per_order, { median: 5, max: 5 });
  assert.equal(a.avg_net_unit_price_ex_tax, 16.53); // 20.00 - 3.47 tax
});

test('exposure: a product added mid-window is only measured over the weeks it existed', () => {
  const e = product(facts(), 'pE');
  assert.equal(e.exposure_weeks, 1.86); // 6/7 of week 6 + week 7
  assert.equal(e.observable_weeks, 2);
  assert.equal(e.inventory.inventory_class, 'TOO_NEW'); // never called slow
  assert.equal(e.inventory.cover_status, 'INSUFFICIENT_HISTORY');
});

test('trend direction needs history and volume; UP / DOWN / FLAT from the recent vs prior half', () => {
  const f = facts();
  assert.equal(product(f, 'pH').demand.trend.direction, 'UP'); // 1 unit prior 4 weeks, 5 recent
  assert.equal(product(f, 'pI').demand.trend.direction, 'DOWN'); // 5 prior, 1 recent
  assert.equal(product(f, 'pA').demand.trend.direction, 'FLAT'); // 3 vs 3
  assert.equal(product(f, 'pD').demand.trend.direction, 'INSUFFICIENT_DATA'); // 2 units
  assert.equal(product(f, 'pE').demand.trend.reason, 'OBSERVABLE_WEEKS_BELOW_MIN');
});

test('weeks of cover = stock / weekly velocity; unavailable (never infinite) without demand or a usable sample', () => {
  const f = facts();
  assert.equal(product(f, 'pA').inventory.weeks_of_cover, 16); // 12 / 0.75
  assert.equal(product(f, 'pA').inventory.days_of_cover, 112);
  assert.equal(product(f, 'pF').inventory.cover_status, 'NO_DEMAND_OBSERVED');
  assert.equal(product(f, 'pF').inventory.weeks_of_cover, null);
  assert.equal(product(f, 'pD').inventory.cover_status, 'INSUFFICIENT_SALES_SAMPLE'); // 2 units < 3
  assert.equal(product(f, 'pG').inventory.cover_status, 'NO_STOCK');
});

test('inventory classes are facts about stock vs demand', () => {
  const f = facts();
  const cls = (id) => product(f, id).inventory.inventory_class;
  assert.equal(cls('pA'), 'ACTIVE_COVER'); // 16 weeks
  assert.equal(cls('pB'), 'SLOW_COVER'); // 50 / 0.625 = 80 weeks
  assert.equal(cls('pC'), 'LOW_COVER'); // 2 / 0.75 = 2.7 weeks
  assert.equal(cls('pD'), 'LIMITED_SALES_SAMPLE');
  assert.equal(cls('pF'), 'NO_SALE_IN_WINDOW');
  assert.equal(cls('pG'), 'NO_STOCK');
  assert.equal(cls('pE'), 'TOO_NEW');
});

test('sell-through = sold / (sold + stock), counting sales through the stock snapshot moment', () => {
  assert.equal(sellThrough({ units: 6, stockUnits: 12 }).rate, 0.3333);
  assert.equal(sellThrough({ units: 0, stockUnits: 0 }).rate, null);
  // Shopify's own reported figure for a real product: 6 sold, 17 ending -> 0.2609
  assert.equal(sellThrough({ units: 6, stockUnits: 17 }).rate, 0.2609);
  const f = facts((d) => { const t = todaysOrder(1); d.orders.push(t.order); d.orderLines.push(t.line); });
  const a = product(f, 'pA');
  assert.equal(a.demand.units_8w, 6); // today is not a complete day: not in the weekly series
  assert.equal(a.inventory.units_since_window_end, 1);
  assert.equal(a.inventory.sell_through.rate, 0.3684); // 7 / (7 + 12)
});

test('categories: product_type is a partition with an explicit UNCLASSIFIED bucket; collections overlap and say so', () => {
  const f = facts();
  const alpha = f.categories.product_type.find((c) => c.category === 'Alpha');
  const beta = f.categories.product_type.find((c) => c.category === 'Beta');
  const none = f.categories.product_type.find((c) => c.category === 'UNCLASSIFIED');
  assert.equal(alpha.products_total, 4);
  assert.equal(alpha.demand.units_8w, 11);
  assert.equal(alpha.demand.orders_8w, 7);
  assert.equal(beta.demand.units_8w, 20);
  assert.equal(none.products_total, 1); // pE: never guessed into a category
  assert.equal(alpha.overlapping, false);
  const c1 = f.categories.collection.find((c) => c.category === 'Featured');
  assert.equal(c1.overlapping, true);
  assert.equal(c1.demand.units_8w, 11); // pA + pB
  assert.equal(product(f, 'pA').collections.length, 2);
  assert.equal(alpha.benchmarks.status, 'THIN'); // only 2 selling products in Alpha (< 3 peers)
  assert.equal(beta.benchmarks.status, 'USABLE'); // 4 selling products
  assert.equal(beta.benchmarks.median_units_per_order, 1.5); // per-product medians 3, 1, 1.5, 1.5
});

test('an order counted once per category even when two of its products sit in that category', () => {
  const f = facts((d) => {
    d.orders.push({ id: 'oMix', ordered_at: '2026-09-10T10:00:00Z', status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false });
    d.orderLines.push(
      { id: 'lm1', order_id: 'oMix', variant_id: 'vA', title_snapshot: 'a', quantity: 1, unit_price: 20, discount_amount: 0, tax_amount: 3.47 },
      { id: 'lm2', order_id: 'oMix', variant_id: 'vB', title_snapshot: 'b', quantity: 1, unit_price: 20, discount_amount: 0, tax_amount: 3.47 },
    );
  });
  const alpha = f.categories.product_type.find((c) => c.category === 'Alpha');
  assert.equal(alpha.demand.orders_8w, 8); // 7 before + 1 shared order, not 9
});

test('revenue concentration: top-N shares, Pareto counts and HHI', () => {
  const c = concentrationOf([{ v: 50 }, { v: 30 }, { v: 15 }, { v: 5 }, { v: 0 }], (x) => x.v);
  assert.equal(c.items_with_value, 4);
  assert.equal(c.top_1, 0.5);
  assert.equal(c.top_3, 0.95);
  assert.equal(c.items_for_50pct, 1);
  assert.equal(c.items_for_80pct, 2);
  assert.equal(c.hhi, 0.365); // .25 + .09 + .0225 + .0025
  assert.equal(concentrationOf([], (x) => x).top_1, null);
  const f = facts();
  assert.equal(f.concentration.products_by_units.items_with_value, 7);
  assert.equal(f.concentration.products_by_units.top_3, 0.5455); // 18 of 33 units
  assert.equal(f.concentration.unclassified_revenue_share, 0.0606); // pE: 2 of 33 units, same price
});

test('stock exposure: units and value by class, with units that have no cost kept out of the value', () => {
  const s = facts().stock_exposure;
  assert.equal(s.total_units, 159); // 12+50+2+10+5+20+0+30+30
  assert.equal(s.units_without_cost, 5); // pE has no cost
  assert.equal(s.value_status, 'PARTIAL');
  assert.equal(s.by_inventory_class.SLOW_COVER.units, 110); // pB 50 (80 weeks) + pH 30 + pI 30 (40 weeks each)
  assert.equal(s.by_inventory_class.TOO_NEW.units_without_cost, 5);
  assert.equal(s.value_at_cost, 12 * 5 + (50 + 2 + 10 + 20 + 30 + 30) * 2); // verified 5.00 + unverified 2.00
});

test('stock quality: round quantities are marked suspect and limit cover and capital signals', () => {
  const f = facts((d) => { d.snapshots.find((s) => s.variant_id === 'vB').quantity = 200; });
  const b = product(f, 'pB');
  assert.equal(b.inventory.stock_quality, 'SUSPECT_ROUND_QUANTITY');
  assert.equal(b.gates.cover.status, 'LIMITED');
  assert.ok(b.gates.capital_exposure_value.reasons.includes('STOCK_QUANTITY_SUSPECT_ROUND_QUANTITY'));
  assert.equal(b.reorder_facts.status, 'LIMITED');
  assert.equal(product(f, 'pA').inventory.stock_quality, 'UNVERIFIED'); // never VERIFIED without a physical count
});

test('stale or missing stock snapshots are flagged, not trusted', () => {
  const stale = facts((d) => { d.snapshots.forEach((s) => { s.synced_at = '2026-09-10T06:00:00Z'; }); });
  assert.equal(product(stale, 'pA').inventory.stock_quality, 'STALE');
  assert.ok(product(stale, 'pA').reorder_facts.reasons.includes('STOCK_QUANTITY_STALE'));
  const none = facts((d) => { d.snapshots = []; });
  assert.equal(product(none, 'pA').inventory.stock_quality, 'NO_STOCK_DATA');
});

test('gates: margin stays GATED without verified all-in cost; capital value stays GATED on unverified or missing cost', () => {
  const f = facts();
  const a = product(f, 'pA'); // verified cost, but the merchant has not confirmed unit cost is all-in
  assert.equal(a.gates.margin.status, 'GATED');
  assert.deepEqual(a.gates.margin.reasons, ['UNIT_COST_NOT_CONFIRMED_ALL_IN']);
  // Verified cost and every unit costed: value is usable, but the quantity was never physically counted - said explicitly.
  assert.equal(a.gates.capital_exposure_value.status, 'OPEN');
  assert.deepEqual(a.gates.capital_exposure_value.caveats, ['STOCK_QUANTITY_NOT_PHYSICALLY_VERIFIED']);
  const b = product(f, 'pB');
  assert.ok(b.gates.margin.reasons.includes('COST_NOT_VERIFIED'));
  assert.ok(b.gates.capital_exposure_value.reasons.includes('COST_NOT_VERIFIED'));
  const e = product(f, 'pE');
  assert.ok(e.gates.capital_exposure_value.reasons.includes('STOCK_UNITS_WITHOUT_COST'));
  assert.equal(product(f, 'pG').gates.capital_exposure_value.status, 'NOT_APPLICABLE');
});

test('gates open only when the merchant confirms all-in unit cost AND cost is verified', () => {
  const cfg = mergeConfig({ gates: { unitCostIsAllInVariableCost: true } });
  const a = product(facts(null, { config: cfg }), 'pA');
  assert.equal(a.gates.margin.status, 'OPEN');
  assert.deepEqual(a.gates.margin.reasons, []);
  assert.deepEqual(a.gates.margin.caveats, ['PAYMENT_FEES_NOT_INCLUDED']);
  assert.equal(a.gates.capital_exposure_value.status, 'OPEN'); // verified cost, all units costed, quantity UNVERIFIED (not suspect)
  assert.equal(product(facts(null, { config: cfg }), 'pB').gates.margin.status, 'GATED'); // unverified cost
});

test('provenance: sales history status reflects reconciliation and history length', () => {
  assert.equal(facts().input_status.sales_history, 'PARTIAL'); // reconciled but only 55 days
  assert.equal(facts(null, { salesReconciled: false }).input_status.sales_history, 'UNVERIFIED');
  assert.ok(facts(null, { salesReconciled: false }).gates.demand.reasons.includes('SALES_NOT_RECONCILED_WITH_SOURCE'));
  const f = facts();
  assert.deepEqual(f.gates.demand.caveats, ['HISTORY_55_DAYS_UNDER_90']);
  assert.equal(product(f, 'pE').input_status.category, 'UNCLASSIFIED');
  assert.equal(product(f, 'pA').input_status.category, 'PRODUCT_TYPE');
  assert.equal(product(f, 'pA').input_status.cost_on_sales, 'VERIFIED');
  assert.equal(product(f, 'pB').input_status.cost_on_sales, 'UNVERIFIED');
  assert.equal(product(f, 'pE').input_status.cost_on_stock, 'MISSING');
});

test('reorder-relevant facts: SUFFICIENT only with a repeatable pattern, repeat orders, a computable cover and trustworthy stock; reasons say why not', () => {
  const f = facts();
  assert.equal(product(f, 'pA').reorder_facts.status, 'SUFFICIENT');
  assert.equal(product(f, 'pA').reorder_facts.facts.velocity_8w, 0.75);
  assert.deepEqual(product(f, 'pB').reorder_facts.reasons, ['PATTERN_SINGLE_ORDER', 'ORDERS_BELOW_MIN']);
  assert.ok(product(f, 'pD').reorder_facts.reasons.includes('COVER_INSUFFICIENT_SALES_SAMPLE'));
  assert.ok(product(f, 'pA').reorder_facts.not_available.includes('supplier_lead_time'));
});

test('SKU is never an identity: every product and variant shares one SKU yet keeps its own demand and stock', () => {
  const f = facts();
  assert.equal(new Set(f.variants.map((v) => v.variant_id)).size, f.variants.length);
  assert.equal(variant(f, 'vA').demand.units_8w, 6);
  assert.equal(variant(f, 'vB').demand.units_8w, 5);
  assert.equal(variant(f, 'vA').inventory.stock_units, 12);
  assert.ok(f.contract.entity_keys.includes('SKU is never a key'));
});

test('pattern and trend classifiers expose the evidence behind every label', () => {
  const p = classifyPattern({ units: 4, orderCount: 3, weeklyUnits: [0, 4, 0, 0, 0, 0, 0, 0], observableWeeks: 8 }, CONFIG.demand);
  assert.equal(p.pattern, 'ONE_OFF_SPIKE');
  assert.equal(p.evidence.top_week_units, 4);
  const t = classifyTrend({ weeklyUnits: [0, 0, 0, 0, 0, 0, 0, 3], observableWeeks: 8 }, CONFIG.demand);
  assert.equal(t.direction, 'INSUFFICIENT_DATA'); // 3 units < 4
  assert.equal(computeCover({ stockUnits: 10, units: 5, exposureWeeks: 5, observableWeeks: 5 }, CONFIG.demand).weeks, 10);
});

test('zero-sales merchant: no crash, honest empty facts', () => {
  const f = facts((d) => { d.orders = []; d.orderLines = []; });
  assert.equal(f.portfolio.demand.units_8w, 0);
  assert.equal(f.portfolio.demand.pattern, 'NO_SALES');
  assert.equal(f.concentration.products_by_revenue.top_1, null);
});
