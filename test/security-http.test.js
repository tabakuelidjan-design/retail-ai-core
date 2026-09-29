// Core C4 - common HTTP security primitives (src/security/*). No server is started, no route exists, no real cookie is sent:
// requests are plain objects (method, headers, socket, body stream). Synthetic hosts, documentation IP ranges (RFC 5737 / 3849),
// secrets generated at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createHttpSecurity, HttpSecurityConfigError } from '../src/security/index.js';
import { constantTimeEqual } from '../src/security/csrf.js';
import { redact, requestLogEntry, publicError, REDACTED } from '../src/security/redact.js';
import { securityHeaders } from '../src/security/headers.js';
import { createLoginTiming } from '../src/security/timing.js';
import { createIdentityDb } from './fixtures/identity-db.js';
import { createFakeGoTrue } from './fixtures/fake-gotrue.js';
import { createIdentityService } from '../src/identity/service.js';
import { createMemberService } from '../src/identity/members.js';
import { createModuleProvisioning } from '../src/identity/provisioning.js';
import { loadIdentityConfig, loadRateLimitConfig } from '../src/identity/config.js';

const HOST = 'growth.nordla-test.example';
const ORIGIN = `https://${HOST}`;
const CSRF_KEY = randomBytes(32);
const hosted = (extra = {}) => createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: [HOST], allowedOrigins: [ORIGIN], moduleCode: 'growth', csrfKey: CSRF_KEY, ...extra });
const local = (extra = {}) => createHttpSecurity({ environment: 'local', proxy: 'none', allowedHosts: ['localhost:4433'], allowedOrigins: ['http://localhost:4433'], moduleCode: 'growth', ...extra });
/** A request as seen behind Railway (proxy headers set by the edge) unless overridden. */
const rreq = (method = 'GET', headers = {}) => ({ method, headers: { 'x-real-ip': '203.0.113.20', 'x-forwarded-proto': 'https', 'x-forwarded-host': HOST, ...headers }, socket: { remoteAddress: '100.64.0.7' } });
const lreq = (method = 'GET', headers = {}, ip = '127.0.0.1') => ({ method, headers: { host: 'localhost:4433', ...headers }, socket: { remoteAddress: ip } });
const token = () => randomBytes(32).toString('base64url');

// ---------- configuration ----------
test('config: valid local and hosted configurations are frozen; defaults 900 ms / 100 ms / 16 KiB / 12 h', () => {
  const h = hosted(); const l = local();
  for (const s of [h, l]) { assert.ok(Object.isFrozen(s)); assert.ok(Object.isFrozen(s.allowedHosts)); }
  assert.deepEqual({ ...h.loginTiming }, { minMs: 900, jitterMs: 100 });
  assert.equal(h.hosted, true); assert.equal(l.hosted, false);
  assert.throws(() => { h.module = 'finance'; }, TypeError);
});

test('config: unknown key, wildcard, http hosted, localhost hosted, public host local, wrong proxy mode, unknown module refused', () => {
  const cases = [
    [() => hosted({ debug: true }), 'debug'],
    [() => hosted({ allowedHosts: ['*.nordla-test.example'], allowedOrigins: [ORIGIN] }), 'allowedHosts'],
    [() => hosted({ allowedOrigins: ['https://*.nordla-test.example'] }), 'allowedOrigins'],
    [() => hosted({ allowedOrigins: [`http://${HOST}`] }), 'allowedOrigins'],
    [() => hosted({ allowedHosts: ['localhost:4433'], allowedOrigins: ['https://localhost:4433'] }), 'allowedHosts'],
    [() => hosted({ allowedHosts: [HOST, '127.0.0.1'] }), 'allowedHosts'],
    [() => local({ allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`] }), 'allowedHosts'],
    [() => createHttpSecurity({ environment: 'hosted', proxy: 'none', allowedHosts: [HOST], allowedOrigins: [ORIGIN], moduleCode: 'growth', csrfKey: CSRF_KEY }), 'proxy'],
    [() => local({ proxy: 'railway' }), 'proxy'],
    [() => hosted({ moduleCode: 'core' }), 'moduleCode'],
    [() => hosted({ allowedHosts: ['Growth.Nordla-Test.Example'] }), 'allowedHosts'],
    [() => hosted({ allowedOrigins: [`${ORIGIN}/`] }), 'allowedOrigins'],
    [() => hosted({ allowedOrigins: ['https://other.nordla-test.example'] }), 'allowedOrigins'],
    [() => hosted({ environment: 'production' }), 'environment'],
    [() => hosted({ sessionMaxAgeSeconds: 13 * 3600 }), 'sessionMaxAgeSeconds'],
    [() => hosted({ loginTiming: { minMs: 50 } }), 'loginTiming.minMs'],
    [() => hosted({ loginTiming: { jitterMs: 5000 } }), 'loginTiming.jitterMs'],
    [() => hosted({ bodyLimitBytes: 10 * 1024 * 1024 }), 'bodyLimitBytes'],
  ];
  for (const [f, field] of cases) assert.throws(f, (e) => e instanceof HttpSecurityConfigError && e.field === field, field);
});

test('config: NORDLA_CSRF_KEY required hosted, >= 32 bytes, not repetitive, different from the rate-limit key; never echoed', () => {
  const weak = 'ab'.repeat(20);
  for (const [extra, field] of [[{ csrfKey: undefined }, 'csrfKey'], [{ csrfKey: 'short' }, 'NORDLA_CSRF_KEY'], [{ csrfKey: weak }, 'NORDLA_CSRF_KEY'], [{ rateLimitKey: CSRF_KEY }, 'csrfKey']]) {
    assert.throws(() => hosted(extra), (e) => e instanceof HttpSecurityConfigError && e.field === field && !e.message.includes(weak) && !e.message.includes(CSRF_KEY.toString('hex')), JSON.stringify(field));
  }
  assert.doesNotThrow(() => hosted({ rateLimitKey: randomBytes(32) }));
  assert.doesNotThrow(() => local(), 'local without a key: a random per-process key');
});

// ---------- request context ----------
test('local: IP from the socket, every proxy header ignored, new request id, only declared loopback hosts', () => {
  const s = local();
  const ctx = s.context(lreq('GET', { 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', 'x-request-id': 'attacker-chosen' }));
  assert.equal(ctx.clientIp, '127.0.0.1'); assert.equal(ctx.host, 'localhost:4433'); assert.equal(ctx.protocol, 'http');
  assert.match(ctx.requestId, /^[0-9a-f-]{36}$/); assert.notEqual(ctx.requestId, 'attacker-chosen');
  assert.throws(() => s.context(lreq('GET', { host: 'localhost:9999' })), (e) => e.code === 'HOST_NOT_ALLOWED');
  assert.throws(() => s.context(lreq('GET', { host: 'evil.example' })), (e) => e.code === 'HOST_NOT_ALLOWED');
});

test('railway: IP = X-Real-IP; a forged X-Forwarded-For is never used; https and the original host required', () => {
  const s = hosted();
  const ctx = s.context(rreq('GET', { 'x-forwarded-for': '198.51.100.66, 203.0.113.20' }));
  assert.equal(ctx.clientIp, '203.0.113.20'); assert.equal(ctx.protocol, 'https'); assert.equal(ctx.host, HOST);
  assert.equal(s.context(rreq('GET', { 'x-forwarded-for': '198.51.100.66' })).clientIp, '203.0.113.20', 'XFF alone changes nothing');
  assert.equal(s.context(rreq('GET', { 'x-real-ip': '2001:db8::5' })).clientIp, '2001:db8::5');
  const refused = [
    [{ 'x-real-ip': undefined }, 'PROXY_CLIENT_IP_INVALID'],
    [{ 'x-real-ip': '203.0.113.20, 198.51.100.66' }, 'PROXY_HEADER_AMBIGUOUS_X_REAL_IP'],
    [{ 'x-real-ip': ['203.0.113.20', '198.51.100.66'] }, 'PROXY_HEADER_AMBIGUOUS_X_REAL_IP'],
    [{ 'x-real-ip': 'not-an-ip' }, 'PROXY_CLIENT_IP_INVALID'],
    [{ 'x-forwarded-proto': 'http' }, 'PROXY_PROTOCOL_NOT_HTTPS'],
    [{ 'x-forwarded-proto': undefined }, 'PROXY_PROTOCOL_NOT_HTTPS'],
    [{ 'x-forwarded-proto': 'https, http' }, 'PROXY_HEADER_AMBIGUOUS_X_FORWARDED_PROTO'],
    [{ 'x-forwarded-host': 'evil.example' }, 'HOST_NOT_ALLOWED'],
    [{ 'x-forwarded-host': `${HOST}:8443` }, 'HOST_NOT_ALLOWED'],
    [{ 'x-forwarded-host': undefined }, 'PROXY_HOST_INVALID'],
    [{ 'x-forwarded-host': `${HOST}, evil.example` }, 'PROXY_HEADER_AMBIGUOUS_X_FORWARDED_HOST'],
  ];
  for (const [h, code] of refused) {
    const req = rreq('GET', h); for (const k of Object.keys(h)) if (h[k] === undefined) delete req.headers[k];
    assert.throws(() => s.context(req), (e) => e.code === code, JSON.stringify(h));
  }
  // the Host header is not what Railway mode trusts
  assert.equal(s.context(rreq('GET', { host: 'evil.example' })).host, HOST);
});

// ---------- origins ----------
test('origins: exact same-origin for mutations and login; missing Origin refused; GET readable without Origin; no CORS', async () => {
  const s = hosted();
  assert.equal(s.guardLogin(rreq('POST', { origin: ORIGIN })).ok, true);
  const refused = [
    [{}, 'ORIGIN_MISSING'], [{ origin: 'https://evil.example' }, 'ORIGIN_NOT_ALLOWED'], [{ origin: `${ORIGIN}:8443` }, 'ORIGIN_NOT_ALLOWED'],
    [{ origin: `http://${HOST}` }, 'ORIGIN_NOT_ALLOWED'], [{ origin: 'null' }, 'ORIGIN_NOT_ALLOWED'], [{ origin: `${ORIGIN}/login` }, 'ORIGIN_NOT_ALLOWED'],
    [{ origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, 'FETCH_SITE_NOT_SAME_ORIGIN'],
  ];
  for (const [h, code] of refused) {
    const r = s.guardLogin(rreq('POST', h));
    assert.equal(r.ok, false); assert.equal(r.code, code, JSON.stringify(h));
    assert.deepEqual({ ...r.response, requestId: 'x' }, { error: 'FORBIDDEN', status: 403, message: 'Action refusée.', requestId: 'x' });
    assert.match(r.response.requestId, /^[0-9a-f-]{36}$/, 'a Nordla-generated request id, nothing else');
  }
  assert.equal(s.guardLogin(rreq('GET', { origin: ORIGIN })).code, 'METHOD_NOT_ALLOWED');
  assert.equal(s.guardRead(rreq('GET')).ok, true, 'GET without Origin');
  assert.equal(s.guardRead(rreq('GET', { origin: 'https://evil.example' })).code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(s.guardRead(rreq('OPTIONS', { origin: 'https://evil.example', 'access-control-request-method': 'POST' })).code, 'CORS_NOT_SUPPORTED');
  assert.ok(!Object.keys(s.headers()).some((k) => /^access-control/i.test(k)), 'no CORS header');
  // local: same rules on the loopback origin
  const l = local();
  assert.equal(l.guardLogin(lreq('POST', { origin: 'http://localhost:4433' })).ok, true);
  assert.equal(l.guardLogin(lreq('POST', { origin: 'http://localhost:5173' })).code, 'ORIGIN_NOT_ALLOWED');
});

// ---------- cookies ----------
test('cookies: exact production attributes, distinct local names, exact clearing, per-module names, never a Domain', () => {
  const s = hosted(); const t = token(); const c = s.csrfTokenFor(t);
  assert.equal(s.cookies.sessionCookie(t), `__Host-nordla_growth_sid=${t}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`);
  assert.equal(s.cookies.csrfCookie(c), `__Host-nordla_growth_csrf=${c}; Secure; SameSite=Lax; Path=/; Max-Age=43200`);
  assert.equal(s.cookies.clearSessionCookie(), '__Host-nordla_growth_sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  assert.equal(s.cookies.clearCsrfCookie(), '__Host-nordla_growth_csrf=; Secure; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  const l = local();
  assert.equal(l.cookies.sessionCookie(t), `nordla_dev_growth_sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
  assert.equal(l.cookies.csrfCookie(c), `nordla_dev_growth_csrf=${c}; SameSite=Lax; Path=/; Max-Age=43200`);
  for (const str of [s.cookies.sessionCookie(t), s.cookies.csrfCookie(c), l.cookies.sessionCookie(t), s.cookies.clearSessionCookie(), l.cookies.clearSessionCookie()]) {
    assert.ok(!/domain=/i.test(str), 'no Domain'); if (str.startsWith('__Host-')) assert.match(str, /; Secure;/);
  }
  assert.ok(!l.cookies.sessionCookie(t).startsWith('__Host-'), 'no __Host- prefix without Secure');
  assert.equal(createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: [HOST], allowedOrigins: [ORIGIN], moduleCode: 'finance', csrfKey: CSRF_KEY }).cookies.names.session, '__Host-nordla_finance_sid');
  assert.equal(hosted({ sessionMaxAgeSeconds: 3600 }).cookies.sessionCookie(t).endsWith('Max-Age=3600'), true);
  assert.throws(() => s.cookies.sessionCookie('bad value; Domain=evil.example'), /COOKIE_VALUE_INVALID/);
  // reading: this module's cookies only; a duplicated cookie is ambiguous -> absent
  assert.deepEqual(s.cookies.read(`other=1; __Host-nordla_growth_sid=${t}; __Host-nordla_growth_csrf=${c}`), { session: t, csrf: c });
  assert.deepEqual(s.cookies.read(`__Host-nordla_growth_sid=${t}; __Host-nordla_growth_sid=${token()}`), { session: null, csrf: null });
  assert.deepEqual(s.cookies.read(`__Host-nordla_finance_sid=${t}`), { session: null, csrf: null });
});

// ---------- CSRF ----------
test('CSRF: HMAC of session + module; header == cookie == expected; other session, other module, missing or forged values refused', async () => {
  const s = hosted(); const t = token(); const c = s.csrfTokenFor(t);
  assert.equal(c, createHmac('sha256', CSRF_KEY).update(`nordla-csrf:v1:growth:${t}`).digest('base64url'));
  assert.notEqual(s.csrfTokenFor(token()), c, 'another session, another token');
  const fin = createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: [HOST], allowedOrigins: [ORIGIN], moduleCode: 'finance', csrfKey: CSRF_KEY });
  assert.notEqual(fin.csrfTokenFor(t), c, 'another module, another token');
  const resolved = []; const resolve = async (tok) => { resolved.push(tok); return { ok: true, userId: 'u' }; };
  const mut = (h) => s.guardMutation(rreq('POST', { origin: ORIGIN, ...h }), resolve);
  const cookie = (sid, csrf) => `__Host-nordla_growth_sid=${sid}; __Host-nordla_growth_csrf=${csrf}`;
  const ok = await mut({ cookie: cookie(t, c), 'x-nordla-csrf': c });
  assert.equal(ok.ok, true); assert.equal(ok.sessionToken, t); assert.deepEqual(resolved, [t]);
  const other = token();
  const forged = `${c.slice(0, -1)}${c.endsWith('A') ? 'E' : 'A'}`;
  assert.notEqual(forged, c);
  const refused = [
    [{ cookie: cookie(t, c) }, 'CSRF_HEADER_MISSING'],
    [{ cookie: `__Host-nordla_growth_sid=${t}`, 'x-nordla-csrf': c }, 'CSRF_COOKIE_MISSING'],
    [{ cookie: cookie(t, c), 'x-nordla-csrf': s.csrfTokenFor(other) }, 'CSRF_MISMATCH'],
    [{ cookie: cookie(other, c), 'x-nordla-csrf': c }, 'CSRF_MISMATCH'], // token of session t replayed with session "other"
    [{ cookie: cookie(t, fin.csrfTokenFor(t)), 'x-nordla-csrf': fin.csrfTokenFor(t) }, 'CSRF_MISMATCH'], // Finances token in Growth
    [{ cookie: cookie(t, forged), 'x-nordla-csrf': forged }, 'CSRF_MISMATCH'], // one character changed (always different)
    [{ cookie: `__Host-nordla_growth_csrf=${c}`, 'x-nordla-csrf': c }, 'CSRF_NO_SESSION'],
    [{ cookie: cookie(t, c), 'x-nordla-csrf': c, origin: undefined }, 'ORIGIN_MISSING'],
    [{ cookie: cookie(t, c), 'x-nordla-csrf': c, origin: 'https://evil.example' }, 'ORIGIN_NOT_ALLOWED'],
  ];
  for (const [h, code] of refused) {
    const req = rreq('POST', { origin: ORIGIN, ...h }); for (const k of Object.keys(h)) if (h[k] === undefined) delete req.headers[k];
    const r = await s.guardMutation(req, resolve);
    assert.equal(r.ok, false); assert.equal(r.code, code, code);
  }
  assert.equal(resolved.length, 1, 'the session is never resolved when Origin or CSRF fail');
  assert.equal((await s.guardMutation(rreq('POST', { origin: ORIGIN, cookie: cookie(t, c), 'x-nordla-csrf': c }), async () => ({ ok: false }))).code, 'SESSION_INVALID');
  assert.equal((await s.guardMutation(rreq('GET', { origin: ORIGIN }), resolve)).code, 'METHOD_NOT_A_MUTATION');
  await assert.rejects(s.guardMutation(rreq('POST'), undefined), /session resolver/);
});

test('CSRF comparisons are constant-time (timingSafeEqual, never ===)', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual(undefined, 'a'), false);
  const code = readFileSync(new URL('../src/security/csrf.js', import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.match(code, /return timingSafeEqual\(x, y\);/);
  assert.ok(!/(headerToken|cookieToken|expected|a)\s*===\s*(headerToken|cookieToken|expected|b)\b/.test(code), 'no plain comparison of secrets');
  assert.equal((code.match(/constantTimeEqual\(headerToken/g) ?? []).length, 2);
});

// ---------- time normalisation ----------
test('timing: every LOGIN_FAILED waits until min + jitter on a monotonic clock; other answers are not padded; nothing blocks', async () => {
  const clock = { t: 1000 }; const sleeps = [];
  const timing = createLoginTiming({ minMs: 900, jitterMs: 100, now: () => clock.t, sleep: async (ms) => { sleeps.push(ms); clock.t += ms; }, randomInt: (min, max) => { assert.equal(min, 0); assert.equal(max, 101); return 37; } });
  const run = (result, cost) => timing.normalize(async () => { clock.t += cost; return result; });
  const FAILED = { ok: false, error: 'LOGIN_FAILED', status: 401, message: 'x' };
  assert.equal(await run(FAILED, 20), FAILED); assert.deepEqual(sleeps, [917]);
  await run(FAILED, 700); assert.deepEqual(sleeps.at(-1), 237);
  await run(FAILED, 1500); assert.equal(sleeps.length, 2, 'already past the floor: no extra wait');
  for (const r of [{ ok: true }, { ok: false, error: 'RATE_LIMITED' }, { ok: false, error: 'UNAVAILABLE' }]) await run(r, 5);
  assert.equal(sleeps.length, 2);
  const src = readFileSync(new URL('../src/security/timing.js', import.meta.url), 'utf8');
  assert.ok(src.includes('performance.now()') && src.includes('randomInt') && src.includes('setTimeout') && !/Atomics\.wait|execSync|while\s*\(.*now\(\)/.test(src), 'monotonic, crypto jitter, asynchronous');
});

test('timing + C3: the seven LOGIN_FAILED cases give the same public result and the same floor', async () => {
  const A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'; const B = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';
  const people = ['owner', 'susp', 'stranger'].map((k, i) => ({ key: k, id: `${String(i + 1).padStart(8, '0')}-3333-4333-8333-${String(i + 1).padStart(12, '0')}`, email: `${k}@nordla-test.example`, password: `synthetic passphrase ${k}` }));
  const [owner, susp, stranger] = people;
  const db = createIdentityDb({ merchants: [A, B], users: people.map((p) => p.id) });
  const auth = createFakeGoTrue({ users: people });
  const ids = (m, mod) => createIdentityService({ merchantId: m, moduleCode: mod, supabase: db.supabase, auth: { baseUrl: 'https://ref.supabase.example', anonKey: `anon-${randomBytes(20).toString('hex')}` }, sessions: loadIdentityConfig({}), rateLimits: loadRateLimitConfig({ NORDLA_LOGIN_MAX_EMAIL_FAILURES: '20', NORDLA_LOGIN_MAX_IP_FAILURES: '200' }), rateLimitKey: randomBytes(32), fetchImpl: auth.fetchImpl });
  const mem = createMemberService({ supabase: db.supabase, merchantId: A });
  await mem.bootstrapOwner({ userId: owner.id }); await mem.addMember({ actorUserId: owner.id, targetUserId: susp.id, role: 'VIEWER' }); await mem.suspendMember({ actorUserId: owner.id, targetUserId: susp.id });
  const prov = createModuleProvisioning({ supabase: db.supabase });
  await prov.enableModule({ merchantId: A, moduleCode: 'growth', source: 'provisioning:manual' });
  await prov.enableModule({ merchantId: A, moduleCode: 'analytics', source: 'provisioning:manual' }); await prov.suspendModule({ merchantId: A, moduleCode: 'analytics', source: 'billing:unpaid' });
  const clock = { t: 0 }; const waited = [];
  const sec = hosted({ now: () => clock.t, sleep: async (ms) => { waited.push(clock.t + ms); clock.t += ms; }, randomInt: () => 50 });
  const cases = [
    ['invalid address', ids(A, 'growth'), { ...owner, email: 'not an address' }],
    ['unknown address', ids(A, 'growth'), { ...owner, email: 'nobody@nordla-test.example' }],
    ['wrong password', ids(A, 'growth'), { ...owner, password: 'wrong password' }],
    ['no membership', ids(A, 'growth'), stranger],
    ['suspended membership', ids(A, 'growth'), susp],
    ['module absent', ids(A, 'finance'), owner],
    ['module suspended', ids(A, 'analytics'), owner],
  ];
  const results = [];
  for (const [label, svc, p] of cases) {
    clock.t = 0; waited.length = 0;
    const r = await sec.normalizeLogin(() => svc.authenticateAndOpenSession({ email: p.email, password: p.password, ipAddress: '203.0.113.9' }));
    results.push(JSON.stringify(r));
    assert.deepEqual(waited, [950], `${label}: answered exactly at the floor (900 + jitter 50)`);
  }
  assert.equal(new Set(results).size, 1, 'one identical public result');
  assert.equal(results[0], JSON.stringify({ ok: false, error: 'LOGIN_FAILED', status: 401, message: 'Impossible de vous connecter avec ces informations.' }));
});

// ---------- methods and bodies ----------
const body = (text, headers = {}, method = 'POST') => Object.assign(Readable.from([Buffer.from(text)]), { method, headers: { 'content-type': 'application/json', ...headers } });
test('login body: POST, JSON, <= 16 KiB, only email + password; forbidden and unexpected fields, duplicates, bad JSON refused generically', async () => {
  const s = hosted();
  assert.deepEqual(await s.readLoginBody(body('{"email":"person@shop.example","password":"x y z"}')), { email: 'person@shop.example', password: 'x y z' });
  assert.deepEqual(await s.readLoginBody(body('{"email":"a@b.example","password":"p"}', { 'content-type': 'application/json; charset=utf-8' })), { email: 'a@b.example', password: 'p' });
  const refused = [
    [body('{"email":"a@b.example","password":"p"}', {}, 'PUT'), 'METHOD_NOT_ALLOWED', 405],
    [body('{"email":"a@b.example","password":"p"}', { 'content-type': 'text/plain' }), 'CONTENT_TYPE_NOT_JSON', 415],
    [body('email=a&password=p', { 'content-type': 'application/x-www-form-urlencoded' }), 'CONTENT_TYPE_NOT_JSON', 415],
    [body('{}', { 'content-length': String(17 * 1024) }), 'BODY_TOO_LARGE', 413],
    [body(JSON.stringify({ email: 'a@b.example', password: 'x'.repeat(17 * 1024) })), 'BODY_TOO_LARGE', 413],
    [body('{"email":"a@b.example","password":'), 'BODY_NOT_JSON', 400],
    [body('["a@b.example","p"]'), 'BODY_NOT_OBJECT', 400],
    [body('{"email":"a@b.example","password":"p","password":"q"}'), 'BODY_DUPLICATE_KEY', 400],
    [body('{"email":"a@b.example","password":"p","remember":true}'), 'BODY_UNEXPECTED_FIELD', 400],
    [body('{"email":"a@b.example"}'), 'BODY_MISSING_FIELD', 400],
    [body('{"email":"a@b.example","password":42}'), 'BODY_FIELD_TYPE', 400],
  ];
  for (const f of ['merchantId', 'module', 'expectedModule', 'role', 'sessionId', 'session']) refused.push([body(JSON.stringify({ email: 'a@b.example', password: 'p', [f]: 'x' })), 'BODY_FORBIDDEN_FIELD', 400]);
  for (const [req, code, status] of refused) {
    await assert.rejects(s.readLoginBody(req), (e) => {
      const pub = publicError(e, { requestId: null });
      return e.code === code && pub.status === status && !JSON.stringify(pub).includes('a@b.example') && !JSON.stringify(pub).includes('password');
    }, code);
  }
});

// ---------- headers ----------
const DEFAULT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const DEFAULT_PERMISSIONS = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';
const csp = (h) => Object.fromEntries(h['Content-Security-Policy'].split('; ').map((d) => { const [k, ...v] = d.split(' '); return [k, v.join(' ')]; }));

test('security headers: closed defaults - frame-src and object-src none, microphone off, nosniff, no framing, HSTS only hosted, no-store for auth', () => {
  const h = securityHeaders({ hosted: true, authentication: true });
  assert.equal(h['Content-Security-Policy'], DEFAULT_CSP);
  assert.equal(csp(h)['frame-src'], "'none'"); assert.equal(csp(h)['object-src'], "'none'");
  assert.equal(h['Permissions-Policy'], DEFAULT_PERMISSIONS);
  assert.match(h['Permissions-Policy'], /(^|, )microphone=\(\)(,|$)/);
  assert.equal(h['X-Content-Type-Options'], 'nosniff'); assert.equal(h['Referrer-Policy'], 'no-referrer'); assert.equal(h['X-Frame-Options'], 'DENY');
  assert.equal(h['Strict-Transport-Security'], 'max-age=31536000'); assert.equal(h['Cache-Control'], 'no-store');
  const l = securityHeaders({ hosted: false });
  assert.equal(l['Strict-Transport-Security'], undefined); assert.equal(l['Cache-Control'], undefined);
  assert.equal(l['Content-Security-Policy'], DEFAULT_CSP);
  const nonce = randomBytes(18).toString('base64');
  assert.ok(securityHeaders({ hosted: true, nonce })['Content-Security-Policy'].includes(`script-src 'self' 'nonce-${nonce}'`));
  assert.throws(() => securityHeaders({ hosted: true, nonce: "x' 'unsafe-inline" }), /nonce/);
  for (const x of [h, l]) assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(x['Content-Security-Policy']));
  assert.equal(hosted().headers()['Content-Security-Policy'], DEFAULT_CSP, 'createHttpSecurity without exceptions = closed defaults');
  assert.equal(hosted().headers()['Permissions-Policy'], DEFAULT_PERMISSIONS);
});

test('CSP exceptions: exact https origins for img, connect, frame and object; normalised, de-duplicated, deterministic', () => {
  const h = securityHeaders({ hosted: true, csp: {
    imgSources: ['https://cdn.shopify.com', 'HTTPS://CDN.Shopify.com/', 'https://b.cdn.example'],
    connectSources: ['https://api.nordla-test.example'],
    frameSources: ["'self'"],
    objectSources: ["'self'"],
  } });
  const c = csp(h);
  assert.equal(c['img-src'], "'self' data: https://b.cdn.example https://cdn.shopify.com", 'defaults kept, duplicates removed, origins sorted');
  assert.equal(c['connect-src'], "'self' https://api.nordla-test.example");
  assert.equal(c['frame-src'], "'self'");
  assert.equal(c['object-src'], "'self'");
  assert.equal(csp(securityHeaders({ hosted: true, csp: { frameSources: ['https://viewer.nordla-test.example'] } }))['frame-src'], 'https://viewer.nordla-test.example');
  // deterministic: the same set in any order gives the same header
  const a = securityHeaders({ hosted: true, csp: { imgSources: ['https://z.example', 'blob:', 'https://a.example', "'self'"] } })['Content-Security-Policy'];
  const b = securityHeaders({ hosted: true, csp: { imgSources: ["'self'", 'https://a.example', 'blob:', 'https://z.example', 'https://a.example'] } })['Content-Security-Policy'];
  assert.equal(a, b);
  assert.equal(csp({ 'Content-Security-Policy': a })['img-src'], "'self' data: blob: https://a.example https://z.example");
});

test('CSP exceptions: data: only in img-src; blob: only in img-src and frame-src; self where allowed; everything else refused', () => {
  assert.equal(csp(securityHeaders({ hosted: true, csp: { frameSources: ['blob:'] } }))['frame-src'], 'blob:');
  assert.equal(csp(securityHeaders({ hosted: true, csp: { imgSources: ['blob:'] } }))['img-src'], "'self' data: blob:");
  const refused = [
    [{ connectSources: ['data:'] }, /data: is not allowed in connect-src/], [{ frameSources: ['data:'] }, /data: is not allowed in frame-src/],
    [{ objectSources: ['data:'] }, /data: is not allowed in object-src/], [{ connectSources: ['blob:'] }, /blob: is not allowed in connect-src/],
    [{ objectSources: ['blob:'] }, /blob: is not allowed in object-src/],
    [{ imgSources: ["'unsafe-inline'"] }, /not allowed in img-src/], [{ connectSources: ["'none'"] }, /not allowed in connect-src/],
    [{ imgSources: ['https:'] }, /not allowed in img-src/], [{ imgSources: ['*'] }, /wildcard/], [{ imgSources: ['https://*.shopify.com'] }, /wildcard/],
    [{ connectSources: ['https://api.example/v1'] }, /not an exact origin/], [{ imgSources: ['https://user:pw@cdn.example'] }, /exact origin|only https/],
    [{ imgSources: ['http://cdn.example'] }, /only https origins are accepted in hosted mode/], [{ frameSources: ['http://localhost:4433'] }, /only https/],
    [{ scriptSources: ['https://cdn.example'] }, /unknown option "scriptSources"/], [{ imgSources: 'https://cdn.example' }, /must be a list/],
    [{ imgSources: [42] }, /invalid value/],
  ];
  for (const [c, rx] of refused) assert.throws(() => securityHeaders({ hosted: true, csp: c }), rx, JSON.stringify(c));
  // locally, http is accepted for loopback origins only
  assert.equal(csp(securityHeaders({ hosted: false, csp: { connectSources: ['http://localhost:5173'] } }))['connect-src'], "'self' http://localhost:5173");
  assert.throws(() => securityHeaders({ hosted: false, csp: { connectSources: ['http://cdn.example'] } }), /only https/);
});

test('Railway mode (createHttpSecurity hosted): an http origin, a wildcard or an unknown directive is refused at construction', () => {
  for (const [c, field] of [[{ imgSources: ['http://cdn.shopify.com'] }, 'csp'], [{ imgSources: ['https://*.shopify.com'] }, 'csp'], [{ frameAncestors: ["'self'"] }, 'csp']]) {
    assert.throws(() => hosted({ csp: c }), (e) => e instanceof HttpSecurityConfigError && e.field === field, JSON.stringify(c));
  }
  const s = hosted({ csp: { imgSources: ['https://cdn.shopify.com'] } });
  assert.equal(csp(s.headers())['img-src'], "'self' data: https://cdn.shopify.com");
  assert.throws(() => s.headers({ csp: { imgSources: ['https://evil.example'] } }), /only \{ nonce, authentication \}/, 'no exception at call time');
});

test('Permissions-Policy: microphone=(self) can be granted explicitly; * and unknown features refused; normalised and ordered', () => {
  assert.equal(securityHeaders({ hosted: true, permissions: { microphone: ['self'] } })['Permissions-Policy'], 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()');
  assert.equal(securityHeaders({ hosted: true, permissions: { microphone: ["'self'", 'self'] } })['Permissions-Policy'], 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()', 'duplicates removed');
  const x = securityHeaders({ hosted: true, permissions: { camera: ['https://z.nordla-test.example', 'self', 'HTTPS://a.nordla-test.example'] } })['Permissions-Policy'];
  assert.equal(x, 'camera=(self "https://a.nordla-test.example" "https://z.nordla-test.example"), microphone=(), geolocation=(), payment=(), usb=()');
  for (const [p, rx] of [[{ microphone: ['*'] }, /\* is never allowed/], [{ microphone: ["'*'"] }, /\* is never allowed/], [{ fullscreen: ['self'] }, /unknown feature "fullscreen"/],
    [{ microphone: ['http://localhost:4433'] }, /only https/], [{ microphone: ['https://*.nordla-test.example'] }, /wildcard/], [{ microphone: 'self' }, /must be a list/]]) {
    assert.throws(() => securityHeaders({ hosted: true, permissions: p }), rx, JSON.stringify(p));
  }
  assert.throws(() => hosted({ permissions: { microphone: ['*'] } }), (e) => e instanceof HttpSecurityConfigError && e.field === 'permissions');
  assert.equal(hosted({ permissions: { microphone: ['self'] } }).headers()['Permissions-Policy'], 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()');
});

test('CSP and Permissions-Policy configurations are frozen', () => {
  const s = hosted({ csp: { imgSources: ['https://cdn.shopify.com'] }, permissions: { microphone: ['self'] } });
  for (const o of [s.csp, s.csp.imgSources, s.csp.frameSources, s.permissions, s.permissions.microphone]) assert.ok(Object.isFrozen(o));
  assert.throws(() => { s.csp.imgSources.push('https://evil.example'); }, TypeError);
  assert.throws(() => { s.permissions.camera = ['self']; }, TypeError);
  assert.equal(csp(s.headers())['img-src'], "'self' data: https://cdn.shopify.com");
});

// ---------- redaction and public errors ----------
test('redaction: sensitive keys and values removed at any depth; log lines keep only safe fields; public errors never leak', () => {
  const jwt = ['ey', 'J', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'c2lnbmF0dXJl'].join('');
  const email = ['person', 'shop.example'].join('@'); const tok = token(); const hex = randomBytes(32).toString('hex');
  const input = {
    route: '/api/login', status: 401,
    body: { email, password: 'hunter2 secret words', nested: [{ Authorization: `Bearer ${tok}` }, { note: jwt }, { value: hex }] },
    headers: { cookie: `__Host-nordla_growth_sid=${tok}`, 'x-nordla-csrf': tok, 'X-Real-IP': '203.0.113.20', 'x-forwarded-for': '198.51.100.1' },
    session: { id: 'abc' }, clientSecret: 'x', apiKey: 'y', ip: '203.0.113.20', peer: '2001:db8::1', who: email,
  };
  const out = redact(input); const text = JSON.stringify(out);
  for (const secret of [email, 'hunter2', tok, jwt, hex, '203.0.113.20', '198.51.100.1', '2001:db8::1']) assert.ok(!text.includes(secret), 'leak');
  assert.equal(out.body.password, REDACTED); assert.equal(out.headers.cookie, REDACTED); assert.equal(out.session, REDACTED); assert.equal(out.body.nested[0].Authorization, REDACTED);
  assert.equal(out.route, '/api/login'); assert.equal(out.status, 401);
  assert.deepEqual(redact(new Error(`failed for ${email} at C:\\Users\\someone\\app.js`)), { name: 'Error', code: null });
  const line = requestLogEntry({ requestId: '12345678-1234-4234-8234-123456789012', method: 'POST', route: '/api/login', status: 401, durationMs: 950.4, module: 'growth', code: 'LOGIN_FAILED', email, ip: '203.0.113.20', body: input.body, headers: input.headers });
  assert.deepEqual(Object.keys(line).sort(), ['code', 'durationMs', 'method', 'module', 'requestId', 'route', 'status']);
  assert.equal(requestLogEntry({ route: `/api/login?email=${email}` }).route, null, 'no query string in a route');
  const err = new Error(`Supabase REST -> HTTP 500: duplicate key; token=${tok} at C:\\Users\\someone\\src\\x.js:12`);
  const pub = publicError(err, { requestId: '12345678-1234-4234-8234-123456789012' });
  assert.deepEqual(pub, { error: 'INTERNAL_ERROR', status: 500, message: 'Une erreur est survenue. Réessayez plus tard.', requestId: '12345678-1234-4234-8234-123456789012' });
  for (const leak of ['stack', 'Supabase', 'Users', tok, 'x.js']) assert.ok(!JSON.stringify(pub).includes(leak), leak);
});

test('C4 opens nothing: no server, no route, no cookie sent, modules untouched', () => {
  for (const f of ['index.js', 'request.js', 'cookies.js', 'csrf.js', 'headers.js', 'timing.js', 'body.js', 'redact.js']) {
    const code = readFileSync(new URL(`../src/security/${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/createServer|\.listen\(|setHeader\(|writeHead\(|res\.end\(/.test(code), `${f} must not send anything`);
    assert.ok(!/growth\/|finance\/|analytics-premium\//.test(code), `${f} must not import a module`);
  }
});
