// Synthetic dataset for the metric engine tests - entirely made up, no real
// merchant data. Hand-computed expectations live in test/metrics.test.js.
//
// Orders (all EUR):
//   o1  2026-09-10  tax-inclusive   L1: V1 x2 @25.00 disc 5.00 tax 7.81 | L2: V2 x1 @10.00 tax 1.74
//   o2  2026-09-12  tax-inclusive   L3: V3 x1 @20.00 tax 3.47   (V3 has no cost row)
//   o3  2026-09-12  tax-EXCLUSIVE   L4: V1 x1 @100.00 tax 21.00
// Refund r1 on o1: 1 unit of L1, line amount 20.00 (tax-inclusive) tax 3.47, refund total 25.00 (5.00 shipping).
// Costs: V1 10.00 verified, V2 4.00 unverified, V4 2.00 estimated, V3 none (all effective 2026-01-01).
// Stock (latest snapshot 2026-09-20): V1 5, V2 20, V3 3, V4 15. P4 ("Idle") never sells.

import { mergeConfig } from '../../src/metrics/config.js';

export const CONFIG = mergeConfig();

export function makeData() {
  const cost = (variant_id, unit_cost, validation_status) => ({
    variant_id, unit_cost, currency: 'EUR', effective_from: '2026-01-01T00:00:00Z', source: 'shopify_unit_cost', validation_status,
  });
  const line = (id, order_id, variant_id, quantity, unit_price, discount_amount, tax_amount, title) => ({
    id, order_id, variant_id, title_snapshot: title, sku_snapshot: null, quantity, unit_price, discount_amount, tax_amount,
  });
  const snap = (variant_id, quantity) => ({ id: `s-${variant_id}`, variant_id, location_id: 'loc1', quantity, synced_at: '2026-09-20T12:00:00Z' });

  return {
    products: [
      { id: 'p1', title: 'Fixture Widget' }, { id: 'p2', title: 'Fixture Gadget' },
      { id: 'p3', title: 'Fixture Gizmo' }, { id: 'p4', title: 'Fixture Idle' },
    ],
    variants: [
      { id: 'v1', product_id: 'p1', sku: 'W-1', title: 'Default' }, { id: 'v2', product_id: 'p2', sku: 'G-1', title: 'Default' },
      { id: 'v3', product_id: 'p3', sku: 'Z-1', title: 'Default' }, { id: 'v4', product_id: 'p4', sku: 'I-1', title: 'Default' },
    ],
    orders: [
      { id: 'o1', ordered_at: '2026-09-10T10:00:00Z', status: 'PARTIALLY_REFUNDED', currency: 'EUR', taxes_included: true },
      { id: 'o2', ordered_at: '2026-09-12T10:00:00Z', status: 'PAID', currency: 'EUR', taxes_included: true },
      { id: 'o3', ordered_at: '2026-09-12T15:00:00Z', status: 'PAID', currency: 'EUR', taxes_included: false },
    ],
    orderLines: [
      line('l1', 'o1', 'v1', 2, 25, 5, 7.81, 'Fixture Widget'),
      line('l2', 'o1', 'v2', 1, 10, 0, 1.74, 'Fixture Gadget'),
      line('l3', 'o2', 'v3', 1, 20, 0, 3.47, 'Fixture Gizmo'),
      line('l4', 'o3', 'v1', 1, 100, 0, 21, 'Fixture Widget'),
    ],
    refunds: [{ id: 'r1', order_id: 'o1', amount: 25, refunded_at: '2026-09-15T09:00:00Z' }],
    refundLines: [{ id: 'rl1', refund_id: 'r1', order_line_id: 'l1', quantity: 1, amount: 20, tax_amount: 3.47 }],
    costs: [cost('v1', 10, 'verified'), cost('v2', 4, 'unverified'), cost('v4', 2, 'estimated')],
    snapshots: [snap('v1', 5), snap('v2', 20), snap('v3', 3), snap('v4', 15)],
  };
}

/** A window covering the whole fixture history. */
export const FULL_WINDOW = {
  key: 'available_window', timeZone: 'UTC',
  start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-10-01T00:00:00Z'),
};
