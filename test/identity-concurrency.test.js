// Core C1b - concurrency of the attempt limits. Simultaneous verifications (one process or several instances sharing ONE database)
// must never let more attempts reach Supabase Auth than the limit allows. The fake database runs each call as one uninterrupted
// unit after a network round trip (like one PostgREST request = one statement / function call in one transaction); the fake
// Supabase Auth answers after a delay and counts every token request. No in-memory lock exists in the code under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createIdentityDb } from './fixtures/identity-db.js';
import { createFakeGoTrue } from './fixtures/fake-gotrue.js';
import { createGoTrueVerifier } from '../src/identity/gotrue.js';
import { createRateLimiter } from '../src/identity/rate-limit.js';
import { loadRateLimitConfig } from '../src/identity/config.js';
import { createEventLog } from '../src/identity/events.js';
import { createIdentityVerifier } from '../src/identity/verify.js';

const MERCHANT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OWNER = { id: '11111111-2222-4333-8444-555555555555', email: 'owner@nordla-test.example', password: 'correct horse battery staple' };
const IP = '203.0.113.7';
const T0 = new Date('2026-09-28T08:00:00.000Z');
const CONFIG = { baseUrl: 'https://project-ref.supabase.example', anonKey: `anon-${randomBytes(24).toString('hex')}` };

/** One shared database and one fake Supabase Auth; `instances` verifiers = separate processes / Railway instances. */
function cluster({ instances = 1, authLatencyMs = 25, mode = 'normal', limits = {} } = {}) {
  const clock = { t: T0.getTime() };
  const now = () => new Date(clock.t);
  const key = randomBytes(32); // the same secret on every instance, as in production
  const db = createIdentityDb({ merchants: [MERCHANT], latencyMs: 1 });
  const auth = createFakeGoTrue({ users: [OWNER], mode, latencyMs: authLatencyMs });
  const make = () => createIdentityVerifier({
    gotrue: createGoTrueVerifier({ config: CONFIG, fetchImpl: auth.fetchImpl, timeoutMs: 1000, logoutTimeoutMs: 200 }),
    limiter: createRateLimiter({ supabase: db.supabase, key, config: loadRateLimitConfig(limits), now }),
    events: createEventLog({ supabase: db.supabase, now }),
    service: { merchantId: MERCHANT, module: 'growth' },
  });
  const nodes = Array.from({ length: instances }, make);
  return { db, auth, nodes, at: (ms) => { clock.t = T0.getTime() + ms; }, tokenCalls: () => auth.requests.filter((r) => r.path === '/auth/v1/token').length };
}

test('concurrency 1: 20 simultaneous wrong passwords, same e-mail, same IP, e-mail limit 5 -> at most 5 reach Supabase', async () => {
  const c = cluster();
  const answers = await Promise.all(Array.from({ length: 20 }, () => c.nodes[0].verify({ email: OWNER.email, password: 'wrong guess', ip: IP })));
  const calls = c.tokenCalls();
  console.log(`[concurrency 1] Supabase token requests: ${calls} / 20 attempts (limit 5)`);
  assert.ok(calls <= 5, `${calls} attempts reached Supabase`);
  assert.equal(answers.filter((a) => a.error === 'INVALID_CREDENTIALS').length, calls);
  assert.equal(answers.filter((a) => a.error === 'RATE_LIMITED').length, 20 - calls);
  // afterwards the address is blocked, even with the right password
  assert.equal((await c.nodes[0].verify({ email: OWNER.email, password: OWNER.password, ip: '198.51.100.1' })).error, 'RATE_LIMITED');
});

test('concurrency 2: 30 simultaneous attempts, 30 different e-mails, same IP, IP limit 20 -> at most 20 reach Supabase', async () => {
  const c = cluster();
  await Promise.all(Array.from({ length: 30 }, (_, i) => c.nodes[0].verify({ email: `user${i}@nordla-test.example`, password: 'guess', ip: IP })));
  const calls = c.tokenCalls();
  console.log(`[concurrency 2] Supabase token requests: ${calls} / 30 attempts (IP limit 20)`);
  assert.ok(calls <= 20, `${calls} attempts reached Supabase`);
});

test('concurrency 3: 20 simultaneous attempts, same e-mail from 20 IPs -> at most 5 reach Supabase', async () => {
  const c = cluster();
  await Promise.all(Array.from({ length: 20 }, (_, i) => c.nodes[0].verify({ email: OWNER.email, password: 'wrong guess', ip: `203.0.113.${100 + i}` })));
  const calls = c.tokenCalls();
  console.log(`[concurrency 3] Supabase token requests: ${calls} / 20 attempts (e-mail limit 5)`);
  assert.ok(calls <= 5, `${calls} attempts reached Supabase`);
});

test('concurrency 4: 4 instances sharing one database, 5 simultaneous attempts each (20) -> at most 5 reach Supabase', async () => {
  const c = cluster({ instances: 4 });
  await Promise.all(c.nodes.flatMap((n) => Array.from({ length: 5 }, () => n.verify({ email: OWNER.email, password: 'wrong guess', ip: IP }))));
  const calls = c.tokenCalls();
  console.log(`[concurrency 4] Supabase token requests: ${calls} / 20 attempts over 4 instances (limit 5)`);
  assert.ok(calls <= 5, `${calls} attempts reached Supabase`);
});

// ---------- settlement rules ----------
const counters = (db) => Object.fromEntries(db.table('identity_rate_limits').map((r) => [r.dimension, r.failures]));
const RESERVE = (subject, at) => ({ p_email_subject: subject.repeat(64), p_ip_subject: 'b'.repeat(64), p_now: new Date(T0.getTime() + at).toISOString(), p_window_seconds: 900, p_max_email: 5, p_max_ip: 20, p_block_seconds: 900, p_lease_seconds: 30 });

test('4 errors, then a success, then an error: e-mail counter 4 -> 0 -> 1; the IP counter keeps every failure (4 -> 4 -> 5)', async () => {
  const c = cluster({ authLatencyMs: 0 });
  for (let i = 0; i < 4; i += 1) await c.nodes[0].verify({ email: OWNER.email, password: 'wrong', ip: IP });
  assert.deepEqual(counters(c.db), { email: 4, ip: 4 });
  assert.equal((await c.nodes[0].verify({ email: OWNER.email, password: OWNER.password, ip: IP })).ok, true);
  assert.deepEqual(counters(c.db), { email: 0, ip: 4 }, 'a success resets the address, never the IP');
  await c.nodes[0].verify({ email: OWNER.email, password: 'wrong', ip: IP });
  assert.deepEqual(counters(c.db), { email: 1, ip: 5 });
  assert.equal(c.db.table('identity_auth_reservations').length, 0);
});

test('a success never lets an IP bypass its limit: failures on other addresses stay counted and the IP ends up blocked', async () => {
  const c = cluster({ authLatencyMs: 0 });
  for (let i = 0; i < 19; i += 1) await c.nodes[0].verify({ email: `victim${i}@nordla-test.example`, password: 'guess', ip: IP });
  assert.equal((await c.nodes[0].verify({ email: OWNER.email, password: OWNER.password, ip: IP })).ok, true, 'a valid account from that IP still works');
  assert.equal(counters(c.db).ip, 19, 'the success did not erase the IP failures');
  assert.equal((await c.nodes[0].verify({ email: 'victim99@nordla-test.example', password: 'guess', ip: IP })).error, 'INVALID_CREDENTIALS');
  assert.equal((await c.nodes[0].verify({ email: OWNER.email, password: OWNER.password, ip: IP })).error, 'RATE_LIMITED', '20 failures from the IP block it for every account');
});

test('two simultaneous attempts, one correct and one wrong: both reach Supabase, the correct one succeeds; e-mail counter 0 or 1, IP 1', async () => {
  const c = cluster();
  const [ok, bad] = await Promise.all([
    c.nodes[0].verify({ email: OWNER.email, password: OWNER.password, ip: IP }),
    c.nodes[0].verify({ email: OWNER.email, password: 'wrong', ip: IP }),
  ]);
  assert.equal(ok.ok, true); assert.equal(bad.error, 'INVALID_CREDENTIALS');
  assert.equal(c.tokenCalls(), 2);
  const k = counters(c.db);
  assert.ok(k.email === 0 || k.email === 1, `e-mail counter ${k.email}`); // 0 if the failure is settled first, 1 if the success is
  assert.equal(k.ip, 1);
});

test('a Supabase outage is released, never counted: 10 outages then the right password works', async () => {
  const c = cluster({ mode: 'http500', authLatencyMs: 0 });
  for (let i = 0; i < 10; i += 1) assert.equal((await c.nodes[0].verify({ email: OWNER.email, password: OWNER.password, ip: IP })).error, 'UNAVAILABLE');
  assert.deepEqual(counters(c.db), { email: 0, ip: 0 });
  assert.equal(c.db.table('identity_auth_reservations').length, 0);
  c.auth.setMode('normal');
  assert.equal((await c.nodes[0].verify({ email: OWNER.email, password: OWNER.password, ip: IP })).ok, true);
});

test('attempts in flight count against the limit, and release their place when they end', async () => {
  const c = cluster({ mode: 'timeout' }); // Supabase never answers until each call's timeout (1 s)
  const pending = Array.from({ length: 5 }, () => c.nodes[0].verify({ email: OWNER.email, password: 'x', ip: IP }));
  await new Promise((r) => setTimeout(r, 100)); // the five are reserved and waiting on Supabase
  assert.equal(c.db.table('identity_auth_reservations').length, 5);
  assert.equal((await c.nodes[0].verify({ email: OWNER.email, password: OWNER.password, ip: '198.51.100.9' })).error, 'RATE_LIMITED');
  await Promise.all(pending);
  assert.equal(c.db.table('identity_auth_reservations').length, 0, 'timeouts released their reservation');
  c.auth.setMode('normal');
  assert.equal((await c.nodes[0].verify({ email: OWNER.email, password: OWNER.password, ip: '198.51.100.9' })).ok, true);
});

test('reservations left by a process that died expire after the lease (30 s) and are never counted as failures', async () => {
  const c = cluster({ authLatencyMs: 0 });
  for (let i = 0; i < 5; i += 1) assert.ok(await c.db.supabase.rpc('identity_auth_reserve', RESERVE('a', 0)));
  assert.equal(await c.db.supabase.rpc('identity_auth_reserve', RESERVE('a', 29_000)), null, 'still in flight at 29 s: refused');
  assert.ok(await c.db.supabase.rpc('identity_auth_reserve', RESERVE('a', 30_000)), 'expired at 30 s: allowed again');
  assert.equal(c.db.table('identity_auth_reservations').length, 1, 'the expired reservations were purged');
  assert.deepEqual(counters(c.db), { email: 0, ip: 0 });
});

test('an unexpected exception during verification releases the reservation', async () => {
  const c = cluster({ authLatencyMs: 0 });
  const boom = createIdentityVerifier({
    gotrue: { verifyPassword: async () => { throw new Error('unexpected'); } },
    limiter: createRateLimiter({ supabase: c.db.supabase, key: randomBytes(32), config: loadRateLimitConfig({}), now: () => new Date(T0) }),
    events: createEventLog({ supabase: c.db.supabase, now: () => new Date(T0) }),
    service: { merchantId: MERCHANT, module: 'growth' },
  });
  await assert.rejects(boom.verify({ email: OWNER.email, password: 'x', ip: IP }), /unexpected/);
  assert.equal(c.db.table('identity_auth_reservations').length, 0);
  assert.deepEqual(counters(c.db), { email: 0, ip: 0 });
});

test('settling is idempotent: a second settlement changes nothing, a released reservation never becomes a failure', async () => {
  const c = cluster({ authLatencyMs: 0 });
  const lim = createRateLimiter({ supabase: c.db.supabase, key: randomBytes(32), config: loadRateLimitConfig({}), now: () => new Date(T0) });
  const s = lim.subjects({ email: OWNER.email, ip: IP });
  const first = await lim.reserve(s);
  await lim.settle(first, 'FAILURE'); await lim.settle(first, 'FAILURE');
  const second = await lim.reserve(s);
  await lim.settle(second, 'RELEASE'); await lim.settle(second, 'FAILURE');
  assert.deepEqual(counters(c.db), { email: 1, ip: 1 });
});

test('after concurrent runs the database holds HMAC subjects only: no e-mail, no IP, no password', async () => {
  const c = cluster({ instances: 3 });
  await Promise.all(Array.from({ length: 21 }, (_, i) => c.nodes[i % 3].verify({ email: OWNER.email, password: 'wrong guess', ip: IP })));
  const all = JSON.stringify([c.db.table('identity_rate_limits'), c.db.table('identity_auth_reservations'), c.db.table('identity_events')]);
  for (const clear of [OWNER.email, IP, 'wrong guess', 'nordla-test']) assert.ok(!all.includes(clear), 'clear value stored');
  for (const r of c.db.table('identity_rate_limits')) assert.match(r.subject_hmac, /^[0-9a-f]{64}$/);
});
