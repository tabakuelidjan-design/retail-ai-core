// Analytics dashboard single sign-on (ticket from the Nordla server): a ticket for THIS merchant opens an HttpOnly session once; the access token keeps working; nothing else does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, ANALYTICS_SSO_AUDIENCE } from '../src/analytics-premium/server/hosting.js';
import { issueTicket } from '../src/finance/sso-ticket.js';

const HOST = 'analytics-staging.up.railway.app'; const TOKEN = 't'.repeat(32); const SECRET = 'an-sso-secret-0123456789-abcdefghij'; const M = 'merchant-1';
let T = Date.parse('2026-11-18T12:00:00Z'); const now = () => T;
const res = () => { const r = { status: 0, headers: {}, body: '', writeHead(s, h) { r.status = s; Object.assign(r.headers, h); }, setHeader(k, v) { r.headers[k] = v; }, end(b) { r.body = String(b ?? ''); } }; return r; };
const run = async (guard, { url = '/', cookie, auth } = {}) => { const r = res(); const ok = await guard({ method: 'GET', url, headers: { host: HOST, ...(cookie ? { cookie } : {}), ...(auth ? { authorization: auth } : {}) }, socket: { remoteAddress: '1.2.3.4' } }, r); return { ok, r }; };
const mk = (sso = { secret: SECRET, merchantId: M }) => createGuard({ allowedHosts: [HOST], token: TOKEN, trustProxyHops: 0, sso, now });
const tk = (o = {}) => issueTicket({ secret: SECRET, merchantId: M, audience: ANALYTICS_SSO_AUDIENCE, now, ...o });

test('AS-1 a good ticket opens a session (302 to /, HttpOnly Secure SameSite=Strict cookie); the cookie then passes the guard; the same ticket again is refused', async () => {
  const g = mk(); const t = tk();
  const a = await run(g, { url: `/sso?t=${encodeURIComponent(t)}` }); assert.equal(a.ok, false); assert.equal(a.r.status, 302); assert.equal(a.r.headers.Location, '/');
  const cookie = a.r.headers['Set-Cookie']; assert.match(cookie, /^an_sid=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Strict; Path=\//);
  const b = await run(g, { cookie: cookie.split(';')[0] }); assert.equal(b.ok, true);
  const again = await run(g, { url: `/sso?t=${encodeURIComponent(t)}` }); assert.equal(again.r.status, 403); assert.equal(JSON.parse(again.r.body).error.code, 'SSO_REPLAYED'); assert.equal(again.r.headers['Set-Cookie'], undefined);
});

test('AS-2 refused: no ticket, another merchant, another audience (a Finance ticket), another key, an expired ticket, a forged cookie; the host allow-list still comes first', async () => {
  const g = mk();
  for (const t of ['', 'garbage', tk({ merchantId: 'other' }), issueTicket({ secret: SECRET, merchantId: M, now }) /* Finance audience */, issueTicket({ secret: 'another-secret-another-secret-123', merchantId: M, audience: ANALYTICS_SSO_AUDIENCE, now })]) {
    const r = await run(mk(), { url: `/sso?t=${encodeURIComponent(t)}` }); assert.equal(r.ok, false); assert.equal(r.r.status, 403); assert.equal(r.r.headers['Set-Cookie'], undefined);
  }
  const old = tk(); T += 61_000; assert.equal((await run(mk(), { url: `/sso?t=${encodeURIComponent(old)}` })).r.status, 403); T -= 61_000;
  assert.equal((await run(g, { cookie: `an_sid=${'a'.repeat(64)}` })).r.status, 401, 'a forged cookie is not a session');
  const wrongHost = res(); assert.equal(await g({ method: 'GET', url: '/', headers: { host: 'evil.example' }, socket: { remoteAddress: '1.2.3.4' } }, wrongHost), false); assert.equal(wrongHost.status, 403);
});

test('AS-3 the access token still works, without a session nothing is served, and without a configured secret /sso does not exist', async () => {
  const g = mk(); assert.equal((await run(g, { auth: `Basic ${Buffer.from(`x:${TOKEN}`).toString('base64')}` })).ok, true);
  assert.equal((await run(g)).r.status, 401);
  const off = mk(null); assert.equal((await run(off, { url: `/sso?t=${encodeURIComponent(tk())}` })).r.status, 401, 'no secret: the path is just another unauthenticated request');
});

test('AS-4 five bad tickets lock the client out for five minutes (same rule as the token)', async () => {
  const g = mk(); for (let i = 0; i < 5; i++) await run(g, { url: '/sso?t=bad' });
  assert.equal((await run(g, { url: `/sso?t=${encodeURIComponent(tk())}` })).r.status, 429);
});

test('AS-5 the session expires after 8 hours', async () => {
  const g = mk(); const a = await run(g, { url: `/sso?t=${encodeURIComponent(tk())}` }); const c = a.r.headers['Set-Cookie'].split(';')[0];
  assert.equal((await run(g, { cookie: c })).ok, true); T += 8 * 3600_000 + 1000; assert.equal((await run(g, { cookie: c })).r.status, 401);
});

import { createCoreHttp } from '../src/core-pilot/http.js';
import { createTicketVerifier } from '../src/finance/sso-ticket.js';
import { buildAnalyticsSso } from '../src/sourcing/server/index.js';

test('AS-6 Nordla side: the Analytics ticket is issued only to owner / administrator / accountant, for the server merchant, with the Analytics audience, and the link carries no secret', async () => {
  const sso = { publicUrl: 'https://analytics.example.app', secret: SECRET, merchantId: M };
  const core = createCoreHttp({ runtime: null, store: {}, analytics: { source: 'Analytics · test' }, analyticsSso: sso });
  const call = async (role, c = core) => { const chunks = []; let status = 0; await c.handle({ method: 'POST', url: '/api/core/analytics/open', headers: {}, on() {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from('{}'); } }, { writeHead: (s) => { status = s; }, end: (b) => chunks.push(String(b ?? '')), setHeader() {} }, new URL('http://x/api/core/analytics/open'), { role, userId: 'u1' }); return { status, body: chunks.join('') ? JSON.parse(chunks.join('')) : null }; };
  for (const role of ['VIEWER', 'COLLABORATOR', 'READ_ONLY', undefined]) assert.equal((await call(role)).status, 403, String(role));
  for (const role of ['OWNER', 'ADMIN', 'ACCOUNTANT']) {
    const r = await call(role); assert.equal(r.status, 200, role); const u = new URL(r.body.url); assert.equal(u.origin, 'https://analytics.example.app'); assert.equal(u.pathname, '/sso'); assert.ok(!r.body.url.includes(SECRET));
    assert.deepEqual(createTicketVerifier({ secret: SECRET, merchantId: M, audience: ANALYTICS_SSO_AUDIENCE }).verify(u.searchParams.get('t')), { ok: true });
    assert.equal(createTicketVerifier({ secret: SECRET, merchantId: M }).verify(new URL((await call(role)).body.url).searchParams.get('t')).ok, false, 'not a Finance ticket');
  }
  assert.equal((await call('OWNER', createCoreHttp({ runtime: null, store: {}, analytics: { source: 's' }, analyticsSso: null }))).status, 503);
  const modules = async (c) => { const chunks = []; await c.handle({ method: 'GET', url: '/api/core/modules', headers: {}, on() {} }, { writeHead() {}, end: (b) => chunks.push(String(b ?? '')), setHeader() {} }, new URL('http://x/api/core/modules'), { role: 'OWNER' }); return JSON.parse(chunks.join('')).modules.find((m) => m.key === 'analytics'); };
  assert.equal((await modules(core)).dashboard, true); assert.equal((await modules(createCoreHttp({ runtime: null, store: {}, analytics: { source: 's' }, analyticsSso: null }))).dashboard, false);
});

test('AS-7 buildAnalyticsSso: only a clean https origin and a 24+ character secret give the dashboard link', () => {
  const ok = { ANALYTICS_PUBLIC_URL: 'https://a.example.app', ANALYTICS_SSO_SECRET: SECRET };
  assert.deepEqual(buildAnalyticsSso(ok, M), { publicUrl: 'https://a.example.app', secret: SECRET, merchantId: M });
  for (const bad of [{ ...ok, ANALYTICS_SSO_SECRET: 'short' }, { ...ok, ANALYTICS_PUBLIC_URL: 'http://a.example.app' }, { ...ok, ANALYTICS_PUBLIC_URL: 'https://a.example.app/x' }, { ...ok, ANALYTICS_PUBLIC_URL: 'https://u:p@a.example.app' }, {}]) assert.equal(buildAnalyticsSso(bad, M), null);
});
