// Step 5 (ADR 0003): Core sync identity comes from NORDLA_MERCHANT_ID, never from Shopify. Shopify is the tenant's connector, checked
// (shop.id === merchant_connectors.external_id) before any write; every write goes through the tenant write guard. The whole runSync
// is exercised against an in-memory Supabase and a synthetic Shopify (no network, no real data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { FAKE_SHOP, FAKE_LOCATION, FAKE_PRODUCTS_PAGE, FAKE_INVENTORY_COST_PAGE } from './fixtures/shopify-sample.js';
import { volumeShopify, orderPages } from './fixtures/sync-volume.js';
import { SHOP_QUERY } from '../src/shopify/queries.js';
import { runSync } from '../src/sync/index.js';
import { syncCatalog } from '../src/sync/catalog.js';
import { syncInventory } from '../src/sync/inventory.js';
import { syncProductCosts } from '../src/sync/cost.js';
import { syncOrders } from '../src/sync/orders.js';
import { latestSyncStatus } from '../src/sync/run-log.js';
import { guardSyncWrites, TenantWriteViolation, SYNC_WRITE_TABLES } from '../src/sync/write-guard.js';

const A = { id: '0f5a1c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b', name: 'Synthetic Merchant A', vertical: 'general_retail', source_system: 'shopify', source_id: 'gid://shopify/Shop/LEGACY-A', source_domain: null };
const B = { id: '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0', name: 'Synthetic Merchant B', vertical: 'bookstore', source_system: 'shopify', source_id: 'gid://shopify/Shop/LEGACY-B', source_domain: null };
const SHOP_A = 'gid://shopify/Shop/SYN-A';
const SHOP_B = 'gid://shopify/Shop/SYN-B';
const UNKNOWN_ID = '11111111-2222-4333-8444-555555555555';
const SHOPIFY_ENV = { SHOPIFY_SHOP_DOMAIN: 'synthetic.myshopify.example', SHOPIFY_CLIENT_ID: 'synthetic-client', SHOPIFY_CLIENT_SECRET: 'synthetic-not-a-secret' };
const DATA_TABLES = SYNC_WRITE_TABLES.filter((t) => t !== 'sync_runs');

/** Fake Supabase: merchants A and B, each with its own shopify connector; every write call is recorded. */
function db({ connectors = [['c-a', A.id, SHOP_A], ['c-b', B.id, SHOP_B]], merchants = [A, B] } = {}) {
  const s = createFakeSupabase();
  s._tables.set('merchants', merchants.map((m) => ({ ...m })));
  s._tables.set('merchant_connectors', connectors.map(([id, merchantId, shop, status = 'CONFIGURED']) => ({ id, merchant_id: merchantId, kind: 'shopify', external_id: shop, external_domain: null, status, config: {} })));
  const writes = [];
  for (const m of ['insert', 'upsert', 'update', 'delete', 'rpc', 'insertIgnoringDuplicates']) {
    if (typeof s[m] !== 'function') continue;
    const orig = s[m].bind(s);
    s[m] = async (table, ...rest) => { writes.push({ method: m, table }); return orig(table, ...rest); };
  }
  s.writes = writes;
  s.rows = (table) => s._tables.get(table) ?? [];
  s.snapshot = (table) => JSON.stringify(s.rows(table));
  return s;
}
// Orders consistent with a clean store: the volume fixture's orders minus its deliberate "refund line without a line" edge case.
const dropMissing = (v) => (Array.isArray(v) ? v.filter((e) => !String(e?.node?.lineItem?.id ?? '').endsWith('missing')).map(dropMissing)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dropMissing(x)])) : v);
const CLEAN_ORDERS = dropMissing(orderPages());
/** Synthetic Shopify answering every query of a full sync, as shop `shopId`. `down` makes every call fail like a network error. */
function shopifyAs(shopId, { down = false } = {}) {
  const calls = { created: 0, queries: 0 };
  const vol = volumeShopify({ orders: CLEAN_ORDERS });
  const client = {
    async graphql(q, vars) {
      calls.queries += 1;
      if (down) throw new TypeError('fetch failed');
      if (q === SHOP_QUERY) return { shop: { ...FAKE_SHOP, id: shopId } };
      if (q.includes('locations(')) return { locations: { edges: [{ node: FAKE_LOCATION }] } };
      if (q.includes('productVariants(')) return FAKE_INVENTORY_COST_PAGE;
      if (q.includes('orders(')) return vol.graphql(q, vars);
      if (q.includes('products(')) return FAKE_PRODUCTS_PAGE;
      throw new Error('unexpected query');
    },
  };
  return { calls, createClient: () => { calls.created += 1; return client; } };
}
const quiet = process.env.DEBUG_CORE_TEST ? (...a) => console.error(...a) : () => {};
const sync = (supabase, { env = {}, shop, mode = 'all', ...rest } = {}) => runSync({
  mode, env, supabase, createClient: shop?.createClient ?? (() => { throw new Error('Shopify must not be contacted'); }),
  log: quiet, logError: quiet, customerKeySecret: () => null, coverage: { read: async () => null, write: async () => {} }, ...rest,
});
const dataWrites = (s) => s.writes.filter((w) => w.table !== 'sync_runs');
const merchantIdsIn = (s, table) => [...new Set(s.rows(table).map((r) => r.merchant_id))];

// 1 + 11 + 12a
test('valid merchant + its own shop: full sync SUCCESS, every row and the sync_runs row belong to that merchant, merchants untouched', async () => {
  const s = db(); const before = s.snapshot('merchants'); const shop = shopifyAs(SHOP_A);
  const r = await sync(s, { env: { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV }, shop });
  assert.equal(r.status, 'SUCCESS'); assert.equal(r.exitCode, 0); assert.equal(r.merchantId, A.id);
  for (const t of ['locations', 'products', 'variants', 'inventory_snapshots', 'product_costs', 'orders', 'order_lines', 'refunds']) {
    assert.ok(s.rows(t).length > 0, `${t} written`); assert.deepEqual(merchantIdsIn(s, t), [A.id], `${t} only for A`);
  }
  assert.deepEqual(s.rows('sync_runs').map((x) => [x.merchant_id, x.status, x.mode]), [[A.id, 'SUCCESS', 'all']]);
  assert.equal(s.snapshot('merchants'), before); assert.equal(s.writes.filter((w) => w.table === 'merchants' || w.table === 'merchant_connectors').length, 0);
});

// 2
test('unknown or missing NORDLA_MERCHANT_ID: refused before any write (not even sync_runs), Shopify never contacted', async () => {
  for (const env of [{ NORDLA_MERCHANT_ID: UNKNOWN_ID, ...SHOPIFY_ENV }, { ...SHOPIFY_ENV }, { NORDLA_MERCHANT_ID: 'not-a-uuid', ...SHOPIFY_ENV }]) {
    const s = db();
    const r = await sync(s, { env });
    assert.equal(r.status, 'REFUSED'); assert.equal(r.exitCode, 1); assert.equal(r.merchantId, null);
    assert.deepEqual(s.writes, [], JSON.stringify(env));
  }
});

// 3
test('Shopify not configured: the Shopify job is skipped (NOT_CONFIGURED, exit 0) - no write, no shop invented, existing data kept', async () => {
  const s = db(); s._tables.set('orders', [{ id: 'o-old', merchant_id: A.id, source_system: 'shopify', source_id: 'gid://shopify/Order/OLD' }]);
  const before = JSON.stringify([...s._tables]);
  const r = await sync(s, { env: { NORDLA_MERCHANT_ID: A.id } });
  assert.equal(r.status, 'SKIPPED'); assert.equal(r.exitCode, 0); assert.equal(r.state, 'NOT_CONFIGURED'); assert.equal(r.reason, 'NO_SHOPIFY_CREDENTIALS');
  assert.deepEqual(s.writes, []); assert.equal(JSON.stringify([...s._tables]), before);
  // a connector explicitly NOT_CONFIGURED in merchant_connectors is skipped the same way
  const s2 = db({ connectors: [['c-a', A.id, SHOP_A, 'NOT_CONFIGURED']] });
  const r2 = await sync(s2, { env: { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV }, shop: shopifyAs(SHOP_A) });
  assert.equal(r2.status, 'SKIPPED'); assert.equal(r2.reason, 'CONNECTOR_NOT_CONFIGURED'); assert.deepEqual(s2.writes, []);
});

// 4
test('Shopify unavailable: controlled FAILED run for the tenant (UNAVAILABLE), zero data write, merchant intact', async () => {
  const s = db(); const before = s.snapshot('merchants');
  const r = await sync(s, { env: { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV }, shop: shopifyAs(SHOP_A, { down: true }) });
  assert.equal(r.status, 'FAILED'); assert.equal(r.exitCode, 1); assert.equal(r.state, 'UNAVAILABLE');
  assert.deepEqual(dataWrites(s), []);
  assert.deepEqual(s.rows('sync_runs').map((x) => [x.merchant_id, x.status, x.error]), [[A.id, 'FAILED', 'UNAVAILABLE: SHOPIFY_ERROR']]);
  assert.equal(s.snapshot('merchants'), before);
});

// 5
test('wrong shop behind the credentials (linked to nobody): MISCONFIGURED, zero data write', async () => {
  const s = db();
  const r = await sync(s, { env: { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV }, shop: shopifyAs('gid://shopify/Shop/NOBODY') });
  assert.equal(r.state, 'MISCONFIGURED'); assert.equal(r.reason, 'SHOP_NOT_LINKED_TO_TENANT'); assert.equal(r.status, 'FAILED');
  assert.deepEqual(dataWrites(s), []);
  assert.deepEqual(s.rows('sync_runs').map((x) => [x.merchant_id, x.status, x.error]), [[A.id, 'FAILED', 'MISCONFIGURED: SHOP_NOT_LINKED_TO_TENANT']]);
});

// 6
test('merchant B\'s shop used with merchant A: MISCONFIGURED (SHOP_LINKED_TO_ANOTHER_MERCHANT), zero write for A and for B', async () => {
  const s = db();
  const r = await sync(s, { env: { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV }, shop: shopifyAs(SHOP_B) });
  assert.equal(r.state, 'MISCONFIGURED'); assert.equal(r.reason, 'SHOP_LINKED_TO_ANOTHER_MERCHANT');
  assert.deepEqual(dataWrites(s), []);
  assert.ok(s.rows('sync_runs').every((x) => x.merchant_id === A.id), 'the FAILED trace is A\'s own, never B\'s');
  for (const t of DATA_TABLES) assert.equal(s.rows(t).length, 0, t);
});

test('credentials present but the tenant has no shopify connector: MISCONFIGURED, zero data write', async () => {
  const s = db({ connectors: [['c-b', B.id, SHOP_B]] });
  const r = await sync(s, { env: { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV }, shop: shopifyAs(SHOP_A) });
  assert.equal(r.reason, 'NO_SHOPIFY_CONNECTOR_FOR_TENANT'); assert.deepEqual(dataWrites(s), []);
});

// 7
test('two merchants: only NORDLA_MERCHANT_ID is synced - B with B\'s shop writes only B, A stays empty', async () => {
  const s = db();
  const r = await sync(s, { env: { NORDLA_MERCHANT_ID: B.id, ...SHOPIFY_ENV }, shop: shopifyAs(SHOP_B) });
  assert.equal(r.status, 'SUCCESS'); assert.equal(r.merchantId, B.id);
  for (const t of ['products', 'variants', 'orders', 'order_lines', 'inventory_snapshots', 'sync_runs']) assert.deepEqual(merchantIdsIn(s, t), [B.id], t);
});

// 8 + 9
test('no merchant is ever created by the sync, and there is no "only merchant" logic left (behaviour + source)', async () => {
  // behaviour: exactly one merchant, no NORDLA_MERCHANT_ID, a valid shop -> refused, never "the only merchant"; empty table -> nothing created
  const one = db({ merchants: [A], connectors: [['c-a', A.id, SHOP_A]] });
  assert.equal((await sync(one, { env: { ...SHOPIFY_ENV }, shop: shopifyAs(SHOP_A) })).status, 'REFUSED'); assert.deepEqual(one.writes, []);
  const empty = db({ merchants: [], connectors: [] });
  await sync(empty, { env: { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV }, shop: shopifyAs(SHOP_A) });
  assert.equal(empty.rows('merchants').length, 0); assert.deepEqual(empty.writes, []);
  // source: nothing under src/sync reads or writes the merchants table any more, nor normalizeMerchant, nor SHOP_QUERY-as-identity
  const dir = new URL('../src/sync/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /['"]merchants['"]/, `${f} touches the merchants table`);
    assert.doesNotMatch(src, /normalizeMerchant\(/, `${f} builds a merchant from Shopify`);
    assert.doesNotMatch(src, /limit: '2'|merchants\.length !== 1|length === 1\)/, `${f} has single-merchant logic`);
  }
});

// 10
test('recovery after a Shopify outage: FAILED run, then the next cycle succeeds normally for the same tenant', async () => {
  const s = db(); const env = { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV };
  const t1 = new Date('2026-09-27T10:00:00Z'); const t2 = new Date('2026-09-27T10:15:00Z');
  assert.equal((await sync(s, { env, shop: shopifyAs(SHOP_A, { down: true }), now: () => t1 })).status, 'FAILED');
  assert.equal((await sync(s, { env, shop: shopifyAs(SHOP_A), now: () => t2 })).status, 'SUCCESS');
  const st = await latestSyncStatus(s, A.id, { now: new Date('2026-09-27T10:16:00Z') });
  assert.equal(st.lastAttempt.status, 'SUCCESS'); assert.equal(st.latestFailed, false); assert.ok(st.lastSuccess);
  assert.deepEqual(s.rows('sync_runs').map((x) => [x.merchant_id, x.status]), [[A.id, 'FAILED'], [A.id, 'SUCCESS']]);
});

test('a failure in the middle of the sync (Shopify drops on an orders page) ends FAILED; rows already written are only the tenant\'s', async () => {
  const s = db();
  const vol = volumeShopify({ orders: CLEAN_ORDERS, failAtCursor: 'o2' });
  const base = shopifyAs(SHOP_A);
  const shop = { createClient: () => ({ graphql: (q, v) => (q.includes('orders(') ? vol.graphql(q, v) : base.createClient().graphql(q, v)) }) };
  const r = await sync(s, { env: { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV }, shop });
  assert.equal(r.status, 'FAILED');
  for (const t of DATA_TABLES) assert.ok(merchantIdsIn(s, t).every((m) => m === A.id), t);
  assert.deepEqual(s.rows('sync_runs').map((x) => [x.merchant_id, x.status]), [[A.id, 'FAILED']]);
});

// 12
test('HABB historical behaviour kept: runSync("all") with a valid connector leaves exactly the data the previous module sequence left', async () => {
  // previous flow = catalog, inventory, cost, orders run in that order for the shop's merchant (here: the same merchant, by id)
  const project = (s) => Object.fromEntries(DATA_TABLES.map((t) => [t, s.rows(t).map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id' && k !== 'effective_from' && !/_id$/.test(k) && !/_at$/.test(k))))).sort()]));
  const oldFlow = db(); const shop = shopifyAs(SHOP_A).createClient();
  await syncCatalog({ shopify: shop, supabase: oldFlow }, { merchantId: A.id });
  await syncInventory({ shopify: shop, supabase: oldFlow }, { merchantId: A.id, timeZone: 'UTC' });
  await syncProductCosts({ shopify: shop, supabase: oldFlow }, { merchantId: A.id });
  await syncOrders({ shopify: shop, supabase: oldFlow }, { merchantId: A.id, customerKeySecret: null, since: null });
  const newFlow = db();
  assert.equal((await sync(newFlow, { env: { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV }, shop: shopifyAs(SHOP_A) })).status, 'SUCCESS');
  assert.deepEqual(project(newFlow), project(oldFlow));
  for (const t of DATA_TABLES) assert.equal(newFlow.rows(t).length, oldFlow.rows(t).length, t);
});

// ---------- legacy fallback (ADR: explicit, transitional, logged, via merchant_connectors) ----------
test('legacy fallback: off -> refused; on and no NORDLA_MERCHANT_ID -> tenant via merchant_connectors (not merchants.source_id), logged', async () => {
  const off = db();
  assert.equal((await sync(off, { env: { ...SHOPIFY_ENV }, shop: shopifyAs(SHOP_A) })).status, 'REFUSED'); assert.deepEqual(off.writes, []);
  const on = db(); const lines = [];
  const r = await sync(on, { env: { ...SHOPIFY_ENV, NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP: 'true' }, shop: shopifyAs(SHOP_A), log: (...a) => lines.push(a.join(' ')) });
  assert.equal(r.status, 'SUCCESS'); assert.equal(r.merchantId, A.id);
  assert.notEqual(A.source_id, SHOP_A, 'merchants.source_id is not what matched');
  assert.ok(lines.some((l) => /tenant source = legacy_shopify/.test(l)) && lines.some((l) => /WARNING/.test(l)));
  const unknown = db();
  assert.equal((await sync(unknown, { env: { ...SHOPIFY_ENV, NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP: 'true' }, shop: shopifyAs('gid://shopify/Shop/NOBODY') })).status, 'REFUSED');
  assert.deepEqual(unknown.writes, []);
});

// ---------- the central write guard ----------
test('write guard: refuses rows of another merchant, foreign tables, unscoped updates, foreign sync_runs, deletes and RPCs - before any request', async () => {
  const s = db(); const g = guardSyncWrites(s, { merchantId: A.id, connectorId: 'c-a', externalId: SHOP_A });
  const refused = (p, reason) => assert.rejects(p, (e) => e instanceof TenantWriteViolation && e.reason === reason);
  await refused(g.upsert('orders', [{ merchant_id: A.id }, { merchant_id: B.id }], { onConflict: 'x' }), 'ROW_NOT_OF_THIS_TENANT');
  await refused(g.insert('inventory_snapshots', [{ variant_id: 'v' }]), 'ROW_NOT_OF_THIS_TENANT');
  await refused(g.upsert('merchants', [{ merchant_id: A.id }], { onConflict: 'x' }), 'TABLE_NOT_WRITABLE_BY_CONNECTOR');
  await refused(g.insert('merchant_connectors', [{ merchant_id: A.id }]), 'TABLE_NOT_WRITABLE_BY_CONNECTOR');
  await refused(g.insert('fin_documents', [{ merchant_id: A.id }]), 'TABLE_NOT_WRITABLE_BY_CONNECTOR');
  await refused(g.update('product_collections', { is_current: 'eq.true' }, { is_current: false }), 'UPDATE_NOT_SCOPED_TO_TENANT');
  await refused(g.update('product_collections', { merchant_id: `eq.${B.id}` }, { is_current: false }), 'UPDATE_NOT_SCOPED_TO_TENANT');
  await refused(g.update('products', { merchant_id: `eq.${A.id}` }, { merchant_id: B.id }), 'RE_ASSIGNS_MERCHANT');
  await refused(g.update('sync_runs', { id: 'eq.someone-elses-run' }, { status: 'SUCCESS' }), 'UPDATE_NOT_SCOPED_TO_TENANT');
  await refused(g.delete('orders', { merchant_id: `eq.${A.id}` }), 'DELETE_NOT_ALLOWED');
  await refused(g.rpc('anything', {}), 'RPC_NOT_ALLOWED');
  assert.deepEqual(s.writes, [], 'nothing reached the database');
  // allowed: own rows, own scoped update, own sync_runs row
  await g.upsert('products', [{ merchant_id: A.id, source_system: 'shopify', source_id: 'p1' }], { onConflict: 'merchant_id,source_system,source_id' });
  const [run] = await g.insert('sync_runs', [{ merchant_id: A.id, mode: 'all', status: 'RUNNING' }]);
  await g.update('sync_runs', { id: `eq.${run.id}` }, { status: 'SUCCESS' });
  await g.update('product_collections', { merchant_id: `eq.${A.id}` }, { is_current: false });
  assert.throws(() => guardSyncWrites(s, { merchantId: 'nope' }), TenantWriteViolation);
});

test('write guard before connector validation: only sync_runs of the tenant can be written', async () => {
  const s = db(); const g = guardSyncWrites(s, { merchantId: A.id });
  await assert.rejects(g.upsert('orders', [{ merchant_id: A.id }], { onConflict: 'x' }), (e) => e.reason === 'CONNECTOR_NOT_VALIDATED');
  await g.insert('sync_runs', [{ merchant_id: A.id, mode: 'all', status: 'RUNNING' }]);
  assert.deepEqual(s.writes.map((w) => w.table), ['sync_runs']);
});
