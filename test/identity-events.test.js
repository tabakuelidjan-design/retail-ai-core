// Core C1a - append-only security journal (src/identity/events.js, table identity_events). Synthetic identifiers only; the
// forbidden values below are assembled at run time so this file itself contains no credential-shaped literal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createIdentityDb } from './fixtures/identity-db.js';
import { createEventLog, buildEventRow, findForbiddenPaths, IdentityEventError, EVENT_ERROR_CODES, EVENT_TYPES, OUTCOMES } from '../src/identity/events.js';

const MERCHANT_A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const USER_U = '11111111-2222-4333-8444-555555555555';
const SESSION = '22222222-3333-4444-8555-666666666666';
const CORR = '33333333-4444-4555-8666-777777777777';
const T0 = new Date('2026-09-28T08:00:00.000Z');

const setup = () => {
  const db = createIdentityDb({ merchants: [MERCHANT_A] });
  return { db, log: createEventLog({ supabase: db.supabase, now: () => T0, newId: () => CORR }) };
};
const base = { merchantId: MERCHANT_A, userId: USER_U, sessionId: SESSION, module: 'growth', type: 'LOGIN_SUCCEEDED', outcome: 'SUCCESS' };

// values that must never reach the journal (built at run time)
const EMAIL = ['someone', 'shop.example'].join('@');
const JWT = ['ey', 'J', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'c2lnbmF0dXJl'].join('');
const SESSION_TOKEN = randomBytes(32).toString('base64url');
const TOKEN_HASH = createHash('sha256').update(SESSION_TOKEN).digest('hex');
const BEARER = `Bearer ${randomBytes(12).toString('hex')}`;
const SHOP_TOKEN = ['shp', 'at_', randomBytes(8).toString('hex')].join('');

test('a legitimate event is appended with technical identifiers, a fixed time and a correlation id', async () => {
  const { db, log } = setup();
  const r = await log.record({ ...base, entity: { type: 'session', id: SESSION }, detail: { reason: 'password_ok', attempts: 1, via: ['login-form'] } });
  assert.deepEqual(r, { id: 1, correlationId: CORR });
  const [row] = db.table('identity_events');
  assert.deepEqual(row, {
    id: 1, merchant_id: MERCHANT_A, user_id: USER_U, session_id: SESSION, module: 'growth', event_type: 'LOGIN_SUCCEEDED', outcome: 'SUCCESS',
    correlation_id: CORR, entity_type: 'session', entity_id: SESSION, detail: { reason: 'password_ok', attempts: 1, via: ['login-form'] }, occurred_at: T0.toISOString(),
  });
  assert.ok(!Object.keys(row).some((k) => /mail/i.test(k)), 'no e-mail column');
});

test('a system event has no user; a given correlation id is kept; the entity is all-or-nothing', async () => {
  const { db, log } = setup();
  const other = '44444444-5555-4666-8777-888888888888';
  await log.record({ merchantId: MERCHANT_A, module: 'core', type: 'SESSION_EXPIRED', outcome: 'SUCCESS', correlationId: other });
  assert.equal(db.table('identity_events')[0].user_id, null);
  assert.equal(db.table('identity_events')[0].correlation_id, other);
  assert.throws(() => buildEventRow({ ...base, entity: { type: 'session' } }), (e) => e.code === EVENT_ERROR_CODES.EVENT_INVALID);
});

test('invalid events are refused: merchant, user, module, unknown type or outcome, detail shape and size', () => {
  const bad = [
    { ...base, merchantId: undefined }, { ...base, merchantId: 'HABB' }, { ...base, userId: 'owner' }, { ...base, module: 'Growth!' },
    { ...base, type: 'LOGGED_IN' }, { ...base, outcome: 'OK' }, { ...base, detail: [] }, { ...base, detail: 'text' },
    { ...base, detail: { blob: 'x'.repeat(5000) } },
  ];
  for (const e of bad) assert.throws(() => buildEventRow(e), (err) => err instanceof IdentityEventError && err.code === EVENT_ERROR_CODES.EVENT_INVALID);
  assert.ok(EVENT_TYPES.includes('LOGOUT_ALL') && OUTCOMES.includes('DENIED'));
});

test('sensitive keys are refused at any depth, case-insensitively, in objects and arrays', () => {
  const detail = {
    ok: 1,
    Password: 'x',
    nested: { deeper: [{ API_KEY: 'x' }, { list: [{ 'Set-Cookie': 'x' }] }], SessionToken: 'x' },
    headers: { AUTHORIZATION: 'x' }, client_secret: 'x', 'e-mail': 'x', privateKey: 'x', credentials: ['x'],
  };
  assert.deepEqual(findForbiddenPaths(detail).sort(), [
    'Password', 'client_secret', 'credentials', 'e-mail', 'headers.AUTHORIZATION', 'nested.SessionToken', 'nested.deeper[0].API_KEY',
    'nested.deeper[1].list[0].Set-Cookie', 'privateKey',
  ].sort());
});

test('sensitive values are refused whatever their key: e-mail, JWT, bearer, session token, token hash, provider token', async () => {
  const { db, log } = setup();
  for (const [label, value] of [['e-mail', EMAIL], ['JWT', JWT], ['bearer', BEARER], ['session token', SESSION_TOKEN], ['token hash', TOKEN_HASH], ['provider token', SHOP_TOKEN]]) {
    const detail = { context: { items: ['fine', { note: value }] } };
    await assert.rejects(log.record({ ...base, detail }), (e) => {
      const everything = `${e.message} ${JSON.stringify(e.detail)} ${e.stack}`;
      return e instanceof IdentityEventError && e.code === EVENT_ERROR_CODES.EVENT_DETAIL_FORBIDDEN
        && JSON.stringify(e.detail.paths) === JSON.stringify(['context.items[1].note']) && !everything.includes(value);
    }, `${label} must be refused without being repeated`);
  }
  assert.equal(db.table('identity_events').length, 0, 'nothing was written');
});

test('no e-mail in clear anywhere: not as the actor, not as the entity, not in the detail', async () => {
  const { log } = setup();
  await assert.rejects(log.record({ ...base, userId: EMAIL }), (e) => e.code === EVENT_ERROR_CODES.EVENT_INVALID && !e.message.includes(EMAIL));
  await assert.rejects(log.record({ ...base, entity: { type: 'user', id: EMAIL } }), (e) => e.code === EVENT_ERROR_CODES.EVENT_DETAIL_FORBIDDEN && !JSON.stringify(e.detail).includes(EMAIL));
  await assert.rejects(log.record({ ...base, detail: { who: `contact ${EMAIL} today` } }), (e) => e.code === EVENT_ERROR_CODES.EVENT_DETAIL_FORBIDDEN);
});

test('append-only: the log only inserts; the database refuses UPDATE and DELETE on the journal', async () => {
  const { db, log } = setup();
  assert.deepEqual(Object.keys(log), ['record']);
  await log.record(base);
  await assert.rejects(db.supabase.update('identity_events', { id: 'eq.1' }, { outcome: 'FAILURE' }), /append-only/);
  await assert.rejects(db.supabase.delete('identity_events', { id: 'eq.1' }), /append-only/);
  assert.equal(db.table('identity_events')[0].outcome, 'SUCCESS');
  assert.deepEqual(db.calls.map((c) => c.op), ['insert', 'update', 'delete']);
});

test('a journal write failure is reported with a fixed message (no database text)', async () => {
  const { db, log } = setup();
  db.failNextWith(new Error(`Supabase REST POST /identity_events -> HTTP 500: detail ${TOKEN_HASH}`));
  await assert.rejects(log.record(base), (e) => e.code === EVENT_ERROR_CODES.EVENT_STORE_FAILED && !`${e.message}${JSON.stringify(e.detail)}`.includes(TOKEN_HASH));
});
