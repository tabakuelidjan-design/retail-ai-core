-- Security hardening (2026-11-20): pin the search_path of every public.fin_* function.
-- Those functions are SECURITY INVOKER, so a caller-controlled search_path could redirect unqualified
-- object names. The path is pinned to the same resolution order Supabase already gives these roles
-- (public, extensions, then pg_temp), so every existing unqualified reference resolves exactly as before.
-- Behaviour is unchanged: no body, grant, owner, trigger or RLS policy is modified.
-- Rollback: supabase/rollback/20261120090000_fin_function_search_path.down.sql
begin;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'fin\_%'
      and p.prokind = 'f'
      and not coalesce(p.proconfig, array[]::text[]) @> array['search_path=public, extensions, pg_temp']
  loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', r.sig);
  end loop;
end $$;

commit;
