// Shopify reauthorization: an expiring offline token that can no longer be refreshed (the merchant must connect again). The connection is
// reported REAUTH_REQUIRED to every reader, and a new consent restores it with a rotated token, for the same merchant only.
// Synthetic data only; the fake Shopify answers the grants it is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeRuntime, tenantOf, M1, M2, START, connectorRows } from './provider-fixtures.js';
import { makeTokenBundle, PC_ERROR } from '../src/provider-connections/index.js';
import { createShopifyCredentialResolver } from '../src/provider-connections/shopify-credentials.js';
import { createShopifyConnector } from '../src/connectors/shopify.js';
import { SHOPIFY_READ_SCOPES } from '../src/provider-connections/providers/shopify-oauth.js';

const SHOP = 'nordla.myshopify.com';
const GID = 'gid://shopify/Shop/900001';
const APP_SECRET = 'SHOPIFY-APP-SECRET-SYNTHETIC-REAUTH';
const REDIRECT = 'https://staging.example.test/api/connections/shopify/callback';
const ENV_SHOPIFY = { NORDLA_SHOPIFY_APP_CLIENT_ID: 'nordla-app-client-synthetic', NORDLA_SHOPIFY_APP_CLIENT_SECRET: APP_SECRET, NORDLA_SHOPIFY_REDIRECT_URI: REDIRECT };
const OLD_TOKEN = 'shpat_old_expired_0001';
const OLD_REFRESH = 'shprt_old_refresh_0001';
const NEW_TOKEN = 'shpat_new_after_reconnect_0002';
const NEW_REFRESH = 'shprt_new_refresh_0002';
const ok = (body) => ({ status: 200, body });
const sign = (q) => ({ ...q, hmac: createHmac('sha256', APP_SECRET).update(Object.keys(q).sort().map((k) => `${k}=${String(q[k]).replace(/%/g, '%25').replace(/&/g, '%26')}`).join('&')).digest('hex') });

/** The fake Shopify: a refresh with the old refresh token is refused (invalid_grant); a consent exchange returns the new tokens. */
function shopifyRoutes({ refreshAccepted = false } = {}) {
  let consented = false;
  return [
    {
      method: 'POST', url: `${SHOP}/admin/oauth/access_token`,
      respond: (req) => {
        if (req.body?.grant_type === 'refresh_token') {
          if (!refreshAccepted || req.body.refresh_token !== OLD_REFRESH) return { status: 400, body: { error: 'invalid_grant' } };
          return ok({ access_token: NEW_TOKEN, refresh_token: NEW_REFRESH, expires_in: 3600, scope: SHOPIFY_READ_SCOPES.join(',') });
        }
        consented = true;
        return ok({ access_token: NEW_TOKEN, refresh_token: NEW_REFRESH, expires_in: 3600, scope: SHOPIFY_READ_SCOPES.join(',') });
      },
    },
    { method: 'POST', url: `${SHOP}/admin/api/2024-10/graphql.json`, respond: () => ok({ data: { shop: { id: GID, name: 'Nordla Test', myshopifyDomain: SHOP } } }) },
  ].map((r) => ({ ...r, consentedSeen: () => consented }));
}

/** A stored, EXPIRED offline credential for M1, with its shop and refresh token (Vault holds it; these are fixtures). */
async function storeExpired(ctx, { status = 'CONFIGURED' } = {}) {
  const { connector } = await ctx.rt.connectorRepository.link({ merchantId: M1, kind: 'shopify', externalId: GID, status, config: { provisioned_via: 'oauth', shop_domain: SHOP, granted_scopes: [...SHOPIFY_READ_SCOPES] } });
  const bundle = makeTokenBundle({ accessToken: OLD_TOKEN, refreshToken: OLD_REFRESH, expiresAt: new Date(START - 60_000).toISOString(), scopes: [...SHOPIFY_READ_SCOPES], refreshable: true, issuedAt: new Date(START - 7_200_000).toISOString() });
  await ctx.rt.credentialStore.storeMerchantCredential({ merchantId: M1, connectorId: connector.id, provider: 'shopify', tokens: { ...bundle, shop_domain: SHOP } });
  return connector;
}

test('an expired offline token whose refresh is refused: the credential is reported REAUTH_REQUIRED to every reader', async () => {
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: shopifyRoutes() });
  const connector = await storeExpired(ctx);
  await assert.rejects(ctx.rt.tokenManager.getValidCredential({ merchantId: M1, connectorId: connector.id, provider: 'shopify' }), (e) => e.code === PC_ERROR.REAUTH_REQUIRED);
  const resolver = createShopifyCredentialResolver({ connectorRepository: ctx.rt.connectorRepository, tokenManager: ctx.rt.tokenManager });
  const r = await resolver(M1);
  assert.equal(r.state, 'REAUTH_REQUIRED');
  assert.equal(JSON.stringify(r).includes(OLD_TOKEN), false, 'no token in the answer');
  // the Finance / report connector reports the same state and never calls Shopify with the dead token
  const conn = createShopifyConnector({ env: {}, merchantId: M1, connectors: ctx.rt.connectorRepository, credentialsFor: resolver, createClient: () => { throw new Error('must not be built with a dead token'); } });
  assert.equal(await conn.state({ verify: true }), 'REAUTH_REQUIRED');
  assert.equal(conn.describe().reason, 'REAUTH_REQUIRED');
});

test('the connection overview shows reconnection once a reader has found the grant dead (view state, no secret)', async () => {
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: shopifyRoutes() });
  const connector = await storeExpired(ctx);
  // a reader (sync, report, Finance) tries the token: the refresh is refused and the credential is marked expired
  await ctx.rt.tokenManager.getValidCredential({ merchantId: M1, connectorId: connector.id, provider: 'shopify' }).catch(() => null);
  const views = await ctx.rt.connectionCenter.listConnections({ tenant: tenantOf(M1) });
  const v = views.find((x) => x.provider === 'shopify');
  assert.ok(v, 'the Shopify connection is listed');
  assert.equal(v.connection_state, 'REAUTH_REQUIRED');
  assert.equal(JSON.stringify(views).includes(OLD_TOKEN), false);
  assert.equal(JSON.stringify(views).includes(OLD_REFRESH), false);
});

test('reconnecting after expiry restores the connection for the SAME merchant, with rotated tokens, and not for another merchant', async () => {
  const ctx = makeRuntime({ env: ENV_SHOPIFY, routes: shopifyRoutes() });
  const connector = await storeExpired(ctx);
  // the merchant consents again, for the shop it names
  const started = await ctx.rt.connectionCenter.startConnect({ tenant: tenantOf(M1), provider: 'shopify', targetHint: SHOP });
  const state = new URL(started.authorization_url).searchParams.get('state');
  await ctx.rt.provisioning.handleCallback({ tenant: tenantOf(M1), provider: 'shopify', query: sign({ code: 'c-reauth', shop: SHOP, state, timestamp: '1700000000' }) });
  const targets = await ctx.rt.connectionCenter.listTargets({ tenant: tenantOf(M1), sessionRef: started.session_ref });
  assert.equal(targets.targets[0].external_id, GID);
  await ctx.rt.connectionCenter.selectTarget({ tenant: tenantOf(M1), sessionRef: started.session_ref, externalId: GID });
  // the same connector was re-bound (no second connection for the merchant)
  assert.equal(connectorRows(ctx).filter((c) => c.merchant_id === M1 && c.kind === 'shopify').length, 1);
  const resolver = createShopifyCredentialResolver({ connectorRepository: ctx.rt.connectorRepository, tokenManager: ctx.rt.tokenManager });
  const r = await resolver(M1);
  assert.equal(r.state, 'CONFIGURED');
  assert.equal(r.accessToken, NEW_TOKEN, 'the rotated token is used');
  assert.equal(r.connectorId, connector.id);
  // another merchant is untouched by this reconnect
  assert.equal((await resolver(M2)).state, 'NOT_CONNECTED');
});
