import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerFacts } from '../src/customers/facts.js';
import { CustomerKeyConfigError, loadCustomerKeySecret, pseudonymizeCustomerId } from '../src/customers/pseudonym.js';
import { phase3CustomerInputs } from '../src/customers/phase3-contract.js';
import { mergeConfig } from '../src/metrics/config.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { ORDERS_PAGE_QUERY, ORDERS_PAGE_QUERY_WITH_CUSTOMER_KEY } from '../src/shopify/queries.js';
import { normalizeOrder } from '../src/sync/normalize.js';
import { syncOrders } from '../src/sync/orders.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { NOW, makeMarketingData } from './fixtures/marketing-sample.js';
import { FAKE_ORDER_1, ordersPage } from './fixtures/shopify-orders-sample.js';

const SECRET = 'a'.repeat(32);
const GID = 'gid://shopify/Customer/123456789';

test('pseudonym: deterministic keyed hash; different secret or id gives an unrelated key; the id never appears', () => {
  const a = pseudonymizeCustomerId(GID, SECRET);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, pseudonymizeCustomerId(GID, SECRET));
  assert.notEqual(a, pseudonymizeCustomerId(GID, 'b'.repeat(32)));
  assert.notEqual(a, pseudonymizeCustomerId('gid://shopify/Customer/2', SECRET));
  assert.ok(!a.includes('123456789'));
  assert.equal(pseudonymizeCustomerId(null, SECRET), null);
  assert.throws(() => pseudonymizeCustomerId(GID, 'short'), CustomerKeyConfigError);
});

test('customer keys are opt-in: off by default, a weak or missing secret fails loudly', () => {
  assert.equal(loadCustomerKeySecret({}), null);
  assert.equal(loadCustomerKeySecret({ CUSTOMER_HASH_KEY: SECRET }), null); // secret alone does not enable it
  assert.equal(loadCustomerKeySecret({ SYNC_CUSTOMER_KEY: '1', CUSTOMER_HASH_KEY: SECRET }), SECRET);
  assert.throws(() => loadCustomerKeySecret({ SYNC_CUSTOMER_KEY: '1' }), CustomerKeyConfigError);
  assert.throws(() => loadCustomerKeySecret({ SYNC_CUSTOMER_KEY: '1', CUSTOMER_HASH_KEY: 'short' }), CustomerKeyConfigError);
});

test('normalizeOrder adds customer_key only when enabled, and only the hash', () => {
  const node = { ...FAKE_ORDER_1, customer: { id: GID } };
  const off = normalizeOrder(node, 'm', 'l');
  assert.ok(!('customer_key' in off));
  const on = normalizeOrder(node, 'm', 'l', { customerKeySecret: SECRET });
  assert.match(on.customer_key, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(on).includes('123456789'));
  assert.equal(normalizeOrder({ ...FAKE_ORDER_1, customer: null }, 'm', 'l', { customerKeySecret: SECRET }).customer_key, null); // anonymous
});

test('the default order query never requests a customer field; the opt-in variant requests only the id', () => {
  assert.ok(!/customer\s*\{/.test(ORDERS_PAGE_QUERY));
  assert.ok(/customer \{ id \}/.test(ORDERS_PAGE_QUERY_WITH_CUSTOMER_KEY));
  const extra = ORDERS_PAGE_QUERY_WITH_CUSTOMER_KEY.replace('customer { id }', '');
  assert.equal(extra.replace(/\s+/g, ''), ORDERS_PAGE_QUERY.replace(/\s+/g, ''));
});

test('order sync stores the hash, never the customer id, and picks the query by opt-in', async () => {
  const seen = [];
  const shopify = { async graphql(q) { seen.push(q); return ordersPage([{ ...FAKE_ORDER_1, customer: { id: GID } }]); } };
  const withKey = createFakeSupabase();
  await syncOrders({ shopify, supabase: withKey }, { merchantId: 'm1', customerKeySecret: SECRET });
  const [row] = withKey._tables.get('orders');
  assert.match(row.customer_key, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify([...withKey._tables.values()]).includes('123456789'));
  const without = createFakeSupabase();
  await syncOrders({ shopify, supabase: without }, { merchantId: 'm1' });
  assert.ok(!('customer_key' in without._tables.get('orders')[0]));
  assert.ok(seen[0].includes('customer { id }'));
  assert.ok(!seen[1].includes('customer { id }'));
});

function keyed(over = {}) {
  const data = makeMarketingData();
  const keys = { o2: 'kA', o3: 'kA', o4: 'kB', o5: 'kC', ...over };
  data.orders = data.orders.map((o) => ({ ...o, customer_key: keys[o.id] ?? null }));
  return data;
}
const cfg = (c = {}) => mergeConfig({ customers: { minCustomers: 1, minIntervals: 1, minOrdersPerGroup: 1, shortHistoryDays: 5, concentration: { topN: 2, riskTop1Share: 0.5, riskTopNShare: 0.9 }, ...c } });
const facts = (data, c = cfg()) => buildCustomerFacts({ ledger: buildLedger(data, { config: c }), data, now: NOW, config: c });

test('customer-level metrics unlock from the pseudonymous key: groups, 1/2/3+, repeat rate, gaps, value', () => {
  const f = facts(keyed());
  const g = f.new_vs_returning_customers.groups;
  assert.equal(g.returning.customers, 1); // kA: two orders
  assert.equal(g.new.customers, 2);
  assert.equal(f.new_vs_returning_customers.coverage.identified_orders, 4);
  assert.equal(f.new_vs_returning_customers.coverage.anonymous_orders, 4);
  const r = f.repeat_behaviour.customer_level;
  assert.deepEqual(r.customers_by_window_orders, { 1: 2, 2: 1, '3_plus': 0 });
  assert.equal(r.repeat_customer_rate_lower_bound, 0.3333);
  assert.equal(r.observed_intervals, 1);
  assert.equal(r.days_between_purchases.median, 1); // o2 (12th) -> o3 (13th)
  const v = f.customer_value;
  assert.equal(v.identified_customers, 3);
  assert.equal(v.observed_orders_per_customer.mean, 1.33);
  assert.ok(v.observed_revenue_ex_tax_per_customer.mean >= 0);
  assert.equal(f.customer_concentration.status, 'OK');
  assert.ok(f.customer_concentration.top1_share > 0 && f.customer_concentration.top1_share <= 1);
});

test('short-history and sample gates stay closed: nothing is safe for Phase 3 and small cells are withheld', () => {
  const f = facts(keyed(), cfg({ minCustomers: 30, minIntervals: 10, minOrdersPerGroup: 30, shortHistoryDays: 90 }));
  for (const b of [f.new_vs_returning_customers, f.repeat_behaviour, f.customer_value, f.customer_concentration]) assert.equal(b.provenance.safe_for_phase3.safe, false);
  assert.ok(f.repeat_behaviour.provenance.safe_for_phase3.reasons.includes('SHORT_HISTORY'));
  assert.equal(f.repeat_behaviour.customer_level.days_between_purchases.median, null);
  assert.equal(f.customer_concentration.status, 'GATED');
  assert.equal(f.customer_concentration.top1_share, null); // a top share over a handful of people is not exposed
  const p3 = phase3CustomerInputs(f);
  assert.equal(p3.customer_concentration.status, 'GATED');
  assert.equal(p3.customer_concentration.facts, null);
});

test('with a long history and enough customers the customer blocks become safe', () => {
  const f = facts(keyed(), cfg({ shortHistoryDays: 1 }));
  assert.equal(f.customer_value.provenance.safe_for_phase3.safe, true);
  assert.equal(f.customer_concentration.provenance.safe_for_phase3.safe, true);
  assert.equal(phase3CustomerInputs(f).customer_value.status, 'SAFE');
});

test('without any customer key the customer-level metrics stay BLOCKED', () => {
  const f = facts(keyed({ o2: null, o3: null, o4: null, o5: null }));
  assert.equal(f.customer_value.status, 'BLOCKED');
  assert.equal(f.customer_concentration.status, 'BLOCKED');
  assert.equal(f.privacy.customer_key_stored, false);
});

test('privacy: the report contains no customer key, id, secret or per-customer row', () => {
  const s = JSON.stringify(facts(keyed({ o2: 'k'.repeat(64), o3: 'k'.repeat(64) })));
  assert.ok(!s.includes('k'.repeat(64)));
  assert.ok(!/"kA"|"kB"|"kC"/.test(s));
  assert.ok(!/@|gid:\/\/|customer_key"\s*:\s*"/.test(s));
  const f = facts(keyed());
  assert.equal(f.privacy.customer_key_in_report, false);
  assert.equal(f.privacy.customer_identity_in_report, false);
});
