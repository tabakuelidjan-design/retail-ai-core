-- Rollback of 20261120090000_fin_function_search_path.sql.
-- Restores the previous state (no pinned search_path) only for public.fin_* functions that carry the exact
-- pin set by that migration. Functions with any other configuration are left untouched.
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
      and coalesce(p.proconfig, array[]::text[]) @> array['search_path=public, extensions, pg_temp']
  loop
    execute format('alter function %s reset search_path', r.sig);
  end loop;
end $$;

commit;
