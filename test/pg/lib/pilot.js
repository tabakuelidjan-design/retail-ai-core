// Shared helpers for the PILOT narrow-role tests (local, disposable databases only).
import pg from 'pg';
import { clientFor, adminClient, seedMerchants, MERCHANT_A, MERCHANT_B } from './db.js';
import { testUrl } from './safety.js';

export const LOGIN_A = 'nordla_fin_pilot_login_a';
export const LOGIN_B = 'nordla_fin_pilot_login_b';
export const PW = 'pilot_local_test_only'; // a test-only literal for disposable local databases, never a secret

// Two real LOGIN roles, each a member of the pilot role only, each bound (immutably) to one merchant.
// Runs inside the disposable test database (the principal table lives there). Roles are cluster-wide.
export async function setupLogins(db) {
  const a = await clientFor(db.name);
  try {
    await seedMerchants(a); // bindings reference merchants
    for (const l of [LOGIN_A, LOGIN_B]) {
      await a.query(`do $$ begin if not exists (select 1 from pg_roles where rolname='${l}') then create role ${l} login noinherit nobypassrls password '${PW}'; end if; end $$`);
      await a.query(`grant nordla_fin_issuer_pilot, nordla_fin_reader_pilot, nordla_fin_archive_pilot to ${l}`);
    }
    await a.query(`insert into nordla_runtime.fin_pilot_principals (login_role, merchant_id) values ('${LOGIN_A}', '${MERCHANT_A}'), ('${LOGIN_B}', '${MERCHANT_B}') on conflict do nothing`);
  } finally { await a.end(); }
}

export function poolFor(db, login, { max = 3 } = {}) {
  const u = new URL(testUrl());
  u.pathname = `/${db.name}`;
  u.username = login; u.password = PW;
  return new pg.Pool({ connectionString: u.toString(), max });
}

// Removes the cluster-wide test logins and their memberships. Run in an `after()` hook: a leftover login that is a member of
// a pilot role would make every later template replay fail closed (the audit is doing its job).
export async function dropPilotLogins() {
  const a = await adminClient();
  try {
    // templates and test databases may still hold grants to these logins: they are disposable and are removed first
    for (const d of (await a.query("select datname from pg_database where datname like 'finance_test%'")).rows) {
      await a.query(`alter database ${d.datname} is_template false`).catch(() => {});
      await a.query(`drop database if exists ${d.datname} with (force)`);
    }
    for (const l of [LOGIN_A, LOGIN_B, 'nordla_fin_pilot_login', 'nordla_fin_pilot_unbound', 'nordla_fin_arch_login_a', 'nordla_fin_arch_login_b']) {
      await a.query(`do $$ begin if exists (select 1 from pg_roles where rolname='${l}') then revoke nordla_fin_issuer_pilot, nordla_fin_reader_pilot, nordla_fin_archive_pilot from ${l}; execute 'drop owned by ${l}'; execute 'drop role ${l}'; end if; end $$`);
    }
  } finally { await a.end(); }
}
