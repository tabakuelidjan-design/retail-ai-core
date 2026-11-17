// Paramètres -> Sécurité over HTTP: real session store + real service on an in-memory PostgREST fake, real host and session gate, fake sign-in provider only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createSecurityHost } from '../src/sourcing/server/security-host.js';
import { createSecurityService } from '../src/settings-security/service.js';
import { createSessionStore, hashSessionToken } from '../src/identity/sessions.js';
import { createEventLog } from '../src/identity/events.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';
import { loadIdentityConfig } from '../src/identity/config.js';

const M1 = '11111111-1111-4111-8111-111111111111'; const M2 = '22222222-2222-4222-8222-222222222222';
const U = { alice: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bob: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', view: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', admin: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
const ROLE = { [U.alice]: 'OWNER', [U.bob]: 'OWNER', [U.view]: 'VIEWER', [U.admin]: 'ADMIN' };

/** Minimal PostgREST fake: eq / neq / is.null / gt / in filters, order, limit. */
function fakeDb() {
  const t = { app_sessions: [], identity_events: [], merchants: [{ id: M1, name: 'Boutique A' }, { id: M2, name: 'Boutique B' }] }; let seq = 1;
  const match = (row, f) => Object.entries(f).every(([k, v]) => { if (['select', 'order', 'limit'].includes(k)) return true; const [op, ...rest] = String(v).split('.'); const arg = rest.join('.'); const x = row[k];
    if (op === 'eq') return String(x) === arg; if (op === 'neq') return String(x) !== arg; if (op === 'is') return x === null || x === undefined; if (op === 'gt') return new Date(x) > new Date(arg); if (op === 'in') return arg.replace(/^\(|\)$/g, '').split(',').includes(String(x)); return true; });
  return { t, select: async (table, f = {}) => { let r = t[table].filter((x) => match(x, f)); if (f.order) { const [c, d] = f.order.split('.'); r = [...r].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (d === 'desc' ? -1 : 1)); } return r.slice(0, Number(f.limit ?? 1000)).map((x) => ({ ...x })); },
    insert: async (table, rows) => rows.map((r) => { const row = { id: table === 'identity_events' ? seq++ : randomUUID(), revoked_at: null, revoked_reason: null, ...r }; t[table].push(row); return { ...row }; }),
    update: async (table, f, patch) => { const hit = t[table].filter((x) => match(x, f)); hit.forEach((x) => Object.assign(x, patch)); return hit.map((x) => ({ ...x })); }, rpc: async () => ({}) };
}

async function boot({ passwordOk = true, providerAccepts = true } = {}) {
  const db = fakeDb(); const cfg = loadIdentityConfig({}); const store = createSessionStore({ supabase: db, config: cfg });
  const calls = { setPassword: [], verify: [] };
  const open = async (userId, merchantId, module = 'sourcing') => (await store.create({ userId, merchantId, module })).token;
  const identity = { context: { module: 'sourcing' }, authenticateAndOpenSession: async () => ({ ok: false }), logoutSession: async (tok) => store.logoutCurrent(tok, { merchantId: M1, module: 'sourcing' }),
    resolveAccessSession: async (tok) => { const v = await store.validate(tok, { merchantId: M1, module: 'sourcing' }); return v.ok ? { ok: true, merchantId: M1, userId: v.session.userId, role: ROLE[v.session.userId] ?? 'VIEWER', module: 'sourcing' } : { ok: false }; } };
  const security = { module: 'sourcing', cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }), sessionCookie: (x) => `sid=${x}`, csrfCookie: (x) => `csrf=${x}`, clearSessionCookie: () => 'sid=;', clearCsrfCookie: () => 'csrf=;' }, csrfTokenFor: (x) => `csrf-${x}`,
    guardRead: () => ({ ok: true }), guardLogin: () => ({ ok: true, ctx: {} }), readLoginBody: async () => ({}), publicError: () => ({ status: 400 }),
    guardMutation: async (req, resolve) => { const x = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const a = x ? await resolve(x) : null; if (!a?.ok) return { ok: false, code: 'SESSION_INVALID' }; if (req.headers['x-nordla-csrf'] !== `csrf-${x}`) return { ok: false, code: 'CSRF_INVALID', response: { status: 403, error: 'CSRF_INVALID' } }; return { ok: true, access: a, sessionToken: x }; } };
  const adminAuth = { getUser: async (id) => ({ id, email: `${id.slice(0, 4)}@example.test`, identities: [{ provider: 'email' }], factors: [], last_sign_in_at: '2026-11-17T10:00:00Z' }), setPassword: async (id, pw) => { calls.setPassword.push([id, pw]); return providerAccepts; } };
  const verifier = { verifyPassword: async (email, pw) => { calls.verify.push(email); return passwordOk && pw === 'old-password-123' ? { ok: true, userId: U.alice } : { ok: false, kind: 'INVALID' }; } };
  const service = createSecurityService({ supabase: db, adminAuth, verifier, events: createEventLog({ supabase: db }), sessions: store, rules: { ...cfg, maxEmailFailures: 5, maxIpFailures: 20, blockSeconds: 900 }, idleMs: cfg.idleMs });
  const host = await createSecurityHost({ gate: createSessionGate({ identity, security }), merchantId: M1, service, sessionCookie: 'sid' });
  const server = http.createServer(async (req, res) => { if (!(await host.handle(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end('nf'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { as, method = 'GET', body, csrf = true } = {}) => { const res = await fetch(base + path, { method, headers: { ...(as ? { cookie: `sid=${as}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(as && csrf && method !== 'GET' ? { 'x-nordla-csrf': `csrf-${as}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ } return { status: res.status, json, text }; };
  return { call, db, open, calls, close: () => server.close() };
}

test('SS-1 no session 401; page and assets served with a strict CSP; unknown rubric 404', async () => {
  const { call, close } = await boot();
  try {
    assert.equal((await call('/api/security')).status, 401);
    const page = await call('/settings/security/sessions'); assert.equal(page.status, 200); assert.match(page.text, /security-assets\/security\.js/);
    assert.equal((await call('/settings/security/inconnu')).status, 404);
    for (const f of ['security.js', 'security.css', 'shell.js', 'general.css', 'connections.css']) assert.equal((await call(`/security-assets/${f}`)).status, 200, f);
  } finally { close(); }
});

test('SS-2 overview states are honest: password sign-in, no second factor at sign-in, enrollment and recovery unavailable with a reason', async () => {
  const { call, open, close } = await boot();
  try {
    const t = await open(U.alice, M1); const r = await call('/api/security', { as: t }); assert.equal(r.status, 200);
    const a = r.json.account; assert.equal(a.scope, 'PERSONAL'); assert.equal(a.signInMethod.id, 'email_password');
    assert.equal(a.mfa.requiredAtSignIn, false); assert.equal(a.mfa.enrollment.available, false); assert.ok(a.mfa.enrollment.reason); assert.equal(a.recovery.available, false); assert.equal(a.passkeys.available, false);
    assert.equal(r.json.team.scope, 'TEAM'); assert.equal(r.json.team.requireMfa.available, false);
    assert.ok(!JSON.stringify(r.json).match(/token|password_hash|service_role/i));
  } finally { close(); }
});

test('SS-3 revoke-others keeps the current session, closes the others (other module, other merchant) and the revoked token loses access to pages and API', async () => {
  const { call, open, db, close } = await boot();
  try {
    const first = await open(U.alice, M1); const second = await open(U.alice, M1); const finance = await open(U.alice, M1, 'finance'); const shop2 = await open(U.alice, M2);
    const bob = await open(U.bob, M1);
    const list = await call('/api/security/sessions', { as: first }); assert.equal(list.status, 200); assert.equal(list.json.sessions.length, 4);
    assert.equal(list.json.sessions.filter((s) => s.current).length, 1); assert.equal(list.json.scopeOfOthers.count, 3); assert.equal(list.json.scopeOfOthers.otherMerchants, true);
    assert.ok(list.json.sessions.every((s) => s.device === null)); assert.equal(list.json.deviceInfo.available, false);
    assert.equal((await call('/api/security/sessions/revoke-others', { as: first, method: 'POST' })).json.revoked, 3);
    assert.equal((await call('/api/security', { as: first })).status, 200, 'the first session stays active');
    assert.equal((await call('/api/security', { as: second })).status, 401, 'the revoked session loses the API');
    assert.equal((await call('/api/security/sessions/revoke-others', { as: second, method: 'POST' })).status, 401, 'and cannot act');
    const live = db.t.app_sessions.filter((s) => !s.revoked_at).map((s) => s.token_hash);
    assert.ok(live.includes(hashSessionToken(first)) && live.includes(hashSessionToken(bob)) && !live.includes(hashSessionToken(finance)) && !live.includes(hashSessionToken(shop2)), 'other modules and merchants closed in the shared table');
    assert.equal((await call('/api/security', { as: bob })).status, 200, 'another account is untouched');
    assert.ok(db.t.app_sessions.filter((s) => s.revoked_reason === 'LOGOUT_OTHERS').length === 3);
    assert.ok(db.t.identity_events.some((e) => e.event_type === 'SESSION_REVOKED' && e.user_id === U.alice && e.detail.count === 3));
  } finally { close(); }
});

test('SS-4 an account sees and revokes only its own sessions; no id is read from the request; CSRF is required', async () => {
  const { call, open, db, close } = await boot();
  try {
    const a = await open(U.alice, M1); const b = await open(U.bob, M1);
    const la = await call('/api/security/sessions', { as: a }); assert.equal(la.json.sessions.length, 1);
    assert.ok(!JSON.stringify(la.json).includes(hashSessionToken(b)));
    const hack = await call(`/api/security/sessions/revoke-others?userId=${U.bob}`, { as: a, method: 'POST', body: { userId: U.bob } }); assert.equal(hack.status, 200); assert.equal(hack.json.revoked, 0);
    assert.equal(db.t.app_sessions.find((s) => s.token_hash === hashSessionToken(b)).revoked_at, null);
    assert.equal((await call('/api/security/sessions/revoke-others', { as: a, method: 'POST', csrf: false })).status, 403);
  } finally { close(); }
});

test('SS-5 revoke-current closes this session server-side and journals it', async () => {
  const { call, open, db, close } = await boot();
  try {
    const a = await open(U.alice, M1);
    assert.equal((await call('/api/security/sessions/revoke-current', { as: a, method: 'POST' })).json.revoked, true);
    assert.equal((await call('/api/security', { as: a })).status, 401);
    assert.ok(db.t.identity_events.some((e) => e.event_type === 'LOGOUT' && e.outcome === 'SUCCESS'));
  } finally { close(); }
});

test('SS-6 team rules: readable by a member, management refused to a viewer (403) and unavailable for an admin (409): no setting can change', async () => {
  const { call, open, close } = await boot();
  try {
    const v = await open(U.view, M1); const ad = await open(U.admin, M1);
    const g = await call('/api/security/team', { as: v }); assert.equal(g.status, 200); assert.equal(g.json.canManage, false); assert.ok(g.json.applied.every((r) => r.editable === false));
    assert.equal((await call('/api/security/team', { as: v, method: 'PUT', body: { requireMfa: true } })).status, 403);
    const p = await call('/api/security/team', { as: ad, method: 'PUT', body: { requireMfa: true } }); assert.equal(p.status, 409); assert.equal(p.json.error.code, 'FEATURE_UNAVAILABLE');
    assert.equal((await call('/api/security/team', { as: ad })).json.canManage, true);
  } finally { close(); }
});

test('SS-7 password change: wrong current refused, nothing changed; success changes it once, keeps this session, closes the others; weak or same refused; rate limited', async () => {
  const { call, open, calls, close } = await boot();
  try {
    const a = await open(U.alice, M1); const other = await open(U.alice, M1);
    const bad = await call('/api/security/password', { as: a, method: 'POST', body: { current: 'wrong-password', next: 'a-brand-new-password' } }); assert.equal(bad.status, 403); assert.equal(calls.setPassword.length, 0);
    assert.equal((await call('/api/security/password', { as: a, method: 'POST', body: { current: 'old-password-123', next: 'short' } })).status, 422);
    assert.equal((await call('/api/security/password', { as: a, method: 'POST', body: { current: 'old-password-123', next: 'old-password-123' } })).status, 422);
    const ok = await call('/api/security/password', { as: a, method: 'POST', body: { current: 'old-password-123', next: 'a-brand-new-password' } }); assert.equal(ok.status, 200); assert.equal(ok.json.otherSessionsClosed, 1); assert.equal(calls.setPassword.length, 1);
    assert.ok(!JSON.stringify(ok.json).includes('brand-new'));
    assert.equal((await call('/api/security', { as: a })).status, 200); assert.equal((await call('/api/security', { as: other })).status, 401);
    for (let i = 0; i < 5; i++) await call('/api/security/password', { as: a, method: 'POST', body: { current: 'wrong-password', next: 'a-brand-new-password' } });
    assert.equal((await call('/api/security/password', { as: a, method: 'POST', body: { current: 'old-password-123', next: 'another-password-1' } })).status, 429);
  } finally { close(); }
});

test('SS-8 provider refusal leaves the password and sessions untouched; activity shows own events only, never a password, token or e-mail', async () => {
  const { call, open, db, close } = await boot({ providerAccepts: false });
  try {
    const a = await open(U.alice, M1); const other = await open(U.alice, M1);
    const r = await call('/api/security/password', { as: a, method: 'POST', body: { current: 'old-password-123', next: 'a-brand-new-password' } }); assert.equal(r.status, 422);
    assert.equal((await call('/api/security', { as: other })).status, 200, 'no session closed when the change failed');
    await db.insert('identity_events', [{ occurred_at: '2026-11-17T09:00:00Z', merchant_id: M1, user_id: U.bob, module: 'sourcing', event_type: 'SESSION_OPENED', outcome: 'SUCCESS', detail: {} }, { occurred_at: '2026-11-17T09:01:00Z', merchant_id: M1, user_id: U.alice, module: 'sourcing', event_type: 'MEMBER_ADDED', outcome: 'SUCCESS', detail: {} }, { occurred_at: '2026-11-17T09:02:00Z', merchant_id: M1, user_id: U.alice, module: 'sourcing', event_type: 'SESSION_OPENED', outcome: 'SUCCESS', detail: { role: 'OWNER', secret: 'x' } }]);
    const act = await call('/api/security/activity', { as: a }); assert.equal(act.status, 200);
    assert.ok(act.json.events.every((e) => ['SESSION_OPENED', 'PASSWORD_CHANGE_FAILED'].includes(e.type)), 'team events and other accounts excluded');
    assert.ok(!JSON.stringify(act.json).match(/secret|OWNER|brand-new|old-password/));
  } finally { close(); }
});
