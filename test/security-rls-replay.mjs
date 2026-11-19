// Optional PostgreSQL engine drill; no remote database, no credentials, no HABB data.
// node test/security-rls-replay.mjs <absolute path to PGlite dist/index.js>
// PGlite is an isolated test tool, not a Nordla production dependency.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const { PGlite } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : '@electric-sql/pglite');
const db = new PGlite();
let checks = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const rows = async (sql) => (await db.query(sql)).rows;
const as = async (role, user, sql) => db.transaction(async (tx) => {
  await tx.exec('set local role ' + role);
  await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user ?? '']);
  return (await tx.query(sql)).rows;
});
const U = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
try {
  await db.exec(`
    create role anon nologin nobypassrls;
    create role authenticated nologin nobypassrls;
    create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    create table public.merchant_members (merchant_id uuid, user_id uuid, status text, removed_at timestamptz);
    create table public.documents (id integer primary key, merchant_id uuid, value text);
    create table public.private_metadata (value text);
    alter table public.merchant_members enable row level security;
    alter table public.documents enable row level security;
    alter table public.private_metadata enable row level security;
    insert into public.merchant_members values ('${A}', '${U}', 'ACTIVE', null);
    insert into public.documents values (1, '${A}', 'synthetic A'), (2, '${B}', 'synthetic B');
    insert into public.private_metadata values ('synthetic private');
    grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
  `);
  const migration = await readFile(new URL('../supabase/migrations/20261119150000_security_client_tenant_guards.sql', import.meta.url), 'utf8');
  await db.exec(migration); await db.exec(migration);
  check((await rows('select count(*)::int as n from pg_policies where schemaname=\'public\''))[0].n, 6, 'replay does not duplicate policies');
  check(await as('authenticated', U, 'select * from public.documents'), [], 'guards do not grant access');
  await db.exec(`
    create policy deliberate_broad_policy on public.documents for all to anon, authenticated using (true) with check (true);
    create policy deliberate_broad_metadata on public.private_metadata for all to anon, authenticated using (true) with check (true);
  `);
  check((await as('authenticated', U, 'select id from public.documents order by id')).map(r => r.id), [1], 'a missing merchant filter cannot expose B');
  check(await as('anon', null, 'select id from public.documents'), [], 'anonymous is still closed under a broad policy');
  check(await as('authenticated', null, 'select id from public.documents'), [], 'missing identity is closed');
  check(await as('authenticated', U, 'select * from public.private_metadata'), [], 'a table without a merchant remains closed');
  await assert.rejects(as('authenticated', U, `insert into public.documents values (3, '${B}', 'forbidden')`), { code: '42501' }); checks++;
  await assert.rejects(as('authenticated', U, `update public.documents set merchant_id='${B}' where id=1`), { code: '42501' }); checks++;
  check(await as('authenticated', U, "update public.documents set value='forbidden' where id=2 returning id"), [], 'cross-merchant update affects nothing');
  check(await as('authenticated', U, 'delete from public.documents where id=2 returning id'), [], 'cross-merchant deletion affects nothing');
  await db.exec("update public.merchant_members set removed_at=now() where user_id='" + U + "'");
  check(await as('authenticated', U, 'select id from public.documents'), [], 'removed ACTIVE membership cannot retain access');
  await db.exec("update public.merchant_members set removed_at=null, status='SUSPENDED' where user_id='" + U + "'");
  check(await as('authenticated', U, 'select id from public.documents'), [], 'suspended membership cannot retain access');
  check((await as('service_role', null, 'select id from public.documents order by id')).map(r => r.id), [1, 2], 'documented limit: BYPASSRLS still sees both merchants');
  check((await rows("select has_function_privilege('anon', 'public.nordla_is_active_member(uuid)', 'execute') as allowed"))[0].allowed, false, 'anonymous cannot execute the membership helper');
  check((await rows('select id from public.documents order by id')).map(r => r.id), [1, 2], 'forbidden writes changed no rows');
  console.log(JSON.stringify({ checks, failed: 0, engine: 'PostgreSQL/PGlite', remoteAccess: false, serviceRoleStillBypassesRls: true }));
} finally { await db.close(); }
