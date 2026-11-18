// Phase 2 - a session opened by Nordla single sign-on is re-checked on EVERY request (Analytics guard).
// A suspended or removed person, a changed role or a removed entitlement loses the open session at once; direct access without a
// session or token stays refused; the access token is not a Nordla identity and is not used for these checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, ANALYTICS_SSO_AUDIENCE } from '../src/analytics-premium/server/hosting.js';
import { issueTicket } from '../src/finance/sso-ticket.js';
import { createAccessChecker } from '../src/identity/sso-contract.js';

const HOST = 'analytics-staging.up.railway.app'; const TOKEN = 't'.repeat(32); import { K_ANALYTICS } from './fixtures/sso-test-keys.js';
const SECRET = K_ANALYTICS; const M = 'merchant-1';
const U = '5c2f4d6e-ea34-452d-8107-0197a3eb54da';
let T = Date.parse('2026-11-19T08:00:00Z'); const now = () => T;
const res = () => { const r = { status: 0, headers: {}, body: '', writeHead(s, h) { r.status = s; Object.assign(r.headers, h); }, setHeader(k, v) { r.headers[k] = v; }, end(b) { r.body = String(b ?? ''); } }; return r; };
const run = async (guard, { url = '/', cookie, auth } = {}) => { const r = res(); const ok = await guard({ method: 'GET', url, headers: { host: HOST, ...(cookie ? { cookie } : {}), ...(auth ? { authorization: auth } : {}) }, socket: { remoteAddress: '1.2.3.4' } }, r); return { ok, r }; };

// a mutable access store: the test changes it between two requests
function store({ role = 'OWNER', status = 'ACTIVE', removed = null, entitlement = 'ACTIVE' } = {}) {
  const s = { role, status, removed, entitlement };
  s.supabase = { select: async (table, q) => {
    const id = (v) => String(v).replace(/^eq\./, '');
    if (table === 'merchant_members') return [{ merchant_id: M, user_id: U, role: s.role, status: s.status, removed_at: s.removed }].filter((r) => r.user_id === id(q.user_id) && r.merchant_id === id(q.merchant_id));
    return s.entitlement ? [{ merchant_id: M, module_code: 'analytics', status: s.entitlement }].filter((r) => r.module_code === id(q.module_code) && r.merchant_id === id(q.merchant_id)) : [];
  } };
  return s;
}
const mk = (s) => createGuard({ allowedHosts: [HOST], token: TOKEN, trustProxyHops: 0, now, sso: { secret: SECRET, merchantId: M, requirePerson: true, checkAccess: createAccessChecker({ supabase: s.supabase, merchantId: M }) } });
const tk = (role = 'OWNER') => issueTicket({ secret: SECRET, merchantId: M, audience: ANALYTICS_SSO_AUDIENCE, now, person: { userId: U, role, module: 'analytics' } });

async function openSession(g, role) {
  const a = await run(g, { url: `/sso?t=${encodeURIComponent(tk(role))}` });
  assert.equal(a.r.status, 302, 'the Core ticket opens a session');
  return a.r.headers['Set-Cookie'].split(';')[0];
}

test('a Core ticket opens the session for an OWNER with active access, and the session passes the guard', async () => {
  const s = store(); const g = mk(s);
  const cookie = await openSession(g, 'OWNER');
  assert.equal((await run(g, { cookie })).ok, true);
});

test('a suspended person loses an OPEN session at the next request (401 SESSION_REVOKED), and it stays closed', async () => {
  const s = store(); const g = mk(s); const cookie = await openSession(g, 'OWNER');
  assert.equal((await run(g, { cookie })).ok, true);
  s.status = 'SUSPENDED';
  const after = await run(g, { cookie }); assert.equal(after.ok, false); assert.equal(after.r.status, 401); assert.equal(JSON.parse(after.r.body).error.code, 'SESSION_REVOKED');
  s.status = 'ACTIVE';
  assert.equal((await run(g, { cookie })).ok, false, 'the revoked session is gone: reactivating the person does not reopen it');
});

test('a removed person loses an open session at once', async () => {
  const s = store(); const g = mk(s); const cookie = await openSession(g, 'OWNER');
  s.removed = '2026-11-19T09:00:00Z';
  assert.equal((await run(g, { cookie })).r.status, 401);
});

test('a role changed after the session opened loses it (the session carries the role it was opened with)', async () => {
  const s = store({ role: 'OWNER' }); const g = mk(s); const cookie = await openSession(g, 'OWNER');
  s.role = 'VIEWER';
  assert.equal((await run(g, { cookie })).r.status, 401);
});

test('a removed entitlement closes an open session at once', async () => {
  const s = store(); const g = mk(s); const cookie = await openSession(g, 'OWNER');
  s.entitlement = null;
  assert.equal((await run(g, { cookie })).r.status, 401);
});

test('direct access without a session or token is refused; a forged session cookie is refused', async () => {
  const g = mk(store());
  assert.equal((await run(g, { url: '/' })).r.status, 401);
  assert.equal((await run(g, { cookie: `an_sid=${'b'.repeat(64)}` })).r.status, 401);
});

test('the access token is still a separate, explicit path: it is not a Nordla identity and does not change the SSO checks', async () => {
  const g = mk(store());
  const basic = `Basic ${Buffer.from(`x:${TOKEN}`).toString('base64')}`;
  assert.equal((await run(g, { url: '/', auth: basic })).ok, true);
});
