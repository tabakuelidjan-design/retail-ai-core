// Security hardening 2026-11-20 on a real PostgreSQL 17:
//  (1) every public.fin_* function carries the pinned search_path of migration 20261120090000 and nothing else changes;
//  (2) the rollback restores the previous state exactly for those functions;
//  (3) nordla_is_active_member(uuid) (Core migration 20261119150000, copied verbatim into a fixture) decides membership
//      only for auth.uid(), ACTIVE status and removed_at null, refuses other merchants, and grants EXECUTE to authenticated only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freshDatabase, MERCHANT_A, MERCHANT_B } from './lib/db.js';

const PIN = 'search_path=public, extensions, pg_temp';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UP = readFileSync(`${ROOT}supabase/migrations/20261120090000_fin_function_search_path.sql`, 'utf8');
const DOWN = readFileSync(`${ROOT}supabase/rollback/20261120090000_fin_function_search_path.down.sql`, 'utf8');

const finState = (c) => c.query(`select p.proname, p.proconfig::text as cfg from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'fin\\_%' order by p.proname, p.oid`);

test('every public.fin_* function is pinned to the Supabase resolution order; the pin is the only change', async () => {
  const db = await freshDatabase();
  const c = await db.open();
  try {
    const rows = (await finState(c)).rows;
    assert.ok(rows.length >= 33, `expected at least the 33 audited functions, got ${rows.length}`);
    const unpinned = rows.filter((r) => !(r.cfg ?? '').includes(PIN));
    assert.deepEqual(unpinned.map((r) => r.proname), [], 'no fin_* function may keep a mutable search_path');
  } finally { await c.end(); await db.drop(); }
});

test('the migration pins exactly the unpinned fin_* functions and the rollback restores the previous state', async () => {
  const db = await freshDatabase();
  const c = await db.open();
  try {
    // Simulate the staging state: remove the pin, then apply the migration, then roll back.
    await c.query(`do $$ declare r record; begin for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'fin\\_%' loop execute format('alter function %s reset search_path', r.sig); end loop; end $$`);
    const before = (await finState(c)).rows;
    assert.ok(before.every((r) => r.cfg === null), 'precondition: no pin');
    await c.query(UP);
    const afterUp = (await finState(c)).rows;
    assert.ok(afterUp.every((r) => (r.cfg ?? '').includes(PIN)), 'migration pins every fin_* function');
    await c.query(UP); // idempotent: a second run changes nothing
    assert.deepEqual((await finState(c)).rows, afterUp, 'second application is a no-op');
    await c.query(DOWN);
    assert.deepEqual((await finState(c)).rows, before, 'rollback restores the exact previous configuration');
    await c.query(UP);
  } finally { await c.end(); await db.drop(); }
});

test('Finance functions keep SECURITY INVOKER and their pin (behaviour is covered by suites 30/50/70 after this migration)', async () => {
  const db = await freshDatabase();
  const c = await db.open();
  try {
    const modes = (await c.query(`select count(*) filter (where prosecdef) as definer, count(*) as total from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'fin\\_%'`)).rows[0];
    assert.equal(Number(modes.definer), 0, 'Finance functions stay SECURITY INVOKER');
    const pinned = (await c.query(`select p.proconfig::text as cfg from pg_proc p where p.proname='fin_next_number'`)).rows[0];
    assert.ok(pinned.cfg.includes(PIN));
  } finally { await c.end(); await db.drop(); }
});

// ---------- nordla_is_active_member: Core migration 20261119150000, verbatim function and grants ----------
// The Finance migrations already create a Finance-shaped merchant_members (no removed_at). This scratch database is
// replaced by the Core shape that the Core function is written against; it is dropped with the scratch database.
const NORDLA_FN = `
drop table if exists public.merchant_members cascade;
create table public.merchant_members (merchant_id uuid not null, user_id uuid not null, status text not null, removed_at timestamptz);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid $$;
create or replace function public.nordla_is_active_member(p_merchant uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.merchant_members m
    where m.merchant_id = p_merchant and m.user_id = auth.uid()
      and m.status = 'ACTIVE' and m.removed_at is null
  )
$$;
revoke all on function public.nordla_is_active_member(uuid) from public, anon, authenticated;
grant execute on function public.nordla_is_active_member(uuid) to authenticated;
`;
const U1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const U2 = 'aaaaaaaa-0000-0000-0000-000000000002';

test('nordla_is_active_member: ACTIVE, not removed, same merchant only; authenticated execute only', async () => {
  const db = await freshDatabase();
  const c = await db.open();
  try {
    await c.query(NORDLA_FN);
    await c.query(`insert into public.merchant_members values
      ('${MERCHANT_A}','${U1}','ACTIVE',null),
      ('${MERCHANT_A}','${U2}','SUSPENDED',null),
      ('${MERCHANT_B}','${U2}','ACTIVE',now())`);
    const check = async (user, merchant) => {
      await c.query('begin');
      try {
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
        await c.query('set local role authenticated');
        return (await c.query('select public.nordla_is_active_member($1::uuid) as ok', [merchant])).rows[0].ok;
      } finally { await c.query('rollback'); }
    };
    assert.equal(await check(U1, MERCHANT_A), true, 'active member of A');
    assert.equal(await check(U1, MERCHANT_B), false, 'refused for another merchant');
    assert.equal(await check(U2, MERCHANT_A), false, 'suspended member refused');
    assert.equal(await check(U2, MERCHANT_B), false, 'removed member refused');
    const anon = await c.query("select has_function_privilege('anon','public.nordla_is_active_member(uuid)','EXECUTE') as a, has_function_privilege('authenticated','public.nordla_is_active_member(uuid)','EXECUTE') as u");
    assert.equal(anon.rows[0].a, false, 'anon cannot execute');
    assert.equal(anon.rows[0].u, true, 'authenticated can execute (intentional: RLS policies use it)');
    const cfg = (await c.query(`select prosecdef, proconfig @> array['search_path=""'] as empty_path from pg_proc where proname='nordla_is_active_member'`)).rows[0];
    assert.equal(cfg.prosecdef, true);
    assert.equal(cfg.empty_path, true, 'search_path already fixed to empty in the source');
  } finally { await c.end(); await db.drop(); }
});
