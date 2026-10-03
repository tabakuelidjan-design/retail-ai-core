// Step 6 (ADR 0003): Analytics serves ONE explicit merchant (NORDLA_MERCHANT_ID via the shared resolver) and builds its report from the
// data Core already synced into Nordla - never Shopify, never "the only merchant". Every report file is stamped with its tenant and a
// bound server never serves another merchant's (or an unstamped) file. Two synthetic merchants share one in-memory Supabase; every
// outbound request is trapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { runReport } from '../src/report/index.js';
import { startAnalyticsServer } from '../src/analytics-premium/server/serve.js';
import { bindReportsTenant, unbindReportsTenant, datasetOwnedBy, servesTenant } from '../src/analytics-premium/server/tenant.js';
import { TENANT_ERROR_CODES as T } from '../src/tenant/index.js';

const A = '0f5a1c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b';
const B = '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0';
const UNKNOWN = '11111111-2222-4333-8444-555555555555';
const SHOPIFY_ENV = { SHOPIFY_SHOP_DOMAIN: 'synthetic.myshopify.example', SHOPIFY_CLIENT_ID: 'synthetic-client', SHOPIFY_CLIENT_SECRET: 'synthetic-not-a-secret' };
const DAY = 86_400_000;

/** Two merchants with the same shapes but distinct names and amounts; each has a shopify connector unless told otherwise. */
async function twoMerchants({ connectors = [A, B] } = {}) {
  const s = createFakeSupabase();
  await s.insert('merchants', [{ id: A, name: 'Merchant Alpha', source_system: 'shopify', source_id: 'gid://shopify/Shop/LEGACY-A' }, { id: B, name: 'Merchant Beta', source_system: 'shopify', source_id: 'gid://shopify/Shop/LEGACY-B' }]);
  s._tables.set('merchant_connectors', connectors.map((m) => ({ id: randomUUID(), merchant_id: m, kind: 'shopify', external_id: `gid://shopify/Shop/SYN-${m === A ? 'A' : 'B'}`, status: 'CONFIGURED', config: {} })));
  const build = async (merchantId, tag, price, qty) => {
    const productId = randomUUID(); const variantId = randomUUID(); const locationId = randomUUID();
    await s.insert('products', [{ id: productId, merchant_id: merchantId, title: `${tag} Product`, product_type: `${tag}Type`, source_system: 'shopify', source_id: `${tag}-p1` }]);
    await s.insert('variants', [{ id: variantId, merchant_id: merchantId, product_id: productId, sku: `${tag}-SKU`, title: 'Default', source_system: 'shopify', source_id: `${tag}-v1` }]);
    await s.insert('locations', [{ id: locationId, merchant_id: merchantId, name: `${tag} Store`, type: 'physical', source_system: 'shopify', source_id: `${tag}-loc` }]);
    for (let d = 1; d <= 3; d += 1) {
      const orderId = randomUUID();
      await s.insert('orders', [{ id: orderId, merchant_id: merchantId, source_system: 'shopify', source_id: `${tag}-o${d}`, ordered_at: new Date(Date.now() - d * DAY).toISOString(), currency: 'EUR', status: 'PAID', taxes_included: true, is_test: false, customer_key: `${tag}-customer-${d % 2}`, location_id: locationId, source_name: 'pos', channel_name: `${tag} Channel` }]);
      await s.insert('order_lines', [{ id: randomUUID(), order_id: orderId, merchant_id: merchantId, variant_id: variantId, source_system: 'shopify', source_id: `${tag}-l${d}`, title_snapshot: `${tag} Product`, sku_snapshot: `${tag}-SKU`, quantity: qty, unit_price: price, discount_amount: 0, tax_amount: 0, tax_rate_bp: 0 }]);
    }
    await s.insert('product_costs', [{ id: randomUUID(), variant_id: variantId, merchant_id: merchantId, unit_cost: price / 2, currency: 'EUR', effective_from: new Date(Date.now() - 90 * DAY).toISOString(), source: 'shopify_unit_cost', validation_status: 'unverified' }]);
    await s.insert('inventory_snapshots', [{ id: randomUUID(), variant_id: variantId, location_id: locationId, merchant_id: merchantId, quantity: 5, synced_at: new Date(Date.now() - DAY).toISOString() }]);
  };
  await build(A, 'Alpha', 10, 1);
  await build(B, 'Beta', 990, 3);
  const writes = [];
  for (const m of ['insert', 'upsert', 'update', 'delete']) { const orig = s[m].bind(s); s[m] = async (table, ...r) => { writes.push(`${m} ${table}`); return orig(table, ...r); }; }
  s.writes = writes;
  return s;
}
/** A Shopify client factory that must never be used, and a fetch trap that lets only loopback traffic through. */
const shopifyTrap = () => { const calls = { created: 0 }; return { calls, factory: () => { calls.created += 1; throw new Error('Analytics must not contact Shopify'); } }; };
async function withNetworkTrap(fn) {
  const real = globalThis.fetch; const outbound = [];
  globalThis.fetch = (u, o) => (/^http:\/\/127\.0\.0\.1:/.test(String(u)) ? real(u, o) : (outbound.push(String(u)), Promise.reject(new TypeError('fetch failed (Shopify down)'))));
  try { return await fn(outbound, real); } finally { globalThis.fetch = real; }
}
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const quiet = () => {};
const tmp = () => mkdtemp(path.join(tmpdir(), 'analytics-tenant-'));
const ENDPOINTS = ['/api/brief', '/api/what-changed', '/api/explorer', '/api/products', '/api/customers', '/api/explorer?period=last_7_days', '/api/products?period=last_90_days', '/api/customers?period=this_month', '/api/sync-status'];

/** Report for `merchant`, then the real server bound to it; returns every endpoint's body plus a POST /api/ask. */
async function serveFor(s, merchant, { env = {}, trap = shopifyTrap(), ask = 'Quel est mon chiffre d’affaires des 30 derniers jours ?' } = {}) {
  const dir = await tmp();
  const fullEnv = { MERCHANT_TIMEZONE: 'UTC', NORDLA_MERCHANT_ID: merchant, ANALYTICS_PREMIUM_PORT: String(await freePort()), ...env };
  await runReport({ mode: 'report', env: fullEnv, supabase: s, outDir: dir, log: quiet, createClient: trap.factory });
  const { server } = await startAnalyticsServer({ env: fullEnv, supabase: s, reportsDir: dir, log: quiet, createClient: trap.factory });
  const base = `http://127.0.0.1:${fullEnv.ANALYTICS_PREMIUM_PORT}`;
  try {
    const bodies = {};
    for (const p of ENDPOINTS) { const r = await fetch(base + p); bodies[p] = { status: r.status, text: await r.text() }; }
    const r = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: ask, merchantId: merchant === A ? B : A, tenant: B }) });
    bodies.ask = { status: r.status, text: await r.text() };
    return { dir, bodies, files: await readdir(dir) };
  } finally { await new Promise((res) => server.close(res)); unbindReportsTenant(dir); }
}

// 1 + 4 + 6 + 7 + 10
test('valid merchant, Shopify totally absent: report built from Nordla data, server up, every page answers - zero Shopify client, zero outbound request', () => withNetworkTrap(async (outbound) => {
  const s = await twoMerchants(); const trap = shopifyTrap();
  const { bodies, files } = await serveFor(s, A, { trap });
  assert.ok(files.some((f) => /^report-\d{4}-\d{2}-\d{2}\.json$/.test(f)) && files.includes('dataset.json'));
  for (const p of ENDPOINTS) assert.equal(bodies[p].status, 200, `${p}: ${bodies[p].text.slice(0, 120)}`);
  assert.equal(bodies.ask.status, 200, bodies.ask.text.slice(0, 200));
  assert.equal(trap.calls.created, 0, 'no Shopify client at boot nor during the report'); assert.deepEqual(outbound, [], 'no outbound request');
}));

// 5
test('Shopify credentials present but Shopify down: Analytics is unaffected (never contacts it)', () => withNetworkTrap(async (outbound) => {
  const s = await twoMerchants(); const trap = shopifyTrap();
  const { bodies } = await serveFor(s, A, { env: SHOPIFY_ENV, trap });
  for (const p of ENDPOINTS) assert.equal(bodies[p].status, 200, p);
  assert.equal(trap.calls.created, 0); assert.deepEqual(outbound, []);
}));

// 3 + 10 + 11 + 9
test('two merchants, NORDLA_MERCHANT_ID=A: Overview, What changed, Explorer, Produits, Clients, periods, Ask, dataset and report contain A only - never B', () => withNetworkTrap(async () => {
  const s = await twoMerchants();
  const { dir, bodies } = await serveFor(s, A);
  for (const [p, b] of Object.entries(bodies)) assert.doesNotMatch(b.text, /Beta|(?<![0-9a-f-])990(?![0-9a-f-])|Merchant Beta/, `${p} leaks merchant B`);
  assert.match(bodies['/api/products'].text + bodies['/api/explorer'].text, /Alpha Product/, 'A\'s own data is there');
  const dataset = JSON.parse(await readFile(path.join(dir, 'dataset.json'), 'utf8'));
  assert.deepEqual(dataset.tenant, { merchant_id: A });
  assert.ok(dataset.data.orders.length === 3 && dataset.data.products.every((p) => p.title === 'Alpha Product'));
  const reportFile = (await readdir(dir)).find((f) => /^report-.*\.json$/.test(f));
  const report = JSON.parse(await readFile(path.join(dir, reportFile), 'utf8'));
  assert.deepEqual(report.tenant, { merchant_id: A }); assert.doesNotMatch(JSON.stringify(report), /Beta/);
  // Ask: the merchantId / tenant sent in the body are ignored - the figures are A's (3 orders x 10 EUR = 30), never B's (8910)
  const ask = JSON.parse(bodies.ask.text);
  assert.equal(ask.figures[0].value, 30);
  // and the same server scoped to B shows only B
  const b = await serveFor(s, B);
  assert.doesNotMatch(Object.values(b.bodies).map((x) => x.text).join(' '), /Alpha/);
  assert.equal(JSON.parse(b.bodies.ask.text).figures[0].value, 8910);
}));

// 2
test('unknown or missing NORDLA_MERCHANT_ID: server start and report refused cleanly, port never opened, no file written', async () => {
  const s = await twoMerchants();
  for (const env of [{ MERCHANT_TIMEZONE: 'UTC', NORDLA_MERCHANT_ID: UNKNOWN }, {}]) {
    const dir = await tmp(); const port = await freePort();
    await assert.rejects(runReport({ mode: 'report', env, supabase: s, outDir: dir, log: quiet }), (e) => [T.MERCHANT_NOT_FOUND, T.MERCHANT_ID_MISSING].includes(e.code));
    assert.deepEqual(await readdir(dir), []);
    await assert.rejects(startAnalyticsServer({ env: { ...env, ANALYTICS_PREMIUM_PORT: String(port) }, supabase: s, reportsDir: dir, log: quiet }), (e) => [T.MERCHANT_NOT_FOUND, T.MERCHANT_ID_MISSING].includes(e.code));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/brief`), 'the port was never opened');
  }
});

// 8
test('sync status: only the current merchant\'s sync_runs (a real FAILED is kept); no sales connector -> neutral NO_SALES_SOURCE', () => withNetworkTrap(async () => {
  const s = await twoMerchants();
  const at = (m) => new Date(Date.now() - m * 60_000).toISOString();
  s._tables.set('sync_runs', [
    { id: randomUUID(), merchant_id: A, mode: 'all', status: 'SUCCESS', started_at: at(30), finished_at: at(29) },
    { id: randomUUID(), merchant_id: A, mode: 'all', status: 'FAILED', started_at: at(10), finished_at: at(9), error: 'UNAVAILABLE: SHOPIFY_ERROR' },
    { id: randomUUID(), merchant_id: B, mode: 'all', status: 'SUCCESS', started_at: at(1), finished_at: at(0) },
  ]);
  const sa = JSON.parse((await serveFor(s, A)).bodies['/api/sync-status'].text).sync;
  assert.equal(sa.available, true); assert.equal(sa.latestFailed, true, 'A\'s real FAILED status is shown, not B\'s newer SUCCESS'); assert.equal(sa.lastAttempt.status, 'FAILED');
  const sb = JSON.parse((await serveFor(s, B)).bodies['/api/sync-status'].text).sync;
  assert.equal(sb.latestFailed, false);
  const none = await twoMerchants({ connectors: [B] });
  assert.deepEqual(JSON.parse((await serveFor(none, A)).bodies['/api/sync-status'].text).sync, { available: false, reason: 'NO_SALES_SOURCE' });
}));

// 9
test('report files: a foreign or unstamped report / dataset is never served by a bound server, and the refresher rebuilds it', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'report-2026-09-27.json'), JSON.stringify({ tenant: { merchant_id: B }, generated_at: '2026-09-27T08:00:00Z', sales: {} }));
  await writeFile(path.join(dir, 'dataset.json'), JSON.stringify({ version: 1, tenant: { merchant_id: B }, generated_at: '2026-09-27T08:00:00Z', data: { orders: [] } }));
  assert.equal(await datasetOwnedBy(dir, A), false); assert.equal(await datasetOwnedBy(dir, B), true);
  bindReportsTenant(dir, A);
  try {
    const { loadBrief } = await import('../src/analytics-premium/server/brief.js');
    const { loadProducts } = await import('../src/analytics-premium/server/products.js');
    const { loadCustomers } = await import('../src/analytics-premium/server/customers.js');
    const { loadExplorer } = await import('../src/analytics-premium/server/explorer.js');
    const { loadWhatChanged } = await import('../src/analytics-premium/server/what-changed.js');
    const { periodReport } = await import('../src/analytics-premium/server/period-engine.js');
    for (const load of [loadBrief, loadProducts, loadCustomers, loadExplorer, loadWhatChanged]) assert.equal(await load(dir), null, load.name);
    assert.equal((await periodReport(dir, { period: 'last_7_days' })).code, 'DATASET_UNAVAILABLE');
    // an unstamped legacy file is refused too
    await writeFile(path.join(dir, 'report-2026-09-28.json'), JSON.stringify({ generated_at: '2026-09-28T08:00:00Z' }));
    assert.equal(await loadBrief(dir), null);
    assert.equal(servesTenant(dir, { tenant: { merchant_id: A } }), true);
  } finally { unbindReportsTenant(dir); await rm(dir, { recursive: true, force: true }); }
});

// 12
test('no merchant is ever created or changed by Analytics (report + serving are read-only on merchants and connectors)', () => withNetworkTrap(async () => {
  const s = await twoMerchants(); const before = JSON.stringify(s._tables.get('merchants')); const writesBefore = s.writes.length;
  await serveFor(s, A);
  assert.equal(JSON.stringify(s._tables.get('merchants')), before);
  assert.deepEqual(s.writes.slice(writesBefore), [], 'report mode + every page: zero database writes');
  const empty = createFakeSupabase();
  await assert.rejects(runReport({ mode: 'report', env: { MERCHANT_TIMEZONE: 'UTC', NORDLA_MERCHANT_ID: A }, supabase: empty, outDir: await tmp(), log: quiet }), (e) => e.code === T.MERCHANT_NOT_FOUND);
  assert.equal((empty._tables.get('merchants') ?? []).length, 0);
}));

// 13
test('no "only merchant" logic left: one merchant + no NORDLA_MERCHANT_ID is refused; the source has no single-merchant or Shopify identity path', async () => {
  const one = createFakeSupabase(); await one.insert('merchants', [{ id: A, name: 'Only' }]);
  await assert.rejects(startAnalyticsServer({ env: { ANALYTICS_PREMIUM_PORT: String(await freePort()) }, supabase: one, reportsDir: await tmp(), log: quiet }), (e) => e.code === T.MERCHANT_ID_MISSING);
  // every source file of the Analytics server, subfolders included (ai/, tools/ appeared with the Ask work)
  const walk = (rel) => readdirSync(new URL(`../${rel}/`, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${rel}/${e.name}`) : e.name.endsWith('.js') ? [`${rel}/${e.name}`] : []));
  const files = ['src/report/index.js', ...walk('src/analytics-premium/server')];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /MERCHANT_NOT_UNIQUE|limit: '2'|merchants\[0\]|source_system: 'eq\.shopify'/, `${f}: single-merchant / Shopify identity logic`);
    assert.doesNotMatch(src, /^import .*shopify\/(client|queries)\.js'/m, `${f}: no static Shopify import (only lazy, for the explicit Shopify modes / legacy lookup)`);
  }
});

test('legacy fallback (ADR): off -> refused; explicitly on and no NORDLA_MERCHANT_ID -> tenant via merchant_connectors (not merchants.source_id), logged', async () => {
  const s = await twoMerchants(); const dir = await tmp();
  await assert.rejects(runReport({ mode: 'report', env: { MERCHANT_TIMEZONE: 'UTC', ...SHOPIFY_ENV }, supabase: s, outDir: dir, log: quiet }), (e) => e.code === T.MERCHANT_ID_MISSING);
  const lines = [];
  const shopB = () => ({ graphql: async () => ({ shop: { id: 'gid://shopify/Shop/SYN-B' } }) });
  const r = await runReport({ mode: 'report', env: { MERCHANT_TIMEZONE: 'UTC', ...SHOPIFY_ENV, NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP: 'true' }, supabase: s, outDir: dir, log: (l) => lines.push(l), createClient: shopB });
  assert.equal(r.merchantId, B);
  assert.ok(lines.some((l) => /tenant source = legacy_shopify/.test(l)) && lines.some((l) => /WARNING/.test(l)));
});

test('the Shopify-comparison modes say so explicitly when Shopify is not configured; "report" never needs it', async () => {
  const s = await twoMerchants();
  for (const mode of ['validate', 'triage', 'demand']) await assert.rejects(runReport({ mode, env: { MERCHANT_TIMEZONE: 'UTC', NORDLA_MERCHANT_ID: A }, supabase: s, outDir: await tmp(), log: quiet }), (e) => e.code === 'SHOPIFY_NOT_CONFIGURED', mode);
});
