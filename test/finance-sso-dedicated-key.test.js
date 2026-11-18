// Phase 2 correction - Finance SSO uses its own key (FINANCE_SSO_KEY), never the dashboard token. No fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { issueTicket, createTicketVerifier, SSO_AUDIENCE } from '../src/finance/sso-ticket.js';
import { createAccessChecker } from '../src/identity/sso-contract.js';
import { financeSsoKeyOf, financeSsoOptions, FINANCE_SSO_KEY_VARIABLE } from '../src/finance/sso-config.js';

const M = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb';
const U = '5c2f4d6e-ea34-452d-8107-0197a3eb54da';
const DASHBOARD_TOKEN = 'dashboard-login-token-0123456789-abcdef';
const SSO_KEY = 'dedicated-finance-sso-key-0123456789-zz';
const P = { userId: U, role: 'OWNER', module: 'finance' };

function activeDb() {
  return { select: async (table, q) => {
    const id = (v) => String(v).replace(/^eq\./, '');
    if (table === 'merchant_members') return [{ merchant_id: M, user_id: U, role: 'OWNER', status: 'ACTIVE', removed_at: null }].filter((r) => r.user_id === id(q.user_id) && r.merchant_id === id(q.merchant_id));
    return [{ merchant_id: M, module_code: 'finance', status: 'ACTIVE' }].filter((r) => r.module_code === id(q.module_code) && r.merchant_id === id(q.merchant_id));
  } };
}
const verifierWith = (secret) => createTicketVerifier({ secret, merchantId: M, audience: SSO_AUDIENCE, module: 'finance', requirePerson: true, checkAccess: createAccessChecker({ supabase: activeDb(), merchantId: M }) });

test('the key is its own variable: FINANCE_SSO_KEY, not the dashboard token', () => {
  assert.equal(FINANCE_SSO_KEY_VARIABLE, 'FINANCE_SSO_KEY');
  assert.equal(financeSsoKeyOf({ FINANCE_SSO_KEY: SSO_KEY }, DASHBOARD_TOKEN), SSO_KEY);
});

test('no fallback: a missing, short, or dashboard-token-equal key gives no key (SSO off)', () => {
  assert.equal(financeSsoKeyOf({}, DASHBOARD_TOKEN), null, 'missing');
  assert.equal(financeSsoKeyOf({ FINANCE_SSO_KEY: 'too-short' }, DASHBOARD_TOKEN), null, 'short');
  assert.equal(financeSsoKeyOf({ FINANCE_SSO_KEY: DASHBOARD_TOKEN }, DASHBOARD_TOKEN), null, 'same as the dashboard token');
  // the dashboard token alone, with no key variable, never turns SSO on
  assert.equal(financeSsoOptions({ hosted: true, enabled: true, env: { FINANCE_DASHBOARD_TOKEN: DASHBOARD_TOKEN }, dashboardToken: DASHBOARD_TOKEN, supabase: activeDb(), merchantId: M }), null);
});

test('SSO options exist only when hosted, enabled and the dedicated key is valid; they require a person', () => {
  const env = { FINANCE_SSO_KEY: SSO_KEY };
  assert.equal(financeSsoOptions({ hosted: false, enabled: true, env, dashboardToken: DASHBOARD_TOKEN, supabase: activeDb(), merchantId: M }), null, 'not hosted');
  assert.equal(financeSsoOptions({ hosted: true, enabled: false, env, dashboardToken: DASHBOARD_TOKEN, supabase: activeDb(), merchantId: M }), null, 'not enabled');
  const o = financeSsoOptions({ hosted: true, enabled: true, env, dashboardToken: DASHBOARD_TOKEN, supabase: activeDb(), merchantId: M });
  assert.equal(o.secret, SSO_KEY); assert.equal(o.requirePerson, true); assert.equal(typeof o.checkAccess, 'function');
});

test('a valid Core ticket (signed with the dedicated key, for a person with access) is accepted', async () => {
  const t = issueTicket({ secret: SSO_KEY, merchantId: M, person: P });
  const r = await verifierWith(SSO_KEY).verifyAsync(t);
  assert.equal(r.ok, true); assert.equal(r.claims.userId, U);
});

test('the dashboard token alone is refused on the SSO path: it cannot sign a ticket Finance accepts', async () => {
  const forged = issueTicket({ secret: DASHBOARD_TOKEN, merchantId: M, person: P }); // signed with the dashboard token
  assert.equal((await verifierWith(SSO_KEY).verifyAsync(forged)).code, 'SSO_BAD_SIGNATURE');
  // presenting the raw token as the ticket is refused as malformed
  assert.equal((await verifierWith(SSO_KEY).verifyAsync(DASHBOARD_TOKEN)).code, 'SSO_MALFORMED');
});

test('without the dedicated key, every ticket is refused (no verifier can be built from the dashboard token)', async () => {
  const t = issueTicket({ secret: SSO_KEY, merchantId: M, person: P });
  // the service has no key, so it uses none: sso is null and no verifier exists; a verifier built with the token refuses a key-signed ticket
  assert.equal(financeSsoOptions({ hosted: true, enabled: true, env: {}, dashboardToken: DASHBOARD_TOKEN, supabase: activeDb(), merchantId: M }), null);
  assert.equal((await verifierWith(DASHBOARD_TOKEN).verifyAsync(t)).code, 'SSO_BAD_SIGNATURE');
});
