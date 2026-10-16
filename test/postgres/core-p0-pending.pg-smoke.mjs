// REAL PostgreSQL smoke test of the three PREPARED (not applied) Core P0 migrations in supabase/migrations-pending/.
//
// It needs a THROW-AWAY database on which every migration of supabase/migrations AND supabase/migrations-pending is already applied, with the
// Supabase roles (anon, authenticated, service_role) and an auth.uid() that reads `request.jwt.claim.sub` (as Supabase does). It never applies a
// migration itself and refuses any database whose name does not contain "smoke" or "check".
//
//   PG_SMOKE_URL=postgres://postgres@127.0.0.1:55432/p0_check node test/postgres/core-p0-pending.pg-smoke.mjs     (needs psql; not part of `npm test`)
//
// Exit code 0 only if every check passes. Every check runs in a transaction that is rolled back: the database is left as it was.
import { spawnSync } from 'node:child_process';

const URL_ = process.env.PG_SMOKE_URL;
if (!URL_) { console.error('STOP: PG_SMOKE_URL is not set (a throw-away database with all migrations applied).'); process.exit(2); }
const dbName = new URL(URL_).pathname.slice(1);
if (!/smoke|check/i.test(dbName)) { console.error(`STOP: refusing database "${dbName}": its name must contain "smoke" or "check" (throw-away databases only).`); process.exit(2); }

const results = [];
/** Runs SQL in one transaction that is always rolled back. Returns { ok, out, err }. */
function sql(text) {
  // PG_SMOKE_DOCKER=<container>: no psql on this machine (Windows) -> psql runs INSIDE that throw-away PostgreSQL container, on the database named in PG_SMOKE_URL
  const args = process.env.PG_SMOKE_DOCKER ? ['exec', '-i', process.env.PG_SMOKE_DOCKER, 'psql', '-U', 'postgres', '-d', dbName, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1'] : [URL_, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1'];
  const r = spawnSync(process.env.PG_SMOKE_DOCKER ? 'docker' : 'psql', args, { input: `begin;
${text}
;
rollback;
`, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n      ${detail}`}`); };
const refused = (name, text, code) => { const r = sql(text); check(name, !r.ok && r.err.includes(code), r.ok ? 'accepted' : r.err); };
const accepted = (name, text, expect) => { const r = sql(text); check(name, r.ok && (expect === undefined || r.out.split('\n').at(-1) === String(expect)), r.ok ? `got ${r.out}` : r.err); };

const A = '00000000-0000-4000-8000-00000000000a'; const B = '00000000-0000-4000-8000-00000000000b'; const U = '00000000-0000-4000-8000-0000000000aa';
const seed = `
  insert into merchants (id, name) values ('${A}', 'smoke A'), ('${B}', 'smoke B');
  insert into auth.users (id) values ('${U}');
  insert into merchant_members (merchant_id, user_id, role, status, created_at, updated_at) values ('${A}', '${U}', 'OWNER', 'ACTIVE', now(), now());
  insert into merchant_profile (merchant_id, timezone, currency) values ('${A}', 'Europe/Brussels', 'EUR'), ('${B}', 'Europe/Paris', 'EUR');`;
const asUser = `set local role authenticated; set local request.jwt.claim.sub = '${U}';`;

// ---------------------------------------------------------------- RLS: nothing opened, everything bounded
accepted('no public table without RLS', `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity;`, 0);
accepted('no RLS table without a policy', `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') and c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid = c.oid);`, 0);
accepted('no permissive policy was added (client roles still read nothing)', `select count(*) from pg_policy where polpermissive and polname like 'nordla_%';`, 0);
accepted('anon reads no merchant_profile row', `${seed} set local role anon; select count(*) from merchant_profile;`, 0);
accepted('an authenticated member still reads nothing without a permissive policy', `${seed} ${asUser} select count(*) from merchant_profile;`, 0);
accepted('a later permissive policy is bounded to the caller\'s own merchant by the tenant guard', `${seed} create policy smoke_open on merchant_profile for select to authenticated using (true); ${asUser} select string_agg(merchant_id::text, ',') from merchant_profile;`, A);
refused('anon cannot insert even with a permissive policy', `${seed} create policy smoke_open_all on merchant_profile for all to anon using (true) with check (true); set local role anon; insert into merchant_profile (merchant_id, timezone, currency) values ('${A}', 'UTC', 'EUR');`, 'row-level security');
refused('the new tables are closed to the client roles (grants revoked)', `${seed} ${asUser} select count(*) from sourcing_cases;`, 'permission denied');

// ---------------------------------------------------------------- fin_* search_path
accepted('every fin_* function has a fixed search_path', `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'fin\\_%' and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%');`, 0);
accepted('a fin_* function still runs after the change', `select fin_vcs_valid('000000000097') is not null;`, 't');

// ---------------------------------------------------------------- trace ledger: append-only, hash-chained per merchant
const h = (c) => c.repeat(64);
const l1 = `insert into integration_trace_ledger (merchant_id, seq, at, workflow_id, source_module, action, outcome, entry, prev, hash) values ('${A}', 1, now(), 'wf', 'CHINA_SOURCING', 'x', 'OK', '{}', 'GENESIS', '${h('a')}');`;
accepted('ledger: first entry chains to GENESIS', `${seed} ${l1} select count(*) from integration_trace_ledger;`, 1);
accepted('ledger: the next entry chains to the previous hash', `${seed} ${l1} insert into integration_trace_ledger (merchant_id, seq, at, workflow_id, source_module, action, outcome, entry, prev, hash) values ('${A}', 2, now(), 'wf', 'BUYING', 'y', 'OK', '{}', '${h('a')}', '${h('b')}'); select max(seq) from integration_trace_ledger;`, 2);
refused('ledger: a gap in seq is refused', `${seed} ${l1} insert into integration_trace_ledger (merchant_id, seq, at, workflow_id, source_module, action, outcome, entry, prev, hash) values ('${A}', 3, now(), 'wf', 'BUYING', 'y', 'OK', '{}', '${h('a')}', '${h('b')}');`, 'LEDGER_SEQ_GAP');
refused('ledger: a wrong previous hash is refused', `${seed} ${l1} insert into integration_trace_ledger (merchant_id, seq, at, workflow_id, source_module, action, outcome, entry, prev, hash) values ('${A}', 2, now(), 'wf', 'BUYING', 'y', 'OK', '{}', '${h('c')}', '${h('b')}');`, 'LEDGER_CHAIN_BROKEN');
accepted('ledger: chains are per merchant', `${seed} ${l1} insert into integration_trace_ledger (merchant_id, seq, at, workflow_id, source_module, action, outcome, entry, prev, hash) values ('${B}', 1, now(), 'wf', 'BUYING', 'y', 'OK', '{}', 'GENESIS', '${h('d')}'); select count(*) from integration_trace_ledger;`, 2);
refused('ledger: update is refused', `${seed} ${l1} update integration_trace_ledger set outcome = 'ERROR';`, 'INTEGRATION_OBJECT_WRITE_ONCE');
refused('ledger: delete is refused', `${seed} ${l1} delete from integration_trace_ledger;`, 'INTEGRATION_OBJECT_WRITE_ONCE');
refused('ledger: truncate is refused', `${seed} ${l1} truncate integration_trace_ledger;`, 'INTEGRATION_OBJECT_WRITE_ONCE');

// ---------------------------------------------------------------- purchase plan / incoming expectation: NOT persisted here
// Decision of the convergence: the purchase order of Stock / Achats is the canonical object; a plan and an expectation are read-only views derived from it
// (src/integration/procurement-compat.js). The migration therefore does not create integration_purchase_plans / integration_incoming_expectations
// (split proposal of the Stock / Achats workstream, tools/procurement-staging/split-integration-migration.mjs). A second persistent copy would double-count.
accepted('plan / incoming: the two tables are NOT created (the purchase order is canonical)', `select count(*) from pg_class where relname in ('integration_purchase_plans','integration_incoming_expectations');`, 0);
accepted('plan / incoming: their guard function does not exist either', `select count(*) from pg_proc where proname = 'integration_purchase_plans_guard';`, 0);
refused('campaign: published = true is refused', `${seed} insert into integration_campaign_contracts (merchant_id, campaign_ref, product_ref, ready_for_creative, owner_review, published, body) values ('${A}', 'campaign:c1', 'product:p1', true, 'PENDING', true, '{}');`, 'check constraint');

// ---------------------------------------------------------------- sourcing cases: per merchant, optimistic revision
const kase = `insert into sourcing_cases (merchant_id, case_id, rev, state) values ('${A}', 'case-1', 1, '{"id":"case-1"}');`;
accepted('sourcing: a case is stored at rev 1', `${seed} ${kase} select rev from sourcing_cases;`, 1);
refused('sourcing: a first write must be rev 1', `${seed} insert into sourcing_cases (merchant_id, case_id, rev, state) values ('${A}', 'case-2', 2, '{"id":"case-2"}');`, 'SOURCING_CASE_FIRST_REV_IS_1');
accepted('sourcing: rev + 1 is accepted', `${seed} ${kase} update sourcing_cases set rev = 2, state = '{"id":"case-1","x":1}'; select rev from sourcing_cases;`, 2);
refused('sourcing: a stale revision is a CONFLICT', `${seed} ${kase} update sourcing_cases set rev = 1, state = '{"id":"case-1","x":1}';`, 'SOURCING_CASE_CONFLICT');
refused('sourcing: the state must carry its own case id', `${seed} insert into sourcing_cases (merchant_id, case_id, rev, state) values ('${A}', 'case-3', 1, '{"id":"other"}');`, 'sourcing_cases_state_id_ck');
refused('sourcing: an unsafe case id is refused', `${seed} insert into sourcing_cases (merchant_id, case_id, rev, state) values ('${A}', '../x', 1, '{"id":"../x"}');`, 'check constraint');
accepted('sourcing: two merchants may hold the same case id', `${seed} ${kase} insert into sourcing_cases (merchant_id, case_id, rev, state) values ('${B}', 'case-1', 1, '{"id":"case-1"}'); select count(*) from sourcing_cases;`, 2);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
