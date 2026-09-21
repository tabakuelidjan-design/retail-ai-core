// Synthetic 8-week dataset for the demand & inventory tests - entirely made up.
// Timezone UTC, NOW = 2026-09-21T09:00Z, so the 8 weekly buckets start on
// 2026-07-27 (week 0, oldest) and end on 2026-09-21 00:00 (week 7, newest).
//
// Product      type     created     weekly sales (week: units per order)              stock
// pA Steady    Alpha    2026-03-01  wk0,1,3,4,6,7: 1 unit each (6 orders)              12   verified cost 5.00
// pB One order Alpha    2026-03-01  wk2: 5 units in ONE order                          50   unverified cost
// pC Spike     Beta     2026-03-01  wk4: two orders of 3 units                         2
// pD Sparse    Beta     2026-03-01  wk1: 1, wk6: 1                                     10
// pE New       (none)   2026-09-08  wk7: 2 units                                       5    no cost
// pF No sales  Alpha    2026-03-01  -                                                  20
// pG No stock  Alpha    2026-03-01  -                                                  0
// pH Rising    Beta     2026-03-01  wk2: 1, wk5: 1, wk6: 2, wk7: 2                      30
// pI Falling   Beta     2026-03-01  wk0: 2, wk1: 2, wk2: 1, wk6: 1                     30

import { mergeConfig } from '../../src/metrics/config.js';

export const NOW = new Date('2026-09-21T09:00:00Z');
export const TZ = 'UTC';
export const CONFIG = mergeConfig();

const WEEK0 = Date.UTC(2026, 6, 27);
const at = (week, hours = 10) => new Date(WEEK0 + week * 7 * 86400000 + hours * 3600000).toISOString();

export function makeDemandData() {
  const products = [
    ['pA', 'Steady', 'Alpha', '2026-03-01T00:00:00Z'], ['pB', 'One order', 'Alpha', '2026-03-01T00:00:00Z'],
    ['pC', 'Spike', 'Beta', '2026-03-01T00:00:00Z'], ['pD', 'Sparse', 'Beta', '2026-03-01T00:00:00Z'],
    ['pE', 'New', null, '2026-09-08T00:00:00Z'], ['pF', 'No sales', 'Alpha', '2026-03-01T00:00:00Z'],
    ['pG', 'No stock', 'Alpha', '2026-03-01T00:00:00Z'], ['pH', 'Rising', 'Beta', '2026-03-01T00:00:00Z'],
    ['pI', 'Falling', 'Beta', '2026-03-01T00:00:00Z'],
  ].map(([id, title, product_type, source_created_at]) => ({ id, title, product_type, source_created_at, source_status: 'ACTIVE' }));

  const variants = products.map((p) => ({ id: `v${p.id.slice(1)}`, product_id: p.id, sku: 'SHARED', title: 'Default' })); // same SKU everywhere on purpose
  const stock = { pA: 12, pB: 50, pC: 2, pD: 10, pE: 5, pF: 20, pG: 0, pH: 30, pI: 30 };
  const snapshots = variants.map((v) => ({ id: `s-${v.id}`, variant_id: v.id, location_id: 'loc1', quantity: stock[v.product_id], synced_at: '2026-09-21T06:00:00Z' }));
  const costs = [
    { variant_id: 'vA', unit_cost: 5, currency: 'EUR', effective_from: '2026-01-01T00:00:00Z', source: 'manual_entry', validation_status: 'verified' },
    ...['vB', 'vC', 'vD', 'vF', 'vG', 'vH', 'vI'].map((variant_id) => ({
      variant_id, unit_cost: 2, currency: 'EUR', effective_from: '2026-01-01T00:00:00Z', source: 'shopify_unit_cost', validation_status: 'unverified',
    })),
  ];

  const sales = [
    ['pA', 0, 1], ['pA', 1, 1], ['pA', 3, 1], ['pA', 4, 1], ['pA', 6, 1], ['pA', 7, 1],
    ['pB', 2, 5], ['pC', 4, 3], ['pC', 4, 3], ['pD', 1, 1], ['pD', 6, 1], ['pE', 7, 2],
    ['pH', 2, 1], ['pH', 5, 1], ['pH', 6, 2], ['pH', 7, 2],
    ['pI', 0, 2], ['pI', 1, 2], ['pI', 2, 1], ['pI', 6, 1],
  ];
  const orders = [];
  const orderLines = [];
  sales.forEach(([pid, week, qty], i) => {
    orders.push({ id: `o${i}`, ordered_at: at(week, 10 + (i % 5)), status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false });
    orderLines.push({
      id: `l${i}`, order_id: `o${i}`, variant_id: `v${pid.slice(1)}`, title_snapshot: pid, sku_snapshot: 'SHARED',
      quantity: qty, unit_price: 20, discount_amount: 0, tax_amount: Math.round(qty * 3.47 * 100) / 100,
    });
  });

  const collections = [
    { product_id: 'pA', source_id: 'c1', title: 'Featured', is_current: true }, { product_id: 'pA', source_id: 'c2', title: 'Seasonal', is_current: true },
    { product_id: 'pB', source_id: 'c1', title: 'Featured', is_current: true }, { product_id: 'pC', source_id: 'c2', title: 'Seasonal', is_current: true },
  ];
  return { products, variants, orders, orderLines, refunds: [], refundLines: [], costs, snapshots, collections };
}

/** An order placed today, after the last complete day (07:00Z on 2026-09-21). */
export function todaysOrder(qty = 1, variantId = 'vA') {
  return {
    order: { id: 'oToday', ordered_at: '2026-09-21T07:00:00Z', status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false },
    line: { id: 'lToday', order_id: 'oToday', variant_id: variantId, title_snapshot: 'today', sku_snapshot: 'SHARED', quantity: qty, unit_price: 20, discount_amount: 0, tax_amount: 3.47 * qty },
  };
}
