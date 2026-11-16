// NET UNITS of the Growth ranking (src/creative-autonomy/opportunity.js#variantRowsFromDataset). OFFLINE: fixtures copied from the real HABB figures read on 2026-11-15 (orders #1063 #1067 #1070 #1114, #1065), no network.
// order_lines.quantity is GROSS (Shopify lineItem.quantity); refund_lines.quantity is deducted once; a test or cancelled order contributes 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { variantRowsFromDataset, rankAdOpportunities } from '../src/creative-autonomy/opportunity.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const base = (over = {}) => ({
  products: [{ id: 'p1', source_id: 'gid://shopify/Product/1', title: 'Casque Bluetooth Remax RB-300HB pliable' }, { id: 'p2', source_id: 'gid://shopify/Product/2', title: 'Produit annulé' }],
  variants: [{ id: 'v-bleu', product_id: 'p1', source_id: 'gid://shopify/ProductVariant/57206453109084', title: 'Bleu' }, { id: 'v-1065', product_id: 'p2', source_id: 'gid://shopify/ProductVariant/57398927622492', title: 'Défaut' }],
  locations: [{ id: 'L-habb', name: 'Habb' }], orders: [], orderLines: [], refunds: [], refundLines: [], snapshots: [], ...over });
const row = (rows, title) => rows.find((r) => r.variant_title === title);

test('NU-1 order #1065 (cancelled and refunded, 1 unit ordered): 0 net, whether the database has cancelled_at (after the migration) or only the REFUNDED status and the refund line (dev database today); never -1 by a double deduction', () => {
  for (const o of [{ id: 'o1065', ordered_at: '2026-09-14T06:44:28Z', is_test: false, status: 'REFUNDED', cancelled_at: '2026-09-18T17:49:45Z' }, { id: 'o1065', ordered_at: '2026-09-14T06:44:28Z', is_test: false, status: 'REFUNDED' }]) {
    const data = base({ orders: [o], orderLines: [{ id: 'l1065', order_id: 'o1065', variant_id: 'v-1065', quantity: 1 }], refunds: [{ id: 'r1', order_id: 'o1065', refunded_at: '2026-09-18T17:49:45Z' }], refundLines: [{ id: 'rl1', refund_id: 'r1', order_line_id: 'l1065', quantity: 1 }] });
    const r = row(variantRowsFromDataset(data, { now: NOW }), 'Défaut');
    assert.equal(r.units, 0); assert.equal(r.evidence.units_net, 0); assert.equal(r.evidence.units_gross, 1); assert.ok(r.evidence.units_refunded + r.evidence.units_cancelled === 1, 'the unit is deducted ONCE (refund) or marked cancelled, not both');
    assert.equal(r.last_sale, null);
  }
});

test('NU-2 the blue Remax: 4 net units over the exact period (#1063 #1067 #1070 #1114), 6 in stock, snapshot of 2026-11-14 23:00 UTC at the location Habb; flows through the ranking with its evidence', () => {
  const ids = ['#1063:2026-09-12T12:00:43Z', '#1067:2026-09-16T12:01:57Z', '#1070:2026-09-19T11:47:15Z', '#1114:2026-10-26T11:20:45Z'].map((x) => x.split(':').length && [x.slice(0, 5), x.slice(6)]);
  const data = base({ orders: ids.map(([n, t]) => ({ id: n, ordered_at: t, is_test: false, status: 'PAID' })), orderLines: ids.map(([n], i) => ({ id: `l${i}`, order_id: n, variant_id: 'v-bleu', quantity: 1 })),
    snapshots: [{ variant_id: 'v-bleu', location_id: 'L-habb', quantity: 6, synced_at: '2026-11-14T23:00:38.506Z' }, { variant_id: 'v-bleu', location_id: 'L-habb', quantity: 9, synced_at: '2026-10-01T00:00:00Z' }] });
  const r = row(variantRowsFromDataset(data, { now: NOW }), 'Bleu');
  assert.deepEqual([r.units, r.stock, r.last_sale], [4, 6, '2026-10-26']);
  assert.deepEqual(r.evidence, { period: { since: '2026-07-18T12:00:00.000Z', until: '2026-11-15T12:00:00.000Z', days: 120 }, units_gross: 4, units_refunded: 0, units_cancelled: 0, units_net: 4, stock_snapshot_at: '2026-11-14T23:00:38.506Z', stock_locations: [{ location_id: 'L-habb', name: 'Habb', quantity: 6, synced_at: '2026-11-14T23:00:38.506Z' }] });
  const { ranked } = rankAdOpportunities(variantRowsFromDataset(data, { now: NOW }), { now: NOW }); assert.equal(ranked[0].evidence.units_net, 4); assert.equal(ranked[0].evidence.stock_locations[0].name, 'Habb');
});

test('NU-3 a partial refund: 3 ordered, 1 refunded = 2 net; a duplicated refund line row is deducted once; a refund dated after the calculation is unknown and not deducted; a refund larger than the line never goes below 0; a test order adds nothing', () => {
  const data = base({ orders: [{ id: 'oA', ordered_at: '2026-10-01T10:00:00Z', is_test: false, status: 'PARTIALLY_REFUNDED' }, { id: 'oT', ordered_at: '2026-10-02T10:00:00Z', is_test: true, status: 'PAID' }, { id: 'oOld', ordered_at: '2026-01-01T10:00:00Z', is_test: false, status: 'PAID' }],
    orderLines: [{ id: 'lA', order_id: 'oA', variant_id: 'v-bleu', quantity: 3 }, { id: 'lT', order_id: 'oT', variant_id: 'v-bleu', quantity: 9 }, { id: 'lOld', order_id: 'oOld', variant_id: 'v-bleu', quantity: 9 }],
    refunds: [{ id: 'r1', order_id: 'oA', refunded_at: '2026-10-05T10:00:00Z' }, { id: 'r2', order_id: 'oA', refunded_at: '2026-11-20T10:00:00Z' }],
    refundLines: [{ id: 'rl1', refund_id: 'r1', order_line_id: 'lA', quantity: 1 }, { id: 'rl1', refund_id: 'r1', order_line_id: 'lA', quantity: 1 }, { id: 'rl2', refund_id: 'r2', order_line_id: 'lA', quantity: 2 }] });
  const r = row(variantRowsFromDataset(data, { now: NOW }), 'Bleu');
  assert.deepEqual([r.units, r.evidence.units_gross, r.evidence.units_refunded, r.stock], [2, 3, 1, null]);
  const over = base({ orders: data.orders.slice(0, 1), orderLines: data.orderLines.slice(0, 1), refunds: [{ id: 'r1', order_id: 'oA', refunded_at: '2026-10-05T10:00:00Z' }], refundLines: [{ id: 'x1', refund_id: 'r1', order_line_id: 'lA', quantity: 2 }, { id: 'x2', refund_id: 'r1', order_line_id: 'lA', quantity: 2 }] });
  assert.equal(row(variantRowsFromDataset(over, { now: NOW }), 'Bleu').units, 0);
});
