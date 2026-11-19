-- BEFORE the pilot migration, as the LOGIN role analytics_login (member of analytics_reader, not superuser, no BYPASSRLS).
-- Expected: the grants exist, but no permissive policy is present, so a valid merchant context shows NO rows, and nothing errors.
-- Writes stay refused. Results go to a temp table; the same comparison rule as tests.sql applies.
create temp table r (name text, expected text, actual text);

insert into r select 'login role', 'analytics_login', current_user::text;
insert into r select 'no superuser/bypassrls', 'false/false', (select rolsuper::text || '/' || rolbypassrls::text from pg_roles where rolname = current_user);

begin;
select set_config('app.merchant_id', 'aaaaaaaa-0000-4000-8000-00000000000a', true);
insert into r select 'before: A context, merchants visible (no policy)', '0', count(*)::text from public.merchants;
insert into r select 'before: A context, sync_runs visible (no policy)', '0', count(*)::text from public.sync_runs;
insert into r select 'before: A context, merchant_connectors visible (no policy)', '0', count(*)::text from public.merchant_connectors;
commit;

begin;
select set_config('app.merchant_id', 'bbbbbbbb-0000-4000-8000-00000000000b', true);
insert into r select 'before: B context, sync_runs visible (no policy)', '0', count(*)::text from public.sync_runs;
commit;

-- no context and invalid context: no error yet (the strict function does not exist before the migration), and no rows
insert into r select 'before: no context, sync_runs rows', '0', count(*)::text from public.sync_runs;
do $$ declare got text := 'NO_ERROR'; begin
  begin perform 1 from public.merchants; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('before: no context, merchants read', 'NO_ERROR', got);
end $$;

-- writes refused (no grant)
do $$ declare got text := 'NO_ERROR'; begin
  begin insert into public.sync_runs (merchant_id, mode, status) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'x', 'SUCCESS'); exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('before: insert sync_runs refused', 'ERR:permission denied', got);
end $$;
do $$ declare got text := 'NO_ERROR'; begin
  begin update public.sync_runs set status = 'FAILED'; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('before: update sync_runs refused', 'ERR:permission denied', got);
end $$;
do $$ declare got text := 'NO_ERROR'; begin
  begin delete from public.sync_runs; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('before: delete sync_runs refused', 'ERR:permission denied', got);
end $$;

select name, expected, actual, case when actual = expected or (expected like 'ERR:%' and actual like expected || '%') then 'OK' else 'ÉCHEC' end as resultat from r order by name;
select count(*) filter (where actual = expected or (expected like 'ERR:%' and actual like expected || '%')) as conformes, count(*) as total from r;
