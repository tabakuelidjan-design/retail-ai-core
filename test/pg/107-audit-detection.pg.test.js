// PILOT v6: every excessive right is introduced on purpose and must be detected by the audit that owns it. Each change is
// reverted in finally blocks (role memberships and attributes are cluster-wide).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './lib/db.js';
import { dropPilotLogins } from './lib/pilot.js';

after(dropPilotLogins);
const READER = 'nordla_fin_reader_pilot';
const ISSUER = 'nordla_fin_issuer_pilot';
const reader = async (c) => (await c.query('select check_name from nordla_runtime.fin_pilot_reader_audit() where not ok')).rows.map((r) => r.check_name);
const transfer = async (c) => (await c.query('select check_name from nordla_runtime.fin_pilot_transfer_audit() where not ok')).rows.map((r) => r.check_name);
const detects = (names, re) => names.some((n) => re.test(n));
async function withDb(fn) {
  const db = await freshDatabase();
  const c = await db.open();
  try { return await fn(c); } finally { await c.end(); await db.drop(); }
}
async function probeLogin(c, name, extra = '') {
  await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname='${name}') then create role ${name} login noinherit password 'x' ${extra}; end if; end $$`);
}
async function dropProbe(c, name) {
  await c.query(`do $$ begin if exists (select 1 from pg_roles where rolname='${name}') then revoke all privileges on all tables in schema public from ${name}; execute 'drop owned by ${name}'; execute 'drop role ${name}'; end if; end $$`);
}

test('the clean state is green for both audits (baseline for the detections below)', async () => {
  await withDb(async (c) => {
    assert.deepEqual(await reader(c), []);
    assert.deepEqual(await transfer(c), []);
  });
});

test('reader: an extra EXECUTE on an extensions function is detected', async () => {
  await withDb(async (c) => {
    await c.query(`grant execute on function extensions.digest(text, text) to ${READER}`);
    assert.ok(detects(await reader(c), /reader privileges/), 'extensions EXECUTE detected');
    await c.query(`revoke execute on function extensions.digest(text, text) from ${READER}`);
    assert.deepEqual(await reader(c), []);
  });
});

test('reader: a PUBLIC table in the extensions schema is detected', async () => {
  await withDb(async (c) => {
    await c.query('create table extensions.nordla_audit_probe_rel (x int)');
    await c.query('grant select on extensions.nordla_audit_probe_rel to public');
    assert.ok(detects(await reader(c), /reader privileges/), 'PUBLIC SELECT on an extensions relation detected');
    await c.query('drop table extensions.nordla_audit_probe_rel');
  });
});

test('reader: a read on a table outside its set is detected', async () => {
  await withDb(async (c) => {
    await c.query(`grant select on public.fin_bank_transactions to ${READER}`);
    assert.ok(detects(await reader(c), /reader privileges/));
    await c.query(`revoke select on public.fin_bank_transactions from ${READER}`);
  });
});

test('reader: a privilege with the grant option (it could be passed on) is detected', async () => {
  await withDb(async (c) => {
    await c.query(`grant select on public.fin_documents to ${READER} with grant option`);
    assert.ok(detects(await reader(c), /grant option/), 'grant option detected');
    await c.query(`revoke grant option for select on public.fin_documents from ${READER}`);
    assert.deepEqual(await reader(c), []);
  });
});

test('reader: a platform schema owned by the reader role is detected (or the platform refuses the change)', async () => {
  await withDb(async (c) => {
    let changed = true;
    try { await c.query(`alter schema nordla_runtime owner to ${READER}`); } catch (e) { changed = false; assert.match(String(e.message), /must be|permission|denied/i, 'the platform refuses the ownership change'); }
    if (changed) {
      try { assert.ok(detects(await reader(c), /no pilot role owns a platform schema/), 'schema ownership detected'); }
      finally { await c.query('alter schema nordla_runtime owner to postgres'); }
    }
  });
});

test('reader: a privileged login that is a member of the reader role is detected', async () => {
  await withDb(async (c) => {
    await probeLogin(c, 'nordla_audit_probe_priv', 'bypassrls');
    await c.query(`grant ${READER} to nordla_audit_probe_priv`);
    try {
      assert.ok(detects(await reader(c), /member of the reader role is unprivileged/), 'privileged member detected');
    } finally { await c.query(`revoke ${READER} from nordla_audit_probe_priv`); await dropProbe(c, 'nordla_audit_probe_priv'); }
    assert.deepEqual(await reader(c), []);
  });
});

test('reader: an ADMIN OPTION held by a non-platform login (it could grant the role onward) is detected', async () => {
  await withDb(async (c) => {
    await probeLogin(c, 'nordla_audit_probe_admin');
    await c.query(`grant ${READER} to nordla_audit_probe_admin with admin option`);
    try {
      assert.ok(detects(await reader(c), /no ADMIN OPTION/), 'ADMIN OPTION detected');
    } finally { await c.query(`revoke ${READER} from nordla_audit_probe_admin`); await dropProbe(c, 'nordla_audit_probe_admin'); }
    assert.deepEqual(await reader(c), []);
  });
});

test('reader: membership of the reader role in another role is detected', async () => {
  await withDb(async (c) => {
    await c.query(`grant service_role to ${READER}`);
    try {
      assert.ok(detects(await reader(c), /reader role is a member of no role/), 'reader member of service_role detected');
    } finally { await c.query(`revoke service_role from ${READER}`); }
    assert.deepEqual(await reader(c), []);
  });
});

test('issue role: a privilege with the grant option is detected by the transfer audit', async () => {
  await withDb(async (c) => {
    await c.query(`grant select on public.fin_documents to ${ISSUER} with grant option`);
    assert.ok(detects(await transfer(c), /grant option/));
    await c.query(`revoke grant option for select on public.fin_documents from ${ISSUER}`);
    assert.deepEqual(await transfer(c), []);
  });
});

test('issue role: an ADMIN OPTION held by a non-platform login is detected by the transfer audit', async () => {
  await withDb(async (c) => {
    await probeLogin(c, 'nordla_audit_probe_issuer_admin');
    await c.query(`grant ${ISSUER} to nordla_audit_probe_issuer_admin with admin option`);
    try {
      assert.ok(detects(await transfer(c), /no ADMIN OPTION/));
    } finally { await c.query(`revoke ${ISSUER} from nordla_audit_probe_issuer_admin`); await dropProbe(c, 'nordla_audit_probe_issuer_admin'); }
    assert.deepEqual(await transfer(c), []);
  });
});
