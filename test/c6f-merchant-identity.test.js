// C6-F (ADR 0003): merchants.id is the only Nordla identity. Every hosted service and tool resolves its merchant from
// NORDLA_MERCHANT_ID and nothing else - never Shopify, never merchants.source_id / source_system, never the shop domain, never
// "the only" or "the first" merchant, and the removed NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP switch re-enables nothing. Shopify stays
// an optional business connector of an ALREADY resolved merchant. Synthetic merchants only; every outbound request is trapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { TENANT_ERROR_CODES as T } from '../src/tenant/index.js';
import { resolveFinanceTenant, createRuntime } from '../src/finance/runtime.js';
import { resolveSyncTenant, prepareShopifySync } from '../src/sync/tenant-context.js';
import { runSync } from '../src/sync/index.js';
import { resolveAnalyticsTenant } from '../src/analytics-premium/server/tenant.js';
import { startAnalyticsServer } from '../src/analytics-premium/server/serve.js';
import { runReport } from '../src/report/index.js';
import { resolveToolTenant } from '../src/tenant/tool-context.js';
import { SHOP_QUERY } from '../src/shopify/queries.js';

const A = { id: '0f5a1c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b', name: 'Synthetic Alpha', vertical: 'general_retail', source_system: 'shopify', source_id: 'gid://shopify/Shop/SYN-A', source_domain: 'synthetic-a.myshopify.example' };
const B = { id: '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0', name: 'Synthetic Beta (no Shopify)', vertical: 'services', source_system: 'manual', source_id: 'nordla:SYN-B', source_domain: null };
const UNKNOWN = '11111111-2222-4333-8444-555555555555';
const SECRET = 'synthetic-secret-value-c6f-0123456789';
// Shopify variables point at A's shop on purpose: they must never select A.
const SHOPIFY_ENV = { SHOPIFY_SHOP_DOMAIN: A.source_domain, SHOPIFY_CLIENT_ID: 'synthetic-client', SHOPIFY_CLIENT_SECRET: SECRET };
const LEGACY_FLAG = { NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP: 'true' };
const quiet = () => {};

/** Fake Supabase: merchants A (+ its shopify connector) and, unless `onlyA`, B (no connector). Records every read and write. */
function db({ onlyA = false } = {}) {
  const s = createFakeSupabase();
  s._tables.set('merchants', (onlyA ? [A] : [A, B]).map((m) => ({ ...m })));
  s._tables.set('merchant_connectors', [{ id: randomUUID(), merchant_id: A.id, kind: 'shopify', external_id: A.source_id, external_domain: A.source_domain, status: 'CONFIGURED', config: {} }]);
  const reads = []; const writes = [];
  const sel = s.select.bind(s); s.select = async (table, params = {}) => { reads.push({ table, params }); return sel(table, params); };
  if (s.selectAll) { const all = s.selectAll.bind(s); s.selectAll = async (table, params = {}) => { reads.push({ table, params }); return all(table, params); }; }
  for (const m of ['insert', 'upsert', 'update', 'delete', 'rpc']) { if (typeof s[m] !== 'function') continue; const o = s[m].bind(s); s[m] = async (table, ...r) => { writes.push({ method: m, table }); return o(table, ...r); }; }
  return Object.assign(s, { reads, writes });
}
/** A Shopify client factory that answers as A's shop and records everything. */
function shopAsA() {
  const calls = { created: 0, queries: [] };
  return { calls, factory: () => { calls.created += 1; return { async graphql(q) { calls.queries.push(q === SHOP_QUERY ? 'SHOP_QUERY' : 'OTHER'); return q === SHOP_QUERY ? { shop: { id: A.source_id, name: 'A', myshopifyDomain: A.source_domain } } : {}; } }; } };
}
async function noNetwork(fn) {
  const real = globalThis.fetch; const hits = [];
  globalThis.fetch = (u, o) => (/^http:\/\/127\.0\.0\.1:/.test(String(u)) ? real(u, o) : (hits.push(String(u)), Promise.reject(new Error('network forbidden in this test'))));
  try { return await fn(hits, real); } finally { globalThis.fetch = real; }
}
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const tmp = () => mkdtemp(path.join(tmpdir(), 'c6f-'));

/** The four identity entry points of the platform (Finance, Core, Analytics, tools incl. Growth), all given every Shopify hint. */
const ENTRY_POINTS = {
  finance: ({ env, supabase, log, factory }) => resolveFinanceTenant({ env, supabase, log, createShopifyClient: factory }),
  core: ({ env, supabase, log, factory }) => resolveSyncTenant({ env, supabase, log, createClient: factory }),
  analytics: ({ env, supabase, log, factory }) => resolveAnalyticsTenant({ env, supabase, log, createClient: factory }),
  tools: ({ env, supabase, log, factory }) => resolveToolTenant({ env, supabase, tool: 'growth', log, createClient: factory }),
};

// 1, 2, 4, 12
for (const [name, resolve] of Object.entries(ENTRY_POINTS)) {
  test(`${name}: no NORDLA_MERCHANT_ID -> MERCHANT_ID_MISSING even with Shopify credentials of a linked shop, the old switch on and one merchant only; no Shopify, no read`, () => noNetwork(async (hits) => {
    for (const env of [{ ...SHOPIFY_ENV }, { ...SHOPIFY_ENV, ...LEGACY_FLAG }, { ...SHOPIFY_ENV, NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP: '1' }]) {
      for (const onlyA of [true, false]) {
        const s = db({ onlyA }); const shop = shopAsA(); const lines = [];
        await assert.rejects(resolve({ env, supabase: s, log: (l) => lines.push(l), factory: shop.factory }), (e) => e.code === T.MERCHANT_ID_MISSING);
        assert.equal(shop.calls.created, 0, 'no Shopify client'); assert.deepEqual(s.reads, [], 'neither merchants nor merchant_connectors is read'); assert.deepEqual(s.writes, []);
        assert.ok(!lines.some((l) => /legacy|WARNING/i.test(l)));
      }
    }
    assert.deepEqual(hits, []);
  }));

  // 5, 6, 7
  test(`${name}: unknown UUID refused, valid UUID served (source env) with exactly one read by id; two merchants each get only themselves`, () => noNetwork(async () => {
    const s = db(); const shop = shopAsA();
    await assert.rejects(resolve({ env: { ...SHOPIFY_ENV, ...LEGACY_FLAG, NORDLA_MERCHANT_ID: UNKNOWN }, supabase: s, log: quiet, factory: shop.factory }), (e) => e.code === T.MERCHANT_NOT_FOUND);
    for (const m of [A, B]) {
      s.reads.length = 0;
      const t = await resolve({ env: { ...SHOPIFY_ENV, ...LEGACY_FLAG, NORDLA_MERCHANT_ID: m.id }, supabase: s, log: quiet, factory: shop.factory });
      assert.equal(t.merchantId, m.id); assert.equal(t.source, 'env'); assert.equal(t.merchant.name, m.name);
      assert.deepEqual(s.reads, [{ table: 'merchants', params: { select: 'id,name,vertical', id: `eq.${m.id}`, limit: '1' } }]);
    }
    await assert.rejects(resolve({ env: { NORDLA_MERCHANT_ID: A.source_id }, supabase: s, log: quiet, factory: shop.factory }), (e) => e.code === T.MERCHANT_ID_INVALID, 'a Shopify id is not a merchant id');
    assert.equal(shop.calls.created, 0); assert.deepEqual(s.writes, []);
  }));
}

// 2 (static): no identity code reads merchants by a Shopify column, passes anything but { supabase, env } to the resolver, or knows the flag
test('static: no source file selects a merchant by source_id / source_system / source_domain / shop domain, and every resolveTenant call passes only { supabase, env }', () => {
  const files = [];
  const walk = (dir) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.ok(files.length > 50);
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8'); const rel = path.relative(process.cwd(), f).replace(/\\/g, '/');
    if (/select\(\s*'merchants'[^)]*source_(id|system|domain)/.test(src)) offenders.push(`${rel}: merchants selected by a source column`);
    if (/from\(\s*'merchants'\)|'\/rest\/v1\/merchants\?/.test(src)) offenders.push(`${rel}: raw merchants query`);
    for (const m of src.matchAll(/resolveTenant\(\{([^}]*)\}\)/g)) if (m[1].split(',').map((x) => x.trim().split(':')[0]).some((k) => k && !['supabase', 'env'].includes(k))) offenders.push(`${rel}: resolveTenant called with ${m[1].trim()}`);
    if (/NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP/.test(src) && !rel.endsWith('src/tenant/index.js')) offenders.push(`${rel}: mentions the removed legacy switch`);
    if (/legacyShopify|findShopId|legacy_shopify|isLegacyShopifyLookupEnabled/.test(src) && !rel.endsWith('src/tenant/index.js')) offenders.push(`${rel}: legacy lookup code`);
  }
  assert.deepEqual(offenders, []);
  // the resolver itself only mentions the switch / reader in its removal notes, and has no code path for them
  const resolver = readFileSync(new URL('../src/tenant/index.js', import.meta.url), 'utf8');
  const code = resolver.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /LEGACY|legacy|findShopId|merchant_connectors|findMerchantByExternal|source_id/);
});

// 9: a merchant without Shopify (no connector, no credentials) starts Finance and Analytics in their independent functions
test('merchant without Shopify: Finance runtime + hosted server start, pages answer, sales source is NO_SALES_SOURCE, zero Shopify', () => noNetwork(async (hits, real) => {
  const s = db(); const shop = shopAsA();
  const rt = await createRuntime({ env: { NORDLA_MERCHANT_ID: B.id }, supabase: s, createShopifyClient: shop.factory, log: quiet });
  assert.equal(rt.merchant.id, B.id); assert.equal(await rt.shopify.state({ verify: true }), 'NOT_CONFIGURED');
  const { startFinanceServer } = await import('../src/finance/server/index.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'c6f-finance-')); const cwd = process.cwd(); process.chdir(dir);
  const port = await freePort(); const token = 'synthetic-dashboard-token-c6f-0123456789'; let server;
  try {
    ({ server } = await startFinanceServer({
      env: { FINANCE_HOSTED: 'true', PORT: String(port), FINANCE_ALLOWED_HOSTS: `127.0.0.1:${port}`, FINANCE_TRUST_PROXY_HOPS: '0', FINANCE_DASHBOARD_TOKEN: token, NORDLA_MERCHANT_ID: B.id, SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40) },
      runtimeDeps: { supabase: s, createShopifyClient: shop.factory }, log: quiet,
    }));
    const base = `http://127.0.0.1:${port}`;
    const login = await real(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
    for (const p of ['/api/overview', '/api/inbox', '/api/documents', '/api/treasury', '/api/contacts', '/api/bank/status', '/api/overview/pack']) assert.equal((await real(base + p, { headers: { cookie } })).status, 200, p);
    assert.deepEqual((await (await real(`${base}/api/sync-status`, { headers: { cookie } })).json()).sync, { available: false, reason: 'NO_SALES_SOURCE' });
  } finally { await new Promise((r) => (server ? server.close(r) : r())); process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
  assert.equal(shop.calls.created, 0); assert.deepEqual(hits, []);
}));

test('merchant without Shopify: the Analytics report is built from Nordla data and the server starts (NO_SALES_SOURCE), zero Shopify', () => noNetwork(async (hits, real) => {
  const s = db(); const shop = shopAsA(); const dir = await tmp();
  const r = await runReport({ mode: 'report', env: { NORDLA_MERCHANT_ID: B.id }, supabase: s, outDir: dir, log: quiet, createClient: shop.factory });
  assert.equal(r.merchantId, B.id);
  const port = await freePort();
  const { server } = await startAnalyticsServer({ env: { NORDLA_MERCHANT_ID: B.id, ANALYTICS_PREMIUM_PORT: String(port) }, supabase: s, reportsDir: dir, log: quiet, createClient: shop.factory });
  try {
    assert.equal((await real(`http://127.0.0.1:${port}/api/brief`)).status, 200);
    assert.deepEqual((await (await real(`http://127.0.0.1:${port}/api/sync-status`)).json()).sync, { available: false, reason: 'NO_SALES_SOURCE' });
  } finally { await new Promise((res) => server.close(res)); }
  assert.equal(shop.calls.created, 0); assert.deepEqual(hits, []);
}));

// 10: Core without a Shopify connector - the planned state, never another merchant
test('Core, merchant without connector: no credentials -> SKIPPED NOT_CONFIGURED; credentials -> MISCONFIGURED before any Shopify call; never A, never A\'s connector', () => noNetwork(async () => {
  for (const [env, state, reason] of [[{ NORDLA_MERCHANT_ID: B.id }, 'NOT_CONFIGURED', 'NO_SHOPIFY_CREDENTIALS'], [{ NORDLA_MERCHANT_ID: B.id, ...SHOPIFY_ENV, ...LEGACY_FLAG }, 'MISCONFIGURED', 'NO_SHOPIFY_CONNECTOR_FOR_TENANT']]) {
    const s = db(); const shop = shopAsA();
    const tenant = await resolveSyncTenant({ env, supabase: s, log: quiet });
    const prep = await prepareShopifySync({ env, supabase: s, tenant, createClient: shop.factory });
    assert.equal(prep.state, state); assert.equal(prep.reason, reason); assert.equal(prep.merchantId, B.id);
    assert.equal(shop.calls.created, 0, 'Shopify never contacted');
    assert.ok(s.reads.filter((x) => x.table === 'merchant_connectors').every((x) => x.params.merchant_id === `eq.${B.id}`), 'only B\'s own connectors are read');
    const r = await runSync({ mode: 'all', env, supabase: s, createClient: shop.factory, log: quiet, logError: quiet, customerKeySecret: () => null, coverage: { read: async () => null, write: async () => {} } });
    assert.equal(r.merchantId ?? B.id, B.id);
    assert.ok(s.writes.every((w) => w.table === 'sync_runs'), `no data written: ${JSON.stringify(s.writes)}`);
    assert.equal(shop.calls.created, 0);
  }
}));

// 11: Shopify stays usable as the connector of an already-resolved merchant
test('Shopify is still the business connector once the merchant is resolved: A\'s own shop -> CONFIGURED sync context bound to A', () => noNetwork(async () => {
  const s = db(); const shop = shopAsA(); const env = { NORDLA_MERCHANT_ID: A.id, ...SHOPIFY_ENV };
  const tenant = await resolveSyncTenant({ env, supabase: s, log: quiet });
  const prep = await prepareShopifySync({ env, supabase: s, tenant, createClient: shop.factory });
  assert.equal(prep.state, 'CONFIGURED'); assert.equal(prep.context.merchantId, A.id); assert.equal(prep.context.externalId, A.source_id);
  assert.deepEqual(shop.calls.queries, ['SHOP_QUERY'], 'one identity check of the CONNECTOR, after the merchant is known');
  const rt = await createRuntime({ env, supabase: s, createShopifyClient: shop.factory, log: quiet });
  assert.equal(await rt.shopify.state({ verify: true }), 'CONFIGURED');
}));

// 8: a request cannot choose another merchant (Finance hosted server; Analytics and Growth are covered in their own suites)
test('Finance: a document created for A is invisible to the server of B, whatever merchantId / merchant_id / tenant a request carries', () => noNetwork(async (hits, real) => {
  const s = db(); const { startFinanceServer } = await import('../src/finance/server/index.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'c6f-inject-')); const cwd = process.cwd(); process.chdir(dir);
  const token = 'synthetic-dashboard-token-c6f-inject-0123';
  const boot = async (merchantId) => {
    const port = await freePort();
    const { server } = await startFinanceServer({
      env: { FINANCE_HOSTED: 'true', PORT: String(port), FINANCE_ALLOWED_HOSTS: `127.0.0.1:${port}`, FINANCE_TRUST_PROXY_HOPS: '0', FINANCE_DASHBOARD_TOKEN: token, NORDLA_MERCHANT_ID: merchantId, SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40) },
      runtimeDeps: { supabase: s }, log: quiet,
    });
    const base = `http://127.0.0.1:${port}`;
    const login = await real(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const { csrf } = await login.json(); const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = (method, p, body, headers = {}) => real(base + p, { method, headers: { cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { server, call };
  };
  let a; let b;
  try {
    a = await boot(A.id);
    const created = await a.call('POST', '/api/inbox/manual', { supplierName: 'Fournisseur Alpha SRL', invoiceNumber: 'C6F-A-1', issueDate: '2026-09-10', dueDate: '2026-10-10', net: '100.00', vat: '21.00', gross: '121.00', currency: 'EUR', merchantId: B.id });
    assert.equal(created.status, 201, 'A records a supplier invoice (a merchantId in the body is ignored)');
    const aRows = (await (await a.call('GET', '/api/inbox')).json()).rows;
    assert.equal(aRows.length, 1); const aId = aRows[0].id;
    b = await boot(B.id);
    const inject = { 'X-Nordla-Merchant-Id': A.id, 'X-Merchant-Id': A.id };
    for (const q of ['', `?merchantId=${A.id}`, `?merchant_id=${A.id}&tenant=${A.id}`]) {
      const list = await (await b.call('GET', `/api/inbox${q}`, undefined, inject)).json();
      assert.deepEqual(list.rows, [], `B sees none of A's invoices (${q || 'no query'})`);
      assert.equal((await b.call('GET', `/api/inbox/${aId}${q}`, undefined, inject)).status, 404, 'A\'s record does not exist for B');
    }
    assert.equal((await (await a.call('GET', `/api/inbox?merchantId=${B.id}`)).json()).rows.length, 1, 'and A still sees exactly its own');
  } finally {
    for (const x of [a, b]) if (x) await new Promise((r) => x.server.close(r));
    process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(hits, []);
}));

// 13: no secret in errors or logs
test('no secret in any identity error or log line (service role key, Shopify secret, dashboard token)', () => noNetwork(async () => {
  const env = { ...SHOPIFY_ENV, ...LEGACY_FLAG, SUPABASE_SERVICE_ROLE_KEY: SECRET, FINANCE_DASHBOARD_TOKEN: SECRET };
  for (const [name, resolve] of Object.entries(ENTRY_POINTS)) {
    for (const extra of [{}, { NORDLA_MERCHANT_ID: UNKNOWN }, { NORDLA_MERCHANT_ID: `bad-${SECRET}` }]) {
      const lines = [];
      const failing = { async select() { throw new Error(`HTTP 401 invalid key ${SECRET}`); } };
      for (const supabase of [db(), failing]) {
        const e = await resolve({ env: { ...env, ...extra }, supabase, log: (l) => lines.push(String(l)), factory: shopAsA().factory }).catch((x) => x);
        assert.ok(e instanceof Error, `${name} must refuse`);
        assert.doesNotMatch(`${e.message} ${JSON.stringify(e.detail ?? {})} ${e.stack ?? ''}`, new RegExp(SECRET), `${name}: secret in the error`);
      }
      assert.doesNotMatch(lines.join('\n'), new RegExp(SECRET), `${name}: secret in the log`);
    }
  }
  const lines = [];
  await resolveFinanceTenant({ env: { ...env, NORDLA_MERCHANT_ID: A.id }, supabase: db(), log: (l) => lines.push(l) });
  assert.deepEqual(lines, [`Finance tenant: ${A.name} (tenant source = env)`]);
}));

// the tool entry used by Growth writes nothing and builds no report file when it refuses
test('a refused tool resolution creates nothing (no merchant, no file)', async () => {
  const s = db({ onlyA: true }); const dir = await tmp();
  await assert.rejects(resolveToolTenant({ env: { ...SHOPIFY_ENV, ...LEGACY_FLAG }, supabase: s, tool: 'growth', log: quiet }), (e) => e.code === T.MERCHANT_ID_MISSING);
  assert.deepEqual(s.writes, []); assert.deepEqual(await readdir(dir), []); assert.equal(s._tables.get('merchants').length, 1);
});
