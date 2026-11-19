-- Tests of migration 20261119160000, run as the LOGIN role analytics_login (member of analytics_reader; not a superuser; no BYPASSRLS).
-- Results go to a temp table. A case passes when actual = expected, or when expected is 'ERR:<text>' and actual starts with it.
create temp table r (name text, expected text, actual text);

-- T1 identity of the connection
insert into r select 'login role', 'analytics_login', current_user::text;
insert into r select 'session user = login role (no SET ROLE)', 'analytics_login', session_user::text;
insert into r select 'superuser/bypassrls', 'false/false', (select rolsuper::text || '/' || rolbypassrls::text from pg_roles where rolname = current_user);
insert into r select 'member of analytics_reader', 'true', pg_has_role(current_user, 'analytics_reader', 'member')::text;

-- T2 no merchant context: every read fails (never an empty list)
do $$ declare got text := 'NO_ERROR'; begin
  begin perform 1 from public.merchants; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('no context: merchants', 'ERR:MERCHANT_CONTEXT_REQUIRED', got);
end $$;
do $$ declare got text := 'NO_ERROR'; begin
  begin perform 1 from public.merchant_connectors; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('no context: merchant_connectors', 'ERR:MERCHANT_CONTEXT_REQUIRED', got);
end $$;
do $$ declare got text := 'NO_ERROR'; begin
  begin perform 1 from public.sync_runs; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('no context: sync_runs', 'ERR:MERCHANT_CONTEXT_REQUIRED', got);
end $$;

-- T3 empty and invalid contexts are refused too
begin;
select set_config('app.merchant_id', '', true);
do $$ declare got text := 'NO_ERROR'; begin
  begin perform 1 from public.sync_runs; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('empty context', 'ERR:MERCHANT_CONTEXT_REQUIRED', got);
end $$;
commit;
begin;
select set_config('app.merchant_id', 'not-a-uuid', true);
do $$ declare got text := 'NO_ERROR'; begin
  begin perform 1 from public.sync_runs; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('invalid context', 'ERR:MERCHANT_CONTEXT_INVALID', got);
end $$;
commit;

-- T4 merchant A in context (one transaction): own rows, cross filters empty, writes refused
begin;
select set_config('app.merchant_id', 'aaaaaaaa-0000-4000-8000-00000000000a', true);
insert into r select 'A: merchants visible', '1', count(*)::text from public.merchants;
insert into r select 'A: merchant_connectors visible', '0', count(*)::text from public.merchant_connectors;
insert into r select 'A: sync_runs visible', '1', count(*)::text from public.sync_runs;
insert into r select 'A: name read back', 'Replay A (fictif)', (select name from public.merchants limit 1);
insert into r select 'A: B failed sync invisible', '0', count(*)::text from public.sync_runs where status = 'FAILED';
insert into r select 'A: cross filter sync_runs of B', '0', count(*)::text from public.sync_runs where merchant_id = 'bbbbbbbb-0000-4000-8000-00000000000b';
insert into r select 'A: cross filter merchants B', '0', count(*)::text from public.merchants where id = 'bbbbbbbb-0000-4000-8000-00000000000b';
do $$ declare got text := 'NO_ERROR'; begin
  begin insert into public.sync_runs (merchant_id, mode, status) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'x', 'SUCCESS'); exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('A: insert sync_runs refused', 'ERR:permission denied', got);
end $$;
do $$ declare got text := 'NO_ERROR'; begin
  begin update public.sync_runs set status = 'FAILED'; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('A: update sync_runs refused', 'ERR:permission denied', got);
end $$;
do $$ declare got text := 'NO_ERROR'; begin
  begin delete from public.sync_runs; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('A: delete sync_runs refused', 'ERR:permission denied', got);
end $$;
do $$ declare got text := 'NO_ERROR'; begin
  begin update public.merchants set name = 'changed'; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('A: update merchants refused', 'ERR:permission denied', got);
end $$;
do $$ declare got text := 'NO_ERROR'; begin
  begin delete from public.merchant_connectors; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('A: delete merchant_connectors refused', 'ERR:permission denied', got);
end $$;
do $$ declare got text := 'NO_ERROR'; begin
  begin truncate public.sync_runs; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('A: truncate sync_runs refused', 'ERR:permission denied', got);
end $$;
do $$ declare got text := 'NO_ERROR'; begin
  begin perform 1 from public.merchant_members; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('A: other table merchant_members refused', 'ERR:permission denied', got);
end $$;
commit;

-- T5 merchant B in context, next transaction on the same connection
begin;
select set_config('app.merchant_id', 'bbbbbbbb-0000-4000-8000-00000000000b', true);
insert into r select 'B: merchant_connectors visible', '1', count(*)::text from public.merchant_connectors;
insert into r select 'B: sync_runs visible', '1', count(*)::text from public.sync_runs;
insert into r select 'B: A success sync invisible', '0', count(*)::text from public.sync_runs where status = 'SUCCESS';
commit;

-- T6 the context does not survive COMMIT or ROLLBACK
begin;
select set_config('app.merchant_id', 'aaaaaaaa-0000-4000-8000-00000000000a', true);
rollback;
do $$ declare got text := 'NO_ERROR'; begin
  begin perform 1 from public.sync_runs; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('after rollback: no context', 'ERR:MERCHANT_CONTEXT_REQUIRED', got);
end $$;
begin;
select set_config('app.merchant_id', 'aaaaaaaa-0000-4000-8000-00000000000a', true);
commit;
do $$ declare got text := 'NO_ERROR'; begin
  begin perform 1 from public.sync_runs; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('after commit: no context', 'ERR:MERCHANT_CONTEXT_REQUIRED', got);
end $$;

-- T7 grants visible to the catalog (pre-existing anon/authenticated grants are reported, not changed)
insert into r select 'analytics_login: no INSERT on sync_runs (catalog)', 'false', has_table_privilege('analytics_reader', 'public.sync_runs', 'INSERT')::text;
insert into r select 'analytics_reader: no UPDATE on merchants (catalog)', 'false', has_table_privilege('analytics_reader', 'public.merchants', 'UPDATE')::text;
insert into r select 'analytics_reader: SELECT on sync_runs (catalog)', 'true', has_table_privilege('analytics_reader', 'public.sync_runs', 'SELECT')::text;

select name, expected, actual,
  case when actual = expected or (expected like 'ERR:%' and actual like expected || '%') then 'OK' else 'ÉCHEC' end as resultat
from r order by name;
select count(*) filter (where actual = expected or (expected like 'ERR:%' and actual like expected || '%')) as conformes, count(*) as total from r;
