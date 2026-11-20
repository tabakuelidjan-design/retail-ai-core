// PILOT v3: audit of the role nordla_fin_issuer_pilot itself. The audit is exact (expected privileges, attributes,
// memberships, ownership) and the migration fails closed on a pre-existing or altered role.
// Cluster-wide role changes are always restored in finally blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { freshDatabase, seedMerchants, adminClient } from './lib/db.js';

// Restore the cluster-wide attributes of the pilot role at the end of this file, whatever happened.
after(async () => {
  const a = await adminClient();
  try { await a.query('alter role nordla_fin_issuer_pilot nosuperuser nobypassrls nocreaterole nocreatedb noreplication'); } finally { await a.end(); }
});

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UP = readFileSync(`${ROOT}supabase/migrations/20261120110000_fin_issuer_narrow_role.sql`, 'utf8');

const failing = async (admin) => (await admin.query('select check_name, detail from nordla_runtime.fin_pilot_role_audit() where not ok')).rows.map((r) => r.check_name);

test('a freshly migrated database passes every role check', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    const rows = (await admin.query('select check_name, ok, detail from nordla_runtime.fin_pilot_role_audit()')).rows;
    assert.ok(rows.length >= 7, 'every check is reported');
    assert.deepEqual(rows.filter((r) => !r.ok).map((r) => `${r.check_name} :: ${r.detail}`), []);
  } finally { await admin.end(); await db.drop(); }
});

test('the audit refuses a pilot role with a privileged attribute', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await admin.query('alter role nordla_fin_issuer_pilot bypassrls');
    try {
      assert.ok((await failing(admin)).some((n) => /privileged attribute/.test(n)), 'BYPASSRLS is reported');
    } finally { await admin.query('alter role nordla_fin_issuer_pilot nobypassrls'); }
    assert.deepEqual(await failing(admin), [], 'restored');
  } finally { await admin.end(); await db.drop(); }
});

test('the audit refuses extra privileges on protected tables and on PUBLIC', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await admin.query('grant select on public.fin_bank_transactions to nordla_fin_issuer_pilot');
    assert.ok((await failing(admin)).includes('privileges (direct and PUBLIC, effective ACL) are exactly the expected set'), 'extra SELECT on a bank table is reported');
    await admin.query('revoke select on public.fin_bank_transactions from nordla_fin_issuer_pilot');
    await admin.query('grant select on public.fin_documents to public');
    assert.ok((await failing(admin)).includes('privileges (direct and PUBLIC, effective ACL) are exactly the expected set'), 'PUBLIC read on fin_documents is reported');
    await admin.query('revoke select on public.fin_documents from public');
    assert.deepEqual(await failing(admin), []);
  } finally { await admin.end(); await db.drop(); }
});

test('the audit refuses a pilot role that is a member of another role, or whose members are privileged', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await admin.query('grant service_role to nordla_fin_issuer_pilot');
    try {
      assert.ok((await failing(admin)).includes('pilot is a member of no role (no indirect power, no SET ROLE target)'), 'pilot member of service_role');
    } finally { await admin.query('revoke service_role from nordla_fin_issuer_pilot'); }
    await admin.query("do $$ begin if not exists (select 1 from pg_roles where rolname='nordla_fin_audit_probe') then create role nordla_fin_audit_probe login createrole; end if; end $$");
    await admin.query('grant nordla_fin_issuer_pilot to nordla_fin_audit_probe');
    try {
      assert.ok((await failing(admin)).includes('every member of the pilot role is unprivileged and in no other role'), 'privileged member is reported');
    } finally {
      await admin.query('revoke nordla_fin_issuer_pilot from nordla_fin_audit_probe');
      await admin.query('drop role nordla_fin_audit_probe');
    }
    assert.deepEqual(await failing(admin), []);
  } finally { await admin.end(); await db.drop(); }
});

test('the audit refuses a pilot that owns an object, and an ADMIN OPTION on the pilot role', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await admin.query('create table public.nordla_pilot_owned_probe (x int)');
    await admin.query('alter table public.nordla_pilot_owned_probe owner to nordla_fin_issuer_pilot');
    assert.ok((await failing(admin)).includes('the pilot role owns no object'), 'ownership is reported');
    await admin.query('drop table public.nordla_pilot_owned_probe');
    await admin.query("do $$ begin if not exists (select 1 from pg_roles where rolname='nordla_fin_audit_admin') then create role nordla_fin_audit_admin login; end if; end $$");
    await admin.query('grant nordla_fin_issuer_pilot to nordla_fin_audit_admin with admin option');
    try {
      assert.ok((await failing(admin)).includes('nobody other than the platform owner can grant the pilot role onward (no ADMIN OPTION)'), 'ADMIN OPTION is reported');
    } finally {
      await admin.query('revoke nordla_fin_issuer_pilot from nordla_fin_audit_admin');
      await admin.query('drop role nordla_fin_audit_admin');
    }
    assert.deepEqual(await failing(admin), []);
  } finally { await admin.end(); await db.drop(); }
});

test('the migration fails closed when the pilot role already exists and is too privileged', async () => {
  const db = await freshDatabase();
  const admin = await db.open();
  try {
    await admin.query('alter role nordla_fin_issuer_pilot createrole');
    try {
      await assert.rejects(() => admin.query(UP), /FIN_PILOT_ROLE_UNSAFE/);
    } finally {
      // the failed migration leaves its BEGIN open on this connection: roll it back before restoring the role
      await admin.query('rollback').catch(() => {});
      await admin.query('alter role nordla_fin_issuer_pilot nocreaterole');
    }
  } finally { await admin.end(); await db.drop(); }
});
