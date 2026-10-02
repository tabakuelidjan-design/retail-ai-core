// Real-PostgreSQL helpers: clean databases, migration replay from zero, template-based reset, many simultaneous connections, catalog fingerprint.
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertSafeServer, safeDbName, testUrl } from './safety.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const MIGRATIONS_DIR = `${REPO}supabase/migrations`;
export const PROD_CATALOG = fileURLToPath(new URL('../fixtures/prod-catalog.txt', import.meta.url));
const TEMPLATE = 'finance_test_template';

// What Supabase provides around the repository migrations (roles, auth/storage schemas, pgcrypto in "extensions"). Nothing here is a production secret.
const SUPABASE_STUBS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  create schema if not exists extensions; create extension if not exists pgcrypto schema extensions;
  create schema if not exists storage; create table if not exists storage.buckets (id text primary key, name text not null, public boolean default false);
  create schema if not exists auth; create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
  grant usage on schema public, extensions to anon, authenticated, service_role; -- Supabase grants "extensions" too (fin_issue_document calls extensions.digest)
  grant execute on all functions in schema extensions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`;

export const clientFor = async (database) => {
  const u = new URL(testUrl());
  if (database) u.pathname = `/${database}`;
  const c = new pg.Client({ connectionString: u.toString() });
  c.on('error', () => {}); // a backend killed on purpose (drop database ... force) must not become an uncaught exception
  await c.connect();
  await assertSafeServer(c);
  return c;
};

export async function adminClient() { return clientFor('postgres'); }

export function migrationFiles() { return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort(); }

/** Replays every repository migration, in filename order, into an EMPTY database. CRLF working copies are normalised (the same SQL on any checkout). */
export async function replayMigrations(client) {
  await client.query(SUPABASE_STUBS);
  const files = migrationFiles();
  for (const f of files) {
    try { await client.query(readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8').split('\r\n').join('\n')); } catch (e) { throw new Error(`migration ${f} failed: ${e.message}`); }
  }
  return files;
}

async function createEmpty(admin, name, template) {
  if (!safeDbName(name)) throw new Error(`refusing database name "${name}"`);
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}${template ? ` template ${template}` : ''}`);
}

/** Builds (once per run) the migrated template; every test database is then a cheap copy of it = "reset". */
export async function ensureTemplate() {
  const admin = await adminClient();
  try {
    const exists = (await admin.query('select 1 from pg_database where datname=$1', [TEMPLATE])).rowCount;
    if (exists) return;
    await createEmpty(admin, TEMPLATE);
    const c = await clientFor(TEMPLATE);
    try { await replayMigrations(c); } finally { await c.end(); }
    await admin.query(`alter database ${TEMPLATE} is_template true`);
  } finally { await admin.end(); }
}

export async function freshDatabase({ fromZero = false } = {}) {
  const name = `finance_test_${randomBytes(5).toString('hex')}`;
  const admin = await adminClient();
  try {
    if (fromZero) { await createEmpty(admin, name); const c = await clientFor(name); try { await replayMigrations(c); } finally { await c.end(); } }
    else { await ensureTemplate(); await createEmpty(admin, name, TEMPLATE); }
  } finally { await admin.end(); }
  const open = async () => clientFor(name);
  const drop = async () => { const a = await adminClient(); try { await a.query(`drop database if exists ${name} with (force)`); } finally { await a.end(); } };
  return { name, open, drop };
}

/** n real, simultaneous server connections, each with its own backend pid. */
export async function openMany(dbName, n) {
  const clients = await Promise.all(Array.from({ length: n }, () => clientFor(dbName)));
  const pids = await Promise.all(clients.map(async (c) => (await c.query('select pg_backend_pid() p')).rows[0].p));
  return { clients, pids, closeAll: () => Promise.all(clients.map((c) => c.end().catch(() => {}))) };
}

/** Runs fn(client, i) on every client at the same instant (released together by one barrier). Returns settled results. */
export async function race(clients, fn) {
  let release; const gate = new Promise((r) => { release = r; });
  const runs = clients.map(async (c, i) => { await gate; return fn(c, i); });
  await new Promise((r) => setTimeout(r, 50)); release();
  return Promise.allSettled(runs);
}

// ---------- catalog fingerprint (same query as the read-only fingerprint taken on the production project) ----------
const Q = `with t as (select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r')
select 'cols' k, t.relname obj, md5(string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),''), ',' order by a.attname)) h, count(*)::text n from t join pg_attribute a on a.attrelid=t.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum group by t.relname
union all select 'cons', t.relname, md5(string_agg(co.conname||':'||pg_get_constraintdef(co.oid), ',' order by co.conname)), count(*)::text from t join pg_constraint co on co.conrelid=t.oid and co.contype <> 'n' group by t.relname
union all select 'idx', t.relname, md5(string_agg(replace(pg_get_indexdef(i.indexrelid),'public.',''), ',' order by i.indexrelid::regclass::text collate "C")), count(*)::text from t join pg_index i on i.indrelid=t.oid group by t.relname
union all select 'trg', t.relname, md5(string_agg(tg.tgname||':'||pg_get_triggerdef(tg.oid), ',' order by tg.tgname)), count(*)::text from t join pg_trigger tg on tg.tgrelid=t.oid and not tg.tgisinternal group by t.relname
union all select 'rls', t.relname, md5(t.relrowsecurity::text||t.relforcerowsecurity::text||(select count(*) from pg_policies p where p.schemaname='public' and p.tablename=t.relname)::text), (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=t.relname)::text from t
union all select 'fn', p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', md5(p.prosrc||':'||pg_get_function_result(p.oid)||':'||p.prosecdef::text||':'||p.provolatile::text), length(p.prosrc)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
order by 1,2`;

export async function catalogFingerprint(client) {
  const rows = (await client.query(Q)).rows;
  return new Map(rows.map((r) => [`${r.k}|${r.obj.startsWith('fin_issue_document') ? 'fin_issue_document(PREFIX)' : r.obj}`, `${r.h}|${r.n}`]));
}

export function prodFingerprint() {
  return new Map(readFileSync(PROD_CATALOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { const [k, o, h, n] = l.split('|'); return [`${k}|${o}`, `${h}|${n}`]; }));
}

export function diffFingerprints(prod, local) {
  const diffs = [];
  for (const [k, v] of prod) { if (!local.has(k)) diffs.push(`ONLY IN PRODUCTION: ${k}`); else if (local.get(k) !== v) diffs.push(`DIFFERS: ${k}`); }
  for (const k of local.keys()) if (!prod.has(k)) diffs.push(`ONLY IN MIGRATIONS: ${k}`);
  return diffs;
}

// ---------- seed helpers shared by the suites ----------
export const MERCHANT_A = '11111111-1111-1111-1111-111111111111';
export const MERCHANT_B = '22222222-2222-2222-2222-222222222222';
export async function seedMerchants(c) {
  await c.query(`insert into merchants (id, name, source_system, source_id) values ($1,'A','shopify','gid://A'), ($2,'B','shopify','gid://B') on conflict do nothing`, [MERCHANT_A, MERCHANT_B]);
}
export const PLACEHOLDER = '__NUMBER_PLACEHOLDER__';
export async function insertDraft(c, merchantId, { docType = 'invoice', gross = 12100, related = null } = {}) {
  const net = Math.round(gross / 1.21);
  return (await c.query(`insert into fin_documents (merchant_id, doc_type, status, currency, issue_date, due_date, net_cents, vat_cents, gross_cents, revenue_basis, related_document_id, body)
    values ($1,$2,'DRAFT','EUR','2026-09-01','2026-10-01',$3,$4,$5,'standalone_b2b',$6,'{"lines":[1]}') returning *`, [merchantId, docType, net, gross - net, gross, related])).rows[0];
}
/** The exact RPC the service calls to issue a document (numbering + lock + audit event in one transaction). */
export const issueSql = 'select fin_issue_document($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) r';
export const issueArgs = (merchantId, doc, { prefix = 'FACT', year = 2026 } = {}) => [merchantId, doc.id, doc.version ?? 1, 'ISSUED', prefix, 4, '{prefix}-{year}-{seq}', year,
  `{"id":"${doc.id}","number":"${PLACEHOLDER}","gross":${doc.gross_cents}}`, PLACEHOLDER, '2026-09-30T10:00:00Z', JSON.stringify({ actor: { type: 'merchant' }, action: 'ISSUED', detail: { n: PLACEHOLDER } })];
export async function issueDocument(c, merchantId, doc, opts) { return (await c.query(issueSql, issueArgs(merchantId, doc, opts))).rows[0].r; }
