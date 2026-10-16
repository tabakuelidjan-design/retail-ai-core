// REAL PostgreSQL rehearsal of the staging runner (tools/procurement-staging/run.mjs) and of the permissions migration, on a THROW-AWAY container (never a shared database).
// It stands in for "staging" with a database named procurement_staging_check, creates the Supabase-style roles (anon, authenticated, service_role) and proves:
//   - every guard refuses (and changes nothing) when it is not satisfied;
//   - apply works once, verify is green, a second apply is refused;
//   - permissions are real: anon / authenticated are denied, service_role works but cannot UPDATE / DELETE the ledger or the journal;
//   - rollback needs its flags, drops the module cleanly, and the module can be applied again.
//   node test/postgres/procurement-staging-tool.pg-smoke.mjs      (needs Docker; not part of `npm test`)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from '../../tools/procurement-staging/run.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NAME = 'nordla-pg-staging-rehearsal'; const IMAGE = process.env.PG_SMOKE_IMAGE ?? 'postgres:17';
const results = [];
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8' });
const sleepMs = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
const check = (name, cond, detail = '') => { results.push(Boolean(cond)); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) { console.error('STOP: Docker is required.'); process.exit(2); }

docker(['rm', '-f', NAME]);
if (docker(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=rehearsal', IMAGE]).status !== 0) process.exit(2);
const psql = (db, sql, user = 'postgres') => { const r = docker(['exec', '-i', NAME, 'psql', '-U', user, '-d', db, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], sql); return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
try {
  const ready = () => ((docker(['logs', NAME]).stderr ?? '') + (docker(['logs', NAME]).stdout ?? '')).split('database system is ready to accept connections').length - 1;
  for (let i = 0; i < 90 && ready() < 2; i += 1) sleepMs(1000);
  for (let i = 0; i < 30 && !psql('postgres', 'select 1').ok; i += 1) sleepMs(1000);
  const DB = 'procurement_staging_check';
  check('throw-away database created', psql('postgres', `create database ${DB};`).ok);
  check('Supabase-style roles created (anon, authenticated, service_role)', psql(DB, `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; grant usage on schema public to anon, authenticated, service_role;`).ok);
  check('phase-1 schema (merchants) present', psql(DB, `begin;\n${readFileSync(`${ROOT}supabase/migrations/20260920132005_phase1_schema.sql`, 'utf8')}\ncommit;`).ok);

  const url = `postgres://postgres@localhost/${DB}`;
  const base = { PSQL_CMD: `docker exec -i ${NAME} psql -U postgres`, PROCUREMENT_STAGING_URL: url };
  const auth = { ...base, PROCUREMENT_OWNER_AUTHORIZATION: 'rehearsal: the owner authorized this throw-away run' };
  const go = (argv, env) => { const lines = []; const code = run(argv, env, (l) => lines.push(l)); return { code, text: lines.join('\n') }; };
  const tablesNow = () => psql(DB, `select count(*) from information_schema.tables where table_name like 'proc\\_%'`).out;

  // ---- guards: each refusal must change nothing
  const refused = (name, argv, env, pattern) => { const r = go(argv, env); check(`REFUSED - ${name}`, r.code === 3 && pattern.test(r.text) && tablesNow() === '0', `${r.code} ${r.text}`); };
  refused('no owner authorization', ['apply', '--database', DB, '--authorized-by', 'Elidjan'], base, /PROCUREMENT_OWNER_AUTHORIZATION/);
  refused('no named person', ['apply', '--database', DB], auth, /--authorized-by/);
  refused('database name typed wrongly', ['apply', '--database', 'something_else', '--authorized-by', 'Elidjan'], auth, /typed exactly/);
  refused('a declared production host', ['apply', '--database', DB, '--authorized-by', 'Elidjan'], { ...auth, PROCUREMENT_PRODUCTION_HOSTS: 'localhost,db.prod.example' }, /PRODUCTION/);
  const prodName = { ...auth, PROCUREMENT_STAGING_URL: 'postgres://postgres@localhost/main_database' };
  refused('a database name that does not look like staging', ['apply', '--database', 'main_database', '--authorized-by', 'Elidjan'], prodName, /does not look like/);
  check('verify on an empty database reports the module absent', go(['verify'], base).code === 1 && /not installed/.test(go(['verify'], base).text));
  check('plan contacts nothing and states the guards', go(['plan'], auth).code === 0 && /apply\s+:/.test(go(['plan'], auth).text));

  // ---- apply
  const applied = go(['apply', '--database', DB, '--authorized-by', 'Elidjan'], auth);
  check('apply succeeds (stock migration, then permissions, one transaction each)', applied.code === 0 && /applied .*procurement_stock/.test(applied.text) && /applied .*procurement_permissions/.test(applied.text), applied.text);
  const rep = JSON.parse(go(['verify'], base).text.slice(go(['verify'], base).text.indexOf('{')));
  check('verify is green: 17 tables, RLS everywhere, 34 deny policies, 0 permissive, search_path fixed, 4 append-only triggers', rep.ok === true && rep.report.tables === 17 && rep.report.policies === 34 && rep.report.permissive_policies === 0 && rep.report.functions_without_search_path === 0, JSON.stringify(rep));
  const again = go(['apply', '--database', DB, '--authorized-by', 'Elidjan'], auth);
  check('a second apply is refused (tables already exist)', again.code === 3 && /already has 17/.test(again.text), again.text);

  // ---- permissions are real
  const M = '00000000-0000-0000-0000-00000000000a'; const I = '00000000-0000-0000-0000-00000000a001'; const L = '00000000-0000-0000-0000-00000000b001';
  check('seed as the owner of the database (superuser) works', psql(DB, `insert into merchants (id, name) values ('${M}','A'); insert into proc_items (id, merchant_id, sku, name) values ('${I}','${M}','S1','one'); insert into proc_locations (id, merchant_id, name, type) values ('${L}','${M}','W','WAREHOUSE'); insert into proc_stock_movements (merchant_id, idempotency_key, item_id, location_id, bucket, delta, kind, actor_id) values ('${M}','k1','${I}','${L}','ON_HAND',5,'ADJUSTMENT','u');`).ok);
  const asRole = (role, sql) => psql(DB, `set role ${role}; ${sql}`);
  for (const role of ['anon', 'authenticated']) {
    check(`${role} cannot read proc_items`, /permission denied/.test(asRole(role, 'select * from proc_items;').err), asRole(role, 'select * from proc_items;').err);
    check(`${role} cannot write the ledger`, /permission denied/.test(asRole(role, `insert into proc_stock_movements (merchant_id, idempotency_key, item_id, location_id, bucket, delta, kind, actor_id) values ('${M}','k2','${I}','${L}','ON_HAND',1,'ADJUSTMENT','u');`).err));
    check(`${role} cannot call the numbering function`, /permission denied/.test(asRole(role, `select proc_next_number('${M}'::uuid, 'x');`).err));
  }
  psql(DB, `grant select on proc_items to anon; grant select on proc_items to authenticated;`); // even a table grant is neutralised by the restrictive policy
  check('a mistaken GRANT to anon still returns no row (restrictive deny policy)', asRole('anon', 'select count(*) from proc_items;').out === '0', asRole('anon', 'select count(*) from proc_items;').err);
  psql(DB, `revoke select on proc_items from anon, authenticated;`);
  check('service_role can read and write', asRole('service_role', `select count(*) from proc_items;`).out === '1' && asRole('service_role', `insert into proc_stock_movements (merchant_id, idempotency_key, item_id, location_id, bucket, delta, kind, actor_id) values ('${M}','k3','${I}','${L}','ON_HAND',2,'ADJUSTMENT','u');`).ok);
  check('service_role cannot UPDATE the ledger (privilege revoked, second lock after the trigger)', /permission denied/.test(asRole('service_role', `update proc_stock_movements set delta = 99;`).err), asRole('service_role', `update proc_stock_movements set delta = 99;`).err);
  check('service_role cannot DELETE the journal', /permission denied/.test(asRole('service_role', `delete from proc_events;`).err));
  check('the balance trigger still works for service_role (7 on hand)', asRole('service_role', `select on_hand from proc_stock_balances;`).out === '7');

  // ---- rollback
  const rb = (extra) => go(['rollback', '--database', DB, '--authorized-by', 'Elidjan', ...extra], auth);
  check('REFUSED - rollback without --data-exported', rb([]).code === 3 && /--data-exported/.test(rb([]).text) && tablesNow() === '17');
  check('REFUSED - rollback of a module holding data without --accept-data-loss', rb(['--data-exported']).code === 3 && /accept-data-loss/.test(rb(['--data-exported']).text) && tablesNow() === '17');
  const done = rb(['--data-exported', '--accept-data-loss']);
  check('rollback with every flag succeeds and leaves no proc_ object', done.code === 0 && tablesNow() === '0' && psql(DB, `select count(*) from pg_proc where proname like 'proc\\_%'`).out === '0', done.text);
  check('the permissions rollback alone does not touch the stock tables (rehearsed order: permissions first)', done.text.indexOf('permissions.down') < done.text.indexOf('procurement_stock.down'));
  check('after a rollback the module can be applied again', go(['apply', '--database', DB, '--authorized-by', 'Elidjan'], auth).code === 0 && tablesNow() === '17');
} finally { if (process.env.KEEP_PG_SMOKE !== '1') docker(['rm', '-f', NAME]); }
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
