// Step 4 (ADR 0003): Finance starts and works from NORDLA_MERCHANT_ID with no Shopify at all; Shopify is an optional connector
// (NOT_CONFIGURED / MISCONFIGURED / UNAVAILABLE); the legacy Shopify lookup is used only when explicitly enabled and resolves
// through merchant_connectors. Synthetic data only; every network path is trapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { startApp, invoiceBody } from './finance-dashboard-helpers.js';
import { resolveTenant, TenantResolutionError, TENANT_ERROR_CODES as T } from '../src/tenant/index.js';
import { createRuntime } from '../src/finance/runtime.js';
import { createShopifyConnector, ShopifyConnectorStateError } from '../src/connectors/shopify.js';
import { createConnectorRepository } from '../src/tenant/connectors.js';
import { SHOP_QUERY } from '../src/shopify/queries.js';
import { createShopifyClient as createShopifyClientReal } from '../src/shopify/client.js';

const A = { id: '0f5a1c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b', name: 'Synthetic Merchant A', vertical: 'general_retail', source_system: 'shopify', source_id: 'gid://shopify/Shop/LEGACY-COLUMN-A', source_domain: null };
const B = { id: '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0', name: 'Synthetic Merchant B', vertical: 'bookstore', source_system: 'manual', source_id: 'nordla:B', source_domain: null };
const SHOP_A = 'gid://shopify/Shop/SYN-A'; // the shop A's connector points to (deliberately different from merchants.source_id)
const UNKNOWN_ID = '11111111-2222-4333-8444-555555555555';
const SHOPIFY_ENV = { SHOPIFY_SHOP_DOMAIN: 'synthetic-a.myshopify.example', SHOPIFY_CLIENT_ID: 'synthetic-client', SHOPIFY_CLIENT_SECRET: 'synthetic-not-a-secret' };

/** Fake Supabase with merchants A and B; A owns one shopify connector (unless `withConnector` is false). */
function db({ withConnector = true } = {}) {
  const s = createFakeSupabase();
  s._tables.set('merchants', [{ ...A }, { ...B }]);
  s._tables.set('merchant_connectors', withConnector ? [{ id: 'c1c1c1c1-0000-4000-8000-000000000001', merchant_id: A.id, kind: 'shopify', external_id: SHOP_A, external_domain: SHOPIFY_ENV.SHOPIFY_SHOP_DOMAIN, status: 'CONFIGURED', config: {} }] : []);
  return s;
}
/** A Shopify client factory that records every construction/call; `shop` = what SHOP_QUERY returns, `fail` = throw instead. */
function shopifyFactory({ shop = SHOP_A, fail = null, hang = false } = {}) {
  const calls = { created: 0, queries: [] };
  const factory = () => {
    calls.created += 1;
    return { async graphql(q) { calls.queries.push(q === SHOP_QUERY ? 'SHOP_QUERY' : 'OTHER'); if (hang) return new Promise(() => {}); if (fail) throw fail; return q === SHOP_QUERY ? { shop: { id: shop } } : { nodes: [] }; } };
  };
  return { factory, calls };
}
const trap = () => { const calls = { created: 0 }; return { calls, factory: () => { calls.created += 1; throw new Error('Shopify must not be contacted'); } }; };
async function noNetwork(fn) {
  const real = globalThis.fetch; const hits = [];
  globalThis.fetch = async (u) => { hits.push(String(u)); throw new Error('network forbidden in this test'); };
  try { return await fn(hits); } finally { globalThis.fetch = real; }
}
const quiet = () => {};

// ---------- tenant resolution (runtime) ----------
test('valid merchant + no Shopify: the runtime is built, zero Shopify client created, zero network, connector NOT_CONFIGURED', () => noNetwork(async (hits) => {
  const t = trap();
  const rt = await createRuntime({ env: { NORDLA_MERCHANT_ID: A.id }, supabase: db(), createShopifyClient: t.factory, log: quiet });
  assert.equal(rt.merchant.id, A.id); assert.equal(rt.tenant.source, 'env');
  assert.equal(await rt.shopify.state({ verify: true }), 'NOT_CONFIGURED');
  await assert.rejects(rt.shopify.graphql('query { x }'), (e) => e instanceof ShopifyConnectorStateError && e.state === 'NOT_CONFIGURED');
  assert.equal(t.calls.created, 0); assert.equal(hits.length, 0);
}));

test('valid merchant + Shopify configured: NO Shopify call at boot; the first real use verifies the shop against merchant_connectors (CONFIGURED)', () => noNetwork(async () => {
  const s = shopifyFactory();
  const rt = await createRuntime({ env: { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV }, supabase: db(), createShopifyClient: s.factory, log: quiet });
  assert.equal(s.calls.created, 0, 'no client built at boot'); assert.deepEqual(s.calls.queries, []);
  await rt.shopify.graphql('query($ids:[ID!]!){ nodes(ids:$ids){ id } }', { ids: [] });
  assert.equal(await rt.shopify.state(), 'CONFIGURED');
  assert.deepEqual(s.calls.queries, ['SHOP_QUERY', 'OTHER'], 'verification first, then the real query');
}));

test('Shopify returns a shop that is not this merchant\'s connector: MISCONFIGURED, Shopify features refused, runtime still usable', () => noNetwork(async () => {
  const s = shopifyFactory({ shop: 'gid://shopify/Shop/SOMEONE-ELSE' });
  const rt = await createRuntime({ env: { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV }, supabase: db(), createShopifyClient: s.factory, log: quiet });
  await assert.rejects(rt.shopify.graphql('query { x }'), (e) => e.state === 'MISCONFIGURED' && e.reason === 'SHOP_NOT_LINKED_TO_TENANT');
  assert.equal(await rt.shopify.state(), 'MISCONFIGURED');
  assert.equal(rt.merchant.id, A.id);
}));

test('Shopify credentials but no shopify connector for the tenant: MISCONFIGURED without even calling Shopify', () => noNetwork(async () => {
  const s = shopifyFactory();
  const rt = await createRuntime({ env: { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV }, supabase: db({ withConnector: false }), createShopifyClient: s.factory, log: quiet });
  assert.equal(await rt.shopify.state({ verify: true }), 'MISCONFIGURED'); assert.equal(s.calls.created, 0);
}));

test('Shopify down or hanging: UNAVAILABLE (runtime state, bounded by the timeout), the runtime keeps working', () => noNetwork(async () => {
  for (const s of [shopifyFactory({ fail: new TypeError('fetch failed') }), shopifyFactory({ hang: true })]) {
    const rt = await createRuntime({ env: { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV }, supabase: db(), createShopifyClient: s.factory, log: quiet, shopifyTimeoutMs: 50 });
    assert.equal(await rt.shopify.state({ verify: true }), 'UNAVAILABLE');
    await assert.rejects(rt.shopify.graphql('query { x }'), (e) => e.state === 'UNAVAILABLE');
    assert.equal(rt.merchant.id, A.id);
  }
}));

test('UNAVAILABLE is re-checked after the cool-down; CONFIGURED once Shopify is back (no restart needed)', async () => {
  let down = true; let now = 0;
  const connectors = createConnectorRepository({ supabase: db() });
  const c = createShopifyConnector({ env: SHOPIFY_ENV, merchantId: A.id, connectors, nowMs: () => now, recheckAfterMs: 1000, createClient: () => ({ async graphql() { if (down) throw new TypeError('fetch failed'); return { shop: { id: SHOP_A } }; } }) });
  assert.equal(await c.state({ verify: true }), 'UNAVAILABLE');
  down = false; now = 500; assert.equal(await c.state({ verify: true }), 'UNAVAILABLE', 'still in cool-down');
  now = 1500; assert.equal(await c.state({ verify: true }), 'CONFIGURED');
});

test('unknown NORDLA_MERCHANT_ID: boot refused cleanly (MERCHANT_NOT_FOUND), never another merchant, nothing created', async () => {
  const s = db(); const before = JSON.stringify(s._tables.get('merchants'));
  await assert.rejects(createRuntime({ env: { NORDLA_MERCHANT_ID: UNKNOWN_ID }, supabase: s, createShopifyClient: trap().factory, log: quiet }), (e) => e instanceof TenantResolutionError && e.code === T.MERCHANT_NOT_FOUND);
  await assert.rejects(createRuntime({ env: {}, supabase: s, createShopifyClient: trap().factory, log: quiet }), (e) => e.code === T.MERCHANT_ID_MISSING);
  assert.equal(JSON.stringify(s._tables.get('merchants')), before);
});

test('two merchants: only the explicit NORDLA_MERCHANT_ID is served', async () => {
  assert.equal((await createRuntime({ env: { NORDLA_MERCHANT_ID: B.id }, supabase: db(), log: quiet })).merchant.name, B.name);
  assert.equal((await createRuntime({ env: { NORDLA_MERCHANT_ID: A.id }, supabase: db(), log: quiet })).merchant.name, A.name);
});

// ---------- legacy Shopify fallback ----------
test('legacy fallback disabled: never used (no Shopify call), even with Shopify credentials and no NORDLA_MERCHANT_ID', () => noNetwork(async () => {
  const t = trap();
  await assert.rejects(createRuntime({ env: { ...SHOPIFY_ENV }, supabase: db(), createShopifyClient: t.factory, log: quiet }), (e) => e.code === T.MERCHANT_ID_MISSING);
  await assert.rejects(createRuntime({ env: { ...SHOPIFY_ENV, NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP: 'false' }, supabase: db(), createShopifyClient: t.factory, log: quiet }), (e) => e.code === T.MERCHANT_ID_MISSING);
  assert.equal(t.calls.created, 0);
}));

test('legacy fallback on + NORDLA_MERCHANT_ID set: the explicit id wins, Shopify is not asked', async () => {
  const t = trap();
  const rt = await createRuntime({ env: { NORDLA_MERCHANT_ID: B.id, NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP: 'true', ...SHOPIFY_ENV }, supabase: db(), createShopifyClient: t.factory, log: quiet });
  assert.equal(rt.tenant.source, 'env'); assert.equal(rt.merchant.id, B.id); assert.equal(t.calls.created, 0);
});

test('legacy fallback explicitly on: shop -> merchant_connectors -> merchant (not merchants.source_id), logged as legacy_shopify', async () => {
  const s = shopifyFactory(); const lines = [];
  const rt = await createRuntime({ env: { NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP: 'true', ...SHOPIFY_ENV }, supabase: db(), createShopifyClient: s.factory, log: (l) => lines.push(l) });
  assert.equal(rt.merchant.id, A.id); assert.equal(rt.tenant.source, 'legacy_shopify');
  assert.notEqual(A.source_id, SHOP_A, 'the legacy merchants.source_id column is NOT what matched');
  assert.ok(lines.some((l) => /tenant source = legacy_shopify/.test(l)) && lines.some((l) => /WARNING/.test(l)));
});

test('legacy fallback with an unknown shop, or a hanging Shopify: clean refusal, no merchant created', async () => {
  const s = db(); const before = JSON.stringify(s._tables.get('merchants'));
  await assert.rejects(createRuntime({ env: { NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP: '1', ...SHOPIFY_ENV }, supabase: s, createShopifyClient: shopifyFactory({ shop: 'gid://shopify/Shop/NOBODY' }).factory, log: quiet }), (e) => e.code === T.MERCHANT_NOT_FOUND && e.detail.reason === 'SHOP_NOT_LINKED');
  await assert.rejects(createRuntime({ env: { NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP: '1', ...SHOPIFY_ENV }, supabase: s, createShopifyClient: shopifyFactory({ hang: true }).factory, log: quiet, shopifyTimeoutMs: 50 }), (e) => e.code === T.TENANT_LOOKUP_FAILED && e.detail.cause === 'TIMEOUT');
  assert.equal(JSON.stringify(s._tables.get('merchants')), before);
  await assert.rejects(resolveTenant({ supabase: s, env: { NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP: 'on' } }), (e) => e.code === T.TENANT_SOURCE_NOT_AVAILABLE, 'flag on but no Shopify connection offered');
});

// ---------- the real server boot: port opened, zero Shopify ----------
/** Adds an old successful sync run: it must NOT be what the pill shows when the source is absent or not configured. */
const withSyncRun = (s) => { s._tables.set('sync_runs', [{ id: 1, merchant_id: A.id, mode: 'all', status: 'SUCCESS', started_at: '2026-09-20T08:00:00Z', finished_at: '2026-09-20T08:00:10Z', error: null, counts: {} }]); return s; };
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// No sales connector at all -> "no sales source"; a Shopify connector in merchant_connectors but no Shopify credentials here ->
// "sales source not configured" (never the old sync run shown as if the source were live).
for (const [withConnector, reason] of [[false, 'NO_SALES_SOURCE'], [true, 'SALES_SOURCE_NOT_CONFIGURED']]) test(`startFinanceServer (${withConnector ? 'Shopify connector in DB, no credentials' : 'no sales connector'}): port opens with NORDLA_MERCHANT_ID - zero Shopify call, zero network; sync-status ${reason}, stock NOT_CONFIGURED`, async () => {
  const { startFinanceServer } = await import('../src/finance/server/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'nordla-finance-boot-')); const cwd = process.cwd(); process.chdir(dir); // settings / sessions go to a temp dir
  const port = await freePort(); const token = 'synthetic-dashboard-token-0123456789';
  const t = trap(); const realFetch = globalThis.fetch; const hits = [];
  globalThis.fetch = async (u, o) => (String(u).startsWith(`http://127.0.0.1:${port}`) ? realFetch(u, o) : (hits.push(String(u)), Promise.reject(new Error('network forbidden'))));
  let server;
  try {
    ({ server } = await startFinanceServer({
      env: { FINANCE_HOSTED: 'true', PORT: String(port), FINANCE_ALLOWED_HOSTS: `127.0.0.1:${port}`, FINANCE_TRUST_PROXY_HOPS: '0', FINANCE_DASHBOARD_TOKEN: token, NORDLA_MERCHANT_ID: A.id, SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic' },
      runtimeDeps: { supabase: withSyncRun(db({ withConnector })), createShopifyClient: t.factory }, log: quiet,
    }));
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await realFetch(`${base}/api/session`)).status, 200, 'the port is open and serving');
    const login = await realFetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = async (p) => (await realFetch(base + p, { headers: { cookie } })).json();
    assert.deepEqual((await get('/api/sync-status')).sync, { available: false, reason });
    assert.equal((await get('/api/stock/status')).connector, 'NOT_CONFIGURED');
    assert.equal(t.calls.created, 0, 'no Shopify client was ever built'); assert.deepEqual(hits, [], 'no outbound request');
  } finally {
    globalThis.fetch = realFetch; await new Promise((r) => (server ? server.close(r) : r())); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the app with no Shopify: pure Finance works, Shopify features report their state ----------
const noSalesSource = async () => ({ available: false, reason: 'NO_SALES_SOURCE' });

test('no Shopify: purchases, sales (issue an invoice), bank CSV, treasury, contacts, pack status all work', async () => {
  const a = await startApp({ deps: { syncStatus: noSalesSource } }); // no priceSource, no stockApplier = no sales connector
  try {
    const c = await a.authed();
    assert.equal((await c.post('/api/inbox/manual', { supplierName: 'Fournisseur Exemple SRL', invoiceNumber: 'SYN-1', issueDate: '2026-09-10', dueDate: '2026-10-10', net: '100.00', vat: '21.00', gross: '121.00', currency: 'EUR' })).status, 201);
    assert.equal((await c.get('/api/inbox')).status, 200);
    const d = (await c.post('/api/documents', invoiceBody())).data; await c.post(`/api/documents/${d.id}/submit`, {});
    assert.equal((await c.post(`/api/documents/${d.id}/approve`, {})).status, 200, 'an invoice is issued without any sales connector');
    assert.equal((await c.post('/api/bank/import-csv', { csv: 'Date;Montant;Contrepartie;Communication\n10/09/2026;125,50;Client A;Facture 1\n' })).status, 200);
    for (const p of ['/api/treasury', '/api/contacts', '/api/sync-status']) assert.equal((await c.get(p)).status, 200, p);
    assert.equal((await c.post('/api/pack-comptable/status', { kind: 'month', year: 2026, month: 9 })).status, 200);
  } finally { await a.close(); }
});

test('no Shopify: stock sync, catalogue prices and sales sync report NOT_CONFIGURED / no source instead of failing', async () => {
  const a = await startApp({ deps: { syncStatus: noSalesSource } });
  try {
    const c = await a.authed();
    assert.equal((await c.get('/api/stock/status')).data.connector, 'NOT_CONFIGURED');
    const apply = await c.post('/api/stock/apply', {}); assert.equal(apply.status, 200);
    if (apply.data.mode !== 'off') assert.equal(apply.data.blocked, 'NOT_CONFIGURED');
    const search = await c.get('/api/catalog/search?q=pr');
    assert.equal(search.status, 200); assert.equal(search.data.priceSource, 'NOT_CONFIGURED');
    assert.equal((await c.get('/api/sync-status')).data.sync.reason, 'NO_SALES_SOURCE');
  } finally { await a.close(); }
});

test('Shopify MISCONFIGURED or UNAVAILABLE: stock sync blocked with that state, catalogue says so, Finance keeps working', async () => {
  for (const state of ['MISCONFIGURED', 'UNAVAILABLE']) {
    const connector = { state: async () => state };
    const applier = { state: async () => state, hasScope: async () => { throw new Error('must not be called'); } };
    const a = await startApp({ deps: { stockApplier: applier, priceSource: async () => { throw new ShopifyConnectorStateError(state); }, salesConnector: connector } });
    try {
      const c = await a.authed();
      assert.equal((await c.get('/api/stock/status')).data.connector, state);
      assert.equal((await c.get('/api/catalog/search?q=pr')).data.priceSource, state);
      assert.equal((await c.post('/api/inbox/manual', { supplierName: 'Fournisseur Exemple SRL', invoiceNumber: `SYN-${state}`, issueDate: '2026-09-10', net: '10.00', vat: '2.10', gross: '12.10', currency: 'EUR' })).status, 201);
    } finally { await a.close(); }
  }
});

// ---------- connector lifecycle without restart: token invalidation, CONFIGURED TTL ----------
/** A fake Shopify at the HTTP level (token exchange + GraphQL), used through the REAL Shopify client. */
function fakeShopifyHttp() {
  const st = { shopId: SHOP_A, tokens: new Set(), exchanges: 0, graphqlCalls: 0, n: 0, down: null, gqlError: false };
  const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  st.fetch = async (url, opts) => {
    if (String(url).endsWith('/admin/oauth/access_token')) { st.exchanges += 1; const t = `tok-${(st.n += 1)}`; st.tokens.add(t); return res(200, { access_token: t, expires_in: 86399 }); }
    st.graphqlCalls += 1;
    if (st.down) return new Response('<html>Application not found</html>', { status: st.down });
    if (st.gqlError) return res(200, { errors: [{ message: 'Field does not exist' }] });
    if (!st.tokens.has(opts.headers['X-Shopify-Access-Token'])) return res(401, { errors: 'Invalid API key or access token' });
    return res(200, { data: String(JSON.parse(opts.body).query).includes('myshopifyDomain') ? { shop: { id: st.shopId, name: 'S', myshopifyDomain: 'x' } } : { nodes: [] } });
  };
  return st;
}
function lifecycleConnector(st, clock) {
  const built = { n: 0 };
  const createClient = (config, deps) => { built.n += 1; return createShopifyClientReal(config, deps); };
  const c = createShopifyConnector({ env: SHOPIFY_ENV, merchantId: A.id, connectors: createConnectorRepository({ supabase: db() }), createClient, fetchImpl: st.fetch, nowMs: () => clock.now });
  return { c, built };
}
const Q = 'query($ids:[ID!]!){ nodes(ids:$ids){ id } }';

test('CONFIGURED -> token invalidated -> auth failure -> new token obtained -> CONFIGURED, without restart; one client for normal requests', async () => {
  const st = fakeShopifyHttp(); const clock = { now: 0 }; const { c, built } = lifecycleConnector(st, clock);
  for (let i = 0; i < 3; i += 1) await c.graphql(Q, { ids: [] });
  assert.equal(await c.state(), 'CONFIGURED'); assert.equal(built.n, 1, 'normal requests reuse one client'); assert.equal(st.exchanges, 1, 'and one token');
  st.tokens.clear(); // app reinstalled / secret rotated / Shopify restarted: the cached token is no longer accepted
  await assert.rejects(c.graphql(Q, { ids: [] }));
  assert.equal(await c.state(), 'UNAVAILABLE'); assert.equal(c.describe().reason, 'AUTH_FAILED');
  const callsAtFailure = st.graphqlCalls;
  clock.now += 30_000; await assert.rejects(c.graphql(Q, { ids: [] }), (e) => e.state === 'UNAVAILABLE', 'cool-down kept: no retry storm');
  assert.equal(st.graphqlCalls, callsAtFailure, 'nothing sent to Shopify during the cool-down');
  clock.now += 31_000; await c.graphql(Q, { ids: [] });
  assert.equal(await c.state(), 'CONFIGURED'); assert.equal(st.exchanges, 2, 'a NEW token was acquired'); assert.equal(built.n, 2, 'by a new client');
});

test('an auth failure during verification (stale token) is AUTH_FAILED, then recovers with a new token, without restart', async () => {
  const st = fakeShopifyHttp(); const clock = { now: 0 }; const { c } = lifecycleConnector(st, clock);
  await c.state({ verify: true }); st.tokens.clear();
  clock.now += 5 * 60_000; // CONFIGURED TTL elapsed: the next use re-verifies with the stale token
  assert.equal(await c.state({ verify: true }), 'UNAVAILABLE'); assert.equal(c.describe().reason, 'AUTH_FAILED');
  clock.now += 60_000; assert.equal(await c.state({ verify: true }), 'CONFIGURED'); assert.equal(st.exchanges, 2);
});

test('CONFIGURED is trusted for a TTL only: a wrong shop is detected and a corrected shop comes back, without restart and without polling', async () => {
  const st = fakeShopifyHttp(); const clock = { now: 0 }; const { c } = lifecycleConnector(st, clock);
  assert.equal(await c.state({ verify: true }), 'CONFIGURED');
  st.shopId = 'gid://shopify/Shop/SOMEONE-ELSE';
  clock.now += 60_000; assert.equal(await c.state({ verify: true }), 'CONFIGURED', 'within the TTL the verification is reused');
  const before = st.graphqlCalls; clock.now += 10 * 60_000;
  assert.equal(await c.state(), 'CONFIGURED'); assert.equal(st.graphqlCalls, before, 'no timer, no polling: nothing happens without a real use');
  assert.equal(await c.state({ verify: true }), 'MISCONFIGURED', 'the next real use after the TTL detects the wrong shop');
  await assert.rejects(c.graphql(Q, { ids: [] }), (e) => e.state === 'MISCONFIGURED');
  st.shopId = SHOP_A; clock.now += 60_000;
  assert.equal(await c.state({ verify: true }), 'CONFIGURED', 'back to the right shop: CONFIGURED again after the recheck delay');
});

test('sales source state: NONE without a sales connector, NOT_CONFIGURED with a Shopify connector but no credentials, ACTIVE with both - no Shopify call', async () => {
  const t = trap();
  const src = async (withConnector, env) => (await createRuntime({ env: { NORDLA_MERCHANT_ID: A.id, ...env }, supabase: db({ withConnector }), createShopifyClient: t.factory, log: quiet })).salesSource();
  assert.equal(await src(false, {}), 'NONE');
  assert.equal(await src(true, {}), 'NOT_CONFIGURED');
  assert.equal(await src(true, SHOPIFY_ENV), 'ACTIVE');
  assert.equal(t.calls.created, 0);
});

test('Shopify down behind a gateway (HTTP 503 / 404) while CONFIGURED: UNAVAILABLE, same client and token kept, back to CONFIGURED after the cool-down; a query error changes nothing', async () => {
  for (const status of [503, 404]) {
    const st = fakeShopifyHttp(); const clock = { now: 0 }; const { c, built } = lifecycleConnector(st, clock);
    await c.graphql(Q, { ids: [] });
    st.gqlError = true; await assert.rejects(c.graphql(Q, { ids: [] })); st.gqlError = false;
    assert.equal(await c.state(), 'CONFIGURED', 'a GraphQL error in a 200 is a query problem, not an outage');
    st.down = status; await assert.rejects(c.graphql(Q, { ids: [] }));
    assert.equal(await c.state(), 'UNAVAILABLE', String(status)); assert.equal(c.describe().reason, 'SHOPIFY_UNREACHABLE');
    st.down = null; clock.now += 60_000; await c.graphql(Q, { ids: [] });
    assert.equal(await c.state(), 'CONFIGURED'); assert.equal(st.exchanges, 1, 'no new token needed'); assert.equal(built.n, 1, 'same client');
  }
});
