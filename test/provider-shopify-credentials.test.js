// Per-merchant Shopify credentials for the readers: resolver isolation, refusals, and the sync preparation that uses them.
// Synthetic data only. The fake token manager and fake database stand in for Vault and Supabase; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyCredentialResolver } from '../src/provider-connections/shopify-credentials.js';
import { prepareShopifySync } from '../src/sync/tenant-context.js';
import { createConnectorRepository } from '../src/tenant/connectors.js';
import { SHOPIFY_READ_SCOPES } from '../src/provider-connections/providers/shopify-oauth.js';

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const SHOP1 = 'merchant-a.myshopify.com';
const SHOP2 = 'merchant-b.myshopify.com';
const GID1 = 'gid://shopify/Shop/101';
const GID2 = 'gid://shopify/Shop/202';
const TOKEN1 = 'shpat_synthetic_merchant_a_0001';
const TOKEN2 = 'shpat_synthetic_merchant_b_0002';

const secret = (v) => ({ reveal: () => v, toJSON: () => '[REDACTED]' });
const oauthRow = (id, merchant, shop, gid, over = {}) => ({
  id, merchant_id: merchant, kind: 'shopify', external_id: gid, external_domain: null, status: 'CONFIGURED',
  config: { provisioned_via: 'oauth', shop_domain: shop, granted_scopes: [...SHOPIFY_READ_SCOPES] }, created_at: '2026-11-25T00:00:00Z', updated_at: '2026-11-25T00:00:00Z', ...over,
});
const globalRow = (id, merchant, gid) => ({
  id, merchant_id: merchant, kind: 'shopify', external_id: gid, external_domain: null, status: 'CONFIGURED', config: {}, created_at: '2026-09-27T00:00:00Z', updated_at: '2026-09-27T00:00:00Z',
});

/** Minimal Supabase stand-in for the connector table: equality filters only. */
function fakeDb(rows) {
  const select = async (table, params = {}) => {
    if (table !== 'merchant_connectors') return [];
    return rows.filter((r) => Object.entries(params).every(([k, v]) => {
      if (['select', 'order', 'limit', 'offset'].includes(k)) return true;
      const eq = /^eq\.(.*)$/.exec(String(v));
      return eq ? String(r[k] ?? '') === eq[1] : true;
    }));
  };
  return { select, insert: async () => { throw new Error('no writes expected'); }, update: async () => { throw new Error('no writes expected'); } };
}

/** Fake token manager: per merchant + connector, answers a valid bundle, or throws the configured error code. */
function fakeTokens(map) {
  const calls = [];
  return {
    calls,
    async getValidCredential({ merchantId, connectorId, provider }) {
      calls.push({ merchantId, connectorId, provider });
      const entry = map[connectorId];
      if (!entry) throw Object.assign(new Error('no credential'), { code: 'CREDENTIAL_NOT_FOUND' });
      if (entry.error) throw Object.assign(new Error(entry.error), { code: entry.error });
      return { tokens: { access_token: secret(entry.token), scopes: entry.scopes ?? [...SHOPIFY_READ_SCOPES] } };
    },
  };
}

test('two merchants: each resolves ONLY its own shop and token', async () => {
  const rows = [oauthRow('c-a', M1, SHOP1, GID1), oauthRow('c-b', M2, SHOP2, GID2)];
  const tokens = fakeTokens({ 'c-a': { token: TOKEN1 }, 'c-b': { token: TOKEN2 } });
  const resolve = createShopifyCredentialResolver({ connectorRepository: createConnectorRepository({ supabase: fakeDb(rows) }), tokenManager: tokens });
  const a = await resolve(M1);
  const b = await resolve(M2);
  assert.equal(a.state, 'CONFIGURED');
  assert.equal(a.shopDomain, SHOP1);
  assert.equal(a.accessToken, TOKEN1);
  assert.equal(b.shopDomain, SHOP2);
  assert.equal(b.accessToken, TOKEN2);
  assert.deepEqual(tokens.calls.map((c) => c.merchantId), [M1, M2], 'each lookup asked for its own merchant only');
  assert.equal(tokens.calls.every((c) => c.connectorId === (c.merchantId === M1 ? 'c-a' : 'c-b')), true);
});

test('a merchant without its own OAuth connection is NOT_CONNECTED, even when another merchant has one', async () => {
  const rows = [oauthRow('c-a', M1, SHOP1, GID1)];
  const resolve = createShopifyCredentialResolver({ connectorRepository: createConnectorRepository({ supabase: fakeDb(rows) }), tokenManager: fakeTokens({}) });
  assert.deepEqual(await resolve(M2), { state: 'NOT_CONNECTED' });
});

test('the global SHOPIFY_* connector is not an OAuth connection', async () => {
  const rows = [globalRow('g-1', M1, GID1)];
  const resolve = createShopifyCredentialResolver({ connectorRepository: createConnectorRepository({ supabase: fakeDb(rows) }), tokenManager: fakeTokens({}) });
  assert.equal((await resolve(M1)).state, 'NOT_CONNECTED');
});

test('two OAuth connections for one merchant are refused, never picked silently', async () => {
  const rows = [oauthRow('c-1', M1, SHOP1, GID1), oauthRow('c-2', M1, 'other-shop.myshopify.com', GID2)];
  const tokens = fakeTokens({});
  const resolve = createShopifyCredentialResolver({ connectorRepository: createConnectorRepository({ supabase: fakeDb(rows) }), tokenManager: tokens });
  assert.equal((await resolve(M1)).state, 'AMBIGUOUS');
  assert.equal(tokens.calls.length, 0, 'no token is read when the choice is ambiguous');
});

test('a connection that is not CONFIGURED, or whose shop domain is not valid, is refused without reading a token', async () => {
  const tokens = fakeTokens({ 'c-x': { token: TOKEN1 }, 'c-y': { token: TOKEN1 } });
  const rows = [oauthRow('c-x', M1, SHOP1, GID1, { status: 'MISCONFIGURED' })];
  const resolve1 = createShopifyCredentialResolver({ connectorRepository: createConnectorRepository({ supabase: fakeDb(rows) }), tokenManager: tokens });
  assert.equal((await resolve1(M1)).state, 'NOT_CONFIGURED');
  const rows2 = [oauthRow('c-y', M1, 'evil.example.com', GID1)];
  const resolve2 = createShopifyCredentialResolver({ connectorRepository: createConnectorRepository({ supabase: fakeDb(rows2) }), tokenManager: tokens });
  assert.equal((await resolve2(M1)).state, 'MISCONFIGURED');
  assert.equal(tokens.calls.length, 0);
});

test('a token missing a read scope is refused (scopes are checked on the token, not on the request)', async () => {
  const rows = [oauthRow('c-a', M1, SHOP1, GID1)];
  const tokens = fakeTokens({ 'c-a': { token: TOKEN1, scopes: ['read_products'] } });
  const resolve = createShopifyCredentialResolver({ connectorRepository: createConnectorRepository({ supabase: fakeDb(rows) }), tokenManager: tokens });
  const r = await resolve(M1);
  assert.equal(r.state, 'MISSING_SCOPES');
  assert.equal(JSON.stringify(r).includes(TOKEN1), false);
});

test('a refused grant asks the merchant to connect again; any other failure is UNAVAILABLE', async () => {
  const rows = [oauthRow('c-a', M1, SHOP1, GID1)];
  const reauth = createShopifyCredentialResolver({ connectorRepository: createConnectorRepository({ supabase: fakeDb(rows) }), tokenManager: fakeTokens({ 'c-a': { error: 'REAUTH_REQUIRED' } }) });
  assert.equal((await reauth(M1)).state, 'REAUTH_REQUIRED');
  const down = createShopifyCredentialResolver({ connectorRepository: createConnectorRepository({ supabase: fakeDb(rows) }), tokenManager: fakeTokens({ 'c-a': { error: 'VAULT_UNAVAILABLE' } }) });
  assert.equal((await down(M1)).state, 'UNAVAILABLE');
});

test('sync preparation uses the merchant\'s own shop and token, not the global environment', async () => {
  const rows = [oauthRow('c-a', M1, SHOP1, GID1)];
  const seen = [];
  const createClient = (config) => {
    seen.push(config);
    return { graphql: async () => ({ shop: { id: GID1, name: 'A', myshopifyDomain: SHOP1 } }) };
  };
  const resolve = createShopifyCredentialResolver({ connectorRepository: createConnectorRepository({ supabase: fakeDb(rows) }), tokenManager: fakeTokens({ 'c-a': { token: TOKEN1 } }) });
  const prep = await prepareShopifySync({
    env: {}, supabase: fakeDb(rows), tenant: { merchantId: M1 }, createClient, shopifyCredentialsFor: resolve,
  });
  assert.equal(prep.state, 'CONFIGURED');
  assert.equal(seen[0].shopDomain, SHOP1);
  assert.equal(seen[0].accessToken, TOKEN1);
  assert.deepEqual(prep.grantedScopes.sort(), [...SHOPIFY_READ_SCOPES].sort());
  assert.equal(JSON.stringify({ state: prep.state, reason: prep.reason, grantedScopes: prep.grantedScopes }).includes(TOKEN1), false);
});

test('sync preparation refuses a shop that is not the connection\'s shop (identity check)', async () => {
  const rows = [oauthRow('c-a', M1, SHOP1, GID1)];
  const createClient = () => ({ graphql: async () => ({ shop: { id: GID2, name: 'Other', myshopifyDomain: SHOP2 } }) });
  const resolve = createShopifyCredentialResolver({ connectorRepository: createConnectorRepository({ supabase: fakeDb(rows) }), tokenManager: fakeTokens({ 'c-a': { token: TOKEN1 } }) });
  const prep = await prepareShopifySync({ env: {}, supabase: fakeDb(rows), tenant: { merchantId: M1 }, createClient, shopifyCredentialsFor: resolve });
  assert.equal(prep.state, 'MISCONFIGURED');
});

test('sync preparation without an OAuth connection and without the global setup is NOT_CONFIGURED (nothing written)', async () => {
  const prep = await prepareShopifySync({ env: {}, supabase: fakeDb([]), tenant: { merchantId: M2 }, createClient: () => { throw new Error('must not be called'); }, shopifyCredentialsFor: async () => ({ state: 'NOT_CONNECTED' }) });
  assert.equal(prep.state, 'NOT_CONFIGURED');
  assert.equal(prep.reason, 'NO_SHOPIFY_CREDENTIALS');
});

test('repeated sync preparations for the same merchant resolve the same identity and write nothing', async () => {
  const rows = [oauthRow('c-a', M1, SHOP1, GID1)];
  const writes = [];
  const db = { ...fakeDb(rows), insert: async (...a) => { writes.push(a); return []; }, update: async (...a) => { writes.push(a); return []; } };
  const createClient = () => ({ graphql: async () => ({ shop: { id: GID1, name: 'A', myshopifyDomain: SHOP1 } }) });
  const resolve = createShopifyCredentialResolver({ connectorRepository: createConnectorRepository({ supabase: db }), tokenManager: fakeTokens({ 'c-a': { token: TOKEN1 } }) });
  const first = await prepareShopifySync({ env: {}, supabase: db, tenant: { merchantId: M1 }, createClient, shopifyCredentialsFor: resolve });
  const second = await prepareShopifySync({ env: {}, supabase: db, tenant: { merchantId: M1 }, createClient, shopifyCredentialsFor: resolve });
  assert.equal(first.context.externalId, second.context.externalId);
  assert.equal(first.context.merchantId, M1);
  assert.equal(writes.length, 0, 'preparation never writes');
});
