// Core C1b - identity verification (src/identity/{gotrue,rate-limit,verify}.js). No network: a fake Supabase Auth reached through
// an injected fetch, the in-memory identity database with the migrations' rules, a fixed clock. Synthetic users and documentation
// IP addresses (RFC 5737 / RFC 3849) only; secrets are generated at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createIdentityDb } from './fixtures/identity-db.js';
import { createFakeGoTrue } from './fixtures/fake-gotrue.js';
import { createGoTrueVerifier, loadGoTrueConfig, GoTrueConfigError, LOGOUT_SCOPE } from '../src/identity/gotrue.js';
import { createRateLimiter, parseRateLimitKey, normalizeEmail, normalizeIp, RateLimitError } from '../src/identity/rate-limit.js';
import { loadRateLimitConfig } from '../src/identity/config.js';
import { createEventLog } from '../src/identity/events.js';
import { createIdentityVerifier, PUBLIC_ERRORS } from '../src/identity/verify.js';

const MERCHANT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_MERCHANT = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';
const OWNER = { id: '11111111-2222-4333-8444-555555555555', email: 'owner@nordla-test.example', password: 'correct horse battery staple' };
const BANNED = { id: '66666666-7777-4888-9999-aaaaaaaaaaaa', email: 'banned@nordla-test.example', password: 'another long passphrase', banned: true };
const IP = '203.0.113.7';
const IP2 = '198.51.100.23';
const T0 = new Date('2026-09-28T08:00:00.000Z');
const MIN = 60_000;
const CONFIG = { baseUrl: 'https://project-ref.supabase.example', anonKey: `anon-${randomBytes(24).toString('hex')}` };

function setup({ mode = 'normal', key = randomBytes(32), limits = {} } = {}) {
  const clock = { t: T0.getTime() };
  const now = () => new Date(clock.t);
  const db = createIdentityDb({ merchants: [MERCHANT, OTHER_MERCHANT] });
  const auth = createFakeGoTrue({ users: [OWNER, BANNED], mode });
  const gotrue = createGoTrueVerifier({ config: CONFIG, fetchImpl: auth.fetchImpl, timeoutMs: 50, logoutTimeoutMs: 50 });
  const limiter = createRateLimiter({ supabase: db.supabase, key, config: loadRateLimitConfig(limits), now });
  const events = createEventLog({ supabase: db.supabase, now });
  const verifier = createIdentityVerifier({ gotrue, limiter, events, service: { merchantId: MERCHANT, module: 'growth' } });
  return { db, auth, gotrue, limiter, verifier, key, at: (ms) => { clock.t = T0.getTime() + ms; }, everything: () => JSON.stringify({ tables: [db.table('app_sessions'), db.table('identity_events'), db.table('identity_rate_limits')] }) };
}
const events = (db) => db.table('identity_events');

// ---------- success ----------
test('correct credentials -> the Supabase user id only; the temporary Supabase session is closed with scope=local', async () => {
  const s = setup();
  const r = await s.verifier.verify({ email: '  Owner@Nordla-Test.EXAMPLE ', password: OWNER.password, ip: IP });
  assert.deepEqual(r, { ok: true, identity: { userId: OWNER.id } });
  assert.deepEqual(Object.keys(r.identity), ['userId']);
  const [token, logout] = s.auth.requests;
  assert.equal(token.path, '/auth/v1/token'); assert.equal(token.query.grant_type, 'password');
  assert.equal(token.headers.apikey, CONFIG.anonKey); assert.ok(token.hasSignal, 'timeout signal on the token request'); assert.equal(token.redirect, 'error');
  assert.equal(logout.path, '/auth/v1/logout');
  assert.deepEqual(logout.query, { scope: 'local' }, 'scope=local, explicitly');
  assert.ok(logout.hasSignal);
  assert.equal(LOGOUT_SCOPE, 'local');
  assert.equal(s.auth.requests.length, 2);
});

test('no token is returned, journalled or stored anywhere; no e-mail or IP in the database', async () => {
  const s = setup();
  const r = await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP });
  await s.verifier.verify({ email: OWNER.email, password: 'wrong password', ip: IP });
  const all = JSON.stringify(r) + s.everything();
  for (const t of s.auth.issued) assert.ok(!all.includes(t), 'a Supabase token leaked');
  for (const clear of [OWNER.email, IP, OWNER.password, 'wrong password', CONFIG.anonKey]) assert.ok(!all.includes(clear), 'a clear value was stored');
  const direct = await s.gotrue.verifyPassword(OWNER.email, OWNER.password);
  assert.deepEqual(Object.keys(direct).sort(), ['localLogout', 'ok', 'userId']);
});

test('success is journalled as AUTH_SUCCEEDED with the user id, the service merchant and no identifying detail', async () => {
  const s = setup();
  await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP });
  const [e] = events(s.db);
  assert.equal(e.event_type, 'AUTH_SUCCEEDED'); assert.equal(e.outcome, 'SUCCESS'); assert.equal(e.user_id, OWNER.id);
  assert.equal(e.merchant_id, MERCHANT); assert.equal(e.module, 'growth'); assert.equal(e.session_id, null);
  assert.deepEqual(e.detail, { supabaseLocalLogout: 'DONE' });
});

test('no Nordla session is created, even after a correct password; the caller cannot choose a merchant', async () => {
  const s = setup();
  await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP });
  assert.equal(s.db.table('app_sessions').length, 0);
  assert.ok(!s.db.calls.some((c) => c.table === 'app_sessions'), 'app_sessions is never touched');
  await assert.rejects(s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP, merchantId: OTHER_MERCHANT }), /does not accept "merchantId"/);
  await assert.rejects(s.verifier.verify({ email: OWNER.email, password: OWNER.password, module: 'finance' }), /does not accept "module"/);
  assert.ok(events(s.db).every((e) => e.merchant_id === MERCHANT), 'journal context = the service merchant, never a caller value');
  for (const f of ['verify.js', 'gotrue.js', 'rate-limit.js']) {
    const code = readFileSync(new URL(`../src/identity/${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/ .*$/, '')).join('\n');
    assert.ok(!/sessions\.js|app_sessions|createSessionStore|Set-Cookie/.test(code), `${f} must not create sessions or cookies`);
  }
});

// ---------- failures: one public answer ----------
test('unknown address, wrong password, refused account and malformed input give the SAME public answer', async () => {
  const s = setup();
  const answers = [
    await s.verifier.verify({ email: 'nobody@nordla-test.example', password: 'whatever it is', ip: IP }),
    await s.verifier.verify({ email: OWNER.email, password: 'wrong password', ip: IP }),
    await s.verifier.verify({ email: BANNED.email, password: BANNED.password, ip: IP }),
    await s.verifier.verify({ email: 'not an address', password: 'x', ip: IP }),
    await s.verifier.verify({ email: OWNER.email, password: '', ip: IP }),
  ];
  for (const a of answers) assert.deepEqual(a, { ok: false, error: 'INVALID_CREDENTIALS' });
  assert.deepEqual(PUBLIC_ERRORS, ['INVALID_CREDENTIALS', 'RATE_LIMITED', 'UNAVAILABLE']);
  const failed = events(s.db).filter((e) => e.event_type === 'AUTH_FAILED');
  assert.equal(failed.length, 5);
  for (const e of failed) {
    assert.equal(e.user_id, null, 'no user id on a failure (would reveal the account)');
    assert.deepEqual(Object.keys(e.detail).sort(), ['blockedNow', 'sourceRef', 'subjectRef']);
    assert.match(e.detail.subjectRef, /^[0-9a-f]{16}$/);
  }
  // the malformed address never reached Supabase
  assert.equal(s.auth.requests.filter((r) => r.path === '/auth/v1/token').length, 3);
});

// ---------- Supabase unavailable ----------
for (const [mode, reason] of [['timeout', 'TIMEOUT'], ['network', 'NETWORK'], ['http500', 'HTTP_5XX'], ['http429', 'PROVIDER_RATE_LIMITED'], ['invalid200', 'INVALID_RESPONSE']]) {
  test(`Supabase ${mode} -> UNAVAILABLE (${reason}), journalled, not counted as a credential failure`, async () => {
    const s = setup({ mode });
    const started = Date.now();
    assert.deepEqual(await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP }), { ok: false, error: 'UNAVAILABLE' });
    if (mode === 'timeout') assert.ok(Date.now() - started < 2000, 'the timeout aborts the request');
    const [e] = events(s.db);
    assert.equal(e.event_type, 'AUTH_UNAVAILABLE'); assert.deepEqual(e.detail, { reason });
    assert.equal(s.db.table('identity_rate_limits').length, 0);
    for (const t of s.auth.issued) assert.ok(!s.everything().includes(t));
  });
}

test('a failed Supabase local logout does not leak the token and is only noted as FAILED', async () => {
  const s = setup({ mode: 'logoutFails' });
  assert.equal((await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP })).ok, true);
  assert.deepEqual(events(s.db)[0].detail, { supabaseLocalLogout: 'FAILED' });
  assert.ok(s.auth.requests.every((r) => r.path !== '/auth/v1/logout' || r.query.scope === 'local'));
});

test('the logout scope is never global nor implicit (source and requests)', async () => {
  const src = readFileSync(new URL('../src/identity/gotrue.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/scope\s*[:=]\s*['"`]?global/.test(code) && !/scope=global/.test(code), 'global scope in code');
  assert.ok(/\/auth\/v1\/logout\?scope=\$\{LOGOUT_SCOPE\}/.test(code), 'the logout URL always carries the scope');
  const s = setup();
  for (let i = 0; i < 3; i += 1) await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP });
  const logouts = s.auth.requests.filter((r) => r.path === '/auth/v1/logout');
  assert.equal(logouts.length, 3);
  for (const l of logouts) assert.equal(l.query.scope, 'local');
});

// ---------- rate limiting ----------
test('per e-mail: 5 failures in 15 min block that address (even with the right password) - not others; the block ends', async () => {
  const s = setup();
  for (let i = 0; i < 5; i += 1) { s.at(i * MIN); assert.equal((await s.verifier.verify({ email: OWNER.email, password: 'wrong password', ip: `203.0.113.${10 + i}` })).error, 'INVALID_CREDENTIALS'); }
  s.at(5 * MIN);
  const tokenCalls = s.auth.requests.filter((r) => r.path === '/auth/v1/token').length;
  assert.deepEqual(await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP2 }), { ok: false, error: 'RATE_LIMITED' });
  assert.equal(s.auth.requests.filter((r) => r.path === '/auth/v1/token').length, tokenCalls, 'a blocked attempt never reaches Supabase');
  assert.equal((await s.verifier.verify({ email: BANNED.email, password: 'nope', ip: IP2 })).error, 'INVALID_CREDENTIALS', 'another address is not blocked');
  const limited = events(s.db).find((e) => e.event_type === 'AUTH_RATE_LIMITED');
  assert.equal(limited.outcome, 'DENIED'); assert.deepEqual(Object.keys(limited.detail).sort(), ['sourceRef', 'subjectRef']);
  s.at(4 * MIN + 15 * MIN - 1); assert.equal((await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP2 })).error, 'RATE_LIMITED');
  s.at(4 * MIN + 15 * MIN); assert.deepEqual(await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP2 }), { ok: true, identity: { userId: OWNER.id } });
});

test('per IP: 20 failures in 15 min block that client address for every account; other addresses keep working', async () => {
  const s = setup();
  for (let i = 0; i < 20; i += 1) { s.at(i * 10_000); await s.verifier.verify({ email: `user${i}@nordla-test.example`, password: 'guess', ip: IP }); }
  assert.equal((await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP })).error, 'RATE_LIMITED');
  assert.equal((await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP2 })).ok, true);
  // IPv6 clients are grouped by /64
  assert.equal(normalizeIp('2001:db8:1:2:aaaa::1'), normalizeIp('2001:DB8:1:2:ffff:1:2:3'));
  assert.notEqual(normalizeIp('2001:db8:1:2::1'), normalizeIp('2001:db8:1:3::1'));
  assert.equal(normalizeIp('::ffff:203.0.113.7'), IP);
  assert.equal(normalizeIp('garbage'), 'unknown');
});

test('the same public answer whatever limit is reached (it never says which one)', async () => {
  const byEmail = setup(); const byIp = setup();
  for (let i = 0; i < 5; i += 1) await byEmail.verifier.verify({ email: OWNER.email, password: 'x-wrong', ip: `203.0.113.${50 + i}` });
  for (let i = 0; i < 20; i += 1) await byIp.verifier.verify({ email: `u${i}@nordla-test.example`, password: 'x-wrong', ip: IP });
  assert.deepEqual(await byEmail.verifier.verify({ email: OWNER.email, password: 'x', ip: IP2 }), await byIp.verifier.verify({ email: OWNER.email, password: 'x', ip: IP }));
});

test('limits are configurable within safe bounds', async () => {
  const s = setup({ limits: { NORDLA_LOGIN_MAX_EMAIL_FAILURES: '3', NORDLA_LOGIN_BLOCK_MINUTES: '5' } });
  for (let i = 0; i < 3; i += 1) await s.verifier.verify({ email: OWNER.email, password: 'no', ip: IP });
  assert.equal((await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP2 })).error, 'RATE_LIMITED');
  s.at(5 * MIN); assert.equal((await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP2 })).ok, true);
  for (const bad of [{ NORDLA_LOGIN_MAX_EMAIL_FAILURES: '1' }, { NORDLA_LOGIN_MAX_IP_FAILURES: '999' }, { NORDLA_LOGIN_WINDOW_MINUTES: '2' }, { NORDLA_LOGIN_BLOCK_MINUTES: 'forever' }, { NORDLA_LOGIN_MAX_EMAIL_FAILURES: '10', NORDLA_LOGIN_MAX_IP_FAILURES: '6' }]) {
    assert.throws(() => loadRateLimitConfig(bad), (e) => e.code === 'IDENTITY_CONFIG_INVALID' && !e.message.includes('forever'));
  }
  assert.deepEqual({ ...loadRateLimitConfig({}) }, { maxEmailFailures: 5, maxIpFailures: 20, windowMinutes: 15, blockMinutes: 15, windowSeconds: 900, blockSeconds: 900 });
});

test('if the attempt store cannot be read, verification fails closed (UNAVAILABLE) without calling Supabase', async () => {
  const s = setup();
  s.db.failNextWith(new Error('Supabase REST GET /identity_rate_limits -> HTTP 500'));
  assert.deepEqual(await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP }), { ok: false, error: 'UNAVAILABLE' });
  assert.equal(s.auth.requests.length, 0);
});

// ---------- HMAC subjects ----------
test('subjects are keyed HMAC-SHA-256 (not a plain SHA-256); another key gives other subjects; the key is required and strong', async () => {
  const key = randomBytes(32);
  const s = setup({ key });
  await s.verifier.verify({ email: OWNER.email, password: 'bad', ip: IP });
  const rows = s.db.table('identity_rate_limits');
  const byDim = Object.fromEntries(rows.map((r) => [r.dimension, r.subject_hmac]));
  assert.equal(byDim.email, createHmac('sha256', key).update(`email:${OWNER.email}`).digest('hex'));
  assert.equal(byDim.ip, createHmac('sha256', key).update(`ip:${IP}`).digest('hex'));
  for (const plain of [OWNER.email, `email:${OWNER.email}`, IP, `ip:${IP}`]) assert.ok(!rows.some((r) => r.subject_hmac === createHash('sha256').update(plain).digest('hex')), 'plain SHA-256 used');
  const other = setup({ key: randomBytes(32) });
  await other.verifier.verify({ email: OWNER.email, password: 'bad', ip: IP });
  assert.notEqual(other.db.table('identity_rate_limits').find((r) => r.dimension === 'email').subject_hmac, byDim.email);
  // key rules: required, >= 32 bytes, not repetitive; the value never appears in the error
  for (const [raw, code] of [[undefined, 'RATE_LIMIT_KEY_MISSING'], ['', 'RATE_LIMIT_KEY_MISSING'], ['short-key-value', 'RATE_LIMIT_KEY_TOO_SHORT'], ['ab'.repeat(20), 'RATE_LIMIT_KEY_WEAK']]) {
    assert.throws(() => parseRateLimitKey(raw), (e) => e instanceof RateLimitError && e.code === code && (!raw || !e.message.includes(raw)));
  }
  assert.throws(() => createRateLimiter({ supabase: s.db.supabase }), (e) => e.code === 'RATE_LIMIT_KEY_MISSING', 'no default key');
  assert.equal(normalizeEmail('  A.B+tag@Shop.EXAMPLE '), 'a.b+tag@shop.example');
  assert.equal(normalizeEmail('two@@signs.example'), null);
});

// ---------- configuration of Supabase Auth ----------
test('Supabase Auth config: https URL and anon key required; values never echoed', () => {
  const key = `anon-${randomBytes(24).toString('hex')}`;
  assert.deepEqual({ ...loadGoTrueConfig({ SUPABASE_URL: 'https://ref.supabase.example/', SUPABASE_ANON_KEY: key }) }, { baseUrl: 'https://ref.supabase.example', anonKey: key });
  assert.equal(loadGoTrueConfig({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_ANON_KEY: key }).baseUrl, 'http://127.0.0.1:54321');
  for (const env of [{ SUPABASE_ANON_KEY: key }, { SUPABASE_URL: 'http://ref.supabase.example', SUPABASE_ANON_KEY: key }, { SUPABASE_URL: 'https://user:pw@ref.supabase.example', SUPABASE_ANON_KEY: key }, { SUPABASE_URL: 'https://ref.supabase.example' }]) {
    assert.throws(() => loadGoTrueConfig(env), (e) => e instanceof GoTrueConfigError && !e.message.includes(key) && !e.message.includes('pw@'));
  }
});

// ---------- nothing is logged ----------
test('nothing is written to the console during verification (no secret can leak through logs)', async () => {
  const seen = []; const orig = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) { orig[m] = console[m]; console[m] = (...a) => seen.push(a.join(' ')); }
  try {
    for (const mode of ['normal', 'timeout', 'network', 'http500', 'logoutFails']) {
      const s = setup({ mode });
      await s.verifier.verify({ email: OWNER.email, password: OWNER.password, ip: IP });
      await s.verifier.verify({ email: OWNER.email, password: 'wrong', ip: IP });
    }
  } finally { Object.assign(console, orig); }
  assert.deepEqual(seen, []);
});
