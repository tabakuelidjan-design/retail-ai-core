// Core C1a - Nordla server sessions (src/identity/sessions.js, ADR 0004). Synthetic identifiers, fixed clock, in-memory database
// with the migration's rules (test/fixtures/identity-db.js) that records every read and write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createIdentityDb } from './fixtures/identity-db.js';
import { loadIdentityConfig } from '../src/identity/config.js';
import {
  createSessionStore, generateSessionToken, hashSessionToken, IdentityError, IDENTITY_ERROR_CODES, TOKEN_BYTES, REFUSAL_REASONS,
} from '../src/identity/sessions.js';

const MERCHANT_A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const MERCHANT_B = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';
const USER_U = '11111111-2222-4333-8444-555555555555';
const USER_V = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const T0 = new Date('2026-09-28T08:00:00.000Z');
const MIN = 60_000; const HOUR = 60 * MIN;

/** A store on a fresh database with a controllable clock. */
function setup({ config = loadIdentityConfig({}) } = {}) {
  const clock = { t: T0.getTime() };
  const db = createIdentityDb({ merchants: [MERCHANT_A, MERCHANT_B] });
  const store = createSessionStore({ supabase: db.supabase, config, now: () => new Date(clock.t) });
  const at = (offsetMs) => { clock.t = T0.getTime() + offsetMs; };
  return { db, store, at, clock };
}
const A_GROWTH = { merchantId: MERCHANT_A, module: 'growth' };

// ---------- token and hash ----------
test('token: 32 cryptographically random bytes, base64url, different every time; only a 64-hex SHA-256 is derived from it', () => {
  const t1 = generateSessionToken(); const t2 = generateSessionToken();
  assert.equal(TOKEN_BYTES, 32);
  assert.equal(Buffer.from(t1, 'base64url').length, 32);
  assert.match(t1, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(t1, t2);
  assert.match(hashSessionToken(t1), /^[0-9a-f]{64}$/);
  assert.equal(hashSessionToken(t1), createHash('sha256').update(t1).digest('hex'));
  assert.throws(() => generateSessionToken(() => Buffer.alloc(16)), (e) => e instanceof IdentityError);
});

test('create: the raw token is never stored - only its hash, unique, with user, merchant and module', async () => {
  const { db, store } = setup();
  const { token, session } = await store.create({ userId: USER_U, ...A_GROWTH });
  const rows = db.table('app_sessions');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, hashSessionToken(token));
  assert.ok(!JSON.stringify(rows).includes(token), 'the raw token must not appear anywhere in the stored rows');
  assert.deepEqual([rows[0].user_id, rows[0].merchant_id, rows[0].module], [USER_U, MERCHANT_A, 'growth']);
  // what callers get back never carries the hash
  assert.ok(!('tokenHash' in session) && !JSON.stringify(session).includes(rows[0].token_hash));
  // a second session never reuses a hash
  const second = await store.create({ userId: USER_U, ...A_GROWTH });
  assert.notEqual(hashSessionToken(second.token), rows[0].token_hash);
});

test('create: fixed clock -> created_at = last_seen_at = now, expires_at = now + 12 h; invalid arguments refused without echoing them', async () => {
  const { store } = setup();
  const { session } = await store.create({ userId: USER_U, ...A_GROWTH });
  assert.equal(session.createdAt, T0.toISOString());
  assert.equal(session.lastSeenAt, T0.toISOString());
  assert.equal(session.expiresAt, new Date(T0.getTime() + 12 * HOUR).toISOString());
  for (const bad of [{ userId: 'not-a-uuid', ...A_GROWTH }, { userId: USER_U, merchantId: 'x', module: 'growth' }, { userId: USER_U, merchantId: MERCHANT_A, module: 'Growth Admin' }]) {
    await assert.rejects(store.create(bad), (e) => e instanceof IdentityError && e.code === IDENTITY_ERROR_CODES.INVALID_ARGUMENT
      && !e.message.includes('not-a-uuid') && !e.message.includes('Growth Admin'));
  }
  // a session always belongs to a user, a merchant and a module
  await assert.rejects(store.create({ merchantId: MERCHANT_A, module: 'growth' }), IdentityError);
  await assert.rejects(store.create({ userId: USER_U, module: 'growth' }), IdentityError);
  await assert.rejects(store.create({ userId: USER_U, merchantId: MERCHANT_A }), IdentityError);
});

test('validate: a fresh session is accepted for its merchant and module', async () => {
  const { store } = setup();
  const { token, session } = await store.create({ userId: USER_U, ...A_GROWTH });
  const r = await store.validate(token, A_GROWTH);
  assert.equal(r.ok, true);
  assert.equal(r.session.id, session.id);
  assert.equal(r.session.userId, USER_U);
});

test('validate: malformed and unknown tokens are refused; a malformed token costs no database call', async () => {
  const { db, store } = setup();
  db.reset();
  for (const t of [undefined, '', 'short', 'x'.repeat(44), 'a'.repeat(42) + '!']) assert.deepEqual(await store.validate(t, A_GROWTH), { ok: false, reason: 'MALFORMED' });
  assert.equal(db.calls.length, 0);
  assert.deepEqual(await store.validate(generateSessionToken(), A_GROWTH), { ok: false, reason: 'UNKNOWN' });
  assert.ok(REFUSAL_REASONS.includes('UNKNOWN'));
});

// ---------- expiry ----------
test('absolute expiry: refused at 12 h even for a session used every 10 minutes', async () => {
  const { store, at } = setup();
  const { token } = await store.create({ userId: USER_U, ...A_GROWTH });
  for (let m = 10; m < 12 * 60; m += 10) { at(m * MIN); assert.equal((await store.validate(token, A_GROWTH)).ok, true, `still valid at ${m} min`); }
  at(12 * HOUR - 1); assert.equal((await store.validate(token, A_GROWTH)).ok, true);
  at(12 * HOUR); assert.deepEqual(await store.validate(token, A_GROWTH), { ok: false, reason: 'EXPIRED' });
});

test('inactivity expiry: valid at 1 h 59 min 59 s of inactivity, refused at 2 h; a refusal writes nothing', async () => {
  const { db, store, at } = setup();
  const { token } = await store.create({ userId: USER_U, ...A_GROWTH });
  const b = await setup(); // independent twin to test the exact boundary without the touch of the first check
  const twin = await b.store.create({ userId: USER_U, ...A_GROWTH });
  at(2 * HOUR - 1000); assert.equal((await store.validate(token, A_GROWTH)).ok, true);
  b.at(2 * HOUR); db.reset(); b.db.reset();
  assert.deepEqual(await b.store.validate(twin.token, A_GROWTH), { ok: false, reason: 'IDLE_EXPIRED' });
  assert.equal(b.db.writes(), 0);
});

// ---------- last_seen_at write limit ----------
test('activity: validations inside the 5-minute window write nothing; the first one after it writes exactly once', async () => {
  const { db, store, at } = setup();
  const { token } = await store.create({ userId: USER_U, ...A_GROWTH });
  db.reset();
  for (const s of [1, 30, 60, 120, 240, 299]) { at(s * 1000); assert.equal((await store.validate(token, A_GROWTH)).ok, true); }
  assert.equal(db.writes(), 0, 'no write before 5 minutes');
  assert.equal(db.calls.filter((c) => c.op === 'select').length, 6, 'one read per validation');
  at(5 * MIN); const r = await store.validate(token, A_GROWTH);
  assert.equal(db.writes(), 1, 'exactly one write at 5 minutes');
  assert.deepEqual(db.calls.at(-1), { op: 'update', table: 'app_sessions', keys: ['last_seen_at'] });
  assert.equal(r.session.lastSeenAt, new Date(T0.getTime() + 5 * MIN).toISOString());
  for (const s of [301, 400, 599]) { at(s * 1000); await store.validate(token, A_GROWTH); }
  assert.equal(db.writes(), 1, 'the window restarts from the new last_seen_at');
  at(10 * MIN); await store.validate(token, A_GROWTH);
  assert.equal(db.writes(), 2);
});

test('activity: the 2-hour inactivity rule stays correct with the write limit', async () => {
  // used every 4 minutes for 3 hours: writes happen every other check, the session never expires for inactivity
  const s1 = setup();
  const one = await s1.store.create({ userId: USER_U, ...A_GROWTH });
  s1.db.reset();
  for (let m = 4; m <= 180; m += 4) { s1.at(m * MIN); assert.equal((await s1.store.validate(one.token, A_GROWTH)).ok, true, `valid at ${m} min`); }
  assert.equal(s1.db.writes(), 22, 'one write every 8 minutes (every other check), never one per request');
  // last written activity at 0 (a check at 4:59 does not write): inactivity is measured from the last WRITTEN activity
  const s2 = setup();
  const two = await s2.store.create({ userId: USER_U, ...A_GROWTH });
  s2.at(5 * MIN - 1000); assert.equal((await s2.store.validate(two.token, A_GROWTH)).ok, true);
  s2.at(2 * HOUR); assert.deepEqual(await s2.store.validate(two.token, A_GROWTH), { ok: false, reason: 'IDLE_EXPIRED' });
});

test('touch() on its own follows the same limit', async () => {
  const { db, store, at } = setup();
  const { session } = await store.create({ userId: USER_U, ...A_GROWTH });
  db.reset();
  at(4 * MIN); assert.equal(await store.touch(session), session); assert.equal(db.writes(), 0);
  at(6 * MIN); const t = await store.touch(session); assert.equal(db.writes(), 1);
  assert.equal(t.lastSeenAt, new Date(T0.getTime() + 6 * MIN).toISOString());
});

// ---------- revocation and logout ----------
test('revoke: a revoked session is refused; revoking again is a no-op that keeps the first reason', async () => {
  const { db, store, at } = setup();
  const { token, session } = await store.create({ userId: USER_U, ...A_GROWTH });
  at(MIN); assert.deepEqual(await store.revoke(session.id, { reason: 'REVOKED' }), { revoked: true });
  assert.deepEqual(await store.validate(token, A_GROWTH), { ok: false, reason: 'REVOKED' });
  at(2 * MIN); assert.deepEqual(await store.revoke(session.id, { reason: 'LOGOUT' }), { revoked: false });
  const row = db.table('app_sessions')[0];
  assert.equal(row.revoked_reason, 'REVOKED');
  assert.equal(row.revoked_at, new Date(T0.getTime() + MIN).toISOString());
  await assert.rejects(store.revoke(session.id, { reason: 'WHATEVER' }), (e) => e.code === IDENTITY_ERROR_CODES.INVALID_ARGUMENT);
});

test('logoutCurrent: closes this module\'s session only, is idempotent, and ignores tokens of another merchant or module', async () => {
  const { db, store } = setup();
  const growth = await store.create({ userId: USER_U, ...A_GROWTH });
  const finance = await store.create({ userId: USER_U, merchantId: MERCHANT_A, module: 'finance' });
  const r = await store.logoutCurrent(growth.token, A_GROWTH);
  assert.deepEqual(r, { revoked: true, sessionId: growth.session.id, userId: USER_U });
  assert.equal((await store.validate(growth.token, A_GROWTH)).reason, 'REVOKED');
  assert.equal((await store.validate(finance.token, { merchantId: MERCHANT_A, module: 'finance' })).ok, true, 'the Finance session is untouched');
  db.reset();
  assert.equal((await store.logoutCurrent(growth.token, A_GROWTH)).revoked, false);
  assert.equal(db.writes(), 0, 'a second logout writes nothing');
  // a token presented to the wrong module or merchant cannot close that session
  assert.equal((await store.logoutCurrent(finance.token, A_GROWTH)).revoked, false);
  assert.equal((await store.logoutCurrent(finance.token, { merchantId: MERCHANT_B, module: 'finance' })).revoked, false);
  assert.equal((await store.validate(finance.token, { merchantId: MERCHANT_A, module: 'finance' })).ok, true);
  assert.deepEqual(await store.logoutCurrent('garbage', A_GROWTH), { revoked: false, sessionId: null, userId: null });
});

test('logoutEverywhere: every session of the user in every merchant and module, nobody else\'s; idempotent', async () => {
  const { store } = setup();
  const mine = [
    await store.create({ userId: USER_U, merchantId: MERCHANT_A, module: 'growth' }),
    await store.create({ userId: USER_U, merchantId: MERCHANT_A, module: 'finance' }),
    await store.create({ userId: USER_U, merchantId: MERCHANT_B, module: 'analytics' }),
  ];
  const other = await store.create({ userId: USER_V, merchantId: MERCHANT_A, module: 'growth' });
  assert.deepEqual(await store.logoutEverywhere(USER_U), { revoked: 3 });
  for (const s of mine) assert.equal((await store.validate(s.token, { merchantId: s.session.merchantId, module: s.session.module })).reason, 'REVOKED');
  assert.equal((await store.validate(other.token, A_GROWTH)).ok, true, 'another user is not logged out');
  assert.deepEqual(await store.logoutEverywhere(USER_U), { revoked: 0 });
  await assert.rejects(store.logoutEverywhere('nope'), IdentityError);
});

// ---------- isolation ----------
test('isolation: a token only opens its own merchant and its own module; users never see each other\'s session', async () => {
  const { store } = setup();
  const u = await store.create({ userId: USER_U, ...A_GROWTH });
  const v = await store.create({ userId: USER_V, ...A_GROWTH });
  assert.deepEqual(await store.validate(u.token, { merchantId: MERCHANT_B, module: 'growth' }), { ok: false, reason: 'WRONG_MERCHANT' });
  assert.deepEqual(await store.validate(u.token, { merchantId: MERCHANT_A, module: 'finance' }), { ok: false, reason: 'WRONG_MODULE' });
  assert.equal((await store.validate(u.token, A_GROWTH)).session.userId, USER_U);
  assert.equal((await store.validate(v.token, A_GROWTH)).session.userId, USER_V);
  await store.revoke(v.session.id);
  assert.equal((await store.validate(u.token, A_GROWTH)).ok, true, 'revoking V never touches U');
});

// ---------- configuration ----------
test('the store follows the configured durations (shorter lifetime, shorter inactivity)', async () => {
  const { store, at } = setup({ config: loadIdentityConfig({ NORDLA_SESSION_ABSOLUTE_HOURS: '1', NORDLA_SESSION_IDLE_MINUTES: '30', NORDLA_SESSION_TOUCH_MINUTES: '2' }) });
  const { token, session } = await store.create({ userId: USER_U, ...A_GROWTH });
  assert.equal(session.expiresAt, new Date(T0.getTime() + HOUR).toISOString());
  at(30 * MIN); assert.deepEqual(await store.validate(token, A_GROWTH), { ok: false, reason: 'IDLE_EXPIRED' });
});

// ---------- errors never leak ----------
test('database errors become a fixed message: no token, no token hash, no database text', async () => {
  const { db, store } = setup();
  const token = generateSessionToken(randomBytes);
  const hash = hashSessionToken(token);
  const leaky = new Error(`Supabase REST GET /app_sessions?token_hash=eq.${hash}&token=${token} -> HTTP 500: boom`);
  for (const run of [() => store.validate(token, A_GROWTH), () => store.create({ userId: USER_U, ...A_GROWTH }), () => store.logoutEverywhere(USER_U)]) {
    db.failNextWith(leaky);
    await assert.rejects(run(), (e) => {
      const everything = `${e.message} ${JSON.stringify(e.detail)} ${e.stack}`;
      return e instanceof IdentityError && e.code === IDENTITY_ERROR_CODES.SESSION_STORE_FAILED && !everything.includes(hash) && !everything.includes(token) && !everything.includes('boom');
    });
  }
});

test('the module exposes session functions only - no cookie, no HTTP, no Supabase Auth', async () => {
  const { store } = setup();
  assert.deepEqual(Object.keys(store).sort(), ['create', 'logoutCurrent', 'logoutEverywhere', 'revoke', 'touch', 'validate']);
  const src = (await import('node:fs')).readFileSync(new URL('../src/identity/sessions.js', import.meta.url), 'utf8');
  for (const word of ['Set-Cookie', 'createServer', '/auth/v1', 'console.']) assert.ok(!src.includes(word), `sessions.js must not contain ${word}`);
});
