import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerFacts, orderGroup } from '../src/customers/facts.js';
import { phase3CustomerInputs } from '../src/customers/phase3-contract.js';
import { mergeConfig } from '../src/metrics/config.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { NOW, makeMarketingData } from './fixtures/marketing-sample.js';

const cfg = (c = {}) => mergeConfig({ customers: { minOrdersPerGroup: 30, shortHistoryDays: 90, basket: { minOrders: 30, minPairSupport: 3, maxPairs: 20 }, ...c } });
const facts = (data = makeMarketingData(), c = cfg()) => buildCustomerFacts({ ledger: buildLedger(data, { config: c }), data, now: NOW, config: c });

test('order groups: only what the recorded index can prove', () => {
  const ctx = { online: true, pos: false };
  assert.equal(orderGroup({ customer_order_index: 1, journey_ready: true }, ctx), 'new');
  assert.equal(orderGroup({ customer_order_index: 2, journey_ready: true }, ctx), 'returning');
  assert.equal(orderGroup({ customer_order_index: 1, journey_ready: true }, { online: false, pos: true }), 'first_recorded_pos');
  assert.equal(orderGroup({ customer_order_index: 3, journey_ready: true }, { online: false, pos: true }), 'returning');
  assert.equal(orderGroup({ customer_order_index: null, journey_ready: true }, ctx), 'unknown');
  assert.equal(orderGroup({ customer_order_index: 1, journey_ready: false }, ctx), 'unknown');
});

test('new vs returning: counts and shares reconcile to the order set', () => {
  const f = facts().new_vs_returning;
  const g = f.groups;
  assert.equal(g.returning.orders, 1);
  assert.equal(g.new.orders, 5);
  assert.equal(g.first_recorded_pos.orders, 2);
  assert.equal(Object.values(g).reduce((a, x) => a + x.orders, 0), 8);
  assert.equal(Object.values(g).reduce((a, x) => a + x.order_share, 0).toFixed(3), '1.000');
  assert.equal(Object.values(g).reduce((a, x) => a + x.revenue_share, 0).toFixed(3), '1.000');
  assert.equal(g.returning.aov, 10);
  assert.equal(f.returning_is_lower_bound, true);
});

test('provenance: window, completeness, sample size, history limits and Phase 3 safety on every block', () => {
  const f = facts();
  for (const b of [f.new_vs_returning, f.repeat_behaviour, f.customer_value, f.customer_concentration, f.basket]) {
    const p = b.provenance;
    assert.ok('observation_window' in p && 'completeness' in p && 'sample_size' in p);
    assert.ok(p.history_limitations.includes('SHORT_HISTORY'));
    assert.equal(typeof p.safe_for_phase3.safe, 'boolean');
    assert.equal(p.causal_claim, false);
    assert.ok(p.limitations.includes('ORDER_LEVEL_ONLY_NO_CUSTOMER_IDENTITY'));
  }
  assert.equal(f.new_vs_returning.provenance.safe_for_phase3.safe, false);
});

test('group comparison opens only when both groups meet the sample threshold', () => {
  assert.equal(facts(makeMarketingData(), cfg({ minOrdersPerGroup: 1 })).new_vs_returning.provenance.safe_for_phase3.safe, true);
});

test('customer-level metrics are BLOCKED, never estimated from order data', () => {
  const f = facts();
  assert.equal(f.repeat_behaviour.customer_level.status, 'BLOCKED');
  assert.equal(f.customer_value.status, 'BLOCKED');
  assert.equal(f.customer_concentration.status, 'BLOCKED');
  assert.ok(f.customer_value.blocked_metrics.includes('revenue_per_customer'));
  assert.ok(f.customer_value.blocked_metrics.includes('top_customer_revenue_share'));
  assert.equal(f.repeat_behaviour.provenance.safe_for_phase3.safe, false);
  assert.equal(f.repeat_behaviour.repeat_order_share_lower_bound, 0.125);
});

function basketData(baskets) {
  const data = makeMarketingData();
  data.orders = []; data.orderLines = []; data.orderAttribution = []; data.refunds = []; data.refundLines = [];
  baskets.forEach((ids, i) => {
    data.orders.push({ id: `b${i}`, ordered_at: '2026-09-10T10:00:00Z', status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false, source_name: 'pos', channel_handle: 'pos', customer_order_index: 1, journey_ready: true });
    ids.forEach((v, j) => data.orderLines.push({ id: `bl${i}_${j}`, order_id: `b${i}`, variant_id: v, title_snapshot: 't', sku_snapshot: 'S', quantity: 1, unit_price: 10, discount_amount: 0, tax_amount: 1.74 }));
  });
  return data;
}

test('basket pairs are gated on order count and on pair support', () => {
  const few = facts(basketData([['v1', 'v2'], ['v1', 'v2'], ['v1', 'v2']])).basket;
  assert.equal(few.pair_gate.status, 'GATED');
  assert.deepEqual(few.product_pairs, []);
  assert.equal(few.provenance.safe_for_phase3.safe, false);
  assert.equal(few.multi_product_orders, 3);
  const many = facts(basketData([...Array(4).fill(['v1', 'v2']), ...Array(30).fill(['v1'])])).basket;
  assert.equal(many.pair_gate.status, 'OPEN');
  assert.equal(many.product_pairs.length, 1);
  assert.equal(many.product_pairs[0].orders_together, 4);
  assert.equal(many.provenance.safe_for_phase3.safe, true);
  const sparse = facts(basketData([['v1', 'v2'], ...Array(40).fill(['v1'])])).basket;
  assert.equal(sparse.pair_gate.status, 'OPEN');
  assert.deepEqual(sparse.product_pairs, []);
  assert.equal(sparse.provenance.safe_for_phase3.safe, false);
  assert.ok(sparse.provenance.safe_for_phase3.reasons.some((r) => r.startsWith('NO_PAIR_REACHES')));
});

test('privacy: the facts hold no customer identity, order ids, emails or platform ids', () => {
  const f = facts();
  const s = JSON.stringify(f);
  assert.equal(f.privacy.customer_identity_stored, false);
  assert.ok(!/@/.test(s));
  assert.ok(!/gid:\/\//.test(s));
  for (const id of ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8']) assert.ok(!s.includes(`"${id}"`));
});

test('Phase 3 contract exposes only blocks marked safe', () => {
  const p = phase3CustomerInputs(facts());
  assert.equal(p.new_vs_returning.status, 'GATED');
  assert.equal(p.new_vs_returning.facts, null);
  assert.equal(p.customer_value.status, 'GATED');
  assert.equal(p.predictive_claims, false);
  assert.equal(phase3CustomerInputs(facts(makeMarketingData(), cfg({ minOrdersPerGroup: 1 }))).new_vs_returning.status, 'SAFE');
});
