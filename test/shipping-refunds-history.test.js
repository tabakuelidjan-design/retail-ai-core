import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRefund, normalizeShipping } from '../src/sync/normalize.js';
import { syncOrders, sinceQuery } from '../src/sync/orders.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { aggregateShipping, computeSalesMetrics } from '../src/metrics/sales.js';
import { buildWindows, comparisonCoverage, previousEquivalentWindow } from '../src/metrics/windows.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { CONFIG, makeData } from './fixtures/metrics-sample.js';
import { FAKE_ORDER_1, ordersPage } from './fixtures/shopify-orders-sample.js';

// SYNTHETIC data only (invented orders and amounts).

const money = (a) => ({ shopMoney: { amount: String(a) } });
const shipLine = (orig, disc, taxes) => ({ originalPriceSet: money(orig), discountedPriceSet: money(disc), taxLines: taxes.map(([rate, amt]) => ({ rate, priceSet: money(amt) })) });
const edges = (nodes) => ({ edges: nodes.map((node) => ({ node })) });

test('shipping normalisation: real price, discount and tax lines - never a hardcoded amount or rate', () => {
  assert.deepEqual(normalizeShipping({ shippingLines: edges([shipLine('7.0', '7.0', [[0.21, '1.21']])]) }), { shipping_price: 7, shipping_discount: 0, shipping_tax: 1.21, shipping_tax_rate_bp: 2100 });
  assert.deepEqual(normalizeShipping({ shippingLines: edges([shipLine('12.5', '5.0', [[0.06, '0.28']])]) }), { shipping_price: 12.5, shipping_discount: 7.5, shipping_tax: 0.28, shipping_tax_rate_bp: 600 });
  assert.deepEqual(normalizeShipping({ shippingLines: edges([]) }), { shipping_price: 0, shipping_discount: 0, shipping_tax: 0, shipping_tax_rate_bp: null }, 'no shipping line = an order without shipping (zero)');
  const mixed = normalizeShipping({ shippingLines: edges([shipLine('5', '5', [[0.21, '0.87']]), shipLine('3', '3', [[0.06, '0.17']])]) });
  assert.equal(mixed.shipping_price, 8); assert.equal(mixed.shipping_tax_rate_bp, null, 'different rates are not collapsed into one');
  assert.deepEqual(normalizeShipping({}), { shipping_price: null, shipping_discount: null, shipping_tax: null, shipping_tax_rate_bp: null }, 'field absent = not captured (NULL), never zero');
});

test('refund normalisation: shipping refund from the source refund shipping lines, product lines untouched', () => {
  const node = { id: 'gid://r/1', createdAt: '2026-09-18T17:49:45Z', totalRefundedSet: money('26.99'), refundShippingLines: edges([{ subtotalAmountSet: money('5.79'), taxAmountSet: money('1.21') }]) };
  const r = normalizeRefund(node, 'order-1', 'm1');
  assert.equal(r.amount, 26.99); assert.equal(r.shipping_subtotal, 5.79); assert.equal(r.shipping_tax, 1.21);
  const legacy = normalizeRefund({ id: 'x', createdAt: '2026-09-18T17:49:45Z', totalRefundedSet: money('5') }, 'order-1', 'm1');
  assert.equal(legacy.shipping_subtotal, null); assert.equal(legacy.shipping_tax, null);
});

// o1 (tax-inclusive) and o3 (tax-exclusive) from the shared fixture, each given real shipping data.
function withShipping() {
  const d = makeData();
  const o1 = d.orders.find((o) => o.id === 'o1'); Object.assign(o1, { order_name: '#1001', shipping_price: 7, shipping_discount: 0, shipping_tax: 1.21, shipping_tax_rate_bp: 2100 });
  const o3 = d.orders.find((o) => o.id === 'o3'); Object.assign(o3, { order_name: '#1003', shipping_price: 10, shipping_discount: 2, shipping_tax: 1.68, shipping_tax_rate_bp: 2100 });
  d.orders.find((o) => o.id === 'o2').order_name = '#1002'; // o2: shipping not captured
  return d;
}
const WIN = { key: 'w', timeZone: 'UTC', start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-10-01T00:00:00Z') };

test('shipping revenue stays separate from product revenue and reconciles with the order totals', () => {
  const d = withShipping();
  d.refunds.forEach((r) => Object.assign(r, { shipping_subtotal: 4.13, shipping_tax: 0.87 })); // the fixture refund carried 5.00 of shipping
  const ledger = buildLedger(d, { config: CONFIG });
  const m = computeSalesMetrics(ledger, WIN);
  const base = computeSalesMetrics(buildLedger(makeData(), { config: CONFIG }), WIN);
  // product metrics are exactly what they were without shipping
  for (const k of ['net_sales', 'net_sales_ex_tax', 'tax', 'gross_sales', 'discounts', 'refunds', 'units_sold']) assert.equal(m[k], base[k], k);
  // o1 (tax incl.): charged 7.00, VAT 1.21, ex-VAT 5.79 | o3 (tax excl.): 10 - 2 = 8.00 ex-VAT, VAT 1.68 on top => 9.68 paid
  assert.equal(m.shipping.charged_incl_tax, 16.68); assert.equal(m.shipping.net_ex_tax, 13.79); assert.equal(m.shipping.tax, 2.89);
  assert.equal(m.shipping.refunds_incl_tax, 5); assert.equal(m.shipping.refunds_ex_tax, 4.13); assert.equal(m.shipping.refunds_tax, 0.87);
  assert.equal(m.shipping.orders_without_shipping_data, 1, 'o2 has no captured shipping: counted, not treated as zero');
  assert.equal(m.shipping.coverage, 'PARTIAL');
  assert.equal(m.totals_with_shipping.net_sales_incl_tax, Math.round((m.net_sales + 16.68 - 5) * 100) / 100);
  assert.equal(m.totals_with_shipping.tax, Math.round((m.tax + 2.89 - 0.87) * 100) / 100);
});

test('refund semantics: product refund, shipping refund and total refund are separate figures on the same refund', () => {
  const d = withShipping();
  d.refunds.forEach((r) => Object.assign(r, { shipping_subtotal: 4.13, shipping_tax: 0.87 }));
  const ledger = buildLedger(d, { config: CONFIG });
  const [t] = ledger.refundTotals;
  assert.equal(t.orderName, '#1001', 'the source order reference is kept');
  assert.equal(t.amount, 25); assert.equal(t.shippingAmount, 5); assert.equal(t.otherAmount, 0);
  assert.equal(Math.round((t.productAmount + t.shippingAmount + t.otherAmount) * 100) / 100, t.amount, 'product + shipping + other = total');
  const m = computeSalesMetrics(ledger, WIN);
  assert.deepEqual(m.refunds_breakdown, { product: m.refunds, shipping: 5, other: 0, total: Math.round((m.refunds + 5) * 100) / 100 });
  assert.equal(m.refunds_non_product, 0, 'no unexplained refund money once shipping is captured');
  // shipping not captured on the refund: the non-product money stays visible as "other" (legacy behaviour), not silently dropped
  const legacy = computeSalesMetrics(buildLedger(makeData(), { config: CONFIG }), WIN);
  assert.equal(legacy.refunds_non_product, 5);
  assert.equal(legacy.refunds_breakdown.shipping, 0);
});

test('aggregateShipping never invents anything for an empty period', () => {
  const z = aggregateShipping([], []);
  assert.equal(z.charged_incl_tax, 0); assert.equal(z.tax, 0); assert.equal(z.refunds_incl_tax, 0); assert.equal(z.orders_with_shipping, 0);
});

test('history coverage: a previous period only partly inside the business history is not a comparable period', () => {
  const now = new Date('2026-09-21T16:00:00Z');
  const partial = buildWindows(now, 'Europe/Brussels', { availableDays: 60, historyStart: '2026-09-05' }).last_30_days;
  const cov = comparisonCoverage(partial);
  assert.equal(cov.sufficient, false);
  assert.equal(cov.current_days, 30); assert.equal(cov.current_days_with_history, 16); assert.equal(cov.previous_days_with_history, 0);
  assert.equal(previousEquivalentWindow(partial), null, 'no comparison window is offered');
  const eleven = { ...partial, localStart: '2026-06-23', localEnd: '2026-09-21', historyStart: '2026-06-12' };
  const c2 = comparisonCoverage(eleven);
  assert.deepEqual([c2.current_days, c2.previous_days, c2.previous_days_with_history, c2.sufficient], [90, 90, 11, false], 'the real HABB case: first sale 11 days before the 90-day window start');
  const full = buildWindows(now, 'Europe/Brussels', { availableDays: 60, historyStart: '2026-01-12' }).last_30_days;
  assert.equal(comparisonCoverage(full).sufficient, true);
  assert.ok(previousEquivalentWindow(full), 'a fully covered previous period is compared normally');
  const unknown = buildWindows(now, 'Europe/Brussels').last_30_days;
  assert.equal(comparisonCoverage(unknown), null, 'history start unknown: nothing asserted');
  assert.ok(previousEquivalentWindow(unknown), 'unchanged behaviour when the history start is unknown');
});

test('order sync keeps shipping, refund shipping and the source reference, and is idempotent (no duplicates, no double shipping)', async () => {
  const supabase = createFakeSupabase();
  await supabase.upsert('locations', [{ merchant_id: 'm1', source_id: 'gid://shopify/Location/1', name: 'Store' }], { onConflict: 'merchant_id,source_system,source_id' });
  await supabase.upsert('variants', [1, 2, 3].map((n) => ({ merchant_id: 'm1', source_id: `gid://shopify/ProductVariant/${n}` })), { onConflict: 'merchant_id,source_system,source_id' });
  const node = structuredClone(FAKE_ORDER_1);
  node.name = '#1065'; node.shippingLines = edges([shipLine('7.0', '7.0', [[0.21, '1.21']])]);
  node.refunds = [{ id: 'gid://shopify/Refund/9', createdAt: '2026-09-18T17:49:45Z', totalRefundedSet: money('7.00'), refundShippingLines: edges([{ subtotalAmountSet: money('5.79'), taxAmountSet: money('1.21') }]), refundLineItems: edges([]) }];
  const shopify = { async graphql(q) { if (q.includes('orders(')) return ordersPage([node]); throw new Error('unexpected'); } };
  const run = () => syncOrders({ shopify, supabase }, { merchantId: 'm1' });
  await run(); await run(); await run();
  const orders = supabase._tables.get('orders'); const refunds = supabase._tables.get('refunds');
  assert.equal(orders.length, 1, 'three syncs, one order'); assert.equal(refunds.length, 1, 'three syncs, one refund');
  assert.deepEqual([orders[0].order_name, orders[0].shipping_price, orders[0].shipping_discount, orders[0].shipping_tax, orders[0].shipping_tax_rate_bp], ['#1065', 7, 0, 1.21, 2100], 'shipping is stored once, not accumulated');
  assert.deepEqual([refunds[0].shipping_subtotal, refunds[0].shipping_tax], [5.79, 1.21]);
  // a later change at the source (shipping refunded afterwards) updates the stored row instead of adding another
  node.shippingLines = edges([shipLine('7.0', '2.0', [[0.21, '0.35']])]);
  await run();
  assert.equal(supabase._tables.get('orders').length, 1); assert.equal(supabase._tables.get('orders')[0].shipping_discount, 5); assert.equal(supabase._tables.get('orders')[0].shipping_tax, 0.35);
});

test('sync window: an explicit --since date reaches further back than the default 60 days and is validated', () => {
  assert.equal(sinceQuery('2026-06-01'), 'created_at:>=2026-06-01');
  assert.throws(() => sinceQuery('06/01/2026'), /YYYY-MM-DD/);
  assert.throws(() => sinceQuery(undefined), /YYYY-MM-DD/);
});

test('null category: exports use the same "Sans catégorie" label as the screen, never an empty or raw null label', () => {
  const src = readFileSync(new URL('../src/analytics-premium/ui/explorer.js', import.meta.url), 'utf8');
  assert.equal((src.match(/\?\? t\('ex\.uncategorised'\)/g) ?? []).length >= 5, true);
  assert.doesNotMatch(src, /\['category', c\.name \?\? ''/);
  assert.doesNotMatch(src, /row\('category', r\.name \?\? ''/);
  const fr = readFileSync(new URL('../src/analytics-premium/ui/lang-fr.js', import.meta.url), 'utf8');
  assert.match(fr, /'ex\.uncategorised': 'Sans catégorie'/);
  assert.match(fr, /'cmp\.insufficientHistory': 'Données historiques insuffisantes'/);
});
