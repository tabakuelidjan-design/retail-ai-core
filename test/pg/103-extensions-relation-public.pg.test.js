// PILOT v4: PUBLIC privileges on an extensions relation are removed by the migration, and every role that held them keeps them
// (made explicit first). The pilot loses the implicit right. The rollback restores PUBLIC exactly. Covers the path that the
// hosted pg_stat_statements views take (owned by postgres, PUBLIC SELECT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freshDatabase } from './lib/db.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATION = readFileSync(`${ROOT}supabase/migrations/20261120110000_fin_issuer_narrow_role.sql`, 'utf8');
const ROLLBACK = readFileSync(`${ROOT}supabase/rollback/20261120110000_fin_issuer_narrow_role.down.sql`, 'utf8');
const REL = 'extensions.nordla_probe_rel';
const PILOT = 'nordla_fin_issuer_pilot';

test('PUBLIC SELECT on an extensions relation is removed, the roles that held it keep it, the pilot loses it; rollback restores it', async () => {
  const db = await freshDatabase({ fromZero: true, upTo: '20261120085527' });
  const c = await db.open();
  try {
    await c.query(`create table ${REL} (x int)`);
    await c.query(`grant select on ${REL} to public`);
    const rights = async () => (await c.query(`select r.rolname as role, has_table_privilege(r.rolname, '${REL}', 'SELECT') as ok from pg_roles r where r.rolname in ('anon','authenticated','service_role','postgres','${PILOT}') order by 1`)).rows;
    const before = await rights();
    assert.equal(before.find((r) => r.role === 'anon').ok, true, 'anon reads through PUBLIC before');

    await c.query(MIGRATION);
    const after = await rights();
    for (const r of before.filter((x) => x.role !== PILOT)) assert.equal(after.find((x) => x.role === r.role).ok, r.ok, `${r.role} keeps its right`);
    assert.equal(after.find((x) => x.role === PILOT).ok, false, 'the pilot has no right on the probe relation');
    const acl = (await c.query(`select relacl::text as a from pg_class where oid = '${REL}'::regclass`)).rows[0].a;
    // PUBLIC is the grantee with an empty name: an entry that starts with "=" (after "{" or ",")
    assert.ok(!/(^|[{,])=[a-zA-Z]*\//.test(acl), `no PUBLIC entry left in ${acl}`);

    await c.query(ROLLBACK.replace('drop role if exists nordla_fin_issuer_pilot;', ''));
    const restored = await rights();
    assert.equal(restored.find((x) => x.role === 'anon').ok, true, 'rollback: anon reads again');
    assert.equal(restored.find((x) => x.role === PILOT).ok, true, 'rollback: PUBLIC is restored, so the pilot reads again');
  } finally { await c.end(); await db.drop(); }
});
