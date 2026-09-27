// Step 7 (ADR 0003): the remaining command-line tools (buying, customers, marketing) serve the merchant named by NORDLA_MERCHANT_ID,
// never the merchant behind a Shopify shop. Shopify is used only where a feature really needs it (buying's sales reconciliation,
// marketing --validate), through the tenant's VERIFIED shopify connector, with explicit NOT_CONFIGURED / MISCONFIGURED / UNAVAILABLE.
// Plus a global source guard: no active code may pick "the first / only merchant" or create a merchant from Shopify again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { SHOP_QUERY } from '../src/shopify/queries.js';
import { runCustomerFacts } from '../src/customers/index.js';
import { runMarketingReport } from '../src/marketing/index.js';
import { loadBuyingContext } from '../src/buying/context.js';
import { TENANT_ERROR_CODES as T } from '../src/tenant/index.js';

const A = '0f5a1c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b';
const B = '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0';
const UNKNOWN = '11111111-2222-4333-8444-555555555555';
const SHOP_A = 'gid://shopify/Shop/SYN-A'; const SHOP_B = 'gid://shopify/Shop/SYN-B';
const SHOPIFY_ENV = { SHOPIFY_SHOP_DOMAIN: 'synthetic.myshopify.example', SHOPIFY_CLIENT_ID: 'synthetic-client', SHOPIFY_CLIENT_SECRET: 'synthetic-not-a-secret' };
const DAY = 86_400_000;
const quiet = () => {};
const tmp = () => mkdtemp(path.join(tmpdir(), 'tools-tenant-'));

/** Merchants A ("Alpha") and B ("Beta"), each with its own shopify connector unless told otherwise; every DB write is recorded. */
async function twoMerchants({ connectors = [[A, SHOP_A], [B, SHOP_B]] } = {}) {
  const s = createFakeSupabase();
  await s.insert('merchants', [{ id: A, name: 'Merchant Alpha', source_system: 'shopify', source_id: 'gid://shopify/Shop/LEGACY-A' }, { id: B, name: 'Merchant Beta', source_system: 'shopify', source_id: 'gid://shopify/Shop/LEGACY-B' }]);
  s._tables.set('merchant_connectors', connectors.map(([m, shop]) => ({ id: randomUUID(), merchant_id: m, kind: 'shopify', external_id: shop, status: 'CONFIGURED', config: {} })));
  const build = async (merchantId, tag, price) => {
    const productId = randomUUID(); const variantId = randomUUID();
    await s.insert('products', [{ id: productId, merchant_id: merchantId, title: `${tag} Product`, product_type: `${tag}Type`, source_system: 'shopify', source_id: `${tag}-p1` }]);
    await s.insert('variants', [{ id: variantId, merchant_id: merchantId, product_id: productId, sku: `${tag}-SKU`, title: 'Default', source_system: 'shopify', source_id: `${tag}-v1` }]);
    for (let d = 1; d <= 3; d += 1) {
      const orderId = randomUUID();
      await s.insert('orders', [{ id: orderId, merchant_id: merchantId, source_system: 'shopify', source_id: `${tag}-o${d}`, ordered_at: new Date(Date.now() - d * DAY).toISOString(), currency: 'EUR', status: 'PAID', taxes_included: true, is_test: false, customer_key: `${tag}-customer-${d % 2}`, source_name: 'web', channel_handle: 'online_store', channel_name: `${tag} Channel` }]);
      await s.insert('order_lines', [{ id: randomUUID(), order_id: orderId, merchant_id: merchantId, variant_id: variantId, source_system: 'shopify', source_id: `${tag}-l${d}`, title_snapshot: `${tag} Product`, sku_snapshot: `${tag}-SKU`, quantity: 1, unit_price: price, discount_amount: 0, tax_amount: 0, tax_rate_bp: 0 }]);
    }
  };
  await build(A, 'Alpha', 10); await build(B, 'Beta', 990);
  const writes = [];
  for (const m of ['insert', 'upsert', 'update', 'delete']) { const orig = s[m].bind(s); s[m] = async (table, ...r) => { writes.push({ m, table }); return orig(table, ...r); }; }
  s.writes = writes;
  return s;
}
/** Synthetic Shopify client factory: answers as `shopId`; `down` fails like a network error; counts business queries. */
function shopAs(shopId, { down = false } = {}) {
  const calls = { created: 0, identity: 0, business: 0 };
  const factory = () => { calls.created += 1; return { async graphql(q) {
    if (down) throw new TypeError('fetch failed');
    if (q === SHOP_QUERY) { calls.identity += 1; return { shop: { id: shopId, name: 'S', myshopifyDomain: 'x' } }; }
    calls.business += 1;
    if (/\borders\s*\(/.test(q)) return { orders: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    throw new Error('unexpected query');
  } }; };
  return { calls, factory };
}
const trap = () => { const calls = { created: 0 }; return { calls, factory: () => { calls.created += 1; throw new Error('Shopify must not be contacted'); } }; };
async function noNetwork(fn) {
  const real = globalThis.fetch; const hits = [];
  globalThis.fetch = async (u) => { hits.push(String(u)); throw new TypeError('network forbidden in this test'); };
  try { return await fn(hits); } finally { globalThis.fetch = real; }
}
// 990 (B's price) only as a standalone number: never as a fragment of a random UUID (hex), which made this check flaky (~0.6% per id)
const leaks = (value, other) => new RegExp(other === 'Beta' ? 'Beta|(?<![0-9a-f-])990(?![0-9a-f-])' : 'Alpha').test(JSON.stringify(value));

// The three tools, behind one shape: run(tool, supabase, env, { argv, createClient }) -> { merchantId, output }
const TOOLS = {
  customers: async (s, env, o) => { const r = await runCustomerFacts({ env, supabase: s, outDir: o.outDir, log: quiet, createClient: o.createClient }); return { merchantId: r.merchantId, output: JSON.parse(await readFile(r.file, 'utf8')) }; },
  marketing: async (s, env, o) => { const r = await runMarketingReport({ argv: o.argv ?? [], env, supabase: s, outDir: o.outDir, log: quiet, createClient: o.createClient, coverage: async () => null }); return { merchantId: r.merchantId, output: JSON.parse(await readFile(r.file, 'utf8')), exitCode: r.exitCode }; },
  buying: async (s, env, o) => { const ctx = await loadBuyingContext({ env, supabase: s, createClient: o.createClient, log: quiet, policyPath: 'no/such/policy.json', verificationPath: 'no/such/counts.json' }); return { merchantId: ctx.merchantId, output: ctx.facts }; },
};

for (const [name, run] of Object.entries(TOOLS)) {
  test(`${name}: valid merchant, Shopify absent -> built from Nordla data only; zero Shopify client, zero network; A only`, () => noNetwork(async (hits) => {
    const s = await twoMerchants(); const t = trap();
    const r = await run(s, { NORDLA_MERCHANT_ID: A }, { outDir: await tmp(), createClient: t.factory });
    assert.equal(r.merchantId, A); assert.equal(leaks(r.output, 'Beta'), false, 'no B data'); assert.equal(t.calls.created, 0); assert.deepEqual(hits, []);
    if (name !== 'buying') assert.deepEqual(r.output.tenant, { merchant_id: A });
    if (name === 'buying') assert.equal(r.output.input_status.sales_reconciliation.status, 'NOT_CONFIGURED');
  }));

  test(`${name}: two merchants - NORDLA_MERCHANT_ID=B reads only B (and the reverse holds)`, async () => {
    const s = await twoMerchants();
    const rb = await run(s, { NORDLA_MERCHANT_ID: B }, { outDir: await tmp(), createClient: trap().factory });
    assert.equal(rb.merchantId, B); assert.equal(leaks(rb.output, 'Alpha'), false);
    const ra = await run(s, { NORDLA_MERCHANT_ID: A }, { outDir: await tmp(), createClient: trap().factory });
    assert.equal(leaks(ra.output, 'Beta'), false);
  });

  test(`${name}: unknown / missing / malformed NORDLA_MERCHANT_ID -> refused cleanly, nothing written, no Shopify`, async () => {
    for (const env of [{ NORDLA_MERCHANT_ID: UNKNOWN, ...SHOPIFY_ENV }, { ...SHOPIFY_ENV }, { NORDLA_MERCHANT_ID: 'nope' }]) {
      const s = await twoMerchants(); const dir = await tmp(); const t = trap();
      await assert.rejects(run(s, env, { outDir: dir, createClient: t.factory }), (e) => [T.MERCHANT_NOT_FOUND, T.MERCHANT_ID_MISSING, T.MERCHANT_ID_INVALID].includes(e.code));
      assert.deepEqual(s.writes, []); assert.deepEqual(await readdir(dir), []); assert.equal(t.calls.created, 0);
    }
  });

  test(`${name}: one merchant in the database and no NORDLA_MERCHANT_ID -> refused (never "the only merchant"), no merchant created`, async () => {
    const one = createFakeSupabase(); await one.insert('merchants', [{ id: A, name: 'Only' }]);
    await assert.rejects(run(one, {}, { outDir: await tmp(), createClient: trap().factory }), (e) => e.code === T.MERCHANT_ID_MISSING);
    const empty = createFakeSupabase();
    await assert.rejects(run(empty, { NORDLA_MERCHANT_ID: A }, { outDir: await tmp(), createClient: trap().factory }), (e) => e.code === T.MERCHANT_NOT_FOUND);
    assert.equal((empty._tables.get('merchants') ?? []).length, 0);
  });

  test(`${name}: legacy lookup only when explicitly enabled - resolved through merchant_connectors (not merchants.source_id), logged`, async () => {
    const s = await twoMerchants();
    const r = await run(s, { ...SHOPIFY_ENV, NORDLA_TENANT_LEGACY_SHOPIFY_LOOKUP: 'true' }, { outDir: await tmp(), createClient: shopAs(SHOP_B).factory });
    assert.equal(r.merchantId, B, 'SYN-B is B\'s connector; B\'s merchants.source_id is LEGACY-B');
    await assert.rejects(run(s, { ...SHOPIFY_ENV }, { outDir: await tmp(), createClient: shopAs(SHOP_B).factory }), (e) => e.code === T.MERCHANT_ID_MISSING);
  });
}

// ---------- the Shopify-dependent features: buying reconciliation, marketing --validate ----------
const SHOPIFY_FEATURES = {
  'buying reconciliation': async (s, env, factory) => (await TOOLS.buying(s, env, { createClient: factory })).output.input_status.sales_reconciliation,
  'marketing --validate': async (s, env, factory) => (await TOOLS.marketing(s, env, { argv: ['--validate'], outDir: await tmp(), createClient: factory })).output.validation,
};
for (const [name, feature] of Object.entries(SHOPIFY_FEATURES)) {
  const status = (v) => v.status ?? (name === 'marketing --validate' ? 'CHECKED' : v.status);
  test(`${name}: the tenant's own shop -> Shopify is read (after the identity check)`, async () => {
    const s = await twoMerchants(); const shop = shopAs(SHOP_A);
    const v = await feature(s, { NORDLA_MERCHANT_ID: A, ...SHOPIFY_ENV }, shop.factory);
    assert.equal(status(v), 'CHECKED'); assert.ok(shop.calls.identity >= 1 && shop.calls.business >= 1);
  });
  test(`${name}: no credentials, or credentials but no shopify connector for the tenant -> NOT_CONFIGURED, no Shopify call`, async () => {
    const s = await twoMerchants(); const t = trap();
    assert.equal((await feature(s, { NORDLA_MERCHANT_ID: A }, t.factory)).status, 'NOT_CONFIGURED');
    const noConn = await twoMerchants({ connectors: [[B, SHOP_B]] });
    const v = await feature(noConn, { NORDLA_MERCHANT_ID: A, ...SHOPIFY_ENV }, t.factory);
    assert.equal(v.status, 'NOT_CONFIGURED'); assert.equal(v.reason, 'NO_SHOPIFY_CONNECTOR_FOR_TENANT'); assert.equal(t.calls.created, 0);
  });
  test(`${name}: Shopify down -> UNAVAILABLE, the tool still produces its Nordla facts`, async () => {
    const s = await twoMerchants();
    assert.equal((await feature(s, { NORDLA_MERCHANT_ID: A, ...SHOPIFY_ENV }, shopAs(SHOP_A, { down: true }).factory)).status, 'UNAVAILABLE');
  });
  test(`${name}: another merchant's shop (B's) behind the credentials for A -> MISCONFIGURED, no business query sent, nothing written`, async () => {
    const s = await twoMerchants(); const shop = shopAs(SHOP_B);
    const v = await feature(s, { NORDLA_MERCHANT_ID: A, ...SHOPIFY_ENV }, shop.factory);
    assert.equal(v.status, 'MISCONFIGURED'); assert.equal(shop.calls.business, 0, 'no data read from the wrong shop');
    assert.deepEqual(s.writes, []);
  });
}

test('marketing --write-flags writes data_quality_flags for the resolved merchant only (never B), and marketing never writes merchants', async () => {
  const s = await twoMerchants();
  await TOOLS.marketing(s, { NORDLA_MERCHANT_ID: A }, { argv: ['--write-flags'], outDir: await tmp(), createClient: trap().factory });
  assert.ok(s.writes.every((w) => w.table === 'data_quality_flags'), JSON.stringify(s.writes));
  assert.ok((s._tables.get('data_quality_flags') ?? []).every((f) => f.merchant_id === A));
});

// ---------- global source guard ----------
const ROOT = new URL('../', import.meta.url);
function sources(dir) {
  const out = [];
  for (const f of readdirSync(new URL(dir, ROOT))) {
    const rel = `${dir}${f}`; if (statSync(new URL(rel, ROOT)).isDirectory()) out.push(...sources(`${rel}/`)); else if (/\.(m?js)$/.test(f)) out.push(rel);
  }
  return out;
}
// Explicitly allowed, each for a stated reason:
const SHOP_QUERY_ALLOWED = {
  'src/shopify/queries.js': 'the query definition',
  'src/connectors/shopify.js': 'verifies the shop behind the credentials against the tenant\'s connector (identity CHECK, not lookup)',
  'src/sync/tenant-context.js': 'Core: connector verification + the ADR legacy lookup (explicit flag, merchant_connectors)',
  'src/finance/runtime.js': 'Finance: the ADR legacy lookup (explicit flag, merchant_connectors)',
  'src/analytics-premium/server/tenant.js': 'Analytics: the ADR legacy lookup (explicit flag, merchant_connectors)',
  'src/tenant/tool-context.js': 'CLI tools: the ADR legacy lookup (explicit flag, merchant_connectors)',
};
const MERCHANT_CREATION_ALLOWED = { 'scripts/finance-db-concurrency-check.mjs': 'admin concurrency check: a clearly labelled SCRATCH merchant, no Shopify' };

test('global source guard: no active code picks the first / only merchant, derives a merchant from a Shopify shop, or creates a merchant', () => {
  const files = [...sources('src/'), ...sources('scripts/')];
  assert.ok(files.length > 100);
  const problems = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, ROOT), 'utf8');
    if (/MERCHANT_NOT_UNIQUE|merchants\[0\]|merchants\.length\s*[!=]==?\s*1|select\(\s*'merchants'[^)]*limit:\s*'2'/.test(src)) problems.push(`${f}: first / only merchant`);
    if (/select\(\s*'merchants'[^)]*source_id/.test(src)) problems.push(`${f}: merchant looked up by source_id (Shopify shop -> merchant)`);
    if (/(upsert|insert)\(\s*'merchants'/.test(src) && !MERCHANT_CREATION_ALLOWED[f]) problems.push(`${f}: creates a merchant`);
    if (/normalizeMerchant\s*\(/.test(src)) problems.push(`${f}: builds a merchant from a Shopify shop`);
    if (/\bSHOP_QUERY\b/.test(src) && !SHOP_QUERY_ALLOWED[f]) problems.push(`${f}: uses SHOP_QUERY outside the allowed identity-check / legacy places`);
  }
  assert.deepEqual(problems, []);
});

test('global source guard catches a reintroduction (self-test of the patterns)', () => {
  const bad = ["const [m] = await supabase.select('merchants', { select: 'id', limit: '2' });", "if (merchants.length !== 1) return;", "await supabase.upsert('merchants', [row], { onConflict: 'source_system,source_id' });", "supabase.select('merchants', { select: 'id', source_system: 'eq.shopify', source_id: `eq.${shop.id}` })"];
  const hit = (s) => /merchants\[0\]|merchants\.length\s*[!=]==?\s*1|select\(\s*'merchants'[^)]*limit:\s*'2'|select\(\s*'merchants'[^)]*source_id|(upsert|insert)\(\s*'merchants'/.test(s);
  for (const b of bad) assert.equal(hit(b), true, b);
});

test('the command-line tools do not depend on NORDLA_SERVICE (only the service dispatcher reads it)', () => {
  const users = [...sources('src/'), ...sources('scripts/')].filter((f) => readFileSync(new URL(f, ROOT), 'utf8').includes('NORDLA_SERVICE'));
  assert.deepEqual(users, ['src/service-start.js']);
});

test('leak marker self-check: B\'s price as a number is detected, a random UUID that happens to contain "990" is not (was a flake)', () => {
  assert.equal(leaks({ price: 990 }, 'Beta'), true); assert.equal(leaks([990, 1], 'Beta'), true); assert.equal(leaks({ name: 'Beta' }, 'Beta'), true);
  for (const id of ['a0b9904c-5e6f-4a1b-8c2d-3e4f5a6b7c8d', '4a1e9901-0000-4000-8000-000000000000', '12345678-990a-4bcd-8ef0-123456789abc']) assert.equal(leaks({ id }, 'Beta'), false, id);
});
