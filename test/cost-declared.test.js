// Cost policy MERCHANT_DECLARED: the Shopify "Coût par article" is the merchant's own reference cost (supplier + transport + other purchase costs).
// Per-merchant (connector config), the amount is used as is, the default behaviour of every other merchant is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCatalog } from '../src/sync/catalog.js';
import { syncProductCosts } from '../src/sync/cost.js';
import { normalizeProductCost } from '../src/sync/normalize.js';
import { COST_POLICY, resolveCostPolicy, costProvenance } from '../src/sync/cost-policy.js';
import { guardSyncWrites } from '../src/sync/write-guard.js';
import { resolveUnitCost, COST_STATUS } from '../src/metrics/costs.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { FAKE_SHOP, FAKE_LOCATION, FAKE_PRODUCTS_PAGE } from './fixtures/shopify-sample.js';

const level = { edges: [] };
const page = (costs) => ({ productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [1, 2, 3].map((n) => ({ node: { id: `gid://shopify/ProductVariant/${n}`, inventoryItem: { unitCost: costs[n] === undefined ? null : costs[n], inventoryLevels: level } } })) } });
const eur = (amount) => ({ amount, currencyCode: 'EUR' });
const shopifyWith = (costs) => ({ async graphql(q) {
  if (q.includes('shop {')) return { shop: FAKE_SHOP }; if (q.includes('locations(')) return { locations: { edges: [{ node: FAKE_LOCATION }] } };
  if (q.includes('products(')) return FAKE_PRODUCTS_PAGE; if (q.includes('productVariants(')) return page(costs); throw new Error('unexpected query'); } });
async function tenant(supabase, name = 'Fake Shop', sourceId = FAKE_SHOP.id) { const [m] = await supabase.insert('merchants', [{ name, vertical: 'general_retail', source_system: 'shopify', source_id: sourceId }]); await syncCatalog({ shopify: shopifyWith({}), supabase }, { merchantId: m.id }); return m.id; }
const rows = (supabase, merchantId) => supabase._tables.get('product_costs').filter((r) => r.merchant_id === merchantId);
const variantRow = async (supabase, n) => (await supabase.select('variants', { select: 'id', source_id: `eq.gid://shopify/ProductVariant/${n}` }))[0];
const D = COST_POLICY.MERCHANT_DECLARED;
const T1 = new Date('2026-11-01T10:00:00Z'); const T2 = new Date('2026-11-10T10:00:00Z');

test('policy: only merchant_declared in the connector config switches the rule; anything else is the default', () => {
  assert.equal(resolveCostPolicy({ cost_policy: 'merchant_declared' }), D); assert.equal(resolveCostPolicy({}), COST_POLICY.DEFAULT); assert.equal(resolveCostPolicy(null), COST_POLICY.DEFAULT);
  assert.equal(resolveCostPolicy({ cost_policy: 'anything' }), COST_POLICY.DEFAULT); assert.equal(resolveCostPolicy({ cost_policy: true }), COST_POLICY.DEFAULT);
});

test('normalize: a positive Shopify cost is verified under the declared policy, unverified by default; a zero is never accepted as declared; empty = no row', () => {
  const at = new Date('2026-11-01T00:00:00Z');
  assert.deepEqual([normalizeProductCost('v', 'm', eur('12.50'), at, { policy: D }).validation_status, normalizeProductCost('v', 'm', eur('12.50'), at, { policy: D }).source], ['verified', 'shopify_unit_cost']);
  assert.equal(normalizeProductCost('v', 'm', eur('12.50'), at).validation_status, 'unverified', 'default policy unchanged');
  assert.equal(normalizeProductCost('v', 'm', eur('0.00'), at, { policy: D }).validation_status, 'unverified', 'a 0 cannot be told from a default: to verify');
  assert.equal(normalizeProductCost('v', 'm', null, at, { policy: D }), null); assert.equal(normalizeProductCost('v', 'm', undefined, at, { policy: D }), null);
  assert.equal(normalizeProductCost('v', 'm', eur('12.50'), at, { policy: D }).unit_cost, 12.5, 'the Shopify amount, as is: no fee added');
});

test('sync: filled cost -> verified row with the Shopify amount; empty cost -> no row; zero -> unverified; counters', async () => {
  const supabase = createFakeSupabase(); const m = await tenant(supabase);
  const s = await syncProductCosts({ shopify: shopifyWith({ 1: eur('12.50'), 2: undefined, 3: eur('0.00') }), supabase }, { merchantId: m, now: T1, costPolicy: D });
  const r = rows(supabase, m); assert.equal(r.length, 2);
  const v1 = r.find((x) => x.variant_id === (supabase._tables.get('variants').find((v) => v.source_id.endsWith('/1')).id)); const v3 = r.find((x) => Number(x.unit_cost) === 0);
  assert.deepEqual([v1.unit_cost, v1.currency, v1.source, v1.validation_status, costProvenance(v1)], [12.5, 'EUR', 'shopify_unit_cost', 'verified', 'shopify_declared_by_merchant']);
  assert.deepEqual([v3.validation_status, costProvenance(v3)], ['unverified', 'shopify_unit_cost_unverified']);
  assert.deepEqual([s.acceptedAsDeclared, s.withoutCost, s.withCost, s.newCostRows, s.promotedToDeclared], [1, 1, 2, 2, 0]);
  // what the metric layer does with it: the verified amount is used; the zero is a MISSING cost
  assert.deepEqual(['status', 'unit_cost'].map((k) => resolveUnitCost([v1], T2, 'EUR')[k]), [COST_STATUS.VERIFIED, 12.5]); assert.equal(resolveUnitCost([v3], T2, 'EUR').status, COST_STATUS.MISSING);
});

test('sync: a modified Shopify cost updates the current cost (one new verified row, history kept); an unchanged one writes nothing', async () => {
  const supabase = createFakeSupabase(); const m = await tenant(supabase); const v1 = await variantRow(supabase, 1);
  await syncProductCosts({ shopify: shopifyWith({ 1: eur('12.50') }), supabase }, { merchantId: m, now: T1, costPolicy: D });
  const same = await syncProductCosts({ shopify: shopifyWith({ 1: eur('12.50') }), supabase }, { merchantId: m, now: T2, costPolicy: D });
  assert.deepEqual([same.newCostRows, same.unchangedSkipped, rows(supabase, m).length], [0, 1, 1]);
  const changed = await syncProductCosts({ shopify: shopifyWith({ 1: eur('14.00') }), supabase }, { merchantId: m, now: T2, costPolicy: D });
  const mine = rows(supabase, m).filter((r) => r.variant_id === v1.id).sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  assert.deepEqual([changed.newCostRows, mine.length, mine.map((r) => r.unit_cost), mine.map((r) => r.validation_status)], [1, 2, [12.5, 14], ['verified', 'verified']]);
  assert.equal(resolveUnitCost(mine, new Date('2026-11-12T00:00:00Z'), 'EUR').unit_cost, 14, 'the current cost is the latest declared');
  assert.equal(resolveUnitCost(mine, new Date('2026-11-05T00:00:00Z'), 'EUR').unit_cost, 12.5, 'a sale made before the change keeps the cost of its day');
});

test('sync: an earlier UNVERIFIED import of the same amount is re-labelled in place (no new row, effective_from kept) so earlier sales read the declared cost', async () => {
  const supabase = createFakeSupabase(); const m = await tenant(supabase);
  await syncProductCosts({ shopify: shopifyWith({ 1: eur('12.50') }), supabase }, { merchantId: m, now: T1 }); // default policy first: unverified import
  const before = rows(supabase, m)[0]; assert.equal(before.validation_status, 'unverified');
  const s = await syncProductCosts({ shopify: shopifyWith({ 1: eur('12.50') }), supabase }, { merchantId: m, now: T2, costPolicy: D });
  const after = rows(supabase, m); assert.equal(after.length, 1, 'no second row'); assert.deepEqual([after[0].validation_status, after[0].effective_from, after[0].unit_cost], ['verified', before.effective_from, 12.5]);
  assert.deepEqual([s.promotedToDeclared, s.newCostRows, s.acceptedAsDeclared], [1, 0, 1]);
  assert.equal(resolveUnitCost(after, new Date('2026-11-02T00:00:00Z'), 'EUR').status, COST_STATUS.VERIFIED);
  // the same cost with a different amount is a real change: a new verified row, the earlier unverified row kept
  const supa2 = createFakeSupabase(); const m2 = await tenant(supa2);
  await syncProductCosts({ shopify: shopifyWith({ 1: eur('12.50') }), supabase: supa2 }, { merchantId: m2, now: T1 });
  await syncProductCosts({ shopify: shopifyWith({ 1: eur('13.00') }), supabase: supa2 }, { merchantId: m2, now: T2, costPolicy: D });
  assert.deepEqual(rows(supa2, m2).map((r) => [r.unit_cost, r.validation_status]).sort(), [[12.5, 'unverified'], [13, 'verified']].sort());
});

test('isolation: the policy of one merchant never touches another; the tenant guard refuses a promotion outside the tenant', async () => {
  const supabase = createFakeSupabase(); const a = await tenant(supabase, 'A', 'gid://shopify/Shop/A'); const b = await tenant(supabase, 'B', 'gid://shopify/Shop/B');
  const same = { 1: eur('12.50') };
  await syncProductCosts({ shopify: shopifyWith(same), supabase }, { merchantId: a, now: T1 }); await syncProductCosts({ shopify: shopifyWith(same), supabase }, { merchantId: b, now: T1 });
  await syncProductCosts({ shopify: shopifyWith(same), supabase }, { merchantId: a, now: T2, costPolicy: D }); // A declares; B keeps the default
  assert.deepEqual([rows(supabase, a).map((r) => r.validation_status), rows(supabase, b).map((r) => r.validation_status)], [['verified'], ['unverified']]);
  await syncProductCosts({ shopify: shopifyWith(same), supabase }, { merchantId: b, now: T2 }); assert.deepEqual(rows(supabase, b).map((r) => r.validation_status), ['unverified'], 'no policy: still unverified');
  await syncProductCosts({ shopify: shopifyWith(same), supabase }, { merchantId: b, now: T2, costPolicy: 'garbage' }); assert.deepEqual(rows(supabase, b).map((r) => r.validation_status), ['unverified'], 'unknown policy = default');
  const guarded = guardSyncWrites(supabase, { merchantId: '11111111-1111-4111-8111-111111111111', connectorId: 'c', externalId: 'e' });
  await assert.rejects(() => guarded.update('product_costs', { merchant_id: `eq.${a}`, id: `in.(${rows(supabase, a)[0].id})` }, { validation_status: 'verified' }), { code: 'TENANT_WRITE_VIOLATION' });
});

test('the existing default behaviour is untouched when no policy is given (run twice: one unverified row, nothing else)', async () => {
  const supabase = createFakeSupabase(); const m = await tenant(supabase);
  const s1 = await syncProductCosts({ shopify: shopifyWith({ 1: eur('5.00'), 3: eur('7.00') }), supabase }, { merchantId: m, now: T1 }); const s2 = await syncProductCosts({ shopify: shopifyWith({ 1: eur('5.00'), 3: eur('7.00') }), supabase }, { merchantId: m, now: T2 });
  assert.deepEqual([rows(supabase, m).every((r) => r.validation_status === 'unverified'), s1.acceptedAsDeclared, s2.newCostRows, s2.promotedToDeclared], [true, undefined, 0, undefined], 'no declared counters outside the policy');
});
