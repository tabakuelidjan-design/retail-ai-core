-- Rollback of supabase/migrations/20261119180000_analytics_access_checker_roles.sql. Owner (postgres), one transaction.
-- Removes only what that migration added. Login roles created out of band are kept (they hold no privilege afterwards).
begin;

drop policy if exists analytics_checker_member on public.merchant_members;
drop policy if exists analytics_checker_entitlement on public.module_entitlements;

revoke all on public.merchant_members, public.module_entitlements from analytics_access_checker;
revoke usage on schema analytics_checker from analytics_access_checker;

drop function if exists analytics_checker.mfa_status(uuid, uuid);
drop function if exists analytics_checker.ctx_uuid(text);
drop schema if exists analytics_checker;

do $$ declare m record; begin
  for m in
    select mem.rolname as member from pg_auth_members am
      join pg_roles g on g.oid = am.roleid join pg_roles mem on mem.oid = am.member
     where g.rolname = 'analytics_access_checker'
  loop
    execute format('revoke analytics_access_checker from %I', m.member);
  end loop;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'analytics_access_checker') then drop role analytics_access_checker; end if;
end $$;

commit;
