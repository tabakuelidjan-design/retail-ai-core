// Finance SSO key: its own variable (FINANCE_SSO_KEY), canonical base64url of 32 random bytes, never the dashboard token, no fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { issueTicket, createTicketVerifier, SSO_AUDIENCE } from '../src/finance/sso-ticket.js';
import { createAccessChecker } from '../src/identity/sso-contract.js';
import { financeSsoKeyOf, financeSsoOptions, FINANCE_SSO_KEY_VARIABLE } from '../src/finance/sso-config.js';
import { K_FINANCE, K_ANALYTICS } from './fixtures/sso-test-keys.js';

const M = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb';
const U = '5c2f4d6e-ea34-452d-8107-0197a3eb54da';
const DASHBOARD_TOKEN = 'dashboard-login-token-0123456789-abcdef-not-a-key';
const P = { userId: U, role: 'OWNER', module: 'finance' };

function activeDb() {
  return { rpc: async () => ({ required: false, privileged: true, compliant: false }), select: async (table, q) => {
    const id = (v) => String(v).replace(/^eq\./, '');
    if (table === 'merchant_members') return [{ merchant_id: M, user_id: U, role: 'OWNER', status: 'ACTIVE', removed_at: null }].filter((r) => r.user_id === id(q.user_id) && r.merchant_id === id(q.merchant_id));
    return [{ merchant_id: M, module_code: 'finance', status: 'ACTIVE' }].filter((r) => r.module_code === id(q.module_code) && r.merchant_id === id(q.merchant_id));
  } };
}
const verifierWith = (secret) => createTicketVerifier({ secret, merchantId: M, audience: SSO_AUDIENCE, module: 'finance', requirePerson: true, checkAccess: createAccessChecker({ supabase: activeDb(), merchantId: M }) });

test('the key is its own variable: FINANCE_SSO_KEY, not the dashboard token', () => {
  assert.equal(FINANCE_SSO_KEY_VARIABLE, 'FINANCE_SSO_KEY');
  assert.deepEqual(financeSsoKeyOf({ FINANCE_SSO_KEY: K_FINANCE }, DASHBOARD_TOKEN), { key: K_FINANCE, error: null });
});

test('absent key: SSO off, with the named reason SSO_KEY_MISSING; the dashboard token alone never turns it on', () => {
  assert.deepEqual(financeSsoKeyOf({}, DASHBOARD_TOKEN), { key: null, error: 'FINANCE_SSO_KEY: SSO_KEY_MISSING' });
  assert.equal(financeSsoOptions({ hosted: true, enabled: true, env: { FINANCE_DASHBOARD_TOKEN: DASHBOARD_TOKEN }, dashboardToken: DASHBOARD_TOKEN, supabase: activeDb(), merchantId: M }), null);
});

test('too short: a 24-character key (the former rule) and a 31-byte key are refused as SSO_KEY_TOO_SHORT', () => {
  assert.equal(financeSsoKeyOf({ FINANCE_SSO_KEY: 'a'.repeat(24) }, DASHBOARD_TOKEN).error, 'FINANCE_SSO_KEY: SSO_KEY_TOO_SHORT');
  const thirtyOneBytes = Buffer.alloc(31, 7).toString('base64url'); // 42 characters
  assert.equal(financeSsoKeyOf({ FINANCE_SSO_KEY: thirtyOneBytes }, DASHBOARD_TOKEN).error, 'FINANCE_SSO_KEY: SSO_KEY_TOO_SHORT');
});

test('bad encoding: padding, standard base64 characters, whitespace and wrong length are refused as SSO_KEY_BAD_ENCODING', () => {
  const bad = [
    `${K_FINANCE}=`,                 // padding
    `${K_FINANCE}\n`,                // trailing newline
    ` ${K_FINANCE}`,                 // leading space
    K_FINANCE.replace(/_/g, '+').replace(/-/g, '/'), // standard base64 alphabet (only if present; otherwise same value)
    `${K_FINANCE}AA`,                // too long
    'not base64url!!',               // invalid characters
  ].filter((v) => v !== K_FINANCE);
  for (const v of bad) assert.equal(financeSsoKeyOf({ FINANCE_SSO_KEY: v }, DASHBOARD_TOKEN).error, 'FINANCE_SSO_KEY: SSO_KEY_BAD_ENCODING', JSON.stringify(v.length));
});

test('the minimal valid key: 32 random bytes, 43 characters, canonical, accepted', () => {
  const minimal = Buffer.alloc(32, 0xab).toString('base64url');
  assert.equal(minimal.length, 43);
  assert.equal(financeSsoKeyOf({ FINANCE_SSO_KEY: minimal }, DASHBOARD_TOKEN).key, minimal);
});

test('reuse is refused: the dashboard token used as the SSO key turns SSO off (no fallback to the token)', () => {
  const tokenAsKey = K_FINANCE; // a valid key, deliberately also used as the dashboard token
  assert.equal(financeSsoKeyOf({ FINANCE_SSO_KEY: tokenAsKey }, tokenAsKey).error, 'FINANCE_SSO_KEY: DASHBOARD_TOKEN_REUSED');
  assert.equal(financeSsoOptions({ hosted: true, enabled: true, env: { FINANCE_SSO_KEY: tokenAsKey }, dashboardToken: tokenAsKey, supabase: activeDb(), merchantId: M }), null);
});

test('SSO options exist only when hosted, enabled and the dedicated key is valid; they require a person', () => {
  const env = { FINANCE_SSO_KEY: K_FINANCE };
  assert.equal(financeSsoOptions({ hosted: false, enabled: true, env, dashboardToken: DASHBOARD_TOKEN, supabase: activeDb(), merchantId: M }), null, 'not hosted');
  assert.equal(financeSsoOptions({ hosted: true, enabled: false, env, dashboardToken: DASHBOARD_TOKEN, supabase: activeDb(), merchantId: M }), null, 'not enabled');
  const o = financeSsoOptions({ hosted: true, enabled: true, env, dashboardToken: DASHBOARD_TOKEN, supabase: activeDb(), merchantId: M });
  assert.equal(o.secret, K_FINANCE); assert.equal(o.requirePerson, true); assert.equal(typeof o.checkAccess, 'function');
});

test('a valid Core ticket (signed with the dedicated key, for a person with access) is accepted', async () => {
  const t = issueTicket({ secret: K_FINANCE, merchantId: M, person: P });
  const r = await verifierWith(K_FINANCE).verifyAsync(t);
  assert.equal(r.ok, true); assert.equal(r.claims.userId, U);
});

test('the dashboard token alone is refused on the SSO path: it cannot sign a ticket Finance accepts', async () => {
  // a ticket signed with the dashboard token: refused by a verifier that holds the dedicated key
  assert.throws(() => issueTicket({ secret: DASHBOARD_TOKEN, merchantId: M, person: P }), { code: 'SSO_NOT_CONFIGURED' }, 'the token is not even a valid signing key');
  const withAnotherKey = issueTicket({ secret: K_ANALYTICS, merchantId: M, person: P });
  assert.equal((await verifierWith(K_FINANCE).verifyAsync(withAnotherKey)).code, 'SSO_BAD_SIGNATURE', 'another module key is refused');
  assert.equal((await verifierWith(K_FINANCE).verifyAsync(DASHBOARD_TOKEN)).code, 'SSO_MALFORMED', 'the raw token as a ticket is refused');
});

test('without the dedicated key, no verifier can accept a Core ticket, and the reason is named', async () => {
  const t = issueTicket({ secret: K_FINANCE, merchantId: M, person: P });
  assert.equal(financeSsoOptions({ hosted: true, enabled: true, env: {}, dashboardToken: DASHBOARD_TOKEN, supabase: activeDb(), merchantId: M }), null);
  assert.throws(() => verifierWith(DASHBOARD_TOKEN), { code: 'SSO_NOT_CONFIGURED' }, 'a verifier cannot be built from the dashboard token');
});
