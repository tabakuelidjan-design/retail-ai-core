-- Returns client-role access to the previous implicit default-deny state.
-- Run before adding any permissive client policies; otherwise STOP and review.
begin;
do $$
declare r record;
begin
  if exists (select 1 from pg_catalog.pg_policies where schemaname='public' and permissive='PERMISSIVE') then
    raise exception 'ROLLBACK_REFUSED: review permissive client policies before removing tenant guards';
  end if;
  for r in select schemaname, tablename, policyname from pg_catalog.pg_policies
    where schemaname='public' and policyname in ('nordla_deny_anon','nordla_tenant_guard','nordla_deny_authenticated')
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;
drop function public.nordla_is_active_member(uuid);
commit;
