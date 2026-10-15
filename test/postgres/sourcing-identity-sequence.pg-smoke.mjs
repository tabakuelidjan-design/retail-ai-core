// REAL PostgreSQL smoke of the Sourcing go-live identity sequence (docs/infrastructure/sourcing-railway-go-live.md §1), on a THROW-AWAY
// database rebuilt to the PRODUCTION state (the first 23 files of supabase/migrations, exactly what production lists on 2026-10-15):
//   1. the 5 migrations apply one by one, in order, each in its own transaction;
//   2. functional: owner bootstrapped, module 'sourcing' enabled, session opened (OWNER), unknown module refused, journal written;
//   3. security: anon / authenticated read no identity table and execute no SECURITY DEFINER function;
//   4. the rollback file brings the schema back EXACTLY (pg_dump -s, restrict markers ignored); merchants and auth.users untouched.
//
//   PG_SMOKE_URL=postgres://postgres@127.0.0.1:55432/seq_check node test/postgres/sourcing-identity-sequence.pg-smoke.mjs
// The database must already hold the 23 production migrations and Supabase-like roles (as in the other smokes). It is MODIFIED (that is
// the point: apply then roll back), so its name must contain "smoke" or "check". Needs psql and pg_dump. Not part of `npm test`.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const URL_ = process.env.PG_SMOKE_URL;
if (!URL_) { console.error('STOP: PG_SMOKE_URL is not set (a throw-away database at the production state).'); process.exit(2); }
const dbName = new URL(URL_).pathname.slice(1);
if (!/smoke|check/i.test(dbName)) { console.error(`STOP: refusing database "${dbName}": its name must contain "smoke" or "check".`); process.exit(2); }

const SEQUENCE = [
  'supabase/migrations/20260928120000_identity_sessions_events.sql',
  'supabase/migrations/20260928130000_identity_rate_limits.sql',
  'supabase/migrations/20260928140000_identity_members.sql',
  'supabase/migrations/20260928150000_identity_modules_sessions.sql',
  'supabase/migrations-pending/20261015093000_identity_module_sourcing.sql',
];
const ROLLBACK = 'supabase/rollback/2026-10-sourcing-identity.rollback.sql';
const IDENTITY_TABLES = ['app_sessions', 'identity_events', 'identity_rate_limits', 'identity_auth_reservations', 'merchant_members', 'module_entitlements'];
const M = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5'; const U = '00000000-0000-4000-8000-0000000000aa';

const psql = (input, { tx = false } = {}) => { const r = spawnSync('psql', [URL_, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1'], { input: tx ? `set search_path = public, extensions; begin;\n${input}\n;\ncommit;\n` : input, encoding: 'utf8' }); return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
const dump = () => spawnSync('pg_dump', ['-s', URL_], { encoding: 'utf8' }).stdout.split('\n').filter((l) => !/^\\(un)?restrict /.test(l)).join('\n');
const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n      ${detail}`}`); };

const pre = psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in (${IDENTITY_TABLES.map((t) => `'${t}'`).join(',')});`);
if (!pre.ok || pre.out !== '0') { console.error(`STOP: the database is not at the production state (identity tables present: ${pre.out || pre.err}).`); process.exit(2); }
const before = dump();
const rows = () => psql('select (select count(*) from merchants) || \':\' || (select count(*) from auth.users);').out;
psql(`insert into merchants (id, name, source_system, source_id) values ('${M}', 'HABB (smoke copy)', 'shopify', 'gid://smoke') on conflict do nothing; insert into auth.users (id) values ('${U}') on conflict do nothing;`);
const rowsBefore = rows();

for (const f of SEQUENCE) { const r = psql(readFileSync(f, 'utf8'), { tx: true }); check(`applies: ${f.split('/').pop()}`, r.ok, r.err); if (!r.ok) process.exit(1); }

const call = (q) => psql(`set role service_role; set search_path = public, extensions; select (${q})::text;`).out;
check('owner bootstrapped', /"BOOTSTRAPPED"/.test(call(`identity_member_bootstrap_owner('${M}', '${U}', now(), gen_random_uuid(), 'sourcing')`)));
check('module sourcing enabled', /"MODULE_ENABLED"/.test(call(`identity_module_set('${M}', 'sourcing', 'ACTIVE', 'provisioning:manual', now(), gen_random_uuid())`)));
check('session opened as OWNER', /"SESSION_OPENED".*"OWNER"|"OWNER".*"SESSION_OPENED"/.test(call(`identity_open_session('${U}', '${M}', 'sourcing', repeat('a', 64), now(), now() + interval '8 hours', gen_random_uuid())`)));
check('unknown module refused', /"MODULE_UNKNOWN"/.test(call(`identity_open_session('${U}', '${M}', 'marketing', repeat('b', 64), now(), now() + interval '8 hours', gen_random_uuid())`)));
check('identity journal written', psql("select string_agg(event_type, ',' order by occurred_at) from identity_events;").out === 'MEMBER_BOOTSTRAPPED,MODULE_ENABLED,SESSION_OPENED');
for (const role of ['anon', 'authenticated']) {
  for (const t of IDENTITY_TABLES) { const r = psql(`set role ${role}; select count(*) from ${t};`); check(`${role} cannot read ${t}`, !r.ok && /permission denied/.test(r.err), r.ok ? `read ${r.out} row(s)` : r.err); }
  const f = psql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and has_function_privilege('${role}', p.oid, 'execute');`);
  check(`${role} executes no SECURITY DEFINER function`, f.out === '0', f.out);
}

const rb = psql(readFileSync(ROLLBACK, 'utf8'));
check('rollback runs', rb.ok, rb.err);
const rowsAfter = rows();
check('merchants and auth.users untouched by the rollback', rowsAfter === rowsBefore, `${rowsBefore} -> ${rowsAfter}`);
psql(`delete from merchants where id = '${M}' and name = 'HABB (smoke copy)'; delete from auth.users where id = '${U}';`); // the smoke's own seed only
check('schema after rollback == schema before the sequence', dump() === before, 'pg_dump -s differs');

const failed = results.filter((p) => !p).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
