// Shopify per-merchant OAuth, end to end through Provider Provisioning on fakes: start for a named shop, signed callback, target
// binding, verification, and isolation from the global SHOPIFY_* connector. Synthetic data only; no network, no real credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeRuntime, ENV, M1, M2, tenantOf, connectorRows, sessionRows } from './provider-fixtures.js';
import { isOauthConnector } from '../src/provider-connections/constants.js';

const APP_SECRET = 'SHOPIFY-APP-SECRET-SYNTHETIC-0001';
const TOKEN = 'shpat_synthetic_flow_token_0001';
const SHOP = 'nordla.myshopify.com';
const SHOP_GID = 'gid://shopify/Shop/900001';
const REDIRECT = 'https://staging.example.test/api/connections/shopify/callback';
const ENV_SHOPIFY = { ...ENV, NORDLA_SHOPIFY_APP_CLIENT_ID: 'nordla-app-client-synthetic', NORDLA_SHOPIFY_APP_CLIENT_SECRET: APP_SECRET, NORDLA_SHOPIFY_REDIRECT_URI: REDIRECT };

const sign = (query) => ({ ...query, hmac: createHmac('sha256', APP_SECRET).update(
  Object.keys(query).sort().map((k) => `${k}=${String(query[k]).replace(/%/g, '%25').replace(/&/g, '%26')}`).join('&'),
).digest('hex') });

const ok = (body) => ({ status: 200, body });
let exchanges = 0; // counts code exchanges sent to Shopify (reset per test)
const shopRoutes = (shopDomain = SHOP, id = SHOP_GID, scope = 'read_orders,read_products,read_inventory,read_locations') => [
  { method: 'POST', url: `${SHOP}/admin/oauth/access_token`, respond: () => { exchanges += 1; return ok({ access_token: TOKEN, scope }); } },
  { method: 'POST', url: `${SHOP}/admin/api/2024-10/graphql.json`, respond: ok({ data: { shop: { id, name: 'Nordla Test', myshopifyDomain: shopDomain } } }) },
];

function start(ctx, shop = SHOP) { // pass null explicitly to test 'no shop'
  return ctx.rt.connectionCenter.startConnect({ tenant: tenantOf(M1), provider: 'shopify', returnTo: '/connections', targetHint: shop });
}

test('starting needs a *.myshopify.com domain; anything else is refused before any session exists', async () => {
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: shopRoutes() });
  await assert.rejects(start(ctx, null), /TARGET_REQUIRED|shop domain/);
  await assert.rejects(start(ctx, 'evil.test'), /TARGET_REQUIRED|shop domain/);
  assert.equal(sessionRows(ctx).length, 0);
});

test('the authorization request names the merchant shop, carries the state, and the session keeps only the shop hint', async () => {
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: shopRoutes() });
  const started = await start(ctx);
  const url = new URL(started.authorization_url);
  assert.equal(url.origin, `https://${SHOP}`);
  assert.equal(url.pathname, '/admin/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'nordla-app-client-synthetic');
  assert.ok(url.searchParams.get('state'));
  const [row] = sessionRows(ctx);
  assert.equal(row.target_hint, SHOP);
  assert.equal(JSON.stringify(row).includes(TOKEN), false);
});

test('a callback with a valid signature exchanges the code at the consenting shop and asks for the target', async () => {
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: shopRoutes() });
  const started = await start(ctx);
  const state = new URL(started.authorization_url).searchParams.get('state');
  const cb = await ctx.rt.provisioning.handleCallback({ tenant: tenantOf(M1), provider: 'shopify', query: sign({ code: 'c-1', shop: SHOP, state, timestamp: '1700000000', host: 'aG9zdA' }) });
  assert.equal(cb.status, 'AUTHORIZED');
  assert.equal(cb.next, 'SELECT_TARGET');
  assert.equal(JSON.stringify(cb).includes(TOKEN), false, 'the token never leaves the server');
});

test('a callback whose shop or signature does not match is refused, the session is failed and nothing is exchanged', async () => {
  exchanges = 0;
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: shopRoutes() });
  const started = await start(ctx);
  const state = new URL(started.authorization_url).searchParams.get('state');
  const forged = sign({ code: 'c-2', shop: 'other.myshopify.com', state, timestamp: '1700000000' });
  await assert.rejects(ctx.rt.provisioning.handleCallback({ tenant: tenantOf(M1), provider: 'shopify', query: forged }), /INVALID_STATE|does not match/);
  assert.equal(exchanges, 0, 'no exchange request was sent');
  assert.equal(sessionRows(ctx)[0].status, 'FAILED');
});

test('a callback without a valid signature is refused and nothing is exchanged', async () => {
  exchanges = 0;
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: shopRoutes() });
  const started = await start(ctx);
  const state = new URL(started.authorization_url).searchParams.get('state');
  await assert.rejects(ctx.rt.provisioning.handleCallback({ tenant: tenantOf(M1), provider: 'shopify', query: { code: 'c-3', shop: SHOP, state, hmac: 'a'.repeat(64) } }), /INVALID_STATE|does not match/);
  assert.equal(sessionRows(ctx)[0].status, 'FAILED');
});

test('full consent: the connector is bound to the consenting shop, per merchant, and verifies as CONFIGURED', async () => {
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: shopRoutes() });
  const started = await start(ctx);
  const state = new URL(started.authorization_url).searchParams.get('state');
  await ctx.rt.provisioning.handleCallback({ tenant: tenantOf(M1), provider: 'shopify', query: sign({ code: 'c-4', shop: SHOP, state, timestamp: '1700000000' }) });
  const targets = await ctx.rt.connectionCenter.listTargets({ tenant: tenantOf(M1), sessionRef: started.session_ref });
  assert.equal(targets.targets[0].external_id, SHOP_GID);
  assert.equal(targets.targets[0].eligibility.eligible, true);
  const bound = await ctx.rt.connectionCenter.selectTarget({ tenant: tenantOf(M1), sessionRef: started.session_ref, externalId: SHOP_GID });
  const [connector] = connectorRows(ctx);
  assert.equal(connector.merchant_id, M1);
  assert.equal(connector.kind, 'shopify');
  assert.equal(connector.external_id, SHOP_GID);
  assert.equal(connector.config.shop_domain, SHOP, 'the shop is stored on the connector, not in the environment');
  assert.equal(connector.config.provisioned_via, 'oauth');
  assert.equal(isOauthConnector(connector), true);
  const verified = await ctx.rt.connectionCenter.verify({ tenant: tenantOf(M1), connectorId: connector.id });
  assert.equal(verified.state, 'CONFIGURED');
  assert.equal(JSON.stringify(bound).includes(TOKEN), false, 'no token in any response');
});

test('the global SHOPIFY_* connector (no provisioned_via) is not treated as a per-merchant OAuth connector', () => {
  assert.equal(isOauthConnector({ kind: 'shopify', config: {} }), false);
  assert.equal(isOauthConnector({ kind: 'shopify', config: null }), false);
  assert.equal(isOauthConnector({ kind: 'shopify', config: { provisioned_via: 'oauth' } }), true);
  assert.equal(isOauthConnector({ kind: 'instagram', config: {} }), true);
  assert.equal(isOauthConnector({ kind: 'bank', config: {} }), false);
});

test('merchant isolation: a second merchant starting its own Shopify flow gets its own session, never the first merchant’s', async () => {
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: shopRoutes('other.myshopify.com', 'gid://shopify/Shop/900002') });
  const a = await ctx.rt.connectionCenter.startConnect({ tenant: tenantOf(M1), provider: 'shopify', returnTo: '/connections', targetHint: SHOP });
  const b = await ctx.rt.connectionCenter.startConnect({ tenant: tenantOf(M2), provider: 'shopify', returnTo: '/connections', targetHint: 'other.myshopify.com' });
  const rows = sessionRows(ctx);
  assert.equal(rows.find((r) => r.id === a.session_ref).merchant_id, M1);
  assert.equal(rows.find((r) => r.id === b.session_ref).merchant_id, M2);
  assert.notEqual(a.session_ref, b.session_ref);
});
