// Phase 2 - Finance: a session opened by Nordla single sign-on is re-checked on EVERY request (public and protected routes).
// A suspended or removed person, a changed role or a removed entitlement closes it at once. Direct access without a session stays refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { issueTicket } from '../src/finance/sso-ticket.js';
import { createAccessChecker } from '../src/identity/sso-contract.js';
import { startApp } from './finance-dashboard-helpers.js';

import { K_FINANCE } from './fixtures/sso-test-keys.js';
const SECRET = K_FINANCE;
const M = 'merchant-test-1';
const U = '5c2f4d6e-ea34-452d-8107-0197a3eb54da';

function store({ role = 'OWNER', status = 'ACTIVE', removed = null, entitlement = 'ACTIVE' } = {}) {
  const s = { role, status, removed, entitlement, required: false, compliant: false, policyUnavailable: false };
  s.supabase = { rpc: async () => {
    if (s.policyUnavailable) throw new Error('policy unavailable');
    return { required: s.required, privileged: ['OWNER', 'ADMIN'].includes(s.role), compliant: s.compliant };
  }, select: async (table, q) => {
    const id = (v) => String(v).replace(/^eq\./, '');
    if (table === 'merchant_members') return [{ merchant_id: M, user_id: U, role: s.role, status: s.status, removed_at: s.removed }].filter((r) => r.user_id === id(q.user_id) && r.merchant_id === id(q.merchant_id));
    return s.entitlement ? [{ merchant_id: M, module_code: 'finance', status: s.entitlement }].filter((r) => r.module_code === id(q.module_code) && r.merchant_id === id(q.merchant_id)) : [];
  } };
  return s;
}

async function openedSession(a, role = 'OWNER') {
  const t = issueTicket({ secret: SECRET, merchantId: M, person: { userId: U, role, module: 'finance' } });
  const r = await fetch(`${a.base}/sso?t=${encodeURIComponent(t)}`, { redirect: 'manual' });
  assert.equal(r.status, 302, 'the Core ticket opens the session');
  return r.headers.get('set-cookie').split(';')[0];
}
const session = (a, cookie) => fetch(`${a.base}/api/session`, { headers: cookie ? { Cookie: cookie } : {} }).then((r) => r.json());
const overview = (a, cookie) => fetch(`${a.base}/api/overview`, { headers: cookie ? { Cookie: cookie } : {} });

function appWith(s) {
  return startApp({ merchantId: M, deps: { sso: { secret: SECRET, requirePerson: true, checkAccess: createAccessChecker({ supabase: s.supabase, merchantId: M }) } } });
}

test('SSO-only Finance refuses the shared token and an old persisted token session, while personal SSO works', async () => {
  const s = store();
  const legacySid = 'legacy-synthetic-session';
  const persistence = { load: () => [[createHash('sha256').update(legacySid).digest('hex'), { csrf: 'legacy', expires: Date.now() + 60000 }]], save: async () => {} };
  const a = await startApp({ merchantId: M, deps: {
    ssoOnly: true, sessionPersistence: persistence,
    sso: { secret: SECRET, requirePerson: true, checkAccess: createAccessChecker({ supabase: s.supabase, merchantId: M }) },
  } });
  try {
    assert.equal((await a.client().login()).status, 403, 'even a correct shared token is refused');
    assert.equal((await overview(a, 'fin_sid=' + legacySid)).status, 401, 'persisted token sessions are refused');
    assert.equal((await overview(a, await openedSession(a))).status, 200, 'personal session is accepted');
  } finally { await a.close(); }
});

test('SSO-only Finance cannot start without personal SSO verification', async () => {
  await assert.rejects(startApp({ deps: { ssoOnly: true } }), /SSO-only/);
});

test('MFA activation and policy outages close existing Finance sessions on the next data request', async () => {
  const s = store(); const a = await appWith(s);
  try {
    const cookie = await openedSession(a);
    assert.equal((await overview(a, cookie)).status, 200);
    s.required = true;
    assert.equal((await overview(a, cookie)).status, 401);
    s.compliant = true;
    await assert.rejects(openedSession(a), /the Core ticket opens the session/, 'an enrolled factor without a session proof is refused');
    s.required = false;
    const protectedCookie = await openedSession(a);
    assert.equal((await overview(a, protectedCookie)).status, 200);
    s.policyUnavailable = true;
    assert.equal((await overview(a, protectedCookie)).status, 401);
  } finally { await a.close(); }
});

test('an OWNER with active access keeps the Core session on every request', async () => {
  const s = store(); const a = await appWith(s);
  try {
    const cookie = await openedSession(a);
    assert.equal((await session(a, cookie)).authenticated, true);
    assert.equal((await overview(a, cookie)).status, 200);
  } finally { await a.close(); }
});

test('a suspended person loses the open session at the next request, on public and protected routes', async () => {
  const s = store(); const a = await appWith(s);
  try {
    const cookie = await openedSession(a);
    s.status = 'SUSPENDED';
    assert.equal((await session(a, cookie)).authenticated, false, 'the public session route no longer says authenticated');
    assert.equal((await overview(a, cookie)).status, 401, 'the protected route refuses');
  } finally { await a.close(); }
});

test('a removed person and a removed entitlement each close the open session', async () => {
  const s = store(); const a = await appWith(s);
  try {
    const c1 = await openedSession(a); s.removed = '2026-11-19T09:00:00Z';
    assert.equal((await overview(a, c1)).status, 401);
    s.removed = null; s.entitlement = null;
    const c2 = await openedSession(a).catch(() => null);
    assert.equal(c2, null, 'no new session while the entitlement is missing');
  } finally { await a.close(); }
});

test('a role changed after opening closes the session', async () => {
  const s = store({ role: 'OWNER' }); const a = await appWith(s);
  try {
    const cookie = await openedSession(a, 'OWNER');
    s.role = 'VIEWER';
    assert.equal((await overview(a, cookie)).status, 401);
  } finally { await a.close(); }
});

test('direct access without a session or token stays refused; a made-up cookie is not a session', async () => {
  const a = await appWith(store());
  try {
    assert.equal((await overview(a)).status, 401);
    assert.equal((await session(a, 'fin_sid=' + 'c'.repeat(64))).authenticated, false);
  } finally { await a.close(); }
});
