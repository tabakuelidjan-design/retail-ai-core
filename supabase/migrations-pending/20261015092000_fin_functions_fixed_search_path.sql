-- NORDLA CORE P0 - PREPARED, NOT APPLIED (supabase/migrations-pending/). Owner authorization required before it is moved to supabase/migrations.
--
-- The Finance functions (fin_*) were created without a fixed search_path (Supabase advisor: function_search_path_mutable; 6 on the live project
-- at the time of the census, 33 in the repository's migrations). A function that resolves names through the CALLER's search_path can be made to
-- call another object of the same name. Each fin_* function without a search_path gets the path it already runs with on Supabase
-- (public, then extensions for pgcrypto), with pg_temp last so a temporary object can never shadow a real one. Behaviour is unchanged.
-- Signature-independent (reads pg_proc), idempotent (a function that already has a search_path is left alone), and it verifies its own result.
do $$
declare f regprocedure; n integer := 0; left_over integer;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and p.proname like 'fin\_%' and p.prokind = 'f'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')
  loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', f);
    n := n + 1;
  end loop;
  select count(*) into left_over from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.proname like 'fin\_%' and p.prokind = 'f'
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%');
  if left_over > 0 then raise exception 'FIN_SEARCH_PATH_INCOMPLETE: % function(s) left', left_over; end if;
  raise notice 'fin_* functions given a fixed search_path: %', n;
end $$;
