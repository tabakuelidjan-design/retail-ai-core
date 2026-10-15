// Real PostgreSQL (Supabase image) proof of ops/staging-db/bootstrap-habb-test.sql BEFORE it is ever run on staging:
// every repository migration + the pending identity_module_sourcing, the staging marker merchant, then the bootstrap script:
//   - without the owner's confirmed account: STOP, nothing created (one transaction);
//   - with it: test merchant, exactly one ACTIVE OWNER, module sourcing ACTIVE, private bucket, no storage policy;
//   - run again: nothing changes; the marker merchant gets no member (isolation).
// No secret, no network beyond the local Docker image. KEEP_PG_SMOKE=1 keeps the container.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NAME = 'nordla-pg-smoke-staging-bootstrap';
const IMAGE = process.env.PG_SMOKE_IMAGE ?? 'supabase/postgres:17.6.1.054';
const MARKER = '4159734e-27be-4772-bb7c-6c5f24fbafcc'; const HABB_TEST = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb';
const OWNER = { id: '0b0b0b0b-1111-4222-8333-444444444444', email: 'owner@nordla-test.example' };
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8' });
if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) { console.error('STOP: Docker is not available.'); process.exit(2); }
const sleepMs = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
const psql = (text, vars = []) => { const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...vars.flatMap((v) => ['-v', v])], text); return { ok: r.status === 0, code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
const results = []; const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  -> ${detail}`}`); };
const one = (q) => psql(q).out;
const state = () => one(`select (select count(*) from public.merchants)||'/'||(select count(*) from public.merchant_members)||'/'||(select count(*) from public.module_entitlements)||'/'||(select count(*) from storage.buckets where id='nordla-backups')`);
const BOOT = readFileSync(`${ROOT}ops/staging-db/bootstrap-habb-test.sql`, 'utf8');

docker(['rm', '-f', NAME]);
if (docker(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=smoke', IMAGE]).status !== 0) { console.error(`STOP: cannot start ${IMAGE}`); process.exit(2); }
try {
  const ready = () => ((docker(['logs', NAME]).stdout ?? '') + (docker(['logs', NAME]).stderr ?? '')).split('database system is ready to accept connections').length - 1;
  for (let i = 0; i < 120 && ready() < 2; i += 1) sleepMs(2000);
  sleepMs(3000); for (let i = 0; i < 30 && !psql('select 1').ok; i += 1) sleepMs(1000);
  // the image ships a minimal storage schema (the real project has the storage service): the same stub as the other smokes
  spawnSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=smoke', NAME, 'psql', '-U', 'supabase_admin', '-h', 'localhost', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input: 'create schema if not exists storage; create table if not exists storage.buckets (id text primary key, name text); create table if not exists storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text); alter table storage.buckets add column if not exists public boolean default false, add column if not exists file_size_limit bigint, add column if not exists allowed_mime_types text[]; alter table auth.users add column if not exists email_confirmed_at timestamptz, add column if not exists banned_until timestamptz, add column if not exists deleted_at timestamptz;', encoding: 'utf8' }); // auth.users: the 3 columns the real project has (checked on staging)
  const files = [...readdirSync(`${ROOT}supabase/migrations`).filter((f) => f.endsWith('.sql')).sort().map((f) => `supabase/migrations/${f}`), 'supabase/migrations-pending/20261015093000_identity_module_sourcing.sql'];
  let applied = 0;
  for (const f of files) { const r = psql(`begin;\n${readFileSync(`${ROOT}${f}`, 'utf8')}\n;\ncommit;\n`); if (!r.ok) { check(`migration ${f}`, false, r.err.split('\n')[0]); break; } applied += 1; }
  check(`all ${files.length} migrations applied in order (identity 1-5 included)`, applied === files.length);
  check('staging marker merchant inserted', psql(`insert into public.merchants (id, name, source_system, source_id) values ('${MARKER}', 'staging marker', 'nordla-staging', 'marker');`).ok);

  const before = state();
  const missing = psql(BOOT, [`owner_email=${OWNER.email}`]);
  check('without the owner\'s confirmed account: STOP (exit 3)', missing.code === 3 && /STOP: no confirmed Supabase Auth account/.test(missing.out + missing.err), `${missing.code} ${missing.err}`);
  check('... and nothing was created', state() === before, `${before} -> ${state()}`);

  check('an UNCONFIRMED account is refused too', psql(`insert into auth.users (id, email, aud, role) values ('0c0c0c0c-1111-4222-8333-444444444444', 'pending@nordla-test.example', 'authenticated', 'authenticated');`).ok && psql(BOOT, ['owner_email=pending@nordla-test.example']).code === 3 && state() === before);
  check('the owner\'s own account exists (created in the dashboard, here a test double)', psql(`insert into auth.users (id, email, email_confirmed_at, aud, role) values ('${OWNER.id}', '${OWNER.email}', now(), 'authenticated', 'authenticated');`).ok);
  const run1 = psql(BOOT, [`owner_email=${OWNER.email.toUpperCase()}`]);
  check('bootstrap runs (one transaction, all checks inside)', run1.ok, run1.err.split('\n').slice(0, 2).join(' | '));
  check('test merchant: own id, not the production HABB id', one(`select name from public.merchants where id='${HABB_TEST}'`) === 'HABB (test staging)');
  check('exactly one ACTIVE OWNER, the owner\'s own account', one(`select count(*) from public.merchant_members where merchant_id='${HABB_TEST}' and user_id='${OWNER.id}' and role='OWNER' and status='ACTIVE'`) === '1');
  check('module sourcing ACTIVE', one(`select status from public.module_entitlements where merchant_id='${HABB_TEST}' and module_code='sourcing'`) === 'ACTIVE');
  check('bucket nordla-backups private, no storage policy', one(`select public::text from storage.buckets where id='nordla-backups'`) === 'false' && one(`select count(*) from pg_policies where schemaname='storage' and (coalesce(qual,'')||coalesce(with_check,'')) like '%nordla-backups%'`) === '0');
  check('identity events recorded by the functions themselves', Number(one(`select count(*) from public.identity_events where merchant_id='${HABB_TEST}'`)) >= 2);
  const after1 = state();
  const run2 = psql(BOOT, [`owner_email=${OWNER.email}`]);
  check('re-run: accepted and changes nothing', run2.ok && state() === after1, `${run2.err} ${after1} -> ${state()}`);
  check('isolation: the marker merchant has no member and no module', one(`select (select count(*) from public.merchant_members where merchant_id='${MARKER}') + (select count(*) from public.module_entitlements where merchant_id='${MARKER}')`) === '0');
  check('anon / authenticated cannot read the members table', one("select has_table_privilege('anon','public.merchant_members','SELECT') or has_table_privilege('authenticated','public.merchant_members','SELECT')") === 'f');
} finally { if (!process.env.KEEP_PG_SMOKE) docker(['rm', '-f', NAME]); }
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed against a real PostgreSQL`);
process.exit(failed ? 1 : 0);
