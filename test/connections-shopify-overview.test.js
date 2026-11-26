// Connections overview for Shopify: a merchant's OAuth connection is shown with its real state (and can be reconnected); the global,
// historical row only when the merchant has no OAuth connection. Synthetic data; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/connections/registry.js';
import { createConnectionsService } from '../src/connections/service.js';
import { makeRuntime, makeBundle, M1, M2, ENV } from './provider-fixtures.js';
import { SHOPIFY_READ_SCOPES } from '../src/provider-connections/providers/shopify-oauth.js';

const SHOP = 'nordla.myshopify.com';
const GID = 'gid://shopify/Shop/900001';
const ENV_SHOPIFY = { ...ENV, NORDLA_SHOPIFY_APP_CLIENT_ID: 'nordla-app-client-synthetic', NORDLA_SHOPIFY_APP_CLIENT_SECRET: 'synthetic-app-secret', NORDLA_SHOPIFY_REDIRECT_URI: 'https://staging.example.test/api/connections/shopify/callback' };

function serviceFor(ctx) {
  return createConnectionsService({
    registry: createRegistry({}), center: ctx.rt.connectionCenter, connectorRepository: ctx.rt.connectorRepository,
    appConfigPresent: ctx.rt.appConfigPresent, appEnvNames: {}, redirectUriOf: () => null, merchantLabel: async () => 'Synthetic', environmentLabel: 'Staging',
    shopifySync: async () => null, bankCatalog: [], bankProvider: null,
  });
}
const shopifyOf = (ov) => ov.categories.flatMap((c) => c.providers).find((p) => p.id === 'shopify');

test('a merchant\'s own Shopify connection is listed with its state, not the global row', async () => {
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: [] });
  await ctx.rt.connectorRepository.link({ merchantId: M1, kind: 'shopify', externalId: GID, status: 'CONFIGURED', config: { provisioned_via: 'oauth', shop_domain: SHOP, granted_scopes: ['read_orders'] } });
  await ctx.rt.connectorRepository.link({ merchantId: M1, kind: 'shopify', externalId: 'gid://shopify/Shop/STAGING-1', status: 'CONFIGURED', config: {} });
  const ov = await serviceFor(ctx).overview({ tenant: { merchantId: M1, source: 'session' }, role: 'OWNER' });
  const p = shopifyOf(ov);
  assert.equal(p.connections.length, 1, 'only the OAuth connection; the global row is hidden when one exists');
  assert.equal(p.connections[0].accountId, GID);
  assert.ok(p.connections[0].stateLabel, 'the connection has a real state label');
  assert.equal(p.setup.canConnect, true, 'an owner can connect a shop');
});

test('a merchant with no OAuth connection shows no Shopify connection to another merchant (isolation)', async () => {
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: [] });
  await ctx.rt.connectorRepository.link({ merchantId: M2, kind: 'shopify', externalId: GID, status: 'CONFIGURED', config: { provisioned_via: 'oauth', shop_domain: SHOP } });
  const ov = await serviceFor(ctx).overview({ tenant: { merchantId: M1, source: 'session' }, role: 'OWNER' });
  assert.equal(shopifyOf(ov).connections.length, 0, 'M2\'s shop is never shown to M1');
});

test('a viewer sees the connection but cannot connect or reconnect', async () => {
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: [] });
  await ctx.rt.connectorRepository.link({ merchantId: M1, kind: 'shopify', externalId: GID, status: 'CONFIGURED', config: { provisioned_via: 'oauth', shop_domain: SHOP } });
  const ov = await serviceFor(ctx).overview({ tenant: { merchantId: M1, source: 'session' }, role: 'VIEWER' });
  const p = shopifyOf(ov);
  assert.equal(p.setup.canConnect, false);
  assert.equal(p.connections.length, 1);
  assert.equal(p.connections[0].actions.includes('reconnect'), false, 'a viewer is never offered a reconnect');
});

test('an error state (misconfigured shop) is shown as an error, and the owner is offered a reconnect', async () => {
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: [] });
  const { connector } = await ctx.rt.connectorRepository.link({ merchantId: M1, kind: 'shopify', externalId: GID, status: 'MISCONFIGURED', config: { provisioned_via: 'oauth', shop_domain: SHOP } });
  // a stored credential is what makes the connection exist (without one it reads "not connected")
  await ctx.credentialStore.storeMerchantCredential({ merchantId: M1, connectorId: connector.id, provider: 'shopify', tokens: makeBundle({ scopes: [...SHOPIFY_READ_SCOPES] }) });
  const ov = await serviceFor(ctx).overview({ tenant: { merchantId: M1, source: 'session' }, role: 'OWNER' });
  const c = shopifyOf(ov).connections[0];
  assert.equal(c.state, 'MISCONFIGURED');
  assert.ok(c.actions.includes('reconnect'), `owner actions: ${JSON.stringify(c.actions)}`);
});
