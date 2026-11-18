// SSO key policy (identity/sso-keys.js) and its use by the Core builders (sourcing server) and the Analytics/Finance services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { parseSsoKey, ssoKeyReuseOf, ssoKeyFingerprint, SSO_KEY_BYTES, SSO_KEY_CHARS } from '../src/identity/sso-keys.js';
import { buildFinanceSso, buildAnalyticsSso } from '../src/sourcing/server/index.js';
import { K_FINANCE, K_ANALYTICS } from './fixtures/sso-test-keys.js';

const M = 'merchant-test-1';
const url = (u) => ({ FINANCE_PUBLIC_URL: u, ANALYTICS_PUBLIC_URL: u });

test('the policy: 32 bytes, 43 characters, canonical base64url', () => {
  assert.equal(SSO_KEY_BYTES, 32); assert.equal(SSO_KEY_CHARS, 43);
  assert.equal(Buffer.from(K_FINANCE, 'base64url').length, 32);
});

test('absent or empty key: SSO_KEY_MISSING', () => {
  for (const v of [undefined, null, '', 42]) assert.equal(parseSsoKey(v).code, 'SSO_KEY_MISSING', String(v));
});

test('too short: the former 24-character rule is not enough; 31 bytes is refused', () => {
  assert.equal(parseSsoKey('a'.repeat(24)).code, 'SSO_KEY_TOO_SHORT');
  assert.equal(parseSsoKey(randomBytes(31).toString('base64url')).code, 'SSO_KEY_TOO_SHORT');
  assert.equal(parseSsoKey('a'.repeat(42)).code, 'SSO_KEY_TOO_SHORT');
});

test('bad encoding: padding, whitespace, standard base64 characters, invalid characters, wrong length', () => {
  const std = randomBytes(32).toString('base64'); // may contain + and /
  const cases = [`${K_FINANCE}=`, `${K_FINANCE}\n`, ` ${K_FINANCE}`, `${K_FINANCE}AA`, 'ab cd!', 'x'.repeat(44) + '=', std.includes('+') || std.includes('/') ? std : 'a+/' + 'b'.repeat(40)];
  for (const v of cases) assert.equal(parseSsoKey(v).code, 'SSO_KEY_BAD_ENCODING', JSON.stringify(v));
});

test('the minimal valid key: 32 random bytes, accepted and decoded to 32 bytes', () => {
  for (let i = 0; i < 20; i++) {
    const v = randomBytes(32).toString('base64url');
    const r = parseSsoKey(v);
    assert.equal(r.ok, true, v); assert.equal(r.key.length, 32);
  }
});

test('error messages name the rule and never print the value', () => {
  const r = parseSsoKey('a'.repeat(24));
  assert.match(r.message, /32 octets/);
  assert.equal(r.message.includes('a'.repeat(24)), false);
});

test('reuse: the dashboard token and another module key are refused, compared on fingerprints', () => {
  assert.equal(ssoKeyReuseOf(K_FINANCE, { dashboardToken: K_FINANCE }), 'DASHBOARD_TOKEN');
  assert.equal(ssoKeyReuseOf(K_FINANCE, { otherKeys: [K_FINANCE] }), 'OTHER_MODULE_KEY');
  assert.equal(ssoKeyReuseOf(K_FINANCE, { dashboardToken: 'something-else-entirely', otherKeys: [K_ANALYTICS] }), null);
  assert.notEqual(ssoKeyFingerprint(K_FINANCE), K_FINANCE, 'the fingerprint is not the key');
});

test('Core builders: a Finance key that is not canonical 32 bytes gives no sign-in link', () => {
  const base = { ...url('https://finance.example.app/'), FINANCE_SSO_SECRET: 'a'.repeat(24) };
  assert.equal(buildFinanceSso(base, M), null, 'short key: no link');
  assert.equal(buildFinanceSso({ ...base, FINANCE_SSO_SECRET: K_FINANCE }, M)?.secret, K_FINANCE, 'canonical key: link');
});

test('Core builders: an Analytics key that is not canonical 32 bytes gives no sign-in link', () => {
  const base = { ...url('https://analytics.example.app/'), ANALYTICS_SSO_SECRET: 'b'.repeat(30) };
  assert.equal(buildAnalyticsSso(base, M), null);
  assert.equal(buildAnalyticsSso({ ...base, ANALYTICS_SSO_SECRET: K_ANALYTICS }, M)?.secret, K_ANALYTICS);
});
