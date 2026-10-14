import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { loadDataset } from '../src/metrics/load.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { windowFacts, aggregate } from '../src/metrics/sales.js';
import { mergeConfig } from '../src/metrics/config.js';

// Analyses Phase 0, defect A: a refund issued INSIDE the analysis window on an order placed BEFORE it used to disappear,
// because the loader filtered orders by date and fetched refunds only through the loaded order ids. SYNTHETIC data only.
// Order O: 2026-07-01, 100.00 tax-included (VAT 17.36 -> ex-tax 82.64). Refund R on 2026-09-20: 30.00 (VAT 5.21 -> ex-tax 24.79).
const config = mergeConfig();
const M = randomUUID(); const OTHER = randomUUID();
const ts = (d) => `${d}T10:00:00Z`;

async function seed({ orderStatus = 'PAID', merchant = M } = {}) {
  const supabase = createFakeSupabase(); const ids = { product: randomUUID(), variant: randomUUID(), order: randomUUID(), line: randomUUID(), refund: randomUUID(), recent: randomUUID(), recentLine: randomUUID() };
  await supabase.insert('products', [{ id: ids.product, merchant_id: merchant, title: 'Fixture', product_type: 'T', source_system: 'shopify', source_id: 'p' }]);
  await supabase.insert('variants', [{ id: ids.variant, merchant_id: merchant, product_id: ids.product, sku: 'S', title: 'D', source_system: 'shopify', source_id: 'v' }]);
  const order = (id, at, status = 'PAID') => ({ id, merchant_id: merchant, source_system: 'shopify', source_id: id, ordered_at: ts(at), currency: 'EUR', status, taxes_included: true, is_test: false, customer_key: 'c1', channel_handle: 'web' });
  await supabase.insert('orders', [order(ids.order, '2026-07-01', orderStatus), order(ids.recent, '2026-09-18')]);
  const line = (id, orderId, price, tax) => ({ id, order_id: orderId, merchant_id: merchant, variant_id: ids.variant, source_system: 'shopify', source_id: id, title_snapshot: 'Fixture', quantity: 1, unit_price: price, discount_amount: 0, tax_amount: tax });
  await supabase.insert('order_lines', [line(ids.line, ids.order, 100, 17.36), line(ids.recentLine, ids.recent, 50, 8.68)]);
  await supabase.insert('refunds', [{ id: ids.refund, order_id: ids.order, merchant_id: merchant, source_system: 'shopify', source_id: 'r', amount: 30, refunded_at: ts('2026-09-20') }]);
  await supabase.insert('refund_lines', [{ id: randomUUID(), refund_id: ids.refund, order_line_id: ids.line, merchant_id: merchant, quantity: 1, amount: 30, tax_amount: 5.21, currency: 'EUR' }]);
  return { supabase, ids };
}
const since = new Date('2026-08-04T00:00:00Z'); // the report's 60-day look-back from 2026-10-03: the July order is OUTSIDE it
const window = { start: new Date('2026-09-14T00:00:00Z'), end: new Date('2026-09-21T00:00:00Z') };

test('A1. a refund inside the window on an older order is loaded and counted by refund date (-24.79 ex-tax), the old order is not a sale', async () => {
  const { supabase } = await seed(); const data = await loadDataset(supabase, M, { since });
  assert.equal(data.refunds.length, 1, 'the refund is loaded although its order is older than `since`');
  assert.equal(data.refundLines.length, 1);
  assert.equal(data.orders.length, 1, 'only the recent order is an order of the window; the old one is context, not history');
  const ledger = buildLedger(data, { config });
  assert.equal(ledger.orders.length, 1); assert.equal(ledger.lineFacts.length, 1, 'the old order contributes no sale line');
  const w = windowFacts(ledger, window); const a = aggregate(w.lines, w.refunds, config);
  assert.equal(a.net_sales_ex_tax, 50 - 8.68 - 24.79, 'recent sale 41.32 minus the refund ex-tax 24.79');
  assert.equal(a.refunds, 30);
  assert.equal(w.orders.length, 1, 'order count is not inflated by the context order');
});

test('A2. the refund-only window shows a NEGATIVE net (-24.79) and zero orders, exactly as the refund-date definition says', async () => {
  const { supabase } = await seed(); const ledger = buildLedger(await loadDataset(supabase, M, { since }), { config });
  const w = windowFacts(ledger, { start: new Date('2026-09-19T00:00:00Z'), end: new Date('2026-09-21T00:00:00Z') }); const a = aggregate(w.lines, w.refunds, config);
  assert.equal(a.net_sales_ex_tax, -24.79); assert.equal(w.orders.length, 0);
  assert.ok(ledger.refundFacts.every((r) => typeof r.outsideWindowOrder === 'boolean'), 'context refunds are labelled');
  assert.equal(ledger.refundFacts[0].outsideWindowOrder, true);
});

test('A3. the context order does not pollute history: orders, first-order date and customer scope stay window-bound', async () => {
  const { supabase } = await seed(); const data = await loadDataset(supabase, M, { since });
  assert.deepEqual(data.orders.map((o) => o.ordered_at), [ts('2026-09-18')]);
  assert.equal(data.refundContext.orders.length, 1); assert.equal(data.refundContext.orderLines.length, 1);
  assert.deepEqual(data.refundContext.orders[0].ordered_at, ts('2026-07-01'));
});

test('A4. a refund on an order that is excluded (VOIDED) is NOT counted, and the exclusion is surfaced', async () => {
  const { supabase } = await seed({ orderStatus: 'VOIDED' }); const ledger = buildLedger(await loadDataset(supabase, M, { since }), { config });
  const w = windowFacts(ledger, window); assert.equal(aggregate(w.lines, w.refunds, config).refunds, 0);
  assert.equal(ledger.excluded.refundsOnExcludedOrders, 1, 'the dropped refund is counted, never silently ignored');
});

test('A5. another merchant\'s refund in the same window is never loaded', async () => {
  const { supabase } = await seed({ merchant: OTHER }); const data = await loadDataset(supabase, M, { since });
  assert.equal(data.refunds.length, 0); assert.equal(data.refundContext.orders.length, 0); assert.equal(data.orders.length, 0);
});

test('A6. a refund whose order is already in the window is not loaded twice', async () => {
  const { supabase, ids } = await seed();
  await supabase.insert('refunds', [{ id: randomUUID(), order_id: ids.recent, merchant_id: M, source_system: 'shopify', source_id: 'r2', amount: 10, refunded_at: ts('2026-09-19') }]);
  const data = await loadDataset(supabase, M, { since });
  assert.equal(data.refunds.length, 2); assert.equal(new Set(data.refunds.map((r) => r.id)).size, 2);
  assert.equal(data.refundContext.orders.length, 1, 'only the old order is context');
});
