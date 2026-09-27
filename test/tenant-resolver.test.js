// Tenant resolver (ADR 0003): NORDLA_MERCHANT_ID is the explicit tenant; never "the first" or "the only" merchant, never a
// merchant creation, never a Shopify call. Synthetic merchants only, in-memory Supabase stand-in, fetch spied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import {
  resolveTenant, resolveMerchantById, readMerchantIdFromEnv, isLegacyShopifyLookupEnabled, isUuid,
  TenantResolutionError, TENANT_ERROR_CODES, TENANT_SOURCES, MERCHANT_ID_ENV, LEGACY_SHOPIFY_LOOKUP_ENV,
} from '../src/tenant/index.js';

const A = { id: '0f5a1c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b', name: 'Synthetic Merchant A', vertical: 'general_retail', source_system: 'shopify', source_id: 'gid://shopify/Shop/SYN-A' };
const B = { id: '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0', name: 'Synthetic Merchant B', vertical: 'bookstore', source_system: 'shopify', source_id: 'gid://shopify/Shop/SYN-B' };
const UNKNOWN = '11111111-2222-4333-8444-555555555555';
// Shopify variables present on purpose: the resolver must ignore them.
const SHOPIFY_ENV = { SHOPIFY_SHOP_DOMAIN: 'synthetic-shop.myshopify.example', SHOPIFY_CLIENT_ID: 'synthetic-client', SHOPIFY_CLIENT_SECRET: 'synthetic-secret' };

/** Fake Supabase seeded with the given merchants, recording every call made on it. */
function spyDb(...merchants) {
  const db = createFakeSupabase(); db._tables.set('merchants', merchants.map((m) => ({ ...m })));
  const calls = [];
  const spy = new Proxy(db, { get(t, prop) { const v = t[prop]; return typeof v === 'function' ? (...args) => { calls.push({ method: prop, table: args[0], params: args[1] }); return v.apply(t, args); } : v; } });
  return { supabase: spy, calls, rows: () => db._tables.get('merchants') };
}
/** Runs fn with global fetch replaced by a recorder that fails loudly: proves no network (Shopify or other) is used. */
async function noNetwork(fn) {
  const real = globalThis.fetch; const hits = [];
  globalThis.fetch = async (url) => { hits.push(String(url)); throw new Error('network is forbidden in this test'); };
  try { return await fn(hits); } finally { globalThis.fetch = real; }
}
const rejectsWith = (p, code) => assert.rejects(p, (e) => e instanceof TenantResolutionError && e.code === code);

test('valid merchant: returns its Nordla identity, source env, after exactly one read of that merchant', () => noNetwork(async (hits) => {
  const { supabase, calls } = spyDb(A);
  const t = await resolveTenant({ supabase, env: { ...SHOPIFY_ENV, [MERCHANT_ID_ENV]: A.id } });
  assert.deepEqual(t, { merchantId: A.id, merchant: { id: A.id, name: A.name, vertical: A.vertical }, source: 'env' });
  assert.equal(t.source, 'env');
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.merchant));
  assert.deepEqual(calls, [{ method: 'select', table: 'merchants', params: { select: 'id,name,vertical', id: `eq.${A.id}`, limit: '1' } }]);
  assert.equal(hits.length, 0);
}));

test('the identity exposes no Shopify fields (source_system / source_id stay out of the tenant contract)', async () => {
  const { supabase } = spyDb(A);
  const t = await resolveTenant({ supabase, env: { [MERCHANT_ID_ENV]: A.id } });
  assert.deepEqual(Object.keys(t.merchant).sort(), ['id', 'name', 'vertical']);
});

test('upper-case and padded UUIDs are accepted and normalised', async () => {
  const { supabase } = spyDb(A);
  const t = await resolveTenant({ supabase, env: { [MERCHANT_ID_ENV]: `  ${A.id.toUpperCase()} ` } });
  assert.equal(t.merchantId, A.id);
});

test('missing NORDLA_MERCHANT_ID: structured MERCHANT_ID_MISSING, no database read, no network', () => noNetwork(async (hits) => {
  for (const env of [{}, { [MERCHANT_ID_ENV]: '' }, { [MERCHANT_ID_ENV]: '   ' }, SHOPIFY_ENV]) {
    const { supabase, calls } = spyDb(A);
    await rejectsWith(resolveTenant({ supabase, env }), TENANT_ERROR_CODES.MERCHANT_ID_MISSING);
    assert.equal(calls.length, 0);
  }
  assert.equal(hits.length, 0);
}));

test('malformed NORDLA_MERCHANT_ID: structured MERCHANT_ID_INVALID, no database read', async () => {
  for (const bad of ['not-a-uuid', '12345', A.id.slice(0, -1), `${A.id}0`, A.id.replace(/-/g, ''), 'gid://shopify/Shop/SYN-A', "' or 1=1 --"]) {
    const { supabase, calls } = spyDb(A);
    await rejectsWith(resolveTenant({ supabase, env: { [MERCHANT_ID_ENV]: bad } }), TENANT_ERROR_CODES.MERCHANT_ID_INVALID);
    assert.equal(calls.length, 0, `no read for ${bad}`);
  }
});

test('well-formed UUID of a merchant that does not exist: MERCHANT_NOT_FOUND, never another merchant', async () => {
  const { supabase } = spyDb(A, B);
  const err = await resolveTenant({ supabase, env: { [MERCHANT_ID_ENV]: UNKNOWN } }).catch((e) => e);
  assert.ok(err instanceof TenantResolutionError);
  assert.equal(err.code, TENANT_ERROR_CODES.MERCHANT_NOT_FOUND);
  assert.equal(err.detail.merchantId, UNKNOWN);
});

test('two merchants: only the explicitly requested one is returned, each way round', async () => {
  const { supabase } = spyDb(A, B);
  assert.equal((await resolveTenant({ supabase, env: { [MERCHANT_ID_ENV]: A.id } })).merchant.name, A.name);
  assert.equal((await resolveTenant({ supabase, env: { [MERCHANT_ID_ENV]: B.id } })).merchant.name, B.name);
});

test('one merchant in the database but no NORDLA_MERCHANT_ID: refused, the only merchant is never selected', async () => {
  const { supabase, calls } = spyDb(A);
  await rejectsWith(resolveTenant({ supabase, env: {} }), TENANT_ERROR_CODES.MERCHANT_ID_MISSING);
  assert.equal(calls.length, 0, 'the merchants table is not even listed');
});

test('no merchant is ever created or modified (only one select, table unchanged, even when the id is unknown)', async () => {
  const { supabase, calls, rows } = spyDb(A);
  const before = JSON.stringify(rows());
  await resolveTenant({ supabase, env: { [MERCHANT_ID_ENV]: A.id } });
  await resolveTenant({ supabase, env: { [MERCHANT_ID_ENV]: UNKNOWN } }).catch(() => {});
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ['select']);
  assert.ok(calls.every((c) => c.table === 'merchants'));
  assert.equal(JSON.stringify(rows()), before);
  assert.equal(rows().length, 1);
});

test('no Shopify: the module imports nothing from Shopify and never touches the network', () => noNetwork(async (hits) => {
  const src = readFileSync(new URL('../src/tenant/index.js', import.meta.url), 'utf8');
  assert.equal([...src.matchAll(/^\s*import\s/gm)].length, 0, 'the resolver has no import at all');
  assert.doesNotMatch(src, /shopify\/client|shopify\/queries|SHOP_QUERY|graphql|fetch\(/);
  const { supabase } = spyDb(A);
  await resolveTenant({ supabase, env: { ...SHOPIFY_ENV, [MERCHANT_ID_ENV]: A.id, [LEGACY_SHOPIFY_LOOKUP_ENV]: 'true' } });
  await resolveTenant({ supabase, env: { ...SHOPIFY_ENV, [LEGACY_SHOPIFY_LOOKUP_ENV]: 'true' } }).catch(() => {});
  assert.equal(hits.length, 0);
}));

test('priority: NORDLA_MERCHANT_ID wins even when the legacy flag is on; the legacy source is reserved (not wired)', async () => {
  const { supabase, calls } = spyDb(A);
  const t = await resolveTenant({ supabase, env: { [MERCHANT_ID_ENV]: A.id, [LEGACY_SHOPIFY_LOOKUP_ENV]: '1' } });
  assert.equal(t.source, 'env');
  const before = calls.length;
  const err = await resolveTenant({ supabase, env: { [LEGACY_SHOPIFY_LOOKUP_ENV]: 'yes' } }).catch((e) => e);
  assert.equal(err.code, TENANT_ERROR_CODES.TENANT_SOURCE_NOT_AVAILABLE); assert.equal(err.detail.source, 'legacy_shopify');
  assert.equal(calls.length, before, 'no read on the unavailable legacy path');
});

test('the legacy flag is on only when explicitly enabled', () => {
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) assert.equal(isLegacyShopifyLookupEnabled({ [LEGACY_SHOPIFY_LOOKUP_ENV]: on }), true, on);
  for (const off of [undefined, '', '0', 'false', 'no', 'off', 'enabled?']) assert.equal(isLegacyShopifyLookupEnabled({ [LEGACY_SHOPIFY_LOOKUP_ENV]: off }), false, String(off));
});

test('session source is reserved: passing a session today is refused, nothing is read', async () => {
  const { supabase, calls } = spyDb(A);
  const err = await resolveTenant({ supabase, env: { [MERCHANT_ID_ENV]: A.id }, session: { merchantId: A.id } }).catch((e) => e);
  assert.equal(err.code, TENANT_ERROR_CODES.TENANT_SOURCE_NOT_AVAILABLE); assert.equal(err.detail.source, 'session');
  assert.equal(calls.length, 0);
  assert.deepEqual(TENANT_SOURCES, ['session', 'env', 'legacy_shopify']);
});

test('a failing database read is a structured TENANT_LOOKUP_FAILED whose message carries no secret', async () => {
  const secret = 'service-role-secret-synthetic';
  const supabase = { async select() { throw new Error(`HTTP 503 with key ${secret}`); } };
  const err = await resolveTenant({ supabase, env: { [MERCHANT_ID_ENV]: A.id } }).catch((e) => e);
  assert.equal(err.code, TENANT_ERROR_CODES.TENANT_LOOKUP_FAILED);
  assert.doesNotMatch(`${err.message} ${JSON.stringify(err.detail)}`, new RegExp(secret));
});

test('readMerchantIdFromEnv is the single validation of NORDLA_MERCHANT_ID', () => {
  assert.equal(readMerchantIdFromEnv({}), null);
  assert.equal(readMerchantIdFromEnv({ [MERCHANT_ID_ENV]: A.id.toUpperCase() }), A.id);
  assert.throws(() => readMerchantIdFromEnv({ [MERCHANT_ID_ENV]: 'nope' }), (e) => e.code === TENANT_ERROR_CODES.MERCHANT_ID_INVALID);
  assert.equal(isUuid(A.id), true); assert.equal(isUuid('nope'), false); assert.equal(isUuid(undefined), false);
});

test('resolveMerchantById rejects unknown sources and malformed ids before any read', async () => {
  const { supabase, calls } = spyDb(A);
  await assert.rejects(resolveMerchantById({ supabase, merchantId: A.id, source: 'first_merchant' }), TypeError);
  await rejectsWith(resolveMerchantById({ supabase, merchantId: 'x', source: 'env' }), TENANT_ERROR_CODES.MERCHANT_ID_INVALID);
  assert.equal(calls.length, 0);
});
