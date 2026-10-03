import test from 'node:test';
import assert from 'node:assert/strict';
import { syncOrders } from '../src/sync/orders.js';
import { normalizeOrder } from '../src/sync/normalize.js';
import { ORDERS_PAGE_QUERY } from '../src/shopify/queries.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { windowFacts, aggregate } from '../src/metrics/sales.js';
import { mergeConfig } from '../src/metrics/config.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { FAKE_ORDER_1, ordersPage } from './fixtures/shopify-orders-sample.js';
import { makeData } from './fixtures/metrics-sample.js';

// Analyses Phase 0, defect B (cancelled / unsafe statuses, surfaced exclusions), nested Shopify truncation, and the currency choice. SYNTHETIC data only.
const MERCHANT = 'merchant-1';
const clone = (x) => JSON.parse(JSON.stringify(x));
async function seedCatalog(supabase) {
  await supabase.upsert('locations', [{ merchant_id: MERCHANT, source_id: 'gid://shopify/Location/1', name: 'Fixture Store' }], { onConflict: 'merchant_id,source_system,source_id' });
  await supabase.upsert('variants', [1, 2, 3].map((n) => ({ merchant_id: MERCHANT, source_id: `gid://shopify/ProductVariant/${n}` })), { onConflict: 'merchant_id,source_system,source_id' });
}
const lineEdge = (n) => ({ node: { id: `gid://shopify/LineItem/extra-${n}`, title: `Extra ${n}`, sku: null, quantity: 1, variant: { id: 'gid://shopify/ProductVariant/1' }, originalUnitPriceSet: { shopMoney: { amount: '1.00' } }, discountAllocations: [], taxLines: [] } });

// ------------------------------------------------------------------ nested pagination
test('N1. the order query asks for pageInfo on every nested connection and fetches the cancellation fields', () => {
  for (const connection of ['shippingLines', 'lineItems', 'refundShippingLines', 'refundLineItems']) {
    const at = ORDERS_PAGE_QUERY.indexOf(`${connection}(first:`); assert.ok(at > 0, connection);
    const block = ORDERS_PAGE_QUERY.slice(at, at + 1400); assert.match(block, /pageInfo\s*\{\s*hasNextPage\s*endCursor\s*\}/, `${connection} has pageInfo`);
  }
  for (const field of ['cancelledAt', 'closedAt', 'cancelReason']) assert.match(ORDERS_PAGE_QUERY, new RegExp(`\\b${field}\\b`));
});

test('N2. an order with more lines than one page is completed through follow-up pages (no silent truncation)', async () => {
  const supabase = createFakeSupabase(); await seedCatalog(supabase);
  const order = clone(FAKE_ORDER_1); order.lineItems.pageInfo = { hasNextPage: true, endCursor: 'c1' };
  const seen = [];
  const shopify = { async graphql(query, vars) {
    seen.push({ query, vars });
    if (query.includes('orders(')) return ordersPage([order]);
    if (vars.cursor === 'c1') return { order: { lineItems: { edges: [lineEdge(1), lineEdge(2)], pageInfo: { hasNextPage: true, endCursor: 'c2' } } } };
    return { order: { lineItems: { edges: [lineEdge(3)], pageInfo: { hasNextPage: false, endCursor: null } } } };
  } };
  const summary = await syncOrders({ shopify, supabase }, { merchantId: MERCHANT });
  assert.equal(supabase._tables.get('order_lines').length, 2 + 3, 'the two original lines plus three from follow-up pages');
  assert.equal(summary.errors.length, 0); assert.equal(summary.ordersTruncated ?? 0, 0);
  assert.equal(supabase._tables.get('orders')[0].lines_truncated, false);
  assert.equal(seen.filter((s) => !s.query.includes('orders(')).length, 2);
});

test('N3. a refund with more refund lines than one page is completed through follow-up pages', async () => {
  const supabase = createFakeSupabase(); await seedCatalog(supabase);
  const order = clone(FAKE_ORDER_1);
  order.refunds = [{ id: 'gid://shopify/Refund/9', createdAt: '2026-09-20T10:00:00Z', totalRefundedSet: { shopMoney: { amount: '5.00' } }, refundShippingLines: { edges: [] }, refundLineItems: { edges: [{ node: { quantity: 1, subtotalSet: { shopMoney: { amount: '2.00' } }, totalTaxSet: { shopMoney: { amount: '0.00' } }, lineItem: { id: order.lineItems.edges[0].node.id } } }], pageInfo: { hasNextPage: true, endCursor: 'r1' } } }];
  const shopify = { async graphql(query, vars) {
    if (query.includes('orders(')) return ordersPage([order]);
    return { node: { refundLineItems: { edges: [{ node: { quantity: 1, subtotalSet: { shopMoney: { amount: '3.00' } }, totalTaxSet: { shopMoney: { amount: '0.00' } }, lineItem: { id: order.lineItems.edges[1].node.id } } }], pageInfo: { hasNextPage: false, endCursor: null } } } };
  } };
  await syncOrders({ shopify, supabase }, { merchantId: MERCHANT });
  assert.equal(supabase._tables.get('refund_lines').length, 2);
});

test('N4. shipping lines beyond the first page are added to the order shipping', async () => {
  const supabase = createFakeSupabase(); await seedCatalog(supabase);
  const order = clone(FAKE_ORDER_1);
  const ship = (amount) => ({ node: { originalPriceSet: { shopMoney: { amount } }, discountedPriceSet: { shopMoney: { amount } }, taxLines: [] } });
  order.shippingLines = { edges: [ship('4.00')], pageInfo: { hasNextPage: true, endCursor: 's1' } };
  const shopify = { async graphql(query, vars) { if (query.includes('orders(')) return ordersPage([order]); return { order: { shippingLines: { edges: [ship('6.00')], pageInfo: { hasNextPage: false, endCursor: null } } } }; } };
  await syncOrders({ shopify, supabase }, { merchantId: MERCHANT });
  assert.equal(supabase._tables.get('orders')[0].shipping_price, 10);
});

test('N5. a failed follow-up is SURFACED: the order is flagged truncated, counted, and the error is in the summary', async () => {
  const supabase = createFakeSupabase(); await seedCatalog(supabase);
  const order = clone(FAKE_ORDER_1); order.lineItems.pageInfo = { hasNextPage: true, endCursor: 'c1' };
  const shopify = { async graphql(query) { if (query.includes('orders(')) return ordersPage([order]); throw new Error('throttled'); } };
  const summary = await syncOrders({ shopify, supabase }, { merchantId: MERCHANT });
  assert.equal(supabase._tables.get('orders')[0].lines_truncated, true);
  assert.equal(summary.ordersTruncated, 1);
  assert.ok(summary.errors.some((e) => e.startsWith('truncated: ') && e.includes('lineItems') && e.includes('throttled')));
});

test('N6. a node without pageInfo (older payloads, fixtures) behaves exactly as before', async () => {
  const supabase = createFakeSupabase(); await seedCatalog(supabase);
  const summary = await syncOrders({ shopify: { async graphql() { return ordersPage([clone(FAKE_ORDER_1)]); } }, supabase }, { merchantId: MERCHANT });
  assert.equal(supabase._tables.get('order_lines').length, 2); assert.equal(summary.ordersTruncated ?? 0, 0);
});

// ------------------------------------------------------------------ cancellations and statuses
test('B1. normalizeOrder maps the cancellation fields (null when the source gives none)', () => {
  const plain = normalizeOrder(FAKE_ORDER_1, 'm', 'l');
  assert.deepEqual([plain.cancelled_at, plain.closed_at, plain.cancel_reason, plain.lines_truncated], [null, null, null, false]);
  const cancelled = normalizeOrder({ ...FAKE_ORDER_1, cancelledAt: '2026-09-11T08:00:00Z', closedAt: '2026-09-11T08:00:00Z', cancelReason: 'CUSTOMER' }, 'm', 'l');
  assert.deepEqual([cancelled.cancelled_at, cancelled.closed_at, cancelled.cancel_reason], ['2026-09-11T08:00:00Z', '2026-09-11T08:00:00Z', 'CUSTOMER']);
});

test('B2. a cancelled order is not a sale, its refund is not counted, and BOTH exclusions are surfaced', () => {
  const data = makeData(); const config = mergeConfig();
  data.orders[1].cancelled_at = '2026-09-13T08:00:00Z'; // o2 (20.00) cancelled
  const ledger = buildLedger(data, { config });
  assert.equal(ledger.orders.some((o) => o.id === 'o2'), false);
  assert.equal(ledger.excluded.cancelled, 1);
  const w = windowFacts(ledger, { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-10-01T00:00:00Z') });
  assert.equal(w.orders.length, 2); assert.equal(aggregate(w.lines, w.refunds, config).units_sold, 4);
  const withRefund = makeData(); withRefund.orders[0].cancelled_at = '2026-09-11T08:00:00Z'; // o1 has refund r1
  const l2 = buildLedger(withRefund, { config }); assert.equal(l2.excluded.refundsOnExcludedOrders, 1); assert.equal(l2.refundFacts.length, 0);
});

test('B3. EXPIRED is not a sale by default; PENDING and AUTHORIZED still are; the list is explicit config', () => {
  const config = mergeConfig(); assert.deepEqual(config.excludedOrderStatuses, ['VOIDED', 'EXPIRED']);
  const data = makeData(); data.orders[0].status = 'EXPIRED'; data.orders[1].status = 'PENDING'; data.orders[2].status = 'AUTHORIZED';
  const ledger = buildLedger(data, { config });
  assert.deepEqual(ledger.orders.map((o) => o.id), ['o2', 'o3']); assert.equal(ledger.excluded.status, 1);
});

// ------------------------------------------------------------------ currency
test('C1. the ledger currency is chosen among COUNTABLE orders only (test and voided orders never decide it) and a profile currency wins', () => {
  const config = mergeConfig(); const data = makeData();
  const mk = (id, currency, extra = {}) => ({ id, ordered_at: '2026-09-14T10:00:00Z', status: 'PAID', currency, taxes_included: true, ...extra });
  data.orders.push(mk('t1', 'USD', { is_test: true }), mk('t2', 'USD', { is_test: true }), mk('t3', 'USD', { is_test: true }), mk('v1', 'USD', { status: 'VOIDED' }));
  assert.equal(buildLedger(data, { config }).currency, 'EUR', 'four non-countable USD orders must not decide the currency');
  const usd = buildLedger(data, { config, currency: 'USD' }); assert.equal(usd.currency, 'USD');
  assert.equal(buildLedger(data, { config }).excluded.otherCurrency, 0);
});
