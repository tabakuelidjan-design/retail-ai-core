-- Rollback of 20261120130000_fin_pilot_audit_hardening.sql (v6). Restores the v5 reader audit body exactly and removes the
-- transfer audit. Audit only: no grant, owner or membership is changed by either direction.
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
  exp_norm text[];
  actual text[];
  missing text[];
  extra text[];
  attrs record;
begin
  select array_agg(x order by x) into exp_norm from unnest(expected) x;
  select coalesce(array_agg(x order by x), '{}') into actual from (
    select 'r:' || n.nspname || '.' || c.relname || ':' || a.privilege_type || '@' || case when a.grantee = reader then 'reader' else 'PUBLIC' end as x
      from pg_class c join pg_namespace n on n.oid = c.relnamespace,
      lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 'S' else 'r' end)::"char", c.relowner))) a
      where n.nspname in ('public', 'nordla_runtime') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and (a.grantee = reader or a.grantee = 0)
    union all
    select 'f:' || regexp_replace(p.oid::regprocedure::text, '\s', '', 'g') || ':' || a.privilege_type || '@' || case when a.grantee = reader then 'reader' else 'PUBLIC' end
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
      lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
      where n.nspname in ('public', 'nordla_runtime') and p.prorettype <> 'trigger'::regtype and (a.grantee = reader or a.grantee = 0)
    union all
    select 'n:' || n.nspname || ':' || a.privilege_type || '@' || case when a.grantee = reader then 'reader' else 'PUBLIC' end
      from pg_namespace n, lateral aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
      where n.nspname in ('public', 'nordla_runtime') and (a.grantee = reader or a.grantee = 0)
  ) s;
  check_name := 'reader privileges (direct and PUBLIC, effective ACL) are exactly the expected set';
  select array_agg(e order by e) into missing from unnest(exp_norm) e where not (e = any (actual));
  select array_agg(a order by a) into extra from unnest(actual) a where not (a = any (exp_norm));
  ok := missing is null and extra is null;
  detail := case when ok then 'exact' else 'missing: ' || coalesce(array_to_string(missing, ', '), 'none') || ' | extra: ' || coalesce(array_to_string(extra, ', '), 'none') end;
  return next;

  select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin, rolinherit into attrs from pg_roles where oid = reader;
  check_name := 'reader role has no privileged attribute (super, bypassrls, createrole, createdb, replication, login, inherit)';
  ok := not (attrs.rolsuper or attrs.rolbypassrls or attrs.rolcreaterole or attrs.rolcreatedb or attrs.rolreplication or attrs.rolcanlogin or attrs.rolinherit);
  detail := format('super=%s bypassrls=%s createrole=%s createdb=%s replication=%s login=%s inherit=%s', attrs.rolsuper, attrs.rolbypassrls, attrs.rolcreaterole, attrs.rolcreatedb, attrs.rolreplication, attrs.rolcanlogin, attrs.rolinherit);
  return next;

  check_name := 'reader role is a member of no role';
  ok := not exists (select 1 from pg_auth_members where member = reader);
  detail := 'checked'; return next;

  check_name := 'reader role owns no object';
  ok := not exists (select 1 from pg_class where relowner = reader) and not exists (select 1 from pg_proc where proowner = reader);
  detail := 'checked'; return next;
end $$;
revoke all on function nordla_runtime.fin_pilot_reader_audit() from public, anon, authenticated, service_role;

drop function if exists nordla_runtime.fin_pilot_transfer_audit();

commit;
