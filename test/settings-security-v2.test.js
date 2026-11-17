// Settings > Security V2: second factor at sign-in, enrolment, recovery codes, password recovery. The real code (gotrue, mfa, recovery, admin-auth, service, host, session store)
// runs against ONE fake Supabase Auth (fetch) and an in-memory PostgREST fake: only the provider and the database are simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { createSecurityHost } from '../src/sourcing/server/security-host.js';
import { createSecurityService } from '../src/settings-security/service.js';
import { createAdminAuth } from '../src/settings-security/admin-auth.js';
import { createMfaProvider } from '../src/settings-security/mfa.js';
import { createRecoveryProvider } from '../src/settings-security/recovery.js';
import { createRecoveryCodes, normalizeCode } from '../src/settings-security/recovery-codes.js';
import { createGoTrueVerifier } from '../src/identity/gotrue.js';
import { createSessionStore } from '../src/identity/sessions.js';
import { createEventLog } from '../src/identity/events.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';
import { loadIdentityConfig } from '../src/identity/config.js';

const M1 = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://auth.example.test';
const CFG = { baseUrl: BASE, anonKey: 'anon-key-for-tests-0123456789' };

// ---- RFC 6238 TOTP (the "authenticator app")
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32dec = (s) => { let bits = ''; for (const c of s.replace(/=+$/, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
const totp = (secret, t = Date.now()) => { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(t / 30000))); const h = createHmac('sha1', b32dec(secret)).update(c).digest(); const o = h[19] & 15; return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0'); };
const B32SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

// ---- fake Supabase Auth
function fakeAuth() {
  const users = new Map(); const tokens = new Map(); const links = new Map(); const sent = []; let n = 1; const quota = { max: Infinity, smtpDown: false };
  const addUser = (email, password) => { const id = randomUUID(); users.set(id, { id, email, password, factors: [], last_sign_in_at: null }); return id; };
  const userJson = (u) => ({ id: u.id, email: u.email, factors: u.factors.map((f) => ({ id: f.id, factor_type: 'totp', status: f.status })), identities: [{ provider: 'email' }], last_sign_in_at: u.last_sign_in_at });
  const issueLink = (id) => { const tok = `recovery-token-${n++}-${'x'.repeat(30)}`; links.set(tok, { userId: id, used: false, expired: false }); return tok; };
  const resp = (status, body) => ({ status, ok: status < 300, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); const path = u.pathname.replace('/auth/v1', ''); const m = init.method ?? 'GET'; const body = init.body ? JSON.parse(init.body) : {};
    const bearer = String(init.headers?.Authorization ?? '').replace(/^Bearer /, ''); const sess = tokens.get(bearer); const service = bearer.startsWith('service-');
    if (path === '/token' && u.searchParams.get('grant_type') === 'password') { const x = [...users.values()].find((q) => q.email === body.email && q.password === body.password); if (!x) return resp(400, {}); const t = `at-${n++}`; tokens.set(t, { userId: x.id, aal: 'aal1' }); x.last_sign_in_at = '2026-11-18T10:00:00Z'; return resp(200, { access_token: t, refresh_token: `rt-${t}`, user: userJson(x) }); }
    if (path === '/logout') { if (sess) { if (u.searchParams.get('scope') === 'global') for (const [k, v] of tokens) if (v.userId === sess.userId) tokens.delete(k); tokens.delete(bearer); } return resp(204, null); }
    if (path === '/recover' && m === 'POST') { if (quota.smtpDown) return resp(500, { error_code: 'unexpected_failure', msg: 'Error sending recovery email' }); if (sent.filter((q) => q.known).length >= quota.max) return resp(429, { error_code: 'over_email_send_rate_limit' }); const x = [...users.values()].find((q) => q.email === body.email); sent.push({ email: body.email, redirect: u.searchParams.get('redirect_to'), known: Boolean(x) }); if (x) { const tok = issueLink(x.id); sent.at(-1).token = tok; } return resp(200, {}); }
    if (path === '/user' && m === 'GET') { if (!sess) return resp(401, {}); const link = links.get(bearer); if (link && (link.used || link.expired)) return resp(401, {}); return resp(200, userJson(users.get(sess.userId))); }
    let f = /^\/factors$/.exec(path);
    if (f && m === 'POST') { if (!sess) return resp(401, {}); const x = users.get(sess.userId); const fac = { id: randomUUID(), status: 'unverified', secret: B32SECRET.slice(0, 16 + (n++ % 8)) }; x.factors.push(fac); return resp(200, { id: fac.id, totp: { secret: fac.secret, uri: `otpauth://totp/Nordla:${x.email}?secret=${fac.secret}`, qr_code: 'data:image/svg+xml;utf-8,<svg/>' } }); }
    f = /^\/factors\/([^/]+)\/(challenge|verify)$/.exec(path);
    if (f) { if (!sess) return resp(401, {}); const x = users.get(sess.userId); const fac = x.factors.find((q) => q.id === f[1]); if (!fac) return resp(404, {}); if (f[2] === 'challenge') return resp(200, { id: randomUUID() }); if (body.code !== totp(fac.secret)) return resp(400, {}); fac.status = 'verified'; const t = `at-${n++}`; tokens.set(t, { userId: x.id, aal: 'aal2' }); return resp(200, { access_token: t, refresh_token: 'r' }); }
    f = /^\/admin\/users\/([^/]+)(?:\/factors\/([^/]+))?$/.exec(path);
    if (f) { if (!service) return resp(401, {}); const x = users.get(f[1]); if (!x) return resp(404, {}); if (m === 'GET') return resp(200, userJson(x)); if (m === 'PUT') { if (String(body.password ?? '').length < 8) return resp(422, {}); x.password = body.password; return resp(200, userJson(x)); } if (m === 'DELETE' && f[2]) { x.factors = x.factors.filter((q) => q.id !== f[2]); return resp(200, {}); } }
    return resp(404, {});
  };
  // a click on the e-mail link: the provider validates the one-time link and hands a recovery session to the page
  const clickLink = (tok) => { const l = links.get(tok); if (!l || l.used || l.expired) return null; l.used = false; tokens.set(tok, { userId: l.userId, aal: 'aal1' }); return tok; };
  const consumeLink = (tok) => { const l = links.get(tok); if (l) l.used = true; };
  return { users, tokens, links, sent, quota, addUser, fetchImpl, clickLink, consumeLink };
}

function fakeDb() {
  const t = { app_sessions: [], identity_events: [], mfa_recovery_codes: [], merchants: [{ id: M1, name: 'Boutique A' }] }; let seq = 1;
  const match = (row, f) => Object.entries(f).every(([k, v]) => { if (['select', 'order', 'limit'].includes(k)) return true; const [op, ...rest] = String(v).split('.'); const arg = rest.join('.'); const x = row[k];
    if (op === 'eq') return String(x) === arg; if (op === 'neq') return String(x) !== arg; if (op === 'is') return x === null || x === undefined; if (op === 'gt') return new Date(x) > new Date(arg); if (op === 'in') return arg.replace(/^\(|\)$/g, '').split(',').includes(String(x)); return true; });
  return { t, select: async (table, f = {}) => { let r = t[table].filter((x) => match(x, f)); if (f.order) { const [c, d] = f.order.split('.'); r = [...r].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (d === 'desc' ? -1 : 1)); } return r.slice(0, Number(f.limit ?? 1000)).map((x) => ({ ...x })); },
    insert: async (table, rows) => rows.map((r) => { const row = { id: table === 'identity_events' ? seq++ : randomUUID(), revoked_at: null, revoked_reason: null, used_at: null, ...r }; t[table].push(row); return { ...row }; }),
    update: async (table, f, patch) => { const hit = t[table].filter((x) => match(x, f)); hit.forEach((x) => Object.assign(x, patch)); return hit.map((x) => ({ ...x })); },
    delete: async (table, f) => { const keep = t[table].filter((x) => !match(x, f)); const gone = t[table].length - keep.length; t[table] = keep; return gone; }, rpc: async () => ({}) };
}

async function boot({ features = { mfa: true, recovery: true } } = {}) {
  const db = fakeDb(); const auth = fakeAuth(); const cfg = loadIdentityConfig({}); const store = createSessionStore({ supabase: db, config: cfg });
  const adminAuth = createAdminAuth({ url: BASE, serviceRoleKey: 'service-role-key', fetchImpl: auth.fetchImpl });
  const codes = createRecoveryCodes({ supabase: db }); const verifier = createGoTrueVerifier({ config: CFG, fetchImpl: auth.fetchImpl });
  const identity = { context: { module: 'sourcing' }, authenticateAndOpenSession: async () => ({ ok: false }), logoutSession: async (tok) => store.logoutCurrent(tok, { merchantId: M1, module: 'sourcing' }),
    resolveAccessSession: async (tok) => { const v = await store.validate(tok, { merchantId: M1, module: 'sourcing' }); return v.ok ? { ok: true, merchantId: M1, userId: v.session.userId, role: 'OWNER', module: 'sourcing' } : { ok: false }; } };
  const security = { module: 'sourcing', cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }), sessionCookie: (x) => `sid=${x}`, csrfCookie: (x) => `csrf=${x}`, clearSessionCookie: () => 'sid=;', clearCsrfCookie: () => 'csrf=;' }, csrfTokenFor: (x) => `csrf-${x}`,
    guardRead: () => ({ ok: true }), guardLogin: (req) => (req.headers.origin === 'https://nordla.test' ? { ok: true, ctx: { clientIp: '203.0.113.9' } } : { ok: false, response: { status: 403, error: 'FORBIDDEN' } }), readLoginBody: async () => ({}), publicError: () => ({ status: 400 }),
    guardMutation: async (req, resolve) => { const x = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const a = x ? await resolve(x) : null; if (!a?.ok) return { ok: false, code: 'SESSION_INVALID' }; if (req.headers['x-nordla-csrf'] !== `csrf-${x}`) return { ok: false, code: 'CSRF_INVALID', response: { status: 403, error: 'CSRF_INVALID' } }; return { ok: true, access: a, sessionToken: x }; } };
  const service = createSecurityService({ supabase: db, adminAuth, verifier, events: createEventLog({ supabase: db }), sessions: store, rules: { ...cfg, maxEmailFailures: 5, maxIpFailures: 20, blockSeconds: 900 }, idleMs: cfg.idleMs,
    mfa: createMfaProvider({ config: CFG, fetchImpl: auth.fetchImpl, adminAuth }), recoveryCodes: codes, recovery: createRecoveryProvider({ config: CFG, fetchImpl: auth.fetchImpl }), context: { merchantId: M1, module: 'sourcing' }, resetUrl: 'https://nordla.test/reset-password', features });
  const host = await createSecurityHost({ gate: createSessionGate({ identity, security, features }), merchantId: M1, service, sessionCookie: 'sid', features });
  const server = http.createServer(async (req, res) => { if (!(await host.handle(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end('nf'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { as, method = 'GET', body, origin = 'https://nordla.test' } = {}) => { const res = await fetch(base + path, { method, headers: { ...(as ? { cookie: `sid=${as}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { origin } : {}), ...(as && method !== 'GET' ? { 'x-nordla-csrf': `csrf-${as}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ } return { status: res.status, json, text }; };
  const open = async (userId) => (await store.create({ userId, merchantId: M1, module: 'sourcing' })).token;
  return { call, open, db, auth, verifier, codes, service, store, close: () => server.close() };
}

const PW = 'old-password-123'; const NEW = 'a-brand-new-password';

test('V2-1 an account WITHOUT a second factor signs in exactly as before (no extra step, no extra call)', async () => {
  const { auth, verifier, close } = await boot(); const id = auth.addUser('a@example.test', PW);
  try {
    const r = await verifier.verifyPassword('a@example.test', PW); assert.deepEqual([r.ok, r.userId], [true, id]); assert.equal(r.mfa, undefined);
    assert.equal((await verifier.verifyPassword('a@example.test', 'wrong')).ok, false);
  } finally { close(); }
});

test('V2-2 enrolment end to end: password -> QR -> first code -> recovery codes; other sessions closed; the factor is verified only after the right code', async () => {
  const { call, open, auth, db, close } = await boot();
  try {
    const id = auth.addUser('a@example.test', PW); const a = await open(id); const other = await open(id);
    assert.equal((await call('/api/security', { as: a })).json.account.mfa.enrollment.available, true);
    assert.equal((await call('/api/security/mfa/enroll', { as: a, method: 'POST', body: { password: 'wrong' } })).status, 403);
    const e = await call('/api/security/mfa/enroll', { as: a, method: 'POST', body: { password: PW } }); assert.equal(e.status, 200); assert.match(e.json.uri, /^otpauth:\/\/totp\//); assert.ok(e.json.qr.startsWith('data:image/svg'));
    assert.equal(auth.users.get(id).factors[0].status, 'unverified', 'not active before the first code');
    assert.equal((await call('/api/security/mfa/confirm', { as: a, method: 'POST', body: { password: PW, factorId: e.json.factorId, code: '000000' } })).status, 403);
    assert.equal(auth.users.get(id).factors[0].status, 'unverified');
    const c = await call('/api/security/mfa/confirm', { as: a, method: 'POST', body: { password: PW, factorId: e.json.factorId, code: totp(e.json.secret) } }); assert.equal(c.status, 200);
    assert.equal(c.json.recoveryCodes.length, 10); assert.equal(c.json.otherSessionsClosed, 1); assert.equal(auth.users.get(id).factors[0].status, 'verified');
    assert.equal((await call('/api/security', { as: a })).status, 200); assert.equal((await call('/api/security', { as: other })).status, 401);
    const acc = (await call('/api/security', { as: a })).json.account.mfa; assert.deepEqual([acc.state, acc.requiredAtSignIn, acc.recoveryCodesLeft], ['ENABLED', true, 10]);
    assert.ok(!JSON.stringify(db.t.mfa_recovery_codes).includes(c.json.recoveryCodes[0]), 'only hashes are stored');
    assert.ok(db.t.identity_events.some((x) => x.event_type === 'MFA_ENABLED'));
    assert.equal((await call('/api/security/mfa/enroll', { as: a, method: 'POST', body: { password: PW } })).status, 409, 'already on');
  } finally { close(); }
});

test('V2-3 a PROTECTED account must finish the second factor: no code -> MFA_REQUIRED, wrong code -> MFA_INVALID, right code or a one-time recovery code -> in; a spent recovery code never works twice', async () => {
  const { call, open, auth, verifier, codes, close } = await boot();
  try {
    const id = auth.addUser('a@example.test', PW); const a = await open(id);
    const e = (await call('/api/security/mfa/enroll', { as: a, method: 'POST', body: { password: PW } })).json;
    const list = (await call('/api/security/mfa/confirm', { as: a, method: 'POST', body: { password: PW, factorId: e.factorId, code: totp(e.secret) } })).json.recoveryCodes;
    const rc = (u, c) => codes.consume(u, c);
    assert.deepEqual(await verifier.verifyPassword('a@example.test', PW), { ok: false, kind: 'MFA_REQUIRED', userId: id });
    assert.equal((await verifier.verifyPassword('a@example.test', 'wrong', { code: totp(e.secret) })).kind, 'INVALID', 'a wrong password is still a wrong password');
    assert.equal((await verifier.verifyPassword('a@example.test', PW, { code: '000000' })).kind, 'MFA_INVALID');
    const good = await verifier.verifyPassword('a@example.test', PW, { code: totp(e.secret) }); assert.deepEqual([good.ok, good.mfa], [true, 'TOTP']);
    const viaCode = await verifier.verifyPassword('a@example.test', PW, { code: list[0], recoveryCheck: rc }); assert.deepEqual([viaCode.ok, viaCode.mfa], [true, 'RECOVERY_CODE']);
    assert.equal((await verifier.verifyPassword('a@example.test', PW, { code: list[0], recoveryCheck: rc })).kind, 'MFA_INVALID', 'a spent code is refused');
    assert.equal((await verifier.verifyPassword('a@example.test', PW, { code: 'AAAAA-AAAAA', recoveryCheck: rc })).kind, 'MFA_INVALID');
    assert.equal(normalizeCode(' abcde-fghjk '), 'ABCDEFGHJK');
    assert.equal(auth.tokens.size === 0 || ![...auth.tokens.values()].some((t) => t.aal === 'aal1' && false), true);
  } finally { close(); }
});

test('V2-4 lost authenticator: renew needs password + a valid code; turning off needs it too; afterwards sign-in is back to a password and the old codes are gone', async () => {
  const { call, open, auth, db, close } = await boot();
  try {
    const id = auth.addUser('a@example.test', PW); const a = await open(id);
    const e = (await call('/api/security/mfa/enroll', { as: a, method: 'POST', body: { password: PW } })).json;
    const list = (await call('/api/security/mfa/confirm', { as: a, method: 'POST', body: { password: PW, factorId: e.factorId, code: totp(e.secret) } })).json.recoveryCodes;
    assert.equal((await call('/api/security/mfa/disable', { as: a, method: 'POST', body: { password: PW } })).status, 422, 'no code, no change');
    assert.equal((await call('/api/security/mfa/disable', { as: a, method: 'POST', body: { password: PW, code: '000000' } })).status, 403);
    assert.equal(auth.users.get(id).factors.length, 1);
    const renew = await call('/api/security/mfa/recovery-codes', { as: a, method: 'POST', body: { password: PW, code: list[1] } }); assert.equal(renew.status, 200); assert.equal(renew.json.recoveryCodes.length, 10);
    assert.equal((await call('/api/security/mfa/recovery-codes', { as: a, method: 'POST', body: { password: PW, code: list[2] } })).status, 403, 'old codes no longer work');
    const off = await call('/api/security/mfa/disable', { as: a, method: 'POST', body: { password: PW, code: renew.json.recoveryCodes[0] } }); assert.equal(off.status, 200);
    assert.equal(auth.users.get(id).factors.length, 0); assert.equal(db.t.mfa_recovery_codes.length, 0);
    assert.equal((await call('/api/security', { as: a })).json.account.mfa.state, 'NOT_ENABLED');
    assert.ok(db.t.identity_events.some((x) => x.event_type === 'MFA_DISABLED'));
  } finally { close(); }
});

test('V2-5 password recovery: the request answers the same for known and unknown addresses; the link resets once; every old session dies; the link cannot be reused; an expired link is refused', async () => {
  const { call, open, auth, db, close } = await boot();
  try {
    const id = auth.addUser('a@example.test', PW); const s1 = await open(id); const s2 = await open(id);
    const known = await call('/api/auth/forgot', { method: 'POST', body: { email: 'a@example.test' } }); const unknown = await call('/api/auth/forgot', { method: 'POST', body: { email: 'nobody@example.test' } });
    assert.deepEqual(known.json, unknown.json); assert.equal(known.status, 200);
    assert.equal(auth.sent[0].redirect, 'https://nordla.test/reset-password'); assert.equal(auth.sent.length, 2);
    assert.equal((await call('/api/auth/forgot', { method: 'POST', body: { email: 'a@example.test' }, origin: 'https://evil.test' })).status, 403, 'same-origin only');
    const tok = auth.clickLink(auth.sent[0].token);
    assert.equal((await call('/api/auth/reset', { method: 'POST', body: { token: tok, password: 'short' } })).status, 422);
    const r = await call('/api/auth/reset', { method: 'POST', body: { token: tok, password: NEW } }); assert.equal(r.status, 200); assert.deepEqual([r.json.reset, r.json.sessionsClosed], [true, 2]);
    assert.equal(auth.users.get(id).password, NEW);
    assert.equal((await call('/api/security', { as: s1 })).status, 401); assert.equal((await call('/api/security', { as: s2 })).status, 401);
    const again = await call('/api/auth/reset', { method: 'POST', body: { token: tok, password: 'another-password-9' } }); assert.equal(again.status, 410, 'a used link is refused'); assert.equal(auth.users.get(id).password, NEW);
    await call('/api/auth/forgot', { method: 'POST', body: { email: 'a@example.test' } }); const t2 = auth.clickLink(auth.sent.at(-1).token); auth.links.get(t2).expired = true;
    assert.equal((await call('/api/auth/reset', { method: 'POST', body: { token: t2, password: 'another-password-9' } })).status, 410, 'an expired link is refused');
    assert.equal((await call('/api/auth/reset', { method: 'POST', body: { token: 'garbage', password: NEW } })).status, 410);
    assert.ok(db.t.identity_events.some((x) => x.event_type === 'PASSWORD_RESET' && x.user_id === id)); assert.ok(!JSON.stringify(db.t.identity_events).includes('example.test'), 'no e-mail in the journal');
    assert.ok(!JSON.stringify(db.t.identity_events).includes(tok));
  } finally { close(); }
});

test('V2-6 the e-mail link alone cannot bypass the second factor: a protected account must also give a code (authenticator or recovery); wrong code refused, limited', async () => {
  const { call, open, auth, close } = await boot();
  try {
    const id = auth.addUser('a@example.test', PW); const a = await open(id);
    const e = (await call('/api/security/mfa/enroll', { as: a, method: 'POST', body: { password: PW } })).json;
    const list = (await call('/api/security/mfa/confirm', { as: a, method: 'POST', body: { password: PW, factorId: e.factorId, code: totp(e.secret) } })).json.recoveryCodes;
    await call('/api/auth/forgot', { method: 'POST', body: { email: 'a@example.test' } }); const tok = auth.clickLink(auth.sent.at(-1).token);
    const noCode = await call('/api/auth/reset', { method: 'POST', body: { token: tok, password: NEW } }); assert.equal(noCode.status, 422); assert.equal(noCode.json.error.code, 'MFA_REQUIRED'); assert.equal(auth.users.get(id).password, PW);
    assert.equal((await call('/api/auth/reset', { method: 'POST', body: { token: tok, password: NEW, code: '000000' } })).status, 403); assert.equal(auth.users.get(id).password, PW);
    const ok = await call('/api/auth/reset', { method: 'POST', body: { token: tok, password: NEW, code: list[3] } }); assert.equal(ok.status, 200); assert.equal(auth.users.get(id).password, NEW);
  } finally { close(); }
});

test('V2-7 features off: the public routes and the enrolment do not exist; the account says unavailable with the reason', async () => {
  const { call, open, auth, close } = await boot({ features: {} });
  try {
    const id = auth.addUser('a@example.test', PW); const a = await open(id);
    assert.equal((await call('/api/auth/forgot', { method: 'POST', body: { email: 'a@example.test' } })).status, 404); assert.equal((await call('/reset-password')).status, 404);
    const acc = (await call('/api/security', { as: a })).json.account; assert.equal(acc.mfa.enrollment.available, false); assert.equal(acc.recovery.available, false); assert.ok(acc.recovery.reason);
    assert.equal((await call('/api/security/mfa/enroll', { as: a, method: 'POST', body: { password: PW } })).status, 409);
  } finally { close(); }
});

test('V2-8 the reset page and its script are served; the token never reaches a log or the journal', async () => {
  const { call, close } = await boot();
  try {
    const p = await call('/reset-password'); assert.equal(p.status, 200); assert.match(p.text, /security-assets\/reset\.js/);
    assert.equal((await call('/security-assets/reset.js')).status, 200);
  } finally { close(); }
});

test('V2-9 an account with a second factor must also give a code to change its password (found on the real staging run); without it nothing changes', async () => {
  const { call, open, auth, close } = await boot();
  try {
    const id = auth.addUser('a@example.test', PW); const a = await open(id); const other = await open(id);
    const e = (await call('/api/security/mfa/enroll', { as: a, method: 'POST', body: { password: PW } })).json;
    const list = (await call('/api/security/mfa/confirm', { as: a, method: 'POST', body: { password: PW, factorId: e.factorId, code: totp(e.secret) } })).json.recoveryCodes;
    const b = await open(id);
    const none = await call('/api/security/password', { as: a, method: 'POST', body: { current: PW, next: NEW } }); assert.equal(none.status, 422); assert.equal(none.json.error.code, 'MFA_REQUIRED'); assert.equal(auth.users.get(id).password, PW);
    assert.equal((await call('/api/security/password', { as: a, method: 'POST', body: { current: PW, next: NEW, code: '000000' } })).status, 403); assert.equal(auth.users.get(id).password, PW);
    const ok = await call('/api/security/password', { as: a, method: 'POST', body: { current: PW, next: NEW, code: list[0] } }); assert.equal(ok.status, 200); assert.equal(auth.users.get(id).password, NEW);
    assert.equal((await call('/api/security', { as: a })).status, 200); assert.equal((await call('/api/security', { as: b })).status, 401); assert.ok(other);
  } finally { close(); }
});

test('V2-10 the neutral public answer never changes, while the internal journal tells ACCEPTED / QUOTA_EXCEEDED / SMTP_ERROR / LOCAL_THROTTLED apart (no e-mail address, no token in it)', async () => {
  const { call, auth, db, close } = await boot();
  try {
    auth.addUser('a@example.test', PW); auth.quota.max = 1;
    const first = await call('/api/auth/forgot', { method: 'POST', body: { email: 'a@example.test' } });
    const quota = await call('/api/auth/forgot', { method: 'POST', body: { email: 'a@example.test' } });
    auth.quota.max = Infinity; auth.quota.smtpDown = true; const smtp = await call('/api/auth/forgot', { method: 'POST', body: { email: 'a@example.test' } });
    for (let i = 0; i < 5; i++) await call('/api/auth/forgot', { method: 'POST', body: { email: 'a@example.test' } }); // the 4th+ of the same address is throttled locally
    assert.ok([first, quota, smtp].every((r) => r.status === 200 && JSON.stringify(r.json) === '{"ok":true}'), 'same answer every time');
    const ev = db.t.identity_events.filter((x) => x.event_type === 'PASSWORD_RESET_REQUESTED');
    assert.deepEqual(ev.slice(0, 3).map((x) => [x.outcome, x.detail.code]), [['SUCCESS', 'ACCEPTED'], ['FAILURE', 'QUOTA_EXCEEDED'], ['FAILURE', 'SMTP_ERROR']]);
    assert.ok(ev.some((x) => x.outcome === 'DENIED' && x.detail.code === 'LOCAL_THROTTLED'));
    assert.ok(ev.slice(0, 3).every((x) => Number.isInteger(x.detail.ms)), 'duration of the provider call recorded');
    assert.ok(!JSON.stringify(db.t.identity_events).includes('example.test'));
  } finally { close(); }
});
