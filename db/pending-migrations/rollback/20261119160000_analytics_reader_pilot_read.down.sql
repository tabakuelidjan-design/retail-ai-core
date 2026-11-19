-- Rollback of supabase/migrations/20261119160000_analytics_reader_pilot_read.sql.
-- Removes only what that migration added. Existing policies, grants and other roles are untouched.
-- Run as the owner (postgres), in a transaction, after stopping any analytics_reader login.
begin;

drop policy if exists analytics_reader_read on public.merchants;
drop policy if exists analytics_reader_read on public.merchant_connectors;
drop policy if exists analytics_reader_read on public.sync_runs;

revoke all on public.merchants, public.merchant_connectors, public.sync_runs from analytics_reader;
-- the schema usage and the SELECT grants may have been given during preparation (before the migration): remove them too
revoke usage on schema public from analytics_reader;
revoke usage on schema analytics_access from analytics_reader;
drop function if exists analytics_access.current_merchant_strict();
drop schema if exists analytics_access;

-- Retire every membership of analytics_reader first (the login roles themselves are created out of band and stay, with no privilege).
do $$ declare m record; begin
  for m in
    select mem.rolname as member from pg_auth_members am
      join pg_roles g on g.oid = am.roleid join pg_roles mem on mem.oid = am.member
     where g.rolname = 'analytics_reader'
  loop
    execute format('revoke analytics_reader from %I', m.member);
  end loop;
end $$;

-- Drop the role. This fails loudly if any privilege or object still depends on it: no orphans are left behind.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'analytics_reader') then
    drop role analytics_reader;
  end if;
end $$;

commit;
