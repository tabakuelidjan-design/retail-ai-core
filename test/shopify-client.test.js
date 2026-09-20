import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyClient } from '../src/shopify/client.js';

const FAKE_CONFIG = {
  shopDomain: 'fixture-test-shop.myshopify.com',
  clientId: 'fixture-client-id',
  clientSecret: 'fixture-client-secret',
  apiVersion: '2024-10',
};

function fakeFetchFactory({ tokenExpiresIn = 3600 } = {}) {
  let tokenExchangeCalls = 0;
  let graphqlCalls = 0;

  const fetchImpl = async (url, options) => {
    if (url.endsWith('/admin/oauth/access_token')) {
      tokenExchangeCalls += 1;
      const body = options.body.toString();
      assert.match(body, /grant_type=client_credentials/);
      assert.match(body, /client_id=fixture-client-id/);
      assert.match(body, /client_secret=fixture-client-secret/);
      return {
        ok: true,
        json: async () => ({ access_token: `fake-token-${tokenExchangeCalls}`, expires_in: tokenExpiresIn }),
      };
    }
    if (url.includes('/admin/api/2024-10/graphql.json')) {
      graphqlCalls += 1;
      assert.equal(options.headers['X-Shopify-Access-Token'], `fake-token-${tokenExchangeCalls}`);
      return { ok: true, json: async () => ({ data: { shop: { id: 'gid://shopify/Shop/1' } } }) };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  return { fetchImpl, getCalls: () => ({ tokenExchangeCalls, graphqlCalls }) };
}

test('client credentials grant: token is requested via POST with grant_type=client_credentials', async () => {
  const { fetchImpl, getCalls } = fakeFetchFactory();
  const client = createShopifyClient(FAKE_CONFIG, { fetchImpl });

  await client.graphql('query { shop { id } }');

  assert.equal(getCalls().tokenExchangeCalls, 1);
  assert.equal(getCalls().graphqlCalls, 1);
});

test('client credentials grant: token is cached and reused across calls within its lifetime', async () => {
  const { fetchImpl, getCalls } = fakeFetchFactory({ tokenExpiresIn: 3600 });
  const client = createShopifyClient(FAKE_CONFIG, { fetchImpl });

  await client.graphql('query { shop { id } }');
  await client.graphql('query { shop { id } }');
  await client.graphql('query { shop { id } }');

  assert.equal(getCalls().tokenExchangeCalls, 1); // not re-fetched for every call
  assert.equal(getCalls().graphqlCalls, 3);
});

test('client credentials grant: an expired token is refreshed automatically', async () => {
  const { fetchImpl, getCalls } = fakeFetchFactory({ tokenExpiresIn: 0 }); // expires immediately
  const client = createShopifyClient(FAKE_CONFIG, { fetchImpl });

  await client.graphql('query { shop { id } }');
  await client.graphql('query { shop { id } }');

  assert.equal(getCalls().tokenExchangeCalls, 2); // refreshed before the second call
});

test('token exchange failure surfaces a clear error without leaking the client secret', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'invalid_client' });
  const client = createShopifyClient(FAKE_CONFIG, { fetchImpl });

  await assert.rejects(() => client.graphql('query { shop { id } }'), (err) => {
    assert.match(err.message, /Shopify token exchange HTTP 401/);
    assert.doesNotMatch(err.message, /fixture-client-secret/);
    return true;
  });
});
