-- PILOT v7 (local only): least-privilege ARCHIVE role for the database side of the legal archive (onIssued hook).
-- Writes: fin_artifacts (PDF original, structured original), fin_seller_profile_versions (through fin_seller_profile_record), fin_events (archive events).
-- Reads: the artifact metadata of the bound merchant only. Nothing here widens the issue or the reader role.
--
-- Storage is NOT changed by this migration: the PDF/XML bytes stay in the existing Supabase Storage bucket (finance-inbox), written by the server
-- with its existing key, under the merchant prefix. That key remains an administrative access (listed in the pilot report); the archive role
-- does not hold it and cannot reach the storage API from the database.
-- Rollback: supabase/rollback/20261120140000_fin_archive_narrow_role.down.sql
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nordla_fin_archive_pilot') then
    create role nordla_fin_archive_pilot nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;

-- The identity check accepts the archive role as a third pilot role (the login is a member of the pilot roles only).
create or replace function nordla_runtime.fin_pilot_assert_role(p_merchant uuid, p_role text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  r record;
  target_oid oid := (select oid from pg_roles where rolname = p_role);
  issuer_oid oid := (select oid from pg_roles where rolname = 'nordla_fin_issuer_pilot');
  reader_oid oid := (select oid from pg_roles where rolname = 'nordla_fin_reader_pilot');
  archive_oid oid := (select oid from pg_roles where rolname = 'nordla_fin_archive_pilot');
  me_oid oid := (select oid from pg_roles where rolname = session_user::name);
begin
  if p_role not in ('nordla_fin_issuer_pilot', 'nordla_fin_reader_pilot', 'nordla_fin_archive_pilot') or target_oid is null then
    raise exception 'FIN_PILOT_ROLE_UNKNOWN' using errcode = '42501';
  end if;
  if nordla_runtime.fin_pilot_bound_merchant() is distinct from p_merchant then
    raise exception 'FIN_PILOT_MERCHANT_MISMATCH: this login is not bound to the requested merchant' using errcode = '42501';
  end if;
  select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication into r from pg_roles where oid = me_oid;
  if r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication then
    raise exception 'FIN_PILOT_LOGIN_PRIVILEGED' using errcode = '42501';
  end if;
  if exists (select 1 from pg_auth_members m where m.member = me_oid and m.roleid not in (issuer_oid, reader_oid, archive_oid)) then
    raise exception 'FIN_PILOT_LOGIN_MEMBERSHIP_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from pg_auth_members m where m.member = me_oid and m.roleid = target_oid) then
    raise exception 'FIN_PILOT_LOGIN_NOT_MEMBER' using errcode = '42501';
  end if;
end $$;

revoke all on function nordla_runtime.fin_pilot_assert_role(uuid, text) from public, anon, authenticated, service_role;
grant execute on function nordla_runtime.fin_pilot_assert_role(uuid, text) to nordla_fin_archive_pilot;
grant execute on function nordla_runtime.fin_pilot_bound_merchant() to nordla_fin_archive_pilot;
grant usage on schema nordla_runtime to nordla_fin_archive_pilot;
grant usage on schema public to nordla_fin_archive_pilot;

-- Archive role grants: exactly the tables and the one function the legal archive uses.
grant select, insert on public.fin_artifacts to nordla_fin_archive_pilot;
grant select, insert on public.fin_seller_profile_versions to nordla_fin_archive_pilot;
grant insert on public.fin_events to nordla_fin_archive_pilot;
grant execute on function public.fin_seller_profile_record(uuid, jsonb, text, jsonb, timestamptz) to nordla_fin_archive_pilot;
-- the VCS check of fin_artifacts (a CHECK constraint) runs as the inserting role; fin_vcs_valid is immutable and reads no table
grant execute on function public.fin_vcs_valid(text) to nordla_fin_archive_pilot;

-- Row policies: the archive role sees and writes only the bound merchant's rows (restrictive guard + permissive policy).
do $$
declare
  t text;
  cmds text[][] := array[array['fin_artifacts', 'all'], array['fin_seller_profile_versions', 'all'], array['fin_events', 'insert']];
  c text[];
begin
  foreach c slice 1 in array cmds loop
    t := c[1];
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists nordla_fin_archive_guard on public.%I', t);
    execute format('drop policy if exists nordla_fin_archive_rows on public.%I', t);
    -- an INSERT policy accepts only WITH CHECK; the other commands take USING as well
    if c[2] = 'insert' then
      execute format('create policy nordla_fin_archive_guard on public.%I as restrictive for insert to nordla_fin_archive_pilot with check (merchant_id = nordla_runtime.fin_pilot_bound_merchant())', t);
      execute format('create policy nordla_fin_archive_rows on public.%I as permissive for insert to nordla_fin_archive_pilot with check (merchant_id = nordla_runtime.fin_pilot_bound_merchant())', t);
    else
      execute format('create policy nordla_fin_archive_guard on public.%I as restrictive for %s to nordla_fin_archive_pilot using (merchant_id = nordla_runtime.fin_pilot_bound_merchant()) with check (merchant_id = nordla_runtime.fin_pilot_bound_merchant())', t, c[2]);
      execute format('create policy nordla_fin_archive_rows on public.%I as permissive for %s to nordla_fin_archive_pilot using (merchant_id = nordla_runtime.fin_pilot_bound_merchant()) with check (merchant_id = nordla_runtime.fin_pilot_bound_merchant())', t, c[2]);
    end if;
  end loop;
end $$;

-- Archive audit: exact effective privileges of the archive role, attributes, memberships and transferability.
create or replace function nordla_runtime.fin_pilot_archive_audit()
returns table (check_name text, ok boolean, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare
  archive oid := (select oid from pg_roles where rolname = 'nordla_fin_archive_pilot');
  expected text[] := array[
    'f:nordla_runtime.fin_pilot_assert_role(uuid,text):EXECUTE@archive',
    'f:nordla_runtime.fin_pilot_bound_merchant():EXECUTE@archive',
    'f:public.fin_seller_profile_record(uuid,jsonb,text,jsonb,timestampwithtimezone):EXECUTE@archive',
    'f:public.fin_vcs_valid(text):EXECUTE@archive',
    'n:nordla_runtime:USAGE@archive', 'n:public:USAGE@PUBLIC', 'n:public:USAGE@archive',
    'r:public.fin_artifacts:INSERT@archive', 'r:public.fin_artifacts:SELECT@archive',
    'r:public.fin_events:INSERT@archive',
    'r:public.fin_seller_profile_versions:INSERT@archive', 'r:public.fin_seller_profile_versions:SELECT@archive'];
  platform_exc text[] := array[
    'f:extensions.grant_pg_cron_access():EXECUTE@PUBLIC',
    'f:extensions.grant_pg_graphql_access():EXECUTE@PUBLIC',
    'f:extensions.grant_pg_net_access():EXECUTE@PUBLIC',
    'f:extensions.pgrst_ddl_watch():EXECUTE@PUBLIC',
    'f:extensions.pgrst_drop_watch():EXECUTE@PUBLIC',
    'f:extensions.set_graphql_placeholder():EXECUTE@PUBLIC'];
  exp_norm text[];
  actual text[];
  missing text[];
  extra text[];
  attrs record;
  bad text;
begin
  select array_agg(x order by x) into exp_norm from (
    select unnest(expected) as x
    union all
    select e from unnest(platform_exc) e where to_regprocedure(split_part(e, ':', 2)) is not null
  ) s;
  select coalesce(array_agg(x order by x), '{}') into actual from (
    select 'r:' || n.nspname || '.' || c.relname || ':' || a.privilege_type || '@' || case when a.grantee = archive then 'archive' else 'PUBLIC' end as x
      from pg_class c join pg_namespace n on n.oid = c.relnamespace,
      lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 'S' else 'r' end)::"char", c.relowner))) a
      where n.nspname in ('public', 'nordla_runtime', 'extensions') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and (a.grantee = archive or a.grantee = 0)
    union all
    select 'f:' || regexp_replace(p.oid::regprocedure::text, '\s', '', 'g') || ':' || a.privilege_type || '@' || case when a.grantee = archive then 'archive' else 'PUBLIC' end
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
      lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
      where n.nspname in ('public', 'nordla_runtime', 'extensions') and p.prorettype <> 'trigger'::regtype and (a.grantee = archive or a.grantee = 0)
    union all
    select 'n:' || n.nspname || ':' || a.privilege_type || '@' || case when a.grantee = archive then 'archive' else 'PUBLIC' end
      from pg_namespace n, lateral aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
      where n.nspname in ('public', 'nordla_runtime', 'extensions') and (a.grantee = archive or a.grantee = 0)
  ) s;
  check_name := 'archive privileges (direct and PUBLIC, effective ACL, incl. extensions) are exactly the expected set';
  select array_agg(e order by e) into missing from unnest(exp_norm) e where not (e = any (actual));
  select array_agg(a order by a) into extra from unnest(actual) a where not (a = any (exp_norm));
  ok := missing is null and extra is null;
  detail := case when ok then 'exact' else 'missing: ' || coalesce(array_to_string(missing, ', '), 'none') || ' | extra: ' || coalesce(array_to_string(extra, ', '), 'none') end;
  return next;

  select string_agg(x, ', ') into bad from (
    select 'table ' || n.nspname || '.' || c.relname || ' ' || a.privilege_type as x
      from pg_class c join pg_namespace n on n.oid = c.relnamespace,
      lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 'S' else 'r' end)::"char", c.relowner))) a
      where a.grantee = archive and a.is_grantable and n.nspname in ('public', 'nordla_runtime', 'extensions')
    union all
    select 'function ' || p.oid::regprocedure::text || ' ' || a.privilege_type
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
      lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
      where a.grantee = archive and a.is_grantable and n.nspname in ('public', 'nordla_runtime', 'extensions')
  ) g;
  check_name := 'archive role holds no privilege with the grant option (it cannot pass its rights on)';
  ok := bad is null; detail := coalesce(bad, 'none'); return next;

  select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin, rolinherit into attrs from pg_roles where oid = archive;
  check_name := 'archive role has no privileged attribute (super, bypassrls, createrole, createdb, replication, login, inherit)';
  ok := not (attrs.rolsuper or attrs.rolbypassrls or attrs.rolcreaterole or attrs.rolcreatedb or attrs.rolreplication or attrs.rolcanlogin or attrs.rolinherit);
  detail := 'checked'; return next;

  check_name := 'archive role is a member of no role and owns no object';
  ok := not exists (select 1 from pg_auth_members where member = archive)
    and not exists (select 1 from pg_class where relowner = archive) and not exists (select 1 from pg_proc where proowner = archive);
  detail := 'checked'; return next;

  select string_agg(u.rolname, ',') into bad from pg_auth_members m join pg_roles u on u.oid = m.member
    where m.roleid = archive and m.admin_option and u.rolname <> 'postgres';
  check_name := 'nobody other than the platform owner can grant the archive role onward (no ADMIN OPTION)';
  ok := bad is null; detail := coalesce(bad, 'checked'); return next;
end $$;
revoke all on function nordla_runtime.fin_pilot_archive_audit() from public, anon, authenticated, service_role;

-- fail closed
do $$
declare bad text;
begin
  select string_agg(check_name || ': ' || detail, ' | ') into bad from nordla_runtime.fin_pilot_archive_audit() where not ok;
  if bad is not null then raise exception 'FIN_ARCHIVE_ROLE_UNSAFE: %', bad; end if;
end $$;

commit;
