-- AFTER the rollback, as the LOGIN role analytics_login (its login role is kept by design; it must hold no privilege any more).
create temp table r (name text, expected text, actual text);

insert into r select 'after rollback: login role kept', 'analytics_login', current_user::text;
insert into r select 'after rollback: no membership of analytics_reader', '0', (select count(*)::text from pg_auth_members am join pg_roles g on g.oid = am.roleid where g.rolname = 'analytics_reader');
insert into r select 'after rollback: analytics_reader role gone', '0', (select count(*)::text from pg_roles where rolname = 'analytics_reader');

do $$ declare got text := 'NO_ERROR'; begin
  begin perform 1 from public.sync_runs; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('after rollback: sync_runs read refused', 'ERR:permission denied', got);
end $$;
do $$ declare got text := 'NO_ERROR'; begin
  begin perform 1 from public.merchants; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('after rollback: merchants read refused', 'ERR:permission denied', got);
end $$;
do $$ declare got text := 'NO_ERROR'; begin
  begin perform 1 from public.merchant_connectors; exception when others then got := 'ERR:' || sqlerrm; end;
  insert into r values ('after rollback: merchant_connectors read refused', 'ERR:permission denied', got);
end $$;

select name, expected, actual, case when actual = expected or (expected like 'ERR:%' and actual like expected || '%') then 'OK' else 'ÉCHEC' end as resultat from r order by name;
select count(*) filter (where actual = expected or (expected like 'ERR:%' and actual like expected || '%')) as conformes, count(*) as total from r;
