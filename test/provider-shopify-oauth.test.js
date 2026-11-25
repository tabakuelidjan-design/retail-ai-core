// Shopify per-merchant OAuth adapter: shop validation, callback HMAC, authorization URL, token exchange, target identity.
// No network: the injected http function is a fake. Tokens in these tests are obvious fixtures, never real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  createShopifyOAuth, normalizeShopDomain, shopifyCallbackHmac, verifyShopifyCallback, SHOPIFY_READ_SCOPES,
} from '../src/provider-connections/providers/shopify-oauth.js';

const SECRET = 'test-app-secret-not-real';
const APP = { clientId: 'test-client-id', clientSecret: SECRET, redirectUri: 'https://staging.example.test/api/connections/shopify/callback' };
const FIXTURE_TOKEN = 'shpat_fixture_token_0000000000';

/** A fake provider HTTP: records requests, answers from `respond(request)`. */
function fakeHttp(respond) {
  const calls = [];
  const http = async (request) => { calls.push(request); return respond(request); };
  return { http, calls };
}

const signed = (query) => ({ ...query, hmac: createHmac('sha256', SECRET).update(
  Object.keys(query).sort().map((k) => `${k}=${String(query[k]).replace(/%/g, '%25').replace(/&/g, '%26')}`).join('&'),
).digest('hex') });

test('shop domain: only *.myshopify.com is accepted, normalized to lower case', () => {
  assert.equal(normalizeShopDomain('Nordla.myshopify.com'), 'nordla.myshopify.com');
  assert.equal(normalizeShopDomain('  https://nordla.myshopify.com/ '), 'nordla.myshopify.com');
  for (const bad of ['habb.be', 'nordla.myshopify.com.evil.test', 'evil.test/nordla.myshopify.com', 'my shop.myshopify.com', '', null, 42, '.myshopify.com']) {
    assert.equal(normalizeShopDomain(bad), null, `refused: ${String(bad)}`);
  }
});

test('callback HMAC: a signed query verifies, any change or a missing hmac is refused', () => {
  const query = signed({ code: 'abc123', shop: 'nordla.myshopify.com', state: 'st8', timestamp: '1700000000', host: 'aG9zdA' });
  assert.equal(verifyShopifyCallback(query, SECRET), true);
  assert.equal(verifyShopifyCallback({ ...query, shop: 'other.myshopify.com' }, SECRET), false, 'tampered shop');
  assert.equal(verifyShopifyCallback({ ...query, code: 'zzz' }, SECRET), false, 'tampered code');
  assert.equal(verifyShopifyCallback(query, 'another-secret'), false, 'wrong app secret');
  const { hmac, ...noHmac } = query;
  assert.equal(verifyShopifyCallback(noHmac, SECRET), false, 'missing hmac');
  assert.equal(verifyShopifyCallback({ ...query, hmac: 'not-hex' }, SECRET), false, 'malformed hmac');
});

test('callback HMAC: hmac and signature keys are excluded from the signed message', () => {
  const base = { code: 'c', shop: 'nordla.myshopify.com', state: 's' };
  assert.equal(shopifyCallbackHmac({ ...base, hmac: 'x', signature: 'y' }, SECRET), shopifyCallbackHmac(base, SECRET));
});

test('authorization request targets the merchant shop with read-only scopes and the state', () => {
  const adapter = createShopifyOAuth({ http: async () => ({ status: 200, body: {} }) });
  const url = new URL(adapter.buildAuthorizationRequest({ appConfig: APP, state: 'state-123', shop: 'Nordla.myshopify.com' }));
  assert.equal(url.origin, 'https://nordla.myshopify.com');
  assert.equal(url.pathname, '/admin/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), APP.clientId);
  assert.equal(url.searchParams.get('scope'), SHOPIFY_READ_SCOPES.join(','));
  assert.equal(url.searchParams.get('redirect_uri'), APP.redirectUri);
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.equal(url.searchParams.has('grant_options[]'), false, 'offline token (default), no online grant');
  assert.throws(() => adapter.buildAuthorizationRequest({ appConfig: APP, state: 's', shop: 'evil.test' }), /APP_MISCONFIGURED|SHOP_DOMAIN/);
});

test('read-only scopes exclude customer and write scopes', () => {
  for (const s of SHOPIFY_READ_SCOPES) assert.match(s, /^read_/);
  assert.equal(SHOPIFY_READ_SCOPES.includes('read_customers'), false);
  assert.equal(SHOPIFY_READ_SCOPES.includes('read_all_orders'), false);
});

test('code exchange posts to the consenting shop and returns a non-refreshable bundle', async () => {
  const { http, calls } = fakeHttp(() => ({ status: 200, body: { access_token: FIXTURE_TOKEN, scope: 'read_orders,read_products,read_inventory,read_locations' } }));
  const adapter = createShopifyOAuth({ http, now: () => 1_700_000_000_000 });
  const bundle = await adapter.exchangeCode({ appConfig: APP, code: 'code-1', shop: 'nordla.myshopify.com' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://nordla.myshopify.com/admin/oauth/access_token');
  assert.deepEqual(calls[0].json, { client_id: APP.clientId, client_secret: SECRET, code: 'code-1' });
  assert.deepEqual([...bundle.scopes].sort(), [...SHOPIFY_READ_SCOPES].sort());
  assert.equal(adapter.descriptor.offline_token, true);
  assert.equal(adapter.descriptor.revocable_remotely, false);
});

test('code exchange refused by Shopify is a normalized, safe failure (no body echoed)', async () => {
  const adapter = createShopifyOAuth({ http: async () => ({ status: 401, body: { error: 'invalid_request', error_description: 'secret detail' } }) });
  await assert.rejects(adapter.exchangeCode({ appConfig: APP, code: 'bad', shop: 'nordla.myshopify.com' }), (e) => {
    const n = adapter.normalizeOAuthError(e);
    assert.equal(n.code, 'CODE_EXCHANGE_FAILED');
    assert.equal(n.reauth, true);
    assert.equal(JSON.stringify(n).includes('secret detail'), false);
    return true;
  });
});

test('identity: the token resolves the shop; the candidate is eligible only for the requested shop and with every read scope', async () => {
  const shopBody = { data: { shop: { id: 'gid://shopify/Shop/1001', name: 'Nordla Test', myshopifyDomain: 'nordla.myshopify.com' } } };
  const { http, calls } = fakeHttp(() => ({ status: 200, body: shopBody }));
  const adapter = createShopifyOAuth({ http });
  const tokens = { access_token: FIXTURE_TOKEN, scopes: [...SHOPIFY_READ_SCOPES] };
  const [candidate] = await adapter.discoverTargets({ tokens, shop: 'nordla.myshopify.com' });
  assert.equal(calls[0].url, 'https://nordla.myshopify.com/admin/api/2024-10/graphql.json');
  assert.equal(calls[0].headers['X-Shopify-Access-Token'], FIXTURE_TOKEN);
  assert.equal(candidate.external_id, 'gid://shopify/Shop/1001');
  assert.equal(candidate.eligibility.eligible, true);
  assert.equal(candidate.safe_metadata.shop_domain, 'nordla.myshopify.com');
});

test('identity: a token for another shop, or missing a read scope, is not eligible', async () => {
  const other = createShopifyOAuth({ http: async () => ({ status: 200, body: { data: { shop: { id: 'gid://shopify/Shop/2', name: 'Other', myshopifyDomain: 'other.myshopify.com' } } } }) });
  const [a] = await other.discoverTargets({ tokens: { access_token: FIXTURE_TOKEN, scopes: [...SHOPIFY_READ_SCOPES] }, shop: 'nordla.myshopify.com' });
  assert.equal(a.eligibility.eligible, false);
  assert.ok(a.eligibility.reasons.includes('SHOP_MISMATCH'));

  const same = createShopifyOAuth({ http: async () => ({ status: 200, body: { data: { shop: { id: 'gid://shopify/Shop/1', name: 'N', myshopifyDomain: 'nordla.myshopify.com' } } } }) });
  const [b] = await same.discoverTargets({ tokens: { access_token: FIXTURE_TOKEN, scopes: ['read_products'] }, shop: 'nordla.myshopify.com' });
  assert.equal(b.eligibility.eligible, false);
  assert.ok(b.eligibility.reasons.includes('SCOPE_MISSING'));
});

test('verifyTarget refuses an external id that is not the shop behind the token', async () => {
  const adapter = createShopifyOAuth({ http: async () => ({ status: 200, body: { data: { shop: { id: 'gid://shopify/Shop/1', name: 'N', myshopifyDomain: 'nordla.myshopify.com' } } } }) });
  await assert.rejects(adapter.verifyTarget({ tokens: { access_token: FIXTURE_TOKEN, scopes: [...SHOPIFY_READ_SCOPES] }, shop: 'nordla.myshopify.com', externalId: 'gid://shopify/Shop/999' }));
});

test('refresh is not offered for offline tokens; revoke is local and says where to uninstall', async () => {
  const adapter = createShopifyOAuth({ http: async () => ({ status: 200, body: {} }) });
  await assert.rejects(adapter.refreshToken({ tokens: {} }), /NOT_REFRESHABLE|TOKEN_RESPONSE_INVALID/);
  assert.deepEqual(await adapter.revoke(), { remote: false, reason: 'UNINSTALL_IN_SHOPIFY_ADMIN' });
});
