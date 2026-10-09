// REAL PostgreSQL smoke test of supabase/migrations/20261009100000_channel_execution_jobs.sql.
//
// No simulation: it starts a throwaway postgres:17 container, applies EVERY migration of the repository in order (the real chain), then
// checks the constraints, triggers and compare-and-set behaviour of channel_execution_jobs with real SQL, including two concurrent
// sessions racing for one job. The only stub is the Supabase-platform `storage` schema (it does not exist on plain PostgreSQL and an
// earlier, unrelated finance migration inserts into storage.buckets); no table of this repository is stubbed.
//
//   node test/postgres/channel-execution-jobs.pg-smoke.mjs        (needs Docker; not part of `npm test`)
//
// Exit code 0 only if every check passes. KEEP_PG_SMOKE=1 keeps the container for inspection.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS = `${ROOT}supabase/migrations/`;
const NAME = 'nordla-pg-smoke-activation';
const DB = 'activation_smoke';
const results = [];

const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8' });
if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) {
  console.error('STOP: Docker is not available - a real PostgreSQL is required for this smoke test (no in-memory substitute).');
  process.exit(2);
}

/** Runs SQL through psql in the container. ok=false (with stderr) when PostgreSQL raises an error. */
function sql(text, { db = DB } = {}) {
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', db, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], text);
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
function sqlAsync(text, delayMs = 0) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const p = spawn('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', DB, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1']);
      let out = ''; let err = '';
      p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }));
      p.stdin.end(text);
    }, delayMs);
  });
}
const check = (name, pass, detail = '') => { results.push({ name, pass: Boolean(pass), detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  -> ${detail}`}`); };
const rejects = (name, r, pattern) => check(name, !r.ok && pattern.test(r.err), r.ok ? 'the statement was ACCEPTED' : r.err.split('\n')[0]);
const accepts = (name, r) => check(name, r.ok, r.err.split('\n')[0]);

// ------------------------------------------------------------------ environment
docker(['rm', '-f', NAME]);
const run = docker(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=smoke', 'postgres:17']);
if (run.status !== 0) { console.error(`STOP: cannot start postgres:17 (${run.stderr.trim()})`); process.exit(2); }
try {
  for (let i = 0; i < 60 && docker(['exec', NAME, 'pg_isready', '-U', 'postgres']).status !== 0; i += 1) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
  // pg_isready is true before the final restart of the entrypoint: wait until a real query works twice in a row
  for (let i = 0; i < 60; i += 1) { if (sql('select 1', { db: 'postgres' }).ok) { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)']); if (sql('select 1', { db: 'postgres' }).ok) break; } spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']); }
  accepts('PostgreSQL 17 is running', sql('select version()', { db: 'postgres' }));
  accepts('create database', sql(`create database ${DB}`, { db: 'postgres' }));
  sql('create schema storage; create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text);');

  // ---------------------------------------------------------------- the real migration chain
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  let chainOk = true; let failed = '';
  for (const file of files) {
    const r = sql(readFileSync(`${MIGRATIONS}${file}`, 'utf8'));
    if (!r.ok) { chainOk = false; failed = `${file}: ${r.err.split('\n')[0]}`; break; }
  }
  check(`all ${files.length} migrations apply in order on PostgreSQL (including 20261009100000_channel_execution_jobs.sql)`, chainOk, failed);
  if (!chainOk) throw new Error('migration chain failed');

  // ---------------------------------------------------------------- seed (real tables)
  const M1 = '11111111-1111-4111-8111-111111111111'; const M2 = '22222222-2222-4222-8222-222222222222';
  const C1 = 'a1111111-1111-4111-8111-111111111111'; const C2 = 'a2222222-2222-4222-8222-222222222222';
  accepts('seed two merchants and one connector each', sql(`
    insert into merchants (id, name, source_system, source_id) values ('${M1}', 'Synthetic A', 'manual', 'smoke-a'), ('${M2}', 'Synthetic B', 'manual', 'smoke-b');
    insert into merchant_connectors (id, merchant_id, kind, external_id, status) values
      ('${C1}', '${M1}', 'instagram', '17841400000000001', 'CONFIGURED'), ('${C2}', '${M2}', 'instagram', '17841400000000002', 'CONFIGURED');`));
  const job = (extra = {}) => {
    const v = {
      merchant_id: M1, connector_id: C1, activation_manifest_ref: 'mam_1', manifest_delivery_ref: 'mdl_1', provider: 'instagram', idempotency_key: 'acj_1',
      request_fingerprint: 'acf_1', publish_mode: 'PUBLISH_NOW', deadline_at: '2026-10-15T00:00:00Z', ...extra,
    };
    const cols = Object.keys(v); const vals = cols.map((c) => (v[c] === null ? 'null' : `'${String(v[c]).replace(/'/g, "''")}'`));
    return `insert into channel_execution_jobs (${cols.join(', ')}) values (${vals.join(', ')}) returning id`;
  };
  const insertJob = (extra) => sql(job(extra));

  // ---------------------------------------------------------------- foreign keys
  const j1 = insertJob();
  accepts('a valid job is inserted (state defaults to PLANNED)', j1);
  const FK = (column, value, refTable) => {
    // the cross-merchant trigger would fire first: disable it inside a rolled-back transaction to prove the FOREIGN KEY itself
    const extra = { [column]: value, idempotency_key: `acj_fk_${column}`, manifest_delivery_ref: `mdl_fk_${column}` };
    return sql(`begin; alter table channel_execution_jobs disable trigger channel_execution_jobs_insert_guard_trg; ${job(extra)}; rollback;`);
  };
  rejects('FK merchant_id -> merchants: an unknown merchant is rejected', FK('merchant_id', '99999999-9999-4999-8999-999999999999'), /violates foreign key constraint "channel_execution_jobs_merchant_id_fkey"/);
  rejects('FK connector_id -> merchant_connectors: an unknown connector is rejected', FK('connector_id', 'a9999999-9999-4999-8999-999999999999'), /violates foreign key constraint "channel_execution_jobs_connector_id_fkey"/);
  rejects('ON DELETE RESTRICT: a connector that has jobs cannot be deleted', sql(`delete from merchant_connectors where id = '${C1}'`), /violates foreign key constraint/);
  rejects('ON DELETE RESTRICT: a merchant that has jobs cannot be deleted', sql(`delete from merchants where id = '${M1}'`), /violates foreign key constraint/);

  // ---------------------------------------------------------------- cross-merchant trigger
  rejects('cross-merchant trigger: a job of merchant A on the connector of merchant B is rejected', insertJob({ connector_id: C2, idempotency_key: 'acj_x', manifest_delivery_ref: 'mdl_x' }), /connector does not belong to the merchant/);
  accepts('the same job on the merchant\'s own connector is accepted', insertJob({ merchant_id: M2, connector_id: C2, idempotency_key: 'acj_own', manifest_delivery_ref: 'mdl_own' }));

  // ---------------------------------------------------------------- uniqueness / idempotency
  rejects('UNIQUE (merchant, manifest, delivery, connector): the same intent twice is rejected', insertJob({ idempotency_key: 'acj_other_key' }), /channel_execution_jobs_intent_uq/);
  rejects('UNIQUE (merchant, idempotency_key): the same key on another delivery is rejected', insertJob({ manifest_delivery_ref: 'mdl_2' }), /channel_execution_jobs_idempotency_uq/);
  accepts('the same key under ANOTHER merchant is allowed (tenant scoped)', insertJob({ merchant_id: M2, connector_id: C2, manifest_delivery_ref: 'mdl_t2' }));

  // ---------------------------------------------------------------- compare-and-set claim, two concurrent sessions
  accepts('insert a READY job to race for', insertJob({ idempotency_key: 'acj_race', manifest_delivery_ref: 'mdl_race' }));
  accepts('mark it READY', sql("update channel_execution_jobs set state = 'READY' where idempotency_key = 'acj_race'"));
  const claim = (hold) => `begin; update channel_execution_jobs set state = 'SUBMITTING', attempt_count = attempt_count + 1 where merchant_id = '${M1}' and idempotency_key = 'acj_race' and state = 'READY' and attempt_count = 0 returning id; ${hold ? 'select pg_sleep(2);' : ''} commit;`;
  const [a, b] = await Promise.all([sqlAsync(claim(true), 0), sqlAsync(claim(false), 700)]); // B starts while A still holds the row lock
  const winners = [a, b].filter((r) => r.ok && /^[0-9a-f-]{36}/m.test(r.out)).length;
  check('compare-and-set claim: two concurrent workers, exactly ONE winner', winners === 1 && a.ok && b.ok, `A=${JSON.stringify(a.out)} B=${JSON.stringify(b.out)} ${a.err} ${b.err}`);
  const claimed = sql("select state, attempt_count from channel_execution_jobs where idempotency_key = 'acj_race'");
  check('the row was claimed exactly once (SUBMITTING, attempt_count 1)', claimed.out === 'SUBMITTING|1', claimed.out);

  // ---------------------------------------------------------------- state / terminal constraints
  rejects('state is a closed list', sql("update channel_execution_jobs set state = 'DONE' where idempotency_key = 'acj_race'"), /check constraint/);
  rejects('identity is immutable (idempotency_key)', sql("update channel_execution_jobs set idempotency_key = 'changed' where idempotency_key = 'acj_race'"), /identity of a job is immutable/);
  rejects('identity is immutable (merchant_id)', sql(`update channel_execution_jobs set merchant_id = '${M2}' where idempotency_key = 'acj_race'`), /identity of a job is immutable/);
  rejects('a job is not PUBLISHED straight from PLANNED (no submission happened)', sql("update channel_execution_jobs set state = 'PUBLISHED', published_at = now(), provider_submission_id = 's' where idempotency_key = 'acj_1'"), /published only after a submission/);
  const toPublished = "update channel_execution_jobs set state = 'PUBLISHED'";
  rejects('PUBLISHED needs a publication time', sql(`${toPublished}, provider_submission_id = 's1' where idempotency_key = 'acj_race'`), /published_proof/);
  rejects('PUBLISHED needs the provider submission id or a real post id (neither: rejected)', sql(`${toPublished}, published_at = now() where idempotency_key = 'acj_race'`), /published_proof/);
  rejects('PUBLISHED with an empty post id list and no submission id is rejected', sql(`${toPublished}, published_at = now(), provider_post_ids = '[]'::jsonb where idempotency_key = 'acj_race'`), /published_proof/);
  rejects('provider_post_ids must be a JSON array', sql("update channel_execution_jobs set provider_post_ids = '{\"a\":1}'::jsonb where idempotency_key = 'acj_race'"), /check constraint/);
  accepts('PUBLISHED with the submission id and NO post id is accepted (a private TikTok post: PUBLISH_COMPLETE without a public id)', sql(`${toPublished}, published_at = now(), provider_submission_id = 'p_pub_url~v2.1' where idempotency_key = 'acj_race'`));
  check('...and its post id list stays empty (the submission id was not copied)', sql("select provider_post_ids::text from channel_execution_jobs where idempotency_key = 'acj_race'").out === '[]');
  for (const next of ['READY', 'SUBMITTING', 'CANCELLED', 'FAILED_FINAL']) {
    rejects(`terminal: a PUBLISHED job cannot go to ${next}`, sql(`update channel_execution_jobs set state = '${next}' where idempotency_key = 'acj_race'`), /terminal job cannot change/);
  }
  rejects('terminal: a PUBLISHED job cannot even change a field', sql("update channel_execution_jobs set attempt_count = 9 where idempotency_key = 'acj_race'"), /terminal job cannot change/);

  const mk = (key, state, extra = '') => {
    insertJob({ idempotency_key: key, manifest_delivery_ref: `mdl_${key}` });
    return sql(`update channel_execution_jobs set state = 'READY' where idempotency_key = '${key}'; update channel_execution_jobs set state = 'SUBMITTING' where idempotency_key = '${key}'; ${state === 'SUBMITTING' ? '' : `update channel_execution_jobs set state = '${state}' ${extra} where idempotency_key = '${key}';`}`);
  };
  accepts('FAILED_FINAL is reachable', mk('acj_ff', 'FAILED_FINAL'));
  rejects('terminal: FAILED_FINAL cannot be resurrected', sql("update channel_execution_jobs set state = 'READY' where idempotency_key = 'acj_ff'"), /terminal job cannot change/);
  accepts('CANCELLED is reachable (from PLANNED)', (insertJob({ idempotency_key: 'acj_cc', manifest_delivery_ref: 'mdl_cc' }), sql("update channel_execution_jobs set state = 'CANCELLED' where idempotency_key = 'acj_cc'")));
  rejects('terminal: CANCELLED cannot be resurrected', sql("update channel_execution_jobs set state = 'READY' where idempotency_key = 'acj_cc'"), /terminal job cannot change/);

  // ---------------------------------------------------------------- SUBMISSION_UNKNOWN: halted until an explicit reconciliation
  accepts('SUBMISSION_UNKNOWN is reachable from SUBMITTING', mk('acj_u1', 'SUBMISSION_UNKNOWN'));
  for (const next of ['READY', 'SUBMITTING', 'PROCESSING', 'FAILED_RETRYABLE', 'CANCELLED']) {
    rejects(`SUBMISSION_UNKNOWN cannot silently go to ${next} (no automatic retry)`, sql(`update channel_execution_jobs set state = '${next}' where idempotency_key = 'acj_u1'`), /explicit reconciliation/);
  }
  rejects('SUBMISSION_UNKNOWN -> FAILED_FINAL needs the reconciliation reference', sql("update channel_execution_jobs set state = 'FAILED_FINAL' where idempotency_key = 'acj_u1'"), /explicit reconciliation/);
  rejects('SUBMISSION_UNKNOWN -> PUBLISHED needs the reconciliation reference', sql("update channel_execution_jobs set state = 'PUBLISHED', published_at = now(), provider_submission_id = 's' where idempotency_key = 'acj_u1'"), /explicit reconciliation/);
  rejects('the reconciliation reference is an opaque ref (no spaces)', sql("update channel_execution_jobs set state = 'FAILED_FINAL', reconciliation_ref = 'looked at it' where idempotency_key = 'acj_u1'"), /check constraint/);
  accepts('SUBMISSION_UNKNOWN -> PUBLISHED with a reconciliation reference and provider evidence', sql("update channel_execution_jobs set state = 'PUBLISHED', reconciliation_ref = 'reconciliation://operator-1', published_at = now(), provider_post_ids = '[\"accounts/1/locations/2/localPosts/3\"]'::jsonb where idempotency_key = 'acj_u1'"));
  accepts('SUBMISSION_UNKNOWN -> FAILED_FINAL with a reconciliation reference (verified: nothing published)', (mk('acj_u2', 'SUBMISSION_UNKNOWN'), sql("update channel_execution_jobs set state = 'FAILED_FINAL', reconciliation_ref = 'reconciliation://operator-2' where idempotency_key = 'acj_u2'")));

  // ---------------------------------------------------------------- no secret columns, RLS
  const cols = sql("select column_name from information_schema.columns where table_name = 'channel_execution_jobs' order by ordinal_position").out.split('\n');
  const suspicious = cols.filter((c) => /token|secret|password|credential|cookie|authorization|signature|private|bearer|url$/i.test(c));
  check(`no secret / token / URL column exists (${cols.length} columns inspected)`, suspicious.length === 0, suspicious.join(','));
  check('provider_post_id (singular) no longer exists: post ids are a list of what the provider really returned', !cols.includes('provider_post_id') && cols.includes('provider_post_ids'), cols.join(','));
  check('row level security is enabled (service role only)', sql("select relrowsecurity from pg_class where relname = 'channel_execution_jobs'").out === 't');
  check('no policy is defined (no anonymous access)', sql("select count(*) from pg_policies where tablename = 'channel_execution_jobs'").out === '0');
  check('the migration created exactly one new table', sql("select count(*) from information_schema.tables where table_schema = 'public' and table_name like 'channel_execution%'").out === '1');
} catch (error) {
  if (!/migration chain failed/.test(String(error.message))) { check('smoke test ran to completion', false, String(error.message)); }
} finally {
  if (!process.env.KEEP_PG_SMOKE) docker(['rm', '-f', NAME]);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed against a real PostgreSQL`);
process.exit(failed.length ? 1 : 0);
