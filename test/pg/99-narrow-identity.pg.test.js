// PILOT v2 identity tests on real LOGIN roles: binding, mismatch, privileged or unbound logins, binding immutability.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase, seedMerchants, insertDraft, adminClient, MERCHANT_A, MERCHANT_B } from './lib/db.js';
import { createNarrowIssuePath } from '../../src/finance/runtime/narrow-issue-path.js';
import { setupLogins, poolFor, LOGIN_A, LOGIN_B, PW, dropPilotLogins } from './lib/pilot.js';
import { testUrl } from './lib/safety.js';

// Cluster-wide probe roles are removed at the end of this file: a leftover privileged member of the pilot role would make
// every later migration (and the template) fail closed, which is the intended behaviour of the audit.
after(async () => {
  const a = await adminClient();
  try {
    for (const r of ['nordla_fin_probe_member', 'nordla_fin_probe_bypass', 'nordla_fin_unbound_login', 'nordla_fin_probe_nonmember']) {
      await a.query(`do $$ begin if exists (select 1 from pg_roles where rolname='${r}') then execute 'drop role ${r}'; end if; end $$`);
    }
  } finally { await a.end(); }
});

const msgOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

async function login(admin, name, extra = '') {
  await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname='${name}') then create role ${name} login noinherit password '${PW}' ${extra}; end if; end $$`);
}
const poolAs = (db, name) => {
  const u = new URL(testUrl());
  u.pathname = `/${db.name}`; u.username = name; u.password = PW;
  return new pg.Pool({ connectionString: u.toString(), max: 1 });
};

test('the adapter verifies its identity: a login bound to A asked for B is refused (mismatch)', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    const poolA = poolFor(db, LOGIN_A);
    try {
      const asB = createNarrowIssuePath({ pool: poolA, merchantId: MERCHANT_B });
      assert.match(String(await msgOf(() => asB.verify())), /FIN_PILOT_MERCHANT_MISMATCH/);
      const asA = createNarrowIssuePath({ pool: poolA, merchantId: MERCHANT_A });
      assert.equal(await asA.verify(), true, 'the bound merchant verifies');
    } finally { await poolA.end(); }
  } finally { await admin.end(); await db.drop(); }
});

test('a login with no binding, a disabled binding, or a privileged login is refused before any query', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    await login(admin, 'nordla_fin_unbound_login');
    await admin.query('grant nordla_fin_issuer_pilot to nordla_fin_unbound_login');
    const unbound = poolAs(db, 'nordla_fin_unbound_login');
    try {
      assert.match(String(await msgOf(() => createNarrowIssuePath({ pool: unbound, merchantId: MERCHANT_A }).verify())), /FIN_PILOT_PRINCIPAL_UNKNOWN_OR_DISABLED/, 'no binding');
    } finally { await unbound.end(); }

    await admin.query(`update nordla_runtime.fin_pilot_principals set enabled = false where login_role = '${LOGIN_A}'`);
    const disabled = poolFor(db, LOGIN_A);
    try {
      assert.match(String(await msgOf(() => createNarrowIssuePath({ pool: disabled, merchantId: MERCHANT_A }).verify())), /FIN_PILOT_PRINCIPAL_UNKNOWN_OR_DISABLED/, 'disabled binding (containment)');
    } finally { await disabled.end(); }
    await admin.query(`update nordla_runtime.fin_pilot_principals set enabled = true where login_role = '${LOGIN_A}'`);

    // privileged: a login that is also a member of service_role
    await login(admin, 'nordla_fin_probe_member');
    await admin.query('grant nordla_fin_issuer_pilot, service_role to nordla_fin_probe_member');
    await admin.query(`insert into nordla_runtime.fin_pilot_principals (login_role, merchant_id) values ('nordla_fin_probe_member', '${MERCHANT_A}')`);
    const member = poolAs(db, 'nordla_fin_probe_member');
    try {
      assert.match(String(await msgOf(() => createNarrowIssuePath({ pool: member, merchantId: MERCHANT_A }).verify())), /FIN_PILOT_LOGIN_MEMBERSHIP_FORBIDDEN/, 'member of service_role');
    } finally { await member.end(); }

    // privileged: BYPASSRLS login
    await login(admin, 'nordla_fin_probe_bypass', 'bypassrls');
    await admin.query('grant nordla_fin_issuer_pilot to nordla_fin_probe_bypass');
    await admin.query(`insert into nordla_runtime.fin_pilot_principals (login_role, merchant_id) values ('nordla_fin_probe_bypass', '${MERCHANT_A}')`);
    const bypass = poolAs(db, 'nordla_fin_probe_bypass');
    try {
      assert.match(String(await msgOf(() => createNarrowIssuePath({ pool: bypass, merchantId: MERCHANT_A }).verify())), /FIN_PILOT_LOGIN_PRIVILEGED/, 'BYPASSRLS login');
    } finally { await bypass.end(); }

    // bound but not a member of the pilot role
    await login(admin, 'nordla_fin_probe_nonmember');
    await admin.query(`insert into nordla_runtime.fin_pilot_principals (login_role, merchant_id) values ('nordla_fin_probe_nonmember', '${MERCHANT_A}')`);
    const nonmember = poolAs(db, 'nordla_fin_probe_nonmember');
    try {
      assert.match(String(await msgOf(() => createNarrowIssuePath({ pool: nonmember, merchantId: MERCHANT_A }).verify())), /permission denied to set role|FIN_PILOT_LOGIN_NOT_MEMBER/, 'a login outside the pilot role is refused at SET ROLE');
    } finally { await nonmember.end(); }
  } finally { await admin.end(); await db.drop(); }
});

test('bindings are immutable: login and merchant cannot change, nothing is deleted', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    assert.match(String(await msgOf(() => admin.query(`update nordla_runtime.fin_pilot_principals set merchant_id = '${MERCHANT_B}' where login_role = '${LOGIN_A}'`))), /FIN_PILOT_BINDING_IMMUTABLE/, 'merchant cannot change');
    assert.match(String(await msgOf(() => admin.query(`update nordla_runtime.fin_pilot_principals set login_role = 'x' where login_role = '${LOGIN_A}'`))), /FIN_PILOT_BINDING_IMMUTABLE/, 'login cannot change');
    assert.match(String(await msgOf(() => admin.query(`delete from nordla_runtime.fin_pilot_principals where login_role = '${LOGIN_A}'`))), /FIN_PILOT_BINDING_IMMUTABLE/, 'no delete');
    const still = (await admin.query(`select merchant_id, enabled from nordla_runtime.fin_pilot_principals where login_role = '${LOGIN_A}'`)).rows[0];
    assert.deepEqual(still, { merchant_id: MERCHANT_A, enabled: true });
  } finally { await admin.end(); await db.drop(); }
});

test('the login role cannot read the binding table or call the binding functions with another identity', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  const pool = poolFor(db, LOGIN_B);
  try {
    await setupLogins(db);
    await seedMerchants(admin);
    const c = await pool.connect();
    try {
      assert.equal(await (async () => { try { await c.query('select * from nordla_runtime.fin_pilot_principals'); return null; } catch (e) { return e.code; } })(), '42501', 'no direct read of bindings');
      await c.query('set role nordla_fin_issuer_pilot');
      const me = (await c.query('select nordla_runtime.fin_pilot_bound_merchant() as m')).rows[0].m;
      assert.equal(me, MERCHANT_B, 'the function answers with the login own binding (B), not a caller value');
      await c.query('reset role');
    } finally { c.release(); }
  } finally { await pool.end(); await admin.end(); await db.drop(); }
});

after(dropPilotLogins);
