-- PILOT v6 (local only): hardening of the audits of the two pilot roles. AUDIT ONLY: no grant, owner or membership is changed,
-- so the rights of every other role are untouched. Already-applied migrations (v4, v5) are not edited.
--
-- fin_pilot_reader_audit (replaced) now also checks:
--   * the effective privileges in the extensions schema (tables and functions, direct and PUBLIC), with the six documented
--     platform exceptions only (supabase_admin-owned event-trigger functions, PUBLIC EXECUTE, present only where they exist);
--   * the grant option (transferability) of every privilege held by the reader role;
--   * the owner of the schemas public, nordla_runtime and extensions (must not be a pilot role);
--   * the members of the reader role (unprivileged, in no other role) and the ADMIN OPTION holders (only the platform owner).
-- fin_pilot_transfer_audit() (new) checks the same transferability and ownership rules for the issue role.
-- Both audits run at the end of this migration and fail closed.
-- Rollback: supabase/rollback/20261120130000_fin_pilot_audit_hardening.down.sql (restores the v5 reader audit body).
begin;

create or replace function nordla_runtime.fin_pilot_reader_audit()
returns table (check_name text, ok boolean, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare
  reader oid := (select oid from pg_roles where rolname = 'nordla_fin_reader_pilot');
  expected text[] := array[
    'f:nordla_runtime.fin_pilot_assert_role(uuid,text):EXECUTE@reader',
    'f:nordla_runtime.fin_pilot_bound_merchant():EXECUTE@reader',
    'n:nordla_runtime:USAGE@reader', 'n:public:USAGE@PUBLIC', 'n:public:USAGE@reader',
    'r:public.fin_documents:SELECT@reader', 'r:public.inventory_snapshots:SELECT@reader', 'r:public.locations:SELECT@reader', 'r:public.order_attribution:SELECT@reader',
    'r:public.order_lines:SELECT@reader', 'r:public.orders:SELECT@reader', 'r:public.product_collections:SELECT@reader',
    'r:public.product_costs:SELECT@reader', 'r:public.products:SELECT@reader', 'r:public.refund_lines:SELECT@reader',
    'r:public.refunds:SELECT@reader', 'r:public.variants:SELECT@reader'];
  -- the documented platform exceptions (see the v4 audit): listed explicitly, expected only where they exist
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
    select 'r:' || n.nspname || '.' || c.relname || ':' || a.privilege_type || '@' || case when a.grantee = reader then 'reader' else 'PUBLIC' end as x
      from pg_class c join pg_namespace n on n.oid = c.relnamespace,
      lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 'S' else 'r' end)::"char", c.relowner))) a
      where n.nspname in ('public', 'nordla_runtime', 'extensions') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and (a.grantee = reader or a.grantee = 0)
    union all
    select 'f:' || regexp_replace(p.oid::regprocedure::text, '\s', '', 'g') || ':' || a.privilege_type || '@' || case when a.grantee = reader then 'reader' else 'PUBLIC' end
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
      lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
      where n.nspname in ('public', 'nordla_runtime', 'extensions') and p.prorettype <> 'trigger'::regtype and (a.grantee = reader or a.grantee = 0)
    union all
    select 'n:' || n.nspname || ':' || a.privilege_type || '@' || case when a.grantee = reader then 'reader' else 'PUBLIC' end
      from pg_namespace n, lateral aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
      where n.nspname in ('public', 'nordla_runtime', 'extensions') and (a.grantee = reader or a.grantee = 0)
  ) s;
  check_name := 'reader privileges (direct and PUBLIC, effective ACL, incl. extensions) are exactly the expected set';
  select array_agg(e order by e) into missing from unnest(exp_norm) e where not (e = any (actual));
  select array_agg(a order by a) into extra from unnest(actual) a where not (a = any (exp_norm));
  ok := missing is null and extra is null;
  detail := case when ok then 'exact' else 'missing: ' || coalesce(array_to_string(missing, ', '), 'none') || ' | extra: ' || coalesce(array_to_string(extra, ', '), 'none') end;
  return next;

  -- transferability: no privilege of the reader role may carry the grant option (it could pass the right on)
  select string_agg(x, ', ') into bad from (
    select 'table ' || n.nspname || '.' || c.relname || ' ' || a.privilege_type as x
      from pg_class c join pg_namespace n on n.oid = c.relnamespace,
      lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 'S' else 'r' end)::"char", c.relowner))) a
      where a.grantee = reader and a.is_grantable and n.nspname in ('public', 'nordla_runtime', 'extensions')
    union all
    select 'function ' || p.oid::regprocedure::text || ' ' || a.privilege_type
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
      lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
      where a.grantee = reader and a.is_grantable and n.nspname in ('public', 'nordla_runtime', 'extensions')
    union all
    select 'schema ' || n.nspname || ' ' || a.privilege_type
      from pg_namespace n, lateral aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
      where a.grantee = reader and a.is_grantable and n.nspname in ('public', 'nordla_runtime', 'extensions')
  ) g;
  check_name := 'reader role holds no privilege with the grant option (it cannot pass its rights on)';
  ok := bad is null; detail := coalesce(bad, 'none'); return next;

  -- schema ownership: a pilot role must own no platform schema
  select string_agg(n.nspname || '=' || pg_get_userbyid(n.nspowner), ', ') into bad from pg_namespace n
    where n.nspname in ('public', 'nordla_runtime', 'extensions') and n.nspowner in (reader, (select oid from pg_roles where rolname = 'nordla_fin_issuer_pilot'));
  check_name := 'no pilot role owns a platform schema (public, nordla_runtime, extensions)';
  ok := bad is null; detail := coalesce(bad, 'owners checked'); return next;

  select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin, rolinherit into attrs from pg_roles where oid = reader;
  check_name := 'reader role has no privileged attribute (super, bypassrls, createrole, createdb, replication, login, inherit)';
  ok := not (attrs.rolsuper or attrs.rolbypassrls or attrs.rolcreaterole or attrs.rolcreatedb or attrs.rolreplication or attrs.rolcanlogin or attrs.rolinherit);
  detail := format('super=%s bypassrls=%s createrole=%s createdb=%s replication=%s login=%s inherit=%s', attrs.rolsuper, attrs.rolbypassrls, attrs.rolcreaterole, attrs.rolcreatedb, attrs.rolreplication, attrs.rolcanlogin, attrs.rolinherit);
  return next;

  check_name := 'reader role is a member of no role';
  ok := not exists (select 1 from pg_auth_members where member = reader);
  detail := 'checked'; return next;

  -- members of the reader role: unprivileged, in no other role. The platform owner is the explicit exception (see v4 audit).
  select string_agg(u.rolname, ',') into bad from pg_auth_members m join pg_roles u on u.oid = m.member
    where m.roleid = reader and u.rolname <> 'postgres' and (u.rolsuper or u.rolbypassrls or u.rolcreaterole or u.rolcreatedb or u.rolreplication
      or exists (select 1 from pg_auth_members m2 where m2.member = m.member and m2.roleid <> reader));
  check_name := 'every member of the reader role is unprivileged and in no other role';
  ok := bad is null; detail := coalesce(bad, 'members checked'); return next;

  -- ADMIN OPTION on the reader role (it allows granting the role onward): only the platform owner
  select string_agg(u.rolname, ',') into bad from pg_auth_members m join pg_roles u on u.oid = m.member
    where m.roleid = reader and m.admin_option and u.rolname <> 'postgres';
  check_name := 'nobody other than the platform owner can grant the reader role onward (no ADMIN OPTION)';
  ok := bad is null; detail := coalesce(bad, 'checked'); return next;

  check_name := 'reader role owns no object';
  ok := not exists (select 1 from pg_class where relowner = reader) and not exists (select 1 from pg_proc where proowner = reader);
  detail := 'checked'; return next;
end $$;
revoke all on function nordla_runtime.fin_pilot_reader_audit() from public, anon, authenticated, service_role;

-- Transfer audit for the issue role: the same transferability and ownership rules, which the v4 audit does not check.
create or replace function nordla_runtime.fin_pilot_transfer_audit()
returns table (check_name text, ok boolean, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare
  pilot oid := (select oid from pg_roles where rolname = 'nordla_fin_issuer_pilot');
  bad text;
begin
  select string_agg(x, ', ') into bad from (
    select 'table ' || n.nspname || '.' || c.relname || ' ' || a.privilege_type as x
      from pg_class c join pg_namespace n on n.oid = c.relnamespace,
      lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 'S' else 'r' end)::"char", c.relowner))) a
      where a.grantee = pilot and a.is_grantable and n.nspname in ('public', 'nordla_runtime', 'extensions')
    union all
    select 'function ' || p.oid::regprocedure::text || ' ' || a.privilege_type
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
      lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
      where a.grantee = pilot and a.is_grantable and n.nspname in ('public', 'nordla_runtime', 'extensions')
    union all
    select 'schema ' || n.nspname || ' ' || a.privilege_type
      from pg_namespace n, lateral aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
      where a.grantee = pilot and a.is_grantable and n.nspname in ('public', 'nordla_runtime', 'extensions')
  ) g;
  check_name := 'issue role holds no privilege with the grant option (it cannot pass its rights on)';
  ok := bad is null; detail := coalesce(bad, 'none'); return next;

  select string_agg(u.rolname, ',') into bad from pg_auth_members m join pg_roles u on u.oid = m.member
    where m.roleid = pilot and m.admin_option and u.rolname <> 'postgres';
  check_name := 'nobody other than the platform owner can grant the issue role onward (no ADMIN OPTION)';
  ok := bad is null; detail := coalesce(bad, 'checked'); return next;

  select string_agg(n.nspname, ', ') into bad from pg_namespace n
    where n.nspname in ('public', 'nordla_runtime', 'extensions') and n.nspowner = pilot;
  check_name := 'the issue role owns no platform schema';
  ok := bad is null; detail := coalesce(bad, 'checked'); return next;
end $$;
revoke all on function nordla_runtime.fin_pilot_transfer_audit() from public, anon, authenticated, service_role;

-- fail closed: any finding aborts this migration
do $$
declare bad text;
begin
  select string_agg(check_name || ': ' || detail, ' | ') into bad from (
    select check_name, detail from nordla_runtime.fin_pilot_reader_audit() where not ok
    union all
    select check_name, detail from nordla_runtime.fin_pilot_transfer_audit() where not ok
  ) f;
  if bad is not null then raise exception 'FIN_PILOT_AUDIT_UNSAFE: %', bad; end if;
end $$;

commit;
