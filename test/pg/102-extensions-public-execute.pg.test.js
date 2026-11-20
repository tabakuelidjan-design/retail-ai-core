// PILOT v4: consequences of removing PUBLIC EXECUTE on the extensions schema. The effective EXECUTE matrix (every role x every
// extensions function) is captured before and after the pilot migration, and after its rollback.
// Expected: the only change is for the pilot role. Every other role keeps exactly the same rights.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freshDatabase, clientFor } from './lib/db.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATION = readFileSync(`${ROOT}supabase/migrations/20261120110000_fin_issuer_narrow_role.sql`, 'utf8');
const ROLLBACK = readFileSync(`${ROOT}supabase/rollback/20261120110000_fin_issuer_narrow_role.down.sql`, 'utf8');
const PILOT = 'nordla_fin_issuer_pilot';
const MATRIX = `select r.rolname::text as role, f.oid::regprocedure::text as sig, has_function_privilege(r.rolname, f.oid, 'EXECUTE') as ok
  from pg_roles r cross join (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'extensions') f
  where r.rolname not like 'pg\\_%' order by 1, 2`;

const matrix = async (c) => (await c.query(MATRIX)).rows;
const keyed = (rows) => new Map(rows.map((r) => [`${r.role}|${r.sig}`, r.ok]));

test('removing PUBLIC EXECUTE on extensions changes the rights of the pilot role only, and the rollback restores every other right', async () => {
  // a database that has every migration EXCEPT the pilot one (the state of the hosted project before this change)
  const db = await freshDatabase({ fromZero: true, upTo: '20261120085527' });
  const c = await db.open();
  try {
    // the issue role exists before the change (in production it does); the replay of the earlier migrations creates it otherwise
    await c.query('create role nordla_fin_issuer_pilot nologin noinherit').catch(() => {});
    const before = await matrix(c);
    assert.ok(before.length > 100, 'matrix covers every role x extensions function');
    const publicCount = before.filter((r) => r.role === 'anon' && r.ok).length;
    assert.ok(publicCount > 0, 'anon can execute extensions functions before the change (through PUBLIC or explicit grants)');

    await c.query(MIGRATION);
    const after = await matrix(c);
    const b = keyed(before); const a = keyed(after);
    const changed = [...b.keys()].filter((k) => b.get(k) !== a.get(k));
    assert.ok(changed.every((k) => k.startsWith(`${PILOT}|`)), `only the pilot changes; other changes: ${changed.filter((k) => !k.startsWith(`${PILOT}|`)).join(', ')}`);
    assert.ok(changed.length > 0, 'the pilot loses its implicit rights');
    // the pilot keeps exactly the one function it needs
    const pilotNow = after.filter((r) => r.role === PILOT && r.ok).map((r) => r.sig);
    assert.deepEqual(pilotNow, ['extensions.digest(text,text)']);
    // platform roles that depended on PUBLIC keep their rights, now explicit
    for (const role of ['anon', 'authenticated', 'service_role', 'postgres']) {
      assert.deepEqual(after.filter((r) => r.role === role).map((r) => r.ok), before.filter((r) => r.role === role).map((r) => r.ok), `${role}: unchanged rights`);
    }

    await c.query(ROLLBACK.replace('drop role if exists nordla_fin_issuer_pilot;', '')); // role drop is cluster-wide, see the rollback header
    const restored = keyed(await matrix(c));
    const diff = [...b.keys()].filter((k) => !k.startsWith(`${PILOT}|`) && b.get(k) !== restored.get(k));
    assert.deepEqual(diff, [], 'after rollback every role other than the pilot has its original rights');
  } finally { await c.end(); await db.drop(); }
});
