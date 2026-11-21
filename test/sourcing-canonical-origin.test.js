// One canonical origin for the hosted Sourcing server (src/sourcing/server/canonical.js): an older address is only REDIRECTED,
// never added to the allowed hosts; no wildcard; the root of an old address goes to /sourcing. Synthetic names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { legacyHostsFrom, redirectTarget } from '../src/sourcing/server/canonical.js';
import { hostedConfig } from '../src/sourcing/server/hosted.js';

const CANON = 'https://staging.example.test';
const OLD = 'sourcing-staging.example.test';

test('legacy hosts: exact host names only; a wildcard, a port, a path or the canonical host itself is refused', () => {
  assert.deepEqual(legacyHostsFrom(` ${OLD} , Other.example.test `, 'staging.example.test'), [OLD, 'other.example.test']);
  assert.deepEqual(legacyHostsFrom(undefined, 'staging.example.test'), []);
  for (const bad of ['*.example.test', `${OLD}:8080`, `${OLD}/sourcing`, 'staging.example.test', 'localhost']) {
    assert.throws(() => legacyHostsFrom(bad, 'staging.example.test'), /SOURCING_LEGACY_HOSTS/, bad);
  }
});

test('an old address: GET / goes to /sourcing on the canonical origin; the path and query are kept', () => {
  const t = (host, method, url) => redirectTarget({ host, method, url, canonicalOrigin: CANON, legacyHosts: [OLD] });
  assert.equal(t(OLD, 'GET', '/'), `${CANON}/sourcing`);
  assert.equal(t(`${OLD}:443`, 'GET', '/'), `${CANON}/sourcing`, 'a port in the Host header is ignored');
  assert.equal(t(OLD, 'HEAD', '/'), `${CANON}/sourcing`);
  assert.equal(t(OLD, 'GET', '/procurement/?x=1'), `${CANON}/procurement/?x=1`);
  assert.equal(t(OLD, 'GET', '//evil.example.test/'), `${CANON}/sourcing`, 'a protocol-relative path never leaves the canonical origin');
});

test('not a redirect: the canonical host, an unknown host, or a change request on an old address (refused by the host list instead)', () => {
  const t = (host, method, url) => redirectTarget({ host, method, url, canonicalOrigin: CANON, legacyHosts: [OLD] });
  assert.equal(t('staging.example.test', 'GET', '/'), null);
  assert.equal(t('attacker.example.test', 'GET', '/'), null);
  assert.equal(t(OLD, 'POST', '/api/core/ask'), null);
  assert.equal(t(OLD, 'PUT', '/'), null);
});

test('hosted config: the allowed hosts are the canonical host only; the old address is not an allowed host', () => {
  const STAGING = 'aaaaaaaaaaaaaaaaaaaa';
  const jwt = (payload) => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'c2lnbmF0dXJlLW5vdC1jaGVja2Vk'].join('.');
  const env = {
    SOURCING_HOSTED: '1', NORDLA_MERCHANT_ID: '67646dbb-5e2e-4cd7-aad6-0ab289b068cb', SOURCING_PUBLIC_ORIGIN: 'https://staging.example.test', SOURCING_MERCHANT_ID: 'habb',
    SOURCING_LEGACY_HOSTS: OLD, NORDLA_SUPABASE_PROJECT_REF: STAGING,
    SUPABASE_URL: `https://${STAGING}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: jwt({ ref: STAGING, role: 'service_role' }), SUPABASE_ANON_KEY: jwt({ ref: STAGING, role: 'anon' }),
    NORDLA_IDENTITY_RATE_LIMIT_KEY: randomBytes(32).toString('hex'), NORDLA_CSRF_KEY: randomBytes(32).toString('hex'),
    RAILWAY_ENVIRONMENT_ID: 'env-test', RAILWAY_SERVICE_ID: 'svc-test',
  };
  const cfg = hostedConfig(env);
  assert.deepEqual(cfg.allowedHosts, ['staging.example.test']);
  assert.deepEqual(cfg.legacyHosts, [OLD]);
  assert.equal(cfg.origin, CANON);
});
