import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger } from '../src/metrics/ledger.js';
import { buildWindows } from '../src/metrics/windows.js';
import { buildExplorer } from '../src/report/explorer.js';
import { mergeConfig } from '../src/metrics/config.js';

// Found by the Phase 0 serving benchmark: a customer whose only activity in the window is a REFUND on an earlier order (a very common case at
// every window boundary) crashed Explorer (`meta[0].at` of an empty list) and was counted as an ACTIVE customer. SYNTHETIC data only.
const NOW = new Date('2026-10-03T10:00:00Z'); const config = mergeConfig();
const order = (id, key, at) => ({ id, customer_key: key, ordered_at: at, status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false, channel_handle: 'web', channel_name: 'Online Store', customer_order_index: 1, journey_ready: true });
const line = (id, orderId, price, tax) => ({ id, order_id: orderId, variant_id: null, title_snapshot: 'X', quantity: 1, unit_price: price, discount_amount: 0, tax_amount: tax });
function explorerOf() {
  const data = {
    products: [], variants: [], costs: [], snapshots: [], refundContext: { orders: [], orderLines: [] },
    orders: [order('old', 'kOld', '2026-08-20T10:00:00Z'), order('new1', 'kNew', '2026-09-20T10:00:00Z')],
    orderLines: [line('lOld', 'old', 100, 17.36), line('lNew', 'new1', 50, 8.68)],
    refunds: [{ id: 'r1', order_id: 'old', amount: 30, refunded_at: '2026-09-25T10:00:00Z' }],
    refundLines: [{ id: 'rl1', refund_id: 'r1', order_line_id: 'lOld', quantity: 1, amount: 30, tax_amount: 5.21 }],
    firstOrderAt: '2026-08-20T10:00:00Z',
  };
  const ledger = buildLedger(data, { config }); const windows = buildWindows(NOW, 'Europe/Brussels');
  return buildExplorer({ ledger, data, windows, now: NOW, config, dailySeries: [], timeZone: 'Europe/Brussels' });
}

test('R1. a refund-only customer does not crash the Explorer', () => { assert.doesNotThrow(() => explorerOf()); });

test('R2. a customer is ACTIVE only if they ordered in the window: the refund-only customer is not counted', () => {
  const ex = explorerOf();
  assert.equal(ex.kpis.active_customers, 1); assert.equal(ex.customers.kpis.active, 1);
  assert.equal(ex.customers.kpis.new + ex.customers.kpis.returning + ex.customers.kpis.unknown, 1);
});

test('R3. the refund is not lost: it is shown as its own bucket and the identified net still reconciles with the buckets', () => {
  const ex = explorerOf(); const k = ex.customers.kpis;
  assert.deepEqual([k.refund_only.customers, k.refund_only.net_sales_ex_tax], [1, -24.79]);
  const seg = ex.customers.segments; const r2 = (x) => Math.round(x * 100) / 100;
  assert.equal(r2(seg.new.net_sales_ex_tax + seg.returning.net_sales_ex_tax + seg.unknown.net_sales_ex_tax + k.refund_only.net_sales_ex_tax), r2(k.identified_net_sales_ex_tax), 'buckets add up to the identified net');
  assert.equal(ex.kpis.net_sales_ex_tax, 50 - 8.68 - 24.79, 'the period total keeps the refund (refund-date semantics)');
});

test('R4. customer rows list active customers only, each with a real last order date', () => {
  const ex = explorerOf(); const rows = ex.top_customers.rows;
  assert.equal(rows.length, 1);
  for (const r of rows) assert.ok(r.order_count > 0, 'a row without an order would be a refund-only customer');
});
