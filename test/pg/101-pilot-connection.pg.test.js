// PILOT connection factory: configuration refusals (no database needed), then start-up identity verification on real
// local logins (A bound, B bound, an unbound login refused). No administrative fallback is possible.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, seedMerchants, adminClient, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { testUrl } from './lib/safety.js';
import { checkPilotConfig, createPilotPool, verifyPilotConnection, PilotConnectionError } from '../../src/finance/runtime/pg-connection.js';
import { setupLogins, LOGIN_A, PW } from './lib/pilot.js';

const CA = '-----BEGIN CERTIFICATE-----\nTEST-ONLY-NOT-A-REAL-CERT\n-----END CERTIFICATE-----';
const remote = (login, extra = '') => `postgres://${login}:${PW}@db.example-pilot.invalid:5432/postgres${extra}`;
const refuses = (fn, code) => assert.throws(fn, (e) => e instanceof PilotConnectionError && e.code === code, `expected ${code}`);

test('refuses administrative and platform logins, and non-pilot logins', () => {
  for (const login of ['postgres', 'supabase_admin', 'service_role', 'authenticator', 'anon', 'authenticated', 'nordla_other_app']) {
    refuses(() => checkPilotConfig({ connectionString: remote(login), ca: CA }), 'PILOT_LOGIN_REFUSED');
  }
});

test('remote hosts need a CA and verify-full; plaintext to a remote host is never accepted', () => {
  refuses(() => checkPilotConfig({ connectionString: remote('nordla_fin_pilot_x'), ca: null }), 'PILOT_TLS_CA_REQUIRED');
  refuses(() => checkPilotConfig({ connectionString: remote('nordla_fin_pilot_x', '?sslmode=disable'), ca: CA }), 'PILOT_TLS_MODE_REFUSED');
  refuses(() => checkPilotConfig({ connectionString: remote('nordla_fin_pilot_x', '?sslmode=require'), ca: CA }), 'PILOT_TLS_MODE_REFUSED');
  assert.deepEqual(checkPilotConfig({ connectionString: remote('nordla_fin_pilot_x', '?sslmode=verify-full'), ca: CA }), { login: 'nordla_fin_pilot_x', loopback: false });
});

test('loopback is refused unless the local-test flag is set', () => {
  refuses(() => checkPilotConfig({ connectionString: `postgres://${LOGIN_A}:${PW}@127.0.0.1:5432/x` }), 'PILOT_TLS_REQUIRED');
  assert.equal(checkPilotConfig({ connectionString: `postgres://${LOGIN_A}:${PW}@127.0.0.1:5432/x`, allowLoopbackPlaintext: true }).loopback, true);
});

test('the pool verifies the server with the CA and never accepts an unverified certificate', () => {
  const pool = createPilotPool({ connectionString: remote('nordla_fin_pilot_x'), ca: CA, max: 2 });
  try {
    assert.equal(pool.options.ssl.rejectUnauthorized, true);
    assert.equal(pool.options.ssl.ca, CA);
    assert.equal(pool.options.max, 2);
    assert.equal(pool.options.statement_timeout, 15000);
  } finally { pool.end().catch(() => {}); }
});

test('start-up identity: a login bound to A verifies for A, is refused for B; an unbound login is refused', async () => {
  const db = await freshDatabase();
  const admin = await adminClient();
  const poolA = createPilotPool({ connectionString: (() => { const u = new URL(testUrl()); u.pathname = `/${db.name}`; u.username = LOGIN_A; u.password = PW; return u.toString(); })(), allowLoopbackPlaintext: true, max: 1 });
  try {
    const setup = await db.open();
    await setupLogins(db);
    await seedMerchants(setup);
    await setup.end();
    const who = await verifyPilotConnection(poolA, MERCHANT_A);
    assert.equal(who.sessionUser, LOGIN_A, 'session_user is the bound login');
    await assert.rejects(() => verifyPilotConnection(poolA, MERCHANT_B), (e) => e.code === 'PILOT_IDENTITY_REFUSED');
    await admin.query("do $$ begin if not exists (select 1 from pg_roles where rolname='nordla_fin_pilot_unbound') then create role nordla_fin_pilot_unbound login noinherit password 'pilot_local_test_only'; end if; end $$");
    await admin.query('grant nordla_fin_issuer_pilot to nordla_fin_pilot_unbound');
    const u = new URL(testUrl()); u.pathname = `/${db.name}`; u.username = 'nordla_fin_pilot_unbound'; u.password = PW;
    const unbound = createPilotPool({ connectionString: u.toString(), allowLoopbackPlaintext: true, max: 1 });
    try {
      await assert.rejects(() => verifyPilotConnection(unbound, MERCHANT_A), (e) => e.code === 'PILOT_IDENTITY_REFUSED');
    } finally { await unbound.end(); }
  } finally {
    await poolA.end();
    await admin.end();
    await db.drop();
  }
});

after(async () => {
  const a = await adminClient();
  try {
    await a.query("do $$ begin if exists (select 1 from pg_roles where rolname='nordla_fin_pilot_unbound') then execute 'drop role nordla_fin_pilot_unbound'; end if; end $$");
  } finally { await a.end(); }
});
