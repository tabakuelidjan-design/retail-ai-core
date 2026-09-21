import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePaymentFees } from '../src/analysis/payment-fees.js';
import { buildCostTriage, buildLargestStockPositions, buildProfitUncertainty } from '../src/analysis/triage.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { detectQualityFlags } from '../src/quality/rules.js';
import { syncQualityFlags } from '../src/quality/flags.js';
import { CONFIG, FULL_WINDOW, makeData } from './fixtures/metrics-sample.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';

const NOW = new Date('2026-09-21T09:00:00Z');
const ledgerOf = (data) => buildLedger(data, { config: CONFIG });

function withExtraVariants(data) {
  // v5: no cost, not sold, stocked (P1). v6: no cost, not sold, no stock (P2).
  data.variants.push(
    { id: 'v5', product_id: 'p4', sku: null, title: 'Stocked, no cost' },
    { id: 'v6', product_id: 'p4', sku: null, title: 'Idle, no cost' },
  );
  data.snapshots.push({ id: 's-v5', variant_id: 'v5', location_id: 'loc1', quantity: 12, synced_at: '2026-09-20T12:00:00Z' });
  return data;
}

test('missing-cost triage: P0 sold, P1 stocked but unsold, P2 neither - with the affected revenue and units', () => {
  const t = buildCostTriage(ledgerOf(withExtraVariants(makeData())), FULL_WINDOW, NOW);
  assert.deepEqual([t.P0.variants, t.P1.variants, t.P2.variants], [1, 1, 1]);
  assert.equal(t.P0.items[0].variant_id, 'v3');
  assert.equal(t.P0.revenue_ex_tax, 16.53);
  assert.equal(t.P0.units_sold, 1);
  assert.equal(t.P1.items[0].variant_id, 'v5');
  assert.equal(t.P1.stock_units, 12);
  assert.equal(t.P1.stock_value_at_cost, 'UNAVAILABLE_NO_COST');
  assert.equal(t.P2.items[0].variant_id, 'v6');
  assert.equal(t.reasons.NO_COST_ROW, 3);
});

test('unmatched sold lines are reported apart from variant triage', () => {
  const data = makeData();
  data.orderLines.push({ id: 'u1', order_id: 'o2', variant_id: null, title_snapshot: 'Retired', quantity: 1, unit_price: 5, discount_amount: 0, tax_amount: 0 });
  const t = buildCostTriage(ledgerOf(data), FULL_WINDOW, NOW);
  assert.deepEqual(t.unmatched_sold_lines, { lines: 1, revenue_ex_tax: 5 });
});

test('profit uncertainty: revenue split by cost trust, production cost stays honestly unquantified', () => {
  const u = buildProfitUncertainty(ledgerOf(makeData()), FULL_WINDOW);
  assert.equal(u.revenue_ex_tax.total_ex_tax, 161.98);
  assert.equal(u.revenue_ex_tax.cost_verified, 137.19); // v1 lines: 37.19 + 100
  assert.equal(u.revenue_ex_tax.cost_unverified, 8.26); // v2
  assert.equal(u.revenue_ex_tax.cost_missing, 16.53); // v3
  assert.equal(u.shares.cost_missing, 0.102);
  assert.equal(u.production_cost.modelled, false);
  assert.equal(u.production_cost.identifiable_subset, null);
  assert.equal(u.production_cost.revenue_potentially_affected_ex_tax, 145.45);
  assert.equal(u.cost_applied_to_history_revenue_ex_tax, 0);
});

test('largest stock positions rank by value at cost, leave uncosted stock out of the value, and describe round quantities', () => {
  const data = makeData();
  data.snapshots.find((s) => s.variant_id === 'v2').quantity = 200; // 200 x 4.00 = 800
  const s = buildLargestStockPositions(ledgerOf(data), NOW, CONFIG);
  assert.equal(s.largest[0].variant_id, 'v2');
  assert.equal(s.largest[0].value_at_cost, 800);
  assert.equal(s.largest[0].round_quantity, true);
  assert.equal(s.units_without_cost, 3); // v3 has stock but no cost
  assert.ok(!s.largest.some((r) => r.variant_id === 'v3'));
});

test('payment fees: visible only for gateways whose fees Shopify reports; nothing is estimated; test orders ignored', () => {
  const tx = (gateway, amount, fee) => ({
    test: false,
    transactions: [{ gateway, kind: 'SALE', status: 'SUCCESS', amountSet: { shopMoney: { amount } }, fees: fee ? [{ amount: { amount: fee } }] : [] }],
  });
  const orders = [
    tx('cash', '30.00'), tx('shopify_payments', '57.00', '0.39'), tx('card_terminal', '20.00'),
    { ...tx('shopify_payments', '99.00', '1.00'), test: true },
  ];
  const s = summarizePaymentFees(orders);
  assert.equal(s.fees_reported_total, 0.39);
  assert.equal(s.captured_amount_total, 107);
  assert.equal(s.captured_amount_fee_not_visible, 50); // cash + external terminal
  assert.equal(s.by_gateway.find((g) => g.gateway === 'shopify_payments').orders, 1);
});

test('MISSING_COST flags carry their priority; P2 is not flagged; an open flag is refreshed in place, not duplicated', async () => {
  const data = withExtraVariants(makeData());
  const detect = (d) => detectQualityFlags(d, ledgerOf(d), { merchantId: 'm1', now: NOW, config: CONFIG });
  const flags = detect(data).filter((f) => f.rule_code === 'MISSING_COST');
  const prio = Object.fromEntries(flags.map((f) => [f.entity_id, [f.details.priority, f.severity]]));
  assert.deepEqual(prio, { v3: ['P0', 'warning'], v5: ['P1', 'info'] });

  const supabase = createFakeSupabase();
  // A flag persisted by the earlier version (no priority): same condition, refreshed evidence.
  await supabase.insert('data_quality_flags', [{
    merchant_id: 'm1', entity_type: 'variant', entity_id: 'v3', rule_code: 'MISSING_COST',
    severity: 'warning', status: 'open', details: { sku: 'Z-1' },
  }]);
  const summary = await syncQualityFlags({ supabase }, { merchantId: 'm1', detected: detect(data), now: NOW });
  const v3Rows = supabase._tables.get('data_quality_flags').filter((r) => r.entity_id === 'v3' && r.rule_code === 'MISSING_COST');
  assert.equal(v3Rows.length, 1);
  assert.equal(v3Rows[0].details.priority, 'P0');
  assert.ok(summary.updated >= 1);

  const again = await syncQualityFlags({ supabase }, { merchantId: 'm1', detected: detect(data), now: NOW });
  assert.equal(again.created, 0);
  assert.equal(again.updated, 0);
});
