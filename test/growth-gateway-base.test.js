import { test } from 'node:test';
import assert from 'node:assert/strict';
import { growthGatewayBase, growthSsoConfig } from '../src/core-pilot/http.js';

const SECRET = 'g'.repeat(40);
const M = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb';

test('Growth under the Core origin: only https://<nordla>/growth is a gateway base; other paths and hosts are refused', () => {
  assert.equal(growthGatewayBase({ GROWTH_PUBLIC_URL: 'https://staging.nordla.app/growth' }), 'https://staging.nordla.app/growth');
  assert.equal(growthGatewayBase({ GROWTH_PUBLIC_URL: 'https://staging.nordla.app/growth/' }), 'https://staging.nordla.app/growth');
  for (const bad of ['https://staging.nordla.app/other', 'http://staging.nordla.app/growth', 'https://u:p@staging.nordla.app/growth', 'https://staging.nordla.app/growth?x=1', 'not a url', undefined]) {
    assert.equal(growthGatewayBase({ GROWTH_PUBLIC_URL: bad }), null, String(bad));
  }
});

test('Growth single sign-on uses the gateway base when configured, and the plain origin otherwise', () => {
  const via = growthSsoConfig({ GROWTH_PUBLIC_URL: 'https://staging.nordla.app/growth', GROWTH_SSO_SECRET: SECRET }, M);
  assert.equal(via.origin, 'https://staging.nordla.app/growth');
  const direct = growthSsoConfig({ GROWTH_PUBLIC_URL: 'https://growth.example.app', GROWTH_SSO_SECRET: SECRET }, M);
  assert.equal(direct.origin, 'https://growth.example.app');
  assert.equal(growthSsoConfig({ GROWTH_PUBLIC_URL: 'https://staging.nordla.app/growth', GROWTH_SSO_SECRET: 'short' }, M), null, 'a short secret is refused');
});
