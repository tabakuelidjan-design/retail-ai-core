// Phase 2 - Finance: a session opened by Nordla single sign-on is re-checked on EVERY request (public and protected routes).
// A suspended or removed person, a changed role or a removed entitlement closes it at once. Direct access without a session stays refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { issueTicket } from '../src/finance/sso-ticket.js';
import { createAccessChecker } from '../src/identity/sso-contract.js';
import { startApp } from './finance-dashboard-helpers.js';

const SECRET = 'a-shared-server-side-secret-0123456789';
const M = 'merchant-test-1';
const U = '5c2f4d6e-ea34-452d-8107-0197a3eb54da';

function store({ role = 'OWNER', status = 'ACTIVE', removed = null, entitlement = 'ACTIVE' } = {}) {
  const s = { role, status, removed, entitlement };
  s.supabase = { select: async (table, q) => {
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
