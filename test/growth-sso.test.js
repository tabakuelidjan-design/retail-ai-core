// Growth single sign-on (GET /sso): a signed one-time ticket from the Nordla server opens a Growth session for THAT person, with the CURRENT role read by the database
// (read-only stays read-only), and nothing else does: a person without Growth access, a replayed, expired, forged or other-merchant ticket gets no session and no data.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHostedGrowth } from '../src/growth/server/hosted.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { createMemoryFollowUpStore } from '../src/growth/server/follow-up-store.js';
import { createGrowthSso } from '../src/growth/server/sso.js';
import { createHandoffVerifier, issueHandoff } from '../src/identity/handoff.js';

const SECRET = 'growth-sso-secret-0123456789abcdef'; const M = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb';
const OWNER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'; const VIEWER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; const NOGROWTH = 'cccccccc-3333-4333-8333-cccccccccccc';
const ROLES = { [OWNER]: 'OWNER', [VIEWER]: 'VIEWER' }; // NOGROWTH is a Nordla member without the Growth module: the database refuses
let nowMs = 1_800_000_000_000;

async function boot({ withSso = true, maxFailures = 5 } = {}) {
  const sessions = new Map(); let n = 0;
  const gate = { // the real gate's contract: a cookie = a session; the role comes from the session
    handle: async () => false,
    authorize: async (req) => { const t = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const s = t && sessions.get(t); return s ? { ok: true, access: { merchantId: M, userId: s.userId, role: s.role } } : { ok: false, status: 401, body: { error: 'SESSION_INVALID' } }; },
  };
  const opened = [];
  const sso = withSso ? createGrowthSso({ verifier: createHandoffVerifier({ secret: SECRET, merchantId: M, now: () => nowMs }), maxFailures, now: () => nowMs, clientIp: () => '203.0.113.9',
    openSession: async (userId) => { opened.push(userId); if (!ROLES[userId]) return { ok: false }; const token = `tok-${(n += 1)}`; sessions.set(token, { userId, role: ROLES[userId] }); return { ok: true, token, role: ROLES[userId] }; },
    cookiesFor: (token) => [`sid=${token}; HttpOnly; Secure`, `csrf=${token}`] }) : null;
  const handler = createHostedGrowth({ gate, merchantId: M, historyScope: 'x'.repeat(64), app: createGrowthApp({ merchantId: M, hosted: true }), store: createMemoryFollowUpStore(), sso });
  const s = http.createServer(handler); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${s.address().port}`;
  const ticket = (userId, extra = {}) => issueHandoff({ secret: SECRET, merchantId: M, userId, now: () => nowMs, ...extra });
  const go = (t, to) => fetch(`${base}/sso?t=${encodeURIComponent(t)}${to ? `&to=${to}` : ''}`, { redirect: 'manual' });
  const api = (path, cookie, init = {}) => fetch(base + path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } });
  return { base, ticket, go, api, opened, close: () => new Promise((r) => s.close(r)) };
}
const cookieOf = (r) => /sid=[^;]+/.exec(r.headers.get('set-cookie') ?? '')?.[0] ?? null;

test('SSO-1 a valid ticket opens a session for THAT person and lands on the requested Growth screen; the session then reads the API', async () => {
  const s = await boot();
  try {
    assert.equal((await s.api('/api/growth/overview')).status, 401, 'no session yet');
    const r = await s.go(s.ticket(OWNER)); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/#/dropoff'); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    const cookie = cookieOf(r); assert.ok(cookie, 'a session cookie is set'); assert.deepEqual(s.opened, [OWNER]);
    assert.notEqual((await s.api('/api/growth/overview', cookie)).status, 401, 'the session reads the data');
    assert.equal((await s.go(s.ticket(OWNER), 'opportunities')).headers.get('location'), '/#/opportunities');
    for (const to of ['https://evil.example', '//evil.example', 'x', '__proto__']) assert.equal((await s.go(s.ticket(OWNER), to)).headers.get('location'), '/#/dropoff', `destination ${to} is never followed`);
  } finally { await s.close(); }
});

test('SSO-2 READ-ONLY: a Lecture seule account gets a session with its own role: it reads, it cannot save follow-up', async () => {
  const s = await boot();
  try {
    const cookie = cookieOf(await s.go(s.ticket(VIEWER))); assert.ok(cookie);
    assert.notEqual((await s.api('/api/growth/overview', cookie)).status, 401);
    const put = await s.api('/api/growth/follow-up', cookie, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'k', value: {}, expected_version: 0 }) });
    assert.equal(put.status, 403); assert.equal((await put.json()).error.code, 'FORBIDDEN_ROLE');
  } finally { await s.close(); }
});

test('SSO-3 NO ACCESS: a member without the Growth module (database refusal) gets no cookie and no data, with the same bare page as any other refusal', async () => {
  const s = await boot();
  try {
    const bad = await s.go(s.ticket(NOGROWTH)); assert.equal(bad.status, 403); assert.equal(bad.headers.get('set-cookie'), null);
    const page = await bad.text(); assert.ok(!/NOT_MEMBER|MODULE|growth_|OWNER|VIEWER/.test(page), 'no reason leaks'); assert.match(page, /Connexion automatique impossible/);
    assert.equal((await s.api('/api/growth/overview')).status, 401); assert.equal((await s.api('/api/growth/dropoff')).status, 401);
    const other = await s.go(s.ticket(OWNER)); assert.equal(await (await s.go(s.ticket(NOGROWTH))).text(), page, 'identical to every refusal'); assert.equal(other.status, 302);
  } finally { await s.close(); }
});

test('SSO-4 replayed, expired, forged, other-merchant or missing tickets are refused without a cookie', async () => {
  const s = await boot({ maxFailures: 100 });
  try {
    const t = s.ticket(OWNER); assert.equal((await s.go(t)).status, 302); const again = await s.go(t); assert.equal(again.status, 403); assert.equal(again.headers.get('set-cookie'), null);
    const old = s.ticket(OWNER, { ttlSeconds: 10 }); nowMs += 120_000; assert.equal((await s.go(old)).status, 403);
    assert.equal((await s.go(issueHandoff({ secret: 'another-secret-another-secret-123', merchantId: M, userId: OWNER, now: () => nowMs }))).status, 403);
    assert.equal((await s.go(issueHandoff({ secret: SECRET, merchantId: '99999999-9999-4999-8999-999999999999', userId: OWNER, now: () => nowMs }))).status, 403);
    assert.equal((await s.go('')).status, 403); assert.equal((await fetch(`${s.base}/sso`, { redirect: 'manual' })).status, 403);
    assert.equal((await fetch(`${s.base}/sso?t=x`, { method: 'POST', redirect: 'manual' })).status, 405);
    assert.deepEqual(s.opened, [OWNER], 'only the first, valid ticket reached the database');
  } finally { await s.close(); }
});

test('SSO-5 repeated failures from one address are blocked (429), even for a valid ticket', async () => {
  const s = await boot({ maxFailures: 3 });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await s.go('bad.ticket')).status, 403);
    const r = await s.go(s.ticket(OWNER)); assert.equal(r.status, 429); assert.equal(r.headers.get('set-cookie'), null);
  } finally { await s.close(); }
});

test('SSO-6 without a configured secret there is no /sso route: the sign-in form stays the only way in', async () => {
  const s = await boot({ withSso: false });
  try { const r = await s.go(s.ticket(OWNER)); assert.notEqual(r.status, 302); assert.equal(r.headers.get('set-cookie'), null); } finally { await s.close(); }
});
