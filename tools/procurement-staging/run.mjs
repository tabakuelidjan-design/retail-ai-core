#!/usr/bin/env node
// Stock / Achats — PostgreSQL staging runner. NEVER RUN against a shared environment without the owner's explicit authorization: this file only PREPARES that step.
//
//   node tools/procurement-staging/run.mjs plan                                  what would run, and which guards are satisfied (no database contact)
//   node tools/procurement-staging/run.mjs verify                                read-only checks of the module in the target database
//   node tools/procurement-staging/run.mjs apply    --database <name> --authorized-by "<who>"
//   node tools/procurement-staging/run.mjs rollback --database <name> --authorized-by "<who>" --data-exported [--accept-data-loss]
//
// Environment:
//   PROCUREMENT_STAGING_URL       postgres connection string of the TARGET (secret: never commit it)
//   PSQL_CMD                      the psql command (default "psql"); e.g. "docker exec -i <container> psql" for a throw-away container
//   PROCUREMENT_OWNER_AUTHORIZATION   a sentence recording the owner's authorization (required by apply / rollback)
//   PROCUREMENT_PRODUCTION_HOSTS  comma-separated host names that are PRODUCTION: the runner refuses them outright
//   PROCUREMENT_ALLOW_ANY_DATABASE_NAME=YES   allow a database whose name does not look like staging/check/smoke/test (still needs --database <name> typed exactly)
//
// Guards (every one must hold, none can be skipped by a flag): an authorization text AND a named person; the database name typed on the command line equals the one in the URL;
// the host is not a declared production host; the name looks like a non-production database (or the explicit override); apply refuses a database that already has proc_ tables;
// rollback refuses without --data-exported and, if the tables hold rows, without --accept-data-loss. Each file runs in ONE transaction (all or nothing).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const UP = ['supabase/migrations-pending/20261016090000_procurement_stock.sql', 'supabase/migrations-pending/20261016091000_procurement_permissions.sql'];
export const DOWN = ['supabase/rollback/20261016091000_procurement_permissions.down.sql', 'supabase/rollback/20261016090000_procurement_stock.down.sql']; // permissions first
export const TABLES = ['proc_items', 'proc_locations', 'proc_suppliers', 'proc_supplier_items', 'proc_quotes', 'proc_purchase_orders', 'proc_po_lines', 'proc_po_schedule', 'proc_visits', 'proc_receipts', 'proc_stock_movements', 'proc_stock_balances', 'proc_events', 'proc_idempotency', 'proc_approvals_used', 'proc_incidents', 'proc_sequences'];
const NONPROD_NAME = /(staging|stg|check|smoke|test)/i;

export class GuardError extends Error { constructor(msg) { super(msg); this.name = 'GuardError'; } }

export function parseArgs(argv) {
  const out = { _: [], flags: new Set(), opts: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); if (['data-exported', 'accept-data-loss'].includes(k)) out.flags.add(k); else { out.opts[k] = argv[i + 1]; i += 1; } } else out._.push(a);
  }
  return out;
}
export function targetOf(url) {
  let u; try { u = new URL(url); } catch { throw new GuardError('PROCUREMENT_STAGING_URL is missing or is not a postgres URL'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new GuardError('PROCUREMENT_STAGING_URL must be a postgres:// URL');
  return { host: u.hostname.toLowerCase(), database: decodeURIComponent(u.pathname.replace(/^\//, '')) };
}

/** Throws GuardError unless EVERY guard holds. Pure: no database contact. */
export function checkGuards({ url, env, opts, action }) {
  const t = targetOf(url);
  if (!String(env.PROCUREMENT_OWNER_AUTHORIZATION ?? '').trim()) throw new GuardError(`${action} needs PROCUREMENT_OWNER_AUTHORIZATION (the owner's explicit authorization, in words). None is set: nothing was done.`);
  if (!String(opts['authorized-by'] ?? '').trim()) throw new GuardError(`${action} needs --authorized-by "<name of the person who authorized it>"`);
  if (opts.database !== t.database) throw new GuardError(`--database must be typed exactly as the database in the URL ("${t.database}"): got "${opts.database ?? ''}"`);
  const prod = String(env.PROCUREMENT_PRODUCTION_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (prod.includes(t.host)) throw new GuardError(`${t.host} is declared PRODUCTION (PROCUREMENT_PRODUCTION_HOSTS): refused`);
  if (!NONPROD_NAME.test(t.database) && env.PROCUREMENT_ALLOW_ANY_DATABASE_NAME !== 'YES') throw new GuardError(`the database name "${t.database}" does not look like a staging / check / smoke / test database: refused (PROCUREMENT_ALLOW_ANY_DATABASE_NAME=YES overrides, with --database typed exactly)`);
  return t;
}

function psql({ url, env, sql, tx = false }) {
  const parts = String(env.PSQL_CMD ?? 'psql').trim().split(/\s+/);
  const r = spawnSync(parts[0], [...parts.slice(1), url, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...(tx ? ['-1'] : []), '-f', '-'], { input: sql, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const readSql = (rel) => readFileSync(`${ROOT}${rel}`, 'utf8');

const VERIFY_SQL = `select json_build_object(
  'tables', (select count(*) from information_schema.tables where table_schema = 'public' and table_name like 'proc\\_%'),
  'tables_without_rls', (select count(*) from pg_tables where schemaname = 'public' and tablename like 'proc\\_%' and not rowsecurity),
  'policies', (select count(*) from pg_policies where tablename like 'proc\\_%'),
  'permissive_policies', (select count(*) from pg_policies where tablename like 'proc\\_%' and permissive = 'PERMISSIVE'),
  'functions_without_search_path', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('proc_apply_movement','proc_forbid_change','proc_po_transition_guard','proc_next_number') and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))),
  'append_only_triggers', (select count(*) from pg_trigger where tgname in ('proc_stock_movements_immutable','proc_stock_movements_no_truncate','proc_events_immutable','proc_events_no_truncate') and not tgisinternal),
  'balance_trigger', (select count(*) from pg_trigger where tgname = 'proc_stock_movements_apply'),
  'rows', 0
);`;
// a separate statement: a query that names proc_ tables cannot even be parsed while they do not exist
const ROWS_SQL = 'select (select count(*) from proc_stock_movements) + (select count(*) from proc_purchase_orders) + (select count(*) from proc_items);';
/** The verify report, with the row count filled in only when the module exists. */
function report(url, env) {
  const r = psql({ url, env, sql: VERIFY_SQL }); if (!r.ok) throw new Error(`verify failed: ${r.err}`);
  const rep = JSON.parse(r.out);
  if (rep.tables > 0) { const n = psql({ url, env, sql: ROWS_SQL }); rep.rows = n.ok ? Number(n.out) : -1; }
  return rep;
}

/** Interprets the verify report: { ok, problems[] }. 'absent' (no proc_ table at all) is reported, not an error. */
export function judge(r, expectPresent = true) {
  const problems = [];
  if (r.tables === 0) return { ok: !expectPresent, absent: true, problems: expectPresent ? ['the module is not installed (no proc_ table)'] : [] };
  if (r.tables !== TABLES.length) problems.push(`expected ${TABLES.length} proc_ tables, found ${r.tables}`);
  if (r.tables_without_rls) problems.push(`${r.tables_without_rls} table(s) without row level security`);
  if (r.policies !== TABLES.length * 2) problems.push(`expected ${TABLES.length * 2} explicit deny policies (anon + authenticated), found ${r.policies}`);
  if (r.permissive_policies) problems.push(`${r.permissive_policies} permissive policy(ies): a table is opened`);
  if (r.functions_without_search_path) problems.push(`${r.functions_without_search_path} function(s) without a fixed search_path`);
  if (r.append_only_triggers !== 4) problems.push(`expected 4 append-only triggers, found ${r.append_only_triggers}`);
  if (r.balance_trigger !== 1) problems.push('the balance trigger is missing');
  return { ok: problems.length === 0, absent: false, problems };
}

export function run(argv, env = process.env, log = console.log) {
  const a = parseArgs(argv); const action = a._[0];
  const url = env.PROCUREMENT_STAGING_URL ?? '';
  if (action === 'plan') {
    log('Stock / Achats staging plan (nothing is executed by this command):');
    log('  apply    : ' + UP.join('  ->  ')); log('  rollback : ' + DOWN.join('  ->  '));
    for (const [k, v] of Object.entries({ PROCUREMENT_STAGING_URL: url ? 'set' : 'NOT SET', PSQL_CMD: env.PSQL_CMD ?? 'psql (default)', PROCUREMENT_OWNER_AUTHORIZATION: env.PROCUREMENT_OWNER_AUTHORIZATION ? 'set' : 'NOT SET', PROCUREMENT_PRODUCTION_HOSTS: env.PROCUREMENT_PRODUCTION_HOSTS ? 'set' : 'NOT SET (strongly recommended)' })) log(`  ${k}: ${v}`);
    if (url) { try { const t = targetOf(url); log(`  target: host ${t.host}, database ${t.database}, ${NONPROD_NAME.test(t.database) ? 'name looks non-production' : 'name does NOT look like staging'}`); } catch (e) { log(`  target: ${e.message}`); } }
    return 0;
  }
  if (!['verify', 'apply', 'rollback'].includes(action)) { log('usage: run.mjs plan | verify | apply | rollback  (see the header of this file)'); return 2; }
  try {
    if (action === 'verify') {
      targetOf(url);
      let rep; try { rep = report(url, env); } catch (e) { log(e.message); return 1; }
      const j = judge(rep); log(JSON.stringify({ report: rep, ...j }, null, 2)); return j.ok ? 0 : 1;
    }
    checkGuards({ url, env, opts: a.opts, action });
    const before = report(url, env);
    if (action === 'apply') {
      if (before.tables > 0) throw new GuardError(`the database already has ${before.tables} proc_ table(s): apply refuses (roll back first, or use a clean database)`);
      if (psql({ url, env, sql: "select to_regclass('public.merchants') is not null" }).out !== 't') throw new GuardError('the database has no `merchants` table (schema phase 1 is a prerequisite)');
      for (const f of UP) { const r = psql({ url, env, sql: readSql(f), tx: true }); if (!r.ok) { log(`FAILED on ${f} (rolled back, that file changed nothing): ${r.err}`); return 1; } log(`applied ${f}`); }
    } else {
      if (!a.flags.has('data-exported')) throw new GuardError('rollback needs --data-exported: export the proc_ data first (the rollback drops it)');
      if (before.rows > 0 && !a.flags.has('accept-data-loss')) throw new GuardError(`the module holds ${before.rows} row(s): rollback refuses without --accept-data-loss`);
      for (const f of DOWN) { const r = psql({ url, env, sql: readSql(f), tx: true }); if (!r.ok) { log(`FAILED on ${f} (rolled back, that file changed nothing): ${r.err}`); return 1; } log(`rolled back ${f}`); }
    }
    const after = report(url, env); const j = judge(after, action === 'apply');
    log(JSON.stringify({ action, authorized_by: a.opts['authorized-by'], report: after, ...j }, null, 2)); return j.ok ? 0 : 1;
  } catch (e) { if (e instanceof GuardError) { log(`REFUSED: ${e.message}`); return 3; } throw e; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(run(process.argv.slice(2)));
