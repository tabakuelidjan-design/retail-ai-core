import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig } from '../src/metrics/config.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { buildProductPerformance, buildRankings, buildSegments } from '../src/metrics/products.js';
import { computeSalesMetrics } from '../src/metrics/sales.js';
import { buildWindows } from '../src/metrics/windows.js';
import { detectCashRisks } from '../src/signals/cash-risk.js';
import { detectCommercialCandidates } from '../src/signals/commercial.js';
import { CONFIG, FULL_WINDOW, makeData } from './fixtures/metrics-sample.js';

const NOW = new Date('2026-09-21T09:00:00Z');
const ledgerOf = (data, config = CONFIG) => buildLedger(data, { config });
const metrics = (data, config = CONFIG, window = FULL_WINDOW) => computeSalesMetrics(ledgerOf(data, config), window);
const productRows = (data, config = CONFIG) => buildProductPerformance(ledgerOf(data, config), FULL_WINDOW, NOW);
const row = (rows, id) => rows.find((r) => r.product_key === id);

test('gross sales, discounts, refunds and units are summed from lines and refund lines', () => {
  const m = metrics(makeData());
  assert.equal(m.order_count, 3);
  assert.equal(m.units_sold, 5);
  assert.equal(m.gross_sales, 180); // 50 + 10 + 20 + 100
  assert.equal(m.discounts, 5);
  assert.equal(m.refunds, 20); // product-line refund only
  assert.equal(m.units_refunded, 1);
  assert.equal(m.net_sales, 155); // 180 - 5 - 20
});

test('tax-inclusive orders: net sales ex tax removes the real captured tax, tax-exclusive orders do not', () => {
  const m = metrics(makeData());
  // ex-tax before refund: (50-5-7.81) + (10-1.74) + (20-3.47) + 100 = 161.98 ; refund ex tax = 20 - 3.47 = 16.53
  assert.equal(m.net_sales_ex_tax, 145.45);
  assert.equal(m.tax, 30.55); // (7.81+1.74+3.47+21) - refunded tax 3.47
});

test('refund outside product lines (shipping/adjustment) is reported apart from net sales', () => {
  assert.equal(metrics(makeData()).refunds_non_product, 5);
});

test('partial refund: only the refunded portion reduces revenue, cost of the refunded unit is not recovered by default', () => {
  const rows = productRows(makeData());
  const p1 = row(rows, 'p1');
  assert.equal(p1.units_sold, 3);
  assert.equal(p1.units_refunded, 1);
  assert.equal(p1.refund_rate, 0.3333);
  assert.equal(p1.net_sales_ex_tax, 120.66); // 37.19 + 100 - 16.53
  assert.equal(p1.cogs, 30); // 3 units x 10, refund does not give the cost back
});

test("cogsRefundTreatment 'restocked' recovers the cost of refunded units", () => {
  const p1 = row(productRows(makeData(), mergeConfig({ cogsRefundTreatment: 'restocked' })), 'p1');
  assert.equal(p1.cogs, 20);
});

test('missing cost -> UNCLASSIFIED profit, but revenue metrics stay valid', () => {
  const p3 = row(productRows(makeData()), 'p3');
  assert.equal(p3.net_sales_ex_tax, 16.53);
  assert.equal(p3.cost_status, 'MISSING');
  assert.equal(p3.gross_profit.status, 'UNCLASSIFIED');
  assert.equal(p3.gross_profit.value, null);
  assert.equal(p3.contribution_margin_v0.value, null);
  assert.equal(p3.cogs, null);
  assert.equal(p3.unclassified_revenue_ex_tax, 16.53);
});

test('mixed classified/unclassified totals are PARTIAL, expose coverage and never present a clean number', () => {
  const m = metrics(makeData());
  assert.equal(m.gross_profit.status, 'PARTIAL');
  assert.equal(m.cost_coverage_pct, 0.898); // 145.45 classified / 161.98 total
  assert.equal(m.unclassified_revenue_ex_tax, 16.53);
  assert.equal(m.cogs, 34); // 2x10 + 1x4 + 1x10
  assert.equal(m.gross_profit.value, 111.45); // 145.45 - 34
  assert.equal(m.contribution_margin_v0.value, 94.92); // 111.45 - 16.53 refund ex tax
  assert.equal(m.gross_profit.certain, false);
  assert.ok(m.gross_profit.caveats.includes('COST_UNVERIFIED'));
  assert.ok(m.gross_profit.caveats.some((c) => c.startsWith('PARTIAL_COST_COVERAGE')));
});

test('verified cost only: gross profit is CALCULATED and certain; contribution margin still carries the payment-fee caveat', () => {
  const data = makeData();
  data.orderLines = data.orderLines.filter((l) => ['l1', 'l4'].includes(l.id)); // V1 only, verified cost
  data.refundLines = [];
  data.refunds = [];
  const m = metrics(data);
  assert.equal(m.gross_profit.status, 'CALCULATED');
  assert.equal(m.gross_profit.cost_confidence, 'VERIFIED');
  assert.equal(m.gross_profit.certain, true);
  assert.equal(m.gross_profit.value, 107.19); // (37.19 + 100) - 3 x 10
  assert.equal(m.contribution_margin_v0.certain, false);
  assert.ok(m.contribution_margin_v0.caveats.includes('PAYMENT_FEES_NOT_INCLUDED'));
  assert.equal(m.payment_fees.status, 'UNAVAILABLE');
});

test('estimated cost carries its caveat forward and is never certain', () => {
  const data = makeData();
  data.costs = data.costs.map((c) => (c.variant_id === 'v1' ? { ...c, validation_status: 'estimated' } : c));
  const p1 = row(productRows(data), 'p1');
  assert.equal(p1.contribution_margin_v0.cost_confidence, 'ESTIMATED_OR_STALE');
  assert.ok(p1.contribution_margin_v0.caveats.includes('COST_ESTIMATED_OR_STALE'));
  assert.equal(p1.gross_profit.certain, false);
});

test('a cost recorded only after the sale is applied with an explicit history caveat', () => {
  const data = makeData();
  data.costs = data.costs.map((c) => ({ ...c, effective_from: '2026-09-18T00:00:00Z' }));
  const p1 = row(productRows(data), 'p1');
  assert.ok(p1.gross_profit.caveats.includes('COST_IS_CURRENT_COST_APPLIED_TO_HISTORY'));
  assert.equal(p1.gross_profit.certain, false);
});

test('a non-positive or wrong-currency cost is treated as missing, never used', () => {
  const zero = makeData();
  zero.costs = zero.costs.map((c) => (c.variant_id === 'v2' ? { ...c, unit_cost: 0 } : c));
  assert.equal(row(productRows(zero), 'p2').cost_status, 'MISSING');
  const usd = makeData();
  usd.costs = usd.costs.map((c) => (c.variant_id === 'v2' ? { ...c, currency: 'USD' } : c));
  assert.equal(row(productRows(usd), 'p2').cost_status, 'MISSING');
});

test('contribution margin v0 = classified net sales ex tax - COGS (discounts and refunds already netted)', () => {
  const p1 = row(productRows(makeData()), 'p1');
  assert.equal(p1.contribution_margin_v0.value, 90.66); // 120.66 - 30
  assert.equal(p1.contribution_margin_v0.margin_pct, 0.7514); // 90.66 / 120.66
  assert.equal(p1.contribution_margin_v0.status, 'CALCULATED');
});

test('zero sales window returns zeros and null ratios, not errors or invented profit', () => {
  const empty = { ...FULL_WINDOW, start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-09-01T00:00:00Z') };
  const m = metrics(makeData(), CONFIG, empty);
  assert.equal(m.order_count, 0);
  assert.equal(m.gross_sales, 0);
  assert.equal(m.net_sales, 0);
  assert.equal(m.aov, null);
  assert.equal(m.cost_coverage_pct, null);
  assert.equal(m.gross_profit.status, 'NO_SALES');
  assert.equal(m.gross_profit.margin_pct, null);
});

test('voided orders are not sales', () => {
  const data = makeData();
  data.orders.find((o) => o.id === 'o2').status = 'VOIDED';
  const m = metrics(data);
  assert.equal(m.order_count, 2);
  assert.equal(m.gross_sales, 160);
});

test('product performance: sold products aggregate, unsold products with stock still appear', () => {
  const rows = productRows(makeData());
  assert.equal(row(rows, 'p1').stock_units, 5);
  const idle = row(rows, 'p4');
  assert.equal(idle.units_sold, 0);
  assert.equal(idle.stock_units, 15);
  assert.equal(idle.inventory_value_at_cost.value, 30); // 15 x 2.00
  assert.equal(idle.inventory_value_at_cost.cost_confidence, 'ESTIMATED');
  assert.equal(idle.days_since_last_sale, null);
});

test('rankings skip UNCLASSIFIED profit rows and order deterministically', () => {
  const rankings = buildRankings(productRows(makeData()), 10);
  assert.deepEqual(rankings.top_revenue.map((r) => r.product_key), ['p1', 'p3', 'p2']);
  assert.ok(!rankings.top_gross_profit.some((r) => r.product_key === 'p3'));
  assert.equal(rankings.top_contribution_margin[0].product_key, 'p1');
});

test('segments expose facts with their criteria', () => {
  const segments = buildSegments(productRows(makeData()), CONFIG);
  assert.deepEqual(segments.stock_with_no_recent_sales.items.map((i) => i.product_key), ['p4']);
  assert.deepEqual(segments.sales_with_missing_cost.items.map((i) => i.product_key), ['p3']);
  assert.match(segments.stock_with_no_recent_sales.criteria, /units_sold = 0/);
  assert.deepEqual(segments.high_refunds.items.map((i) => i.product_key), ['p1']);
});

test('commercial candidate: refund rate above the limit blocks it; relaxing the criteria admits it with a capped confidence', () => {
  const window = FULL_WINDOW;
  assert.equal(detectCommercialCandidates(productRows(makeData()), CONFIG, window).length, 0);

  const relaxed = mergeConfig({ candidate: { maxRefundRate: 0.5 } });
  const [c] = detectCommercialCandidates(productRows(makeData(), relaxed), relaxed, window);
  assert.equal(c.signal, 'COMMERCIAL_CANDIDATE');
  assert.equal(c.product_key, 'p1');
  assert.equal(c.confidence, 'MEDIUM'); // verified cost (HIGH) but only 3 units < 4 -> one step down
  assert.ok(c.reason_codes.includes('COST_VERIFIED'));
  assert.ok(c.reason_codes.includes('STOCK_AVAILABLE'));
  assert.equal(c.evidence.units_sold, 3);
});

test('commercial candidate: unverified cost caps confidence at MEDIUM and says so; missing cost is never a candidate', () => {
  const data = makeData();
  data.orderLines.find((l) => l.id === 'l2').quantity = 5;
  data.orderLines.find((l) => l.id === 'l2').tax_amount = 8.68;
  const candidates = detectCommercialCandidates(productRows(data), CONFIG, FULL_WINDOW);
  const p2 = candidates.find((c) => c.product_key === 'p2');
  assert.equal(p2.confidence, 'MEDIUM');
  assert.ok(p2.reason_codes.includes('COST_UNVERIFIED'));
  assert.ok(!candidates.some((c) => c.product_key === 'p3'));
});

test('cash-risk signals: no recent sales, high stock/low velocity, missing cost, negative margin', () => {
  const risks = detectCashRisks(productRows(makeData()), CONFIG, FULL_WINDOW);
  const codes = (id) => risks.find((r) => r.product_key === id)?.reason_codes ?? [];
  assert.deepEqual(codes('p4'), ['NO_RECENT_SALES_WITH_STOCK']);
  assert.ok(codes('p2').includes('HIGH_STOCK_LOW_VELOCITY')); // stock 20, 1 unit sold
  assert.ok(codes('p3').includes('MISSING_COST'));
  assert.equal(risks.find((r) => r.product_key === 'p4').evidence.inventory_value_at_cost.value, 30);

  const data = makeData();
  data.costs = data.costs.map((c) => (c.variant_id === 'v2' ? { ...c, unit_cost: 12 } : c)); // above its ex-tax price 8.26
  const negative = detectCashRisks(productRows(data), CONFIG, FULL_WINDOW);
  assert.ok(negative.find((r) => r.product_key === 'p2').reason_codes.includes('NEGATIVE_MARGIN'));
});

test('timezone windows: local calendar days in the merchant zone, DST-safe, zone is a parameter', () => {
  const w = buildWindows(new Date('2026-09-21T09:00:00Z'), 'Europe/Brussels');
  assert.equal(w.yesterday.start.toISOString(), '2026-09-19T22:00:00.000Z'); // local 2026-09-20 00:00 (UTC+2)
  assert.equal(w.yesterday.end.toISOString(), '2026-09-20T22:00:00.000Z');
  assert.equal(w.last_30_days.start.toISOString(), '2026-08-21T22:00:00.000Z');

  // 22:30Z on the 20th is already the 21st in Brussels: "today" is the 21st there, still the 20th in UTC.
  const late = buildWindows(new Date('2026-09-20T22:30:00Z'), 'Europe/Brussels');
  assert.equal(late.yesterday.localStart, '2026-09-20');
  assert.equal(buildWindows(new Date('2026-09-20T22:30:00Z'), 'UTC').yesterday.localStart, '2026-09-19');

  // DST ends 2026-10-25 in Europe/Brussels: a 7-day window is 7 local days, not 168 hours.
  const dst = buildWindows(new Date('2026-10-30T12:00:00Z'), 'Europe/Brussels');
  assert.equal(dst.last_7_days.start.toISOString(), '2026-10-22T22:00:00.000Z'); // 23 Oct 00:00 CEST
  assert.equal(dst.last_7_days.end.toISOString(), '2026-10-29T23:00:00.000Z'); // 30 Oct 00:00 CET
  assert.equal(buildWindows(NOW, 'America/New_York').yesterday.start.toISOString(), '2026-09-20T04:00:00.000Z');
});

test('available window spans the source order window through now', () => {
  const w = buildWindows(NOW, 'Europe/Brussels');
  assert.equal(w.available_window.end, NOW);
  assert.equal(w.available_window.localStart, '2026-07-23');
});

test('test orders are excluded from every sales metric and counted as excluded', () => {
  const data = makeData();
  data.orders.find((o) => o.id === 'o2').is_test = true;
  const ledger = ledgerOf(data);
  const m = computeSalesMetrics(ledger, FULL_WINDOW);
  assert.equal(m.order_count, 2);
  assert.equal(m.gross_sales, 160);
  assert.equal(ledger.excluded.test, 1);
  assert.equal(row(buildProductPerformance(ledger, FULL_WINDOW, NOW), 'p3').units_sold, 0);
});
