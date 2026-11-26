// Silent renewal of a merchant's Shopify access token (synthetic data, no network):
//  - a refused token is renewed ONCE (single-flight across concurrent requests), then the request is retried once;
//  - a refused refresh grant is REAUTH_REQUIRED (the merchant must reconnect); a transient failure is an outage;
//  - a rejected Nordla app secret is MISCONFIGURED (configuration), never a merchant reconnection;
//  - loadDataset of one merchant never reads another merchant's rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyConnector } from '../src/connectors/shopify.js';
import { createShopifyCredentialResolver } from '../src/provider-connections/shopify-credentials.js';
import { createConnectorRepository } from '../src/tenant/connectors.js';
import { PC_ERROR, ProvisioningError } from '../src/provider-connections/constants.js';
import { SHOPIFY_READ_SCOPES } from '../src/provider-connections/providers/shopify-oauth.js';
import { loadDataset } from '../src/metrics/load.js';

const M = '11111111-1111-4111-8111-111111111111';
const SHOP = 'merchant-a.myshopify.com';
const secret = (v) => ({ reveal: () => v, toJSON: () => '[REDACTED]' });
const row = (merchant) => ({
  id: 'c-1', merchant_id: merchant, kind: 'shopify', external_id: 'gid://shopify/Shop/101', external_domain: null, status: 'CONFIGURED',
  config: { provisioned_via: 'oauth', shop_domain: SHOP, granted_scopes: [...SHOPIFY_READ_SCOPES] }, created_at: '2026-11-25T00:00:00Z', updated_at: '2026-11-25T00:00:00Z',
});
function fakeDb(rows) {
  return {
    select: async (table, p = {}) => (table !== 'merchant_connectors' ? [] : rows.filter((r) => Object.entries(p).every(([k, v]) => {
      if (['select', 'order', 'limit', 'offset'].includes(k)) return true;
      const eq = /^eq\.(.*)$/.exec(String(v)); return eq ? String(r[k] ?? '') === eq[1] : true;
    }))),
    insert: async () => { throw new Error('no writes expected'); }, update: async () => { throw new Error('no writes expected'); },
  };
}

// A synthetic provider. `accepted` = the access tokens Shopify accepts; `refresh(n)` = what the n-th forceRefresh does
// (returns the new token, or throws the error the token manager would raise).
function world({ accepted = new Set(['tok-2']), refresh = () => 'tok-2' } = {}) {
  const stats = { refreshes: 0, graphql: 0, tokensUsed: [] };
  let current = 'tok-1';
  const tokenManager = {
    async getValidCredential() { return { tokens: { access_token: secret(current), scopes: [...SHOPIFY_READ_SCOPES] } }; },
    async forceRefresh() {
      stats.refreshes += 1;
      await new Promise((r) => setTimeout(r, 5)); // a real refresh takes time: concurrent refusals arrive meanwhile
      const outcome = refresh(stats.refreshes);
      if (outcome instanceof Error) throw outcome;
      current = outcome;
      return { refreshed: true };
    },
  };
  const fetchImpl = async (url, opts) => {
    if (!String(url).endsWith('/graphql.json')) throw new Error(`unexpected url ${url}`);
    stats.graphql += 1;
    const used = opts.headers['X-Shopify-Access-Token'];
    stats.tokensUsed.push(used);
    if (!accepted.has(used)) return { ok: false, status: 401, text: async () => '{"errors":"[API] Invalid API key or access token"}', json: async () => ({}) };
    return { ok: true, status: 200, text: async () => '', json: async () => ({ data: { shop: { id: 'gid://shopify/Shop/101' } } }) };
  };
  const resolver = createShopifyCredentialResolver({ connectorRepository: createConnectorRepository({ supabase: fakeDb([row(M)]) }), tokenManager, apiVersion: '2026-01' });
  const connector = createShopifyConnector({ env: {}, merchantId: M, connectors: createConnectorRepository({ supabase: fakeDb([row(M)]) }), credentialsFor: resolver, fetchImpl });
  return { connector, stats };
}
const Q = 'query { shop { id } }';

test('successful refresh: the refused token is renewed once and the request succeeds with the new token', async () => {
  const w = world({ accepted: new Set(['tok-2']), refresh: () => 'tok-2' });
  const data = await w.connector.graphql(Q);
  assert.equal(data.shop.id, 'gid://shopify/Shop/101');
  assert.equal(w.stats.refreshes, 1, 'exactly one refresh');
  // the connector verifies the store before a call, so the refusal may be seen by the verification request: the refused token is
  // used once, and every request after the renewal uses the renewed token
  assert.equal(w.stats.tokensUsed.filter((t) => t === 'tok-1').length, 1, 'the refused token is tried once');
  assert.equal(w.stats.tokensUsed.at(-1), 'tok-2', 'the last request uses the renewed token');
});

test('concurrent refusals share ONE refresh (single-flight), and every request still succeeds', async () => {
  const w = world({ accepted: new Set(['tok-2']), refresh: () => 'tok-2' });
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => w.connector.graphql(Q)));
  assert.equal(results.length, 5);
  assert.equal(w.stats.refreshes, 1, 'five refusals, one refresh');
});

test('rejected refresh grant (invalid_grant): REAUTH_REQUIRED, the merchant must reconnect', async () => {
  const w = world({ accepted: new Set(), refresh: () => new ProvisioningError(PC_ERROR.REAUTH_REQUIRED, 'grant refused', { provider: 'shopify' }) });
  await assert.rejects(w.connector.graphql(Q));
  assert.equal(await w.connector.state(), 'REAUTH_REQUIRED');
  assert.equal(w.connector.describe().reason, 'REAUTH_REQUIRED');
});

test('transient refresh failure: an outage (UNAVAILABLE), never a reconnection request', async () => {
  const w = world({ accepted: new Set(), refresh: () => new ProvisioningError(PC_ERROR.OAUTH, 'could not refresh right now', { oauth: 'PROVIDER_UNAVAILABLE' }) });
  await assert.rejects(w.connector.graphql(Q));
  assert.equal(await w.connector.state(), 'UNAVAILABLE');
});

test('rejected Nordla app secret: MISCONFIGURED (a configuration error), not a merchant reconnection', async () => {
  const w = world({ accepted: new Set(), refresh: () => new ProvisioningError(PC_ERROR.APP_MISCONFIGURED, 'app secret rejected', { provider: 'shopify' }) });
  await assert.rejects(w.connector.graphql(Q));
  assert.equal(await w.connector.state(), 'MISCONFIGURED');
  assert.equal(w.connector.describe().reason, 'APP_SECRET_REJECTED');
});

test('a renewed token that Shopify still refuses is not a loop: one renewal, then the outage state', async () => {
  const w = world({ accepted: new Set(), refresh: () => 'tok-still-bad' });
  await assert.rejects(w.connector.graphql(Q));
  assert.equal(w.stats.refreshes, 1);
});

test('data layer, two merchants: loading one merchant never reads the other merchant rows', async () => {
  const table = {
    orders: [
      { id: 'o-a', merchant_id: 'merchant-a', currency: 'EUR', created_at: '2026-11-20T10:00:00Z' },
      { id: 'o-b', merchant_id: 'merchant-b', currency: 'EUR', created_at: '2026-11-20T10:00:00Z' },
    ],
  };
  const supabase = {
    async selectAll(name, params = {}) {
      return (table[name] ?? []).filter((r) => Object.entries(params).every(([k, v]) => {
        if (['select', 'order', 'limit', 'offset'].includes(k)) return true;
        const eq = /^eq\.(.*)$/.exec(String(v));
        return eq ? String(r[k] ?? '') === eq[1] : true;
      }));
    },
    async select() { return []; },
    async rpc() { return null; },
  };
  const data = await loadDataset(supabase, 'merchant-a', { since: new Date('2026-11-01T00:00:00Z') });
  assert.ok(data.orders.length >= 1, 'merchant A orders are read');
  assert.ok(data.orders.every((o) => o.merchant_id === 'merchant-a'), 'no row of merchant B is read');
});
