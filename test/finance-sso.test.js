import test from 'node:test';
import assert from 'node:assert/strict';
import { issueTicket, createTicketVerifier, SSO_MAX_TTL_SECONDS } from '../src/finance/sso-ticket.js';
import { startApp } from './finance-dashboard-helpers.js';
import { createCoreHttp } from '../src/core-pilot/http.js';
import { buildFinanceSso } from '../src/sourcing/server/index.js';

const SECRET = 'a-shared-server-side-secret-0123456789';
const M = 'merchant-test-1';
const T0 = Date.parse('2026-11-16T12:00:00.000Z');
const clock = (start = T0) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };

test('a fresh ticket for this merchant is accepted ONCE; the same ticket again is refused', () => {
  const c = clock(); const v = createTicketVerifier({ secret: SECRET, merchantId: M, now: c.now });
  const t = issueTicket({ secret: SECRET, merchantId: M, now: c.now });
  assert.deepEqual(v.verify(t), { ok: true });
  assert.deepEqual(v.verify(t), { ok: false, code: 'SSO_REPLAYED' });
});

test('an expired ticket, a ticket of another merchant, a forged or altered one and garbage are all refused, with a named reason', () => {
  const c = clock(); const v = createTicketVerifier({ secret: SECRET, merchantId: M, now: c.now });
  const old = issueTicket({ secret: SECRET, merchantId: M, ttlSeconds: 60, now: c.now });
  c.advance(61_000);
  assert.equal(v.verify(old).code, 'SSO_EXPIRED');
  const other = issueTicket({ secret: SECRET, merchantId: 'someone-else', now: c.now });
  assert.equal(v.verify(other).code, 'SSO_WRONG_MERCHANT');
  const forged = issueTicket({ secret: 'another-secret-another-secret-123', merchantId: M, now: c.now });
  assert.equal(v.verify(forged).code, 'SSO_BAD_SIGNATURE');
  const good = issueTicket({ secret: SECRET, merchantId: M, now: c.now });
  const [body, sig] = good.split('.');
  const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), m: 'someone-else' })).toString('base64url');
  assert.equal(v.verify(`${edited}.${sig}`).code, 'SSO_BAD_SIGNATURE'); // the merchant cannot be swapped without the key
  for (const junk of ['', 'abc', 'a.b.c', null, undefined, 42, 'x'.repeat(3000)]) assert.equal(v.verify(junk).ok, false);
});

test('the lifetime is capped and a secret that is too short is refused on both sides', () => {
  const c = clock(); const v = createTicketVerifier({ secret: SECRET, merchantId: M, now: c.now });
  const t = issueTicket({ secret: SECRET, merchantId: M, ttlSeconds: 99999, now: c.now });
  const p = JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString());
  assert.equal(p.exp - p.iat, SSO_MAX_TTL_SECONDS);
  assert.equal(v.verify(t).ok, true);
  assert.throws(() => issueTicket({ secret: 'short', merchantId: M }), (e) => e.code === 'SSO_NOT_CONFIGURED');
  assert.throws(() => createTicketVerifier({ secret: 'short', merchantId: M }), (e) => e.code === 'SSO_NOT_CONFIGURED');
});

test('the Finance dashboard: /sso opens a session without any token, once; direct access without a session stays refused', async () => {
  const a = await startApp({ merchantId: M, deps: { sso: { secret: SECRET } } });
  try {
    const go = (t) => fetch(`${a.base}/sso?t=${encodeURIComponent(t)}`, { redirect: 'manual' });
    // direct access, no ticket, no session
    assert.equal((await a.client().raw('GET', '/api/overview')).status, 401);
    assert.equal((await go('')).status, 403);
    // a good ticket: 302 to the dashboard + the usual HttpOnly session cookie
    const t = issueTicket({ secret: SECRET, merchantId: M });
    const ok = await go(t);
    assert.equal(ok.status, 302); assert.equal(ok.headers.get('location'), '/');
    const cookie = ok.headers.get('set-cookie'); assert.match(cookie, /^fin_sid=[0-9a-f]{64};.*HttpOnly.*SameSite=Strict/i);
    const session = await fetch(`${a.base}/api/session`, { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal((await session.json()).authenticated, true);
    // the same ticket again, a ticket for another merchant, and a ticket signed with another key: refused, no cookie
    const again = await go(t); assert.equal(again.status, 403); assert.equal(again.headers.get('set-cookie'), null);
    assert.equal((await go(issueTicket({ secret: SECRET, merchantId: 'other-merchant' }))).status, 403);
    assert.equal((await go(issueTicket({ secret: 'another-secret-another-secret-123', merchantId: M }))).status, 403);
    assert.ok(a.audits.some((e) => e.action === 'LOGIN_SSO') && a.audits.some((e) => e.action === 'LOGIN_SSO_REFUSED'));
    // the token login still works as before
    assert.equal((await a.client().login()).status, 200);
  } finally { await a.close(); }
});

test('without a secret configured, /sso does not exist (404)', async () => {
  const a = await startApp({ merchantId: M });
  try { assert.equal((await fetch(`${a.base}/sso?t=x`, { redirect: 'manual' })).status, 404); } finally { await a.close(); }
});

test('Nordla side: the ticket is issued only to owner / administrator / accountant, from the server merchant, and the link carries no secret', async () => {
  const sso = { publicUrl: 'https://finance.example.app', secret: SECRET, merchantId: M };
  const core = createCoreHttp({ runtime: null, store: {}, finance: { source: 'Finance · test', inbox: async () => ({}) }, financeSso: sso, entitlements: async () => new Set(['finance']) });
  const call = async (role) => {
    const chunks = []; let status = 0;
    const res = { writeHead: (s) => { status = s; }, end: (b) => chunks.push(String(b ?? '')), setHeader() {} };
    const req = { method: 'POST', url: '/api/core/finance/open', headers: {}, on() {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from('{}'); } };
    await core.handle(req, res, new URL('http://x/api/core/finance/open'), { role, userId: 'u1' });
    return { status, body: chunks.join('') ? JSON.parse(chunks.join('')) : null };
  };
  for (const role of ['VIEWER', 'COLLABORATOR']) assert.equal((await call(role)).status, 403);
  const r = await call('OWNER'); assert.equal(r.status, 200);
  const u = new URL(r.body.url); assert.equal(u.origin, 'https://finance.example.app'); assert.equal(u.pathname, '/sso');
  assert.ok(!r.body.url.includes(SECRET)); assert.deepEqual(createTicketVerifier({ secret: SECRET, merchantId: M }).verify(u.searchParams.get('t')), { ok: true });
  const none = createCoreHttp({ runtime: null, store: {}, finance: { source: 's' }, financeSso: null });
  const res2 = { s: 0, writeHead(s) { this.s = s; }, end() {}, setHeader() {} };
  await none.handle({ method: 'POST', url: '/api/core/finance/open', headers: {}, on() {}, [Symbol.asyncIterator]: async function* () {} }, res2, new URL('http://x/api/core/finance/open'), { role: 'OWNER' });
  assert.equal(res2.s, 503);
});

test('buildFinanceSso: only a clean https origin and a 24+ character secret give a dashboard link', () => {
  assert.deepEqual(buildFinanceSso({ FINANCE_PUBLIC_URL: 'https://finance.example.app', FINANCE_SSO_SECRET: SECRET }, M), { publicUrl: 'https://finance.example.app', secret: SECRET, merchantId: M });
  for (const env of [{}, { FINANCE_PUBLIC_URL: 'http://finance.example.app', FINANCE_SSO_SECRET: SECRET }, { FINANCE_PUBLIC_URL: 'https://finance.example.app/path', FINANCE_SSO_SECRET: SECRET },
    { FINANCE_PUBLIC_URL: `https://user:pw${String.fromCharCode(64)}finance.example.app`, FINANCE_SSO_SECRET: SECRET }, { FINANCE_PUBLIC_URL: 'https://finance.example.app', FINANCE_SSO_SECRET: 'short' }]) assert.equal(buildFinanceSso(env, M), null);
});

const FILE = '6c714261-0e3d-44ae-aced-981beedff16b';
test('integrated navigation: /sso?open=<file id> lands on that Finance file, a malformed id lands on the dashboard, the session still comes from the ticket alone', async () => {
  const a = await startApp({ merchantId: M, deps: { sso: { secret: SECRET } } });
  try {
    const go = (t, q) => fetch(`${a.base}/sso?t=${encodeURIComponent(t)}${q}`, { redirect: 'manual' });
    const ok = await go(issueTicket({ secret: SECRET, merchantId: M }), `&open=${FILE.toUpperCase()}`);
    assert.equal(ok.status, 302); assert.equal(ok.headers.get('location'), `/#/purchases?open=${FILE}`);
    for (const bad of ['&open=../../etc', '&open=<script>', '&open=123', '&open=']) { const r = await go(issueTicket({ secret: SECRET, merchantId: M }), bad); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/', bad); }
    assert.equal((await go('forged', `&open=${FILE}`)).status, 403, 'the hint never replaces the ticket');
  } finally { await a.close(); }
});

test('integrated navigation: the Finance session carries the Nordla home address only when it is a clean https origin', async () => {
  for (const [homeUrl, expected] of [['https://nordla.example.app', 'https://nordla.example.app'], [null, undefined]]) {
    const a = await startApp({ merchantId: M, deps: { sso: { secret: SECRET }, ...(homeUrl ? { homeUrl } : {}) } });
    try {
      const ok = await fetch(`${a.base}/sso?t=${encodeURIComponent(issueTicket({ secret: SECRET, merchantId: M }))}`, { redirect: 'manual' });
      const s = await (await fetch(`${a.base}/api/session`, { headers: { Cookie: ok.headers.get('set-cookie').split(';')[0] } })).json();
      assert.equal(s.nordlaHome, expected);
    } finally { await a.close(); }
  }
});

test('integrated navigation: Nordla issues the Finance link with the file to open (UUID only) and shows the Analytics address only for a clean https origin', async () => {
  const sso = { publicUrl: 'https://finance.example.app', secret: SECRET, merchantId: M };
  const mk = (env) => createCoreHttp({ runtime: null, store: {}, finance: { source: 'Finance · test', inbox: async () => ({}) }, financeSso: sso, entitlements: async () => new Set(['finance', 'analytics']), env });
  const call = async (core, bodyText) => {
    const chunks = []; let status = 0; const res = { writeHead: (s) => { status = s; }, end: (b) => chunks.push(String(b ?? '')), setHeader() {} };
    await core.handle({ method: 'POST', url: '/api/core/finance/open', headers: {}, on() {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from(bodyText); } }, res, new URL('http://x/api/core/finance/open'), { role: 'OWNER', userId: 'u1' });
    return { status, body: JSON.parse(chunks.join('')) };
  };
  const core = mk({});
  assert.equal(new URL((await call(core, JSON.stringify({ dossier: FILE }))).body.url).searchParams.get('open'), FILE);
  for (const bad of [{ dossier: 'x' }, { dossier: '../../a' }, {}, { dossier: 42 }]) assert.equal(new URL((await call(core, JSON.stringify(bad))).body.url).searchParams.get('open'), null);
  assert.equal(new URL((await call(core, 'not json')).body.url).searchParams.get('open'), null, 'a broken body still opens the dashboard');
  const modules = async (env) => { const chunks = []; await mk(env).handle({ method: 'GET', url: '/api/core/modules', headers: {}, on() {} }, { writeHead() {}, end: (b) => chunks.push(String(b ?? '')), setHeader() {} }, new URL('http://x/api/core/modules'), { role: 'OWNER' }); return JSON.parse(chunks.join('')).modules; };
  assert.equal((await modules({ ANALYTICS_PUBLIC_URL: 'https://analytics.example.app/' })).find((m) => m.key === 'analytics').analytics_url, 'https://analytics.example.app');
  for (const bad of [undefined, 'http://a.example', 'javascript:alert(1)']) assert.equal((await modules({ ANALYTICS_PUBLIC_URL: bad })).find((m) => m.key === 'analytics').analytics_url, undefined);
});
