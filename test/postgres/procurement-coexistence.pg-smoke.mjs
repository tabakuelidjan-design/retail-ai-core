// REAL PostgreSQL proof, on a THROW-AWAY container (never a shared database), of what cannot be seen from the unit tests:
//   1. COEXISTENCE with chantier A's prepared migrations (supabase/migrations-pending of the convergence line), in BOTH orders (A then C, C then A):
//      every statement applies, the global invariants A checks still hold (0 public table without RLS, 0 RLS table without policy, 0 permissive policy on the
//      new tables), the client roles are denied on proc_*, and merchant isolation holds at the database level;
//   2. RESTART RECOVERY: the container is stopped and started again; every row and every balance is still there and balances still equal the ledger;
//   3. BACKUP / RESTORE: pg_dump of the proc_* tables, restored into a fresh database prepared the same way; the restored ledger and balances are identical.
//
//   node test/postgres/procurement-coexistence.pg-smoke.mjs        (needs Docker and git; not part of `npm test`)
//   CONVERGENCE_REF=origin/integration/nordla-convergence-v1 (default) is where A's migrations are read from with `git show` (nothing is checked out or modified).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NAME = 'nordla-pg-coexistence'; const IMAGE = process.env.PG_SMOKE_IMAGE ?? 'postgres:17';
const REF = process.env.CONVERGENCE_REF ?? 'origin/integration/nordla-convergence-v1';
const results = [];
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const sleepMs = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
const check = (name, cond, detail = '') => { results.push(Boolean(cond)); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) { console.error('STOP: Docker is required.'); process.exit(2); }

// A's migrations, read straight from git (the working tree and the branch are untouched)
const gitRead = (...args) => { const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) { console.error(`STOP: git ${args.join(' ')} failed: ${r.stderr}`); process.exit(2); } return r.stdout; };
const sqlIn = (dir) => gitRead('ls-tree', '--name-only', REF, `${dir}/`).split(String.fromCharCode(10)).filter((f) => f.endsWith('.sql')).sort().map((f) => [f.split('/').pop(), gitRead('show', `${REF}:${f}`)]);
const BASE = sqlIn('supabase/migrations').map(([, s]) => s);
const A_PENDING = sqlIn('supabase/migrations-pending').filter(([f]) => !/procurement/.test(f));
const sqlOf = (dir, f) => readFileSync(join(dir, f), 'utf8');
const C_PENDING = ['20261016090000_procurement_stock.sql', '20261016091000_procurement_permissions.sql'].map((f) => [f, sqlOf(join(ROOT, 'supabase/migrations-pending'), f)]);

const STUBS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  create schema if not exists extensions; create extension if not exists pgcrypto schema extensions;
  create schema if not exists storage; create table if not exists storage.buckets (id text primary key, name text not null, public boolean default false);
  create schema if not exists auth; create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
  create or replace function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
  grant usage on schema public, extensions to anon, authenticated, service_role;
  grant execute on all functions in schema extensions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`;

const psql = (db, text) => { const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', db, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], text); return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
const one = (db, q) => psql(db, q).out;
const applyAll = (db, files) => files.every(([f, s]) => { const r = psql(db, `begin;\n${s}\ncommit;`); if (!r.ok) check(`apply ${f} on ${db}`, false, r.err); return r.ok; });

const M1 = '00000000-0000-4000-8000-0000000000a1'; const M2 = '00000000-0000-4000-8000-0000000000b2';
const SEED = `
  insert into merchants (id, name) values ('${M1}', 'coexist A'), ('${M2}', 'coexist B') on conflict do nothing;
  insert into proc_locations (id, merchant_id, name, type) values ('00000000-0000-4000-8000-0000000000c1', '${M1}', 'Entrepôt', 'WAREHOUSE'), ('00000000-0000-4000-8000-0000000000c2', '${M2}', 'Entrepôt', 'WAREHOUSE');
  insert into proc_items (id, merchant_id, sku, name) values ('00000000-0000-4000-8000-0000000000d1', '${M1}', 'SKU-1', 'Magnet'), ('00000000-0000-4000-8000-0000000000d2', '${M2}', 'SKU-1', 'Magnet');
  insert into proc_stock_movements (merchant_id, idempotency_key, item_id, location_id, bucket, delta, kind, actor_id) values
    ('${M1}', 'k1', '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', 'ON_HAND', 10, 'RECEIPT', 't'),
    ('${M1}', 'k2', '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', 'ON_HAND', 5, 'RECEIPT', 't'),
    ('${M2}', 'k1', '00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000c2', 'ON_HAND', 3, 'RECEIPT', 't');`;
const FINGERPRINT = `select (select count(*) from proc_locations)||'/'||(select count(*) from proc_items)||'/'||(select count(*) from proc_stock_movements)||'/'||(select coalesce(sum(on_hand),0) from proc_stock_balances)||'/'||(select count(*) from (select b.merchant_id, b.item_id, b.location_id from proc_stock_balances b join (select merchant_id, item_id, location_id, sum(delta) filter (where bucket='ON_HAND') oh from proc_stock_movements group by 1,2,3) m using (merchant_id, item_id, location_id) where b.on_hand <> m.oh) x)`;

docker(['rm', '-f', NAME]);
if (docker(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=coexist', IMAGE]).status !== 0) process.exit(2);
const waitReady = () => { const ready = () => ((docker(['logs', NAME]).stderr ?? '') + (docker(['logs', NAME]).stdout ?? '')).split('database system is ready to accept connections').length - 1; for (let i = 0; i < 90 && ready() < 2; i += 1) sleepMs(1000); for (let i = 0; i < 30 && !psql('postgres', 'select 1').ok; i += 1) sleepMs(1000); };
try {
  waitReady();
  const prepare = (db) => { check(`database ${db} created`, psql('postgres', `create database ${db};`).ok); psql(db, STUBS); return BASE.every((s, i) => { const r = psql(db, `begin;\n${s}\ncommit;`); if (!r.ok) check(`convergence migration #${i} applies on ${db}`, false, r.err); return r.ok; }); };

  // ---------------------------------------------------------------- 1. coexistence, both orders
  for (const [db, order] of [['coexist_a_then_c', [A_PENDING, C_PENDING]], ['coexist_c_then_a', [C_PENDING, A_PENDING]]]) {
    check(`${db}: the convergence base migrations apply`, prepare(db));
    const ok = order.every((files) => applyAll(db, files));
    check(`${db}: A's pending (${A_PENDING.length} files) and C's pending (${C_PENDING.length} files) apply in this order, one transaction each`, ok);
    if (!ok) continue;
    check(`${db}: 0 public table without RLS`, one(db, `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity`) === '0');
    check(`${db}: 0 RLS table without a policy`, one(db, `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid=c.oid)`) === '0');
    check(`${db}: no permissive policy on any proc_ table`, one(db, `select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname like 'proc\\_%' and p.polpermissive`) === '0');
    check(`${db}: 17 proc_ tables next to A's integration_ tables (no name collision)`, one(db, `select (select count(*) from pg_class where relname like 'proc\\_%' and relkind='r')||'/'||(select count(*) from pg_class where relname in ('integration_purchase_plans','integration_incoming_expectations','sourcing_cases') and relkind='r')`) === '17/3');
    check(`${db}: no function without a fixed search_path was added by C`, one(db, `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'proc\\_%' and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')`) === '0');
    check(`${db}: data can be written by the owner role`, psql(db, SEED).ok);
    check(`${db}: the balance trigger kept the ledger sum (15 for merchant A, 3 for B) and no balance differs from its ledger`, one(db, FINGERPRINT) === '2/2/3/18/0', one(db, FINGERPRINT));
    // merchant isolation at the database level
    check(`${db}: the same SKU exists for two merchants (unique per merchant, not global)`, one(db, `select count(*) from proc_items where sku='SKU-1'`) === '2');
    check(`${db}: a movement cannot point at another merchant's item (composite foreign key)`, !psql(db, `insert into proc_stock_movements (merchant_id, idempotency_key, item_id, location_id, bucket, delta, kind, actor_id) values ('${M1}', 'cross', '00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000c1', 'ON_HAND', 1, 'RECEIPT', 't')`).ok);
    check(`${db}: the idempotency key is unique per merchant only (M1 and M2 both used 'k1')`, !psql(db, `insert into proc_stock_movements (merchant_id, idempotency_key, item_id, location_id, bucket, delta, kind, actor_id) values ('${M1}', 'k1', '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', 'ON_HAND', 1, 'RECEIPT', 't')`).ok);
    // roles
    for (const role of ['anon', 'authenticated']) {
      check(`${db}: ${role} cannot read the ledger`, !psql(db, `set role ${role}; select count(*) from proc_stock_movements;`).ok);
      check(`${db}: ${role} cannot write the ledger`, !psql(db, `set role ${role}; insert into proc_stock_movements (merchant_id, idempotency_key, item_id, location_id, bucket, delta, kind, actor_id) values ('${M1}', 'z', '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', 'ON_HAND', 1, 'RECEIPT', 't')`).ok);
    }
    check(`${db}: service_role reads but cannot UPDATE or DELETE the ledger`, psql(db, `set role service_role; select count(*) from proc_stock_movements;`).ok && !psql(db, `set role service_role; update proc_stock_movements set delta = 99;`).ok && !psql(db, `set role service_role; delete from proc_stock_movements;`).ok);
    check(`${db}: the owner role cannot rewrite the ledger either (append-only trigger)`, !psql(db, `update proc_stock_movements set delta = 99;`).ok && !psql(db, `truncate proc_stock_movements cascade;`).ok);
    check(`${db}: A's own objects still refuse the client roles`, !psql(db, `set role authenticated; select count(*) from integration_purchase_plans;`).ok);
  }

  // ---------------------------------------------------------------- 2. restart recovery (stop / start the whole database server)
  const before = one('coexist_a_then_c', FINGERPRINT);
  check('server stopped and started (data directory kept)', docker(['restart', NAME]).status === 0); waitReady();
  check('restart: every row and every balance is back, balances equal the ledger', one('coexist_a_then_c', FINGERPRINT) === before && before === '2/2/3/18/0', `${before} -> ${one('coexist_a_then_c', FINGERPRINT)}`);
  check('restart: the ledger is still append-only and the next movement still posts', !psql('coexist_a_then_c', `update proc_stock_movements set delta = 1;`).ok
    && psql('coexist_a_then_c', `insert into proc_stock_movements (merchant_id, idempotency_key, item_id, location_id, bucket, delta, kind, actor_id) values ('${M1}', 'after-restart', '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', 'ON_HAND', 2, 'RECEIPT', 't')`).ok
    && one('coexist_a_then_c', `select on_hand from proc_stock_balances where merchant_id='${M1}'`) === '17');

  // ---------------------------------------------------------------- 3. backup / restore into a fresh database
  const dump = docker(['exec', NAME, 'sh', '-c', `pg_dump -U postgres -d coexist_a_then_c -Fc -t 'proc_*' -f /tmp/proc.dump && ls -l /tmp/proc.dump`]);
  check('pg_dump of the proc_* tables works', dump.status === 0, dump.stderr);
  check('fresh database prepared the same way (schema only, no procurement data)', prepare('coexist_restored') && applyAll('coexist_restored', [...A_PENDING, ...C_PENDING]));
  psql('coexist_restored', `insert into merchants (id, name) values ('${M1}', 'coexist A'), ('${M2}', 'coexist B') on conflict do nothing;`);
  const restore = docker(['exec', NAME, 'pg_restore', '-U', 'postgres', '-d', 'coexist_restored', '--data-only', '--disable-triggers', '/tmp/proc.dump']);
  check('pg_restore --data-only --disable-triggers (balances come from the dump, not recomputed twice)', restore.status === 0, restore.stderr);
  const now = one('coexist_a_then_c', FINGERPRINT);
  check('the restored database is identical: same counts, same balances, balances equal the ledger', one('coexist_restored', FINGERPRINT) === now && now.endsWith('/0'), `${now} vs ${one('coexist_restored', FINGERPRINT)}`);
  check('the restored database still refuses a ledger rewrite and still posts new movements', !psql('coexist_restored', `delete from proc_stock_movements;`).ok
    && psql('coexist_restored', `insert into proc_stock_movements (merchant_id, idempotency_key, item_id, location_id, bucket, delta, kind, actor_id) values ('${M1}', 'after-restore', '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', 'ON_HAND', 1, 'RECEIPT', 't')`).ok
    && one('coexist_restored', `select on_hand from proc_stock_balances where merchant_id='${M1}'`) === '18');
} finally { if (process.env.KEEP_PG_SMOKE !== '1') docker(['rm', '-f', NAME]); }
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} CHECK(S) FAILED of ${results.length}` : `\nall ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
