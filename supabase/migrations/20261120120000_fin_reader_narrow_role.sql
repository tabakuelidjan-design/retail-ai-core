-- PILOT v5 (local only, not applied remotely): least-privilege READ role for the reads that happen before an issue
-- (linkage: fin_documents; ledger: the commerce tables that the dataset loader reads). Read-only, merchant-scoped by the
-- PostgreSQL login identity (the same binding as the issue role). The issue role gets NO new right.
--
-- Changes:
--   * new role nordla_fin_reader_pilot (NOLOGIN, NOBYPASSRLS, NOINHERIT), SELECT only on the listed tables;
--   * restrictive guard + permissive policy per table: the row must belong to the bound merchant;
--   * fin_pilot_assert_role(p_merchant, p_role): the identity check for either role; fin_pilot_assert keeps its meaning for
--     the issue role. A login may be a member of the issue role and of the reader role, and of nothing else;
--   * fin_pilot_reader_audit(): exact privileges of the reader role.
-- Rollback: supabase/rollback/20261120120000_fin_reader_narrow_role.down.sql
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nordla_fin_reader_pilot') then
    create role nordla_fin_reader_pilot nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  -- the creator of a role is added to it automatically on PostgreSQL 16+: that membership is the platform owner's, not ours
end $$;

-- Identity check for either pilot role. Membership: the login is a member of the requested role, and of no role other than
-- the two pilot roles. Privileged logins are refused; the bound merchant must be p_merchant.
create or replace function nordla_runtime.fin_pilot_assert_role(p_merchant uuid, p_role text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  r record;
  target_oid oid := (select oid from pg_roles where rolname = p_role);
  issuer_oid oid := (select oid from pg_roles where rolname = 'nordla_fin_issuer_pilot');
  reader_oid oid := (select oid from pg_roles where rolname = 'nordla_fin_reader_pilot');
  me_oid oid := (select oid from pg_roles where rolname = session_user::name);
begin
  if p_role not in ('nordla_fin_issuer_pilot', 'nordla_fin_reader_pilot') or target_oid is null then
    raise exception 'FIN_PILOT_ROLE_UNKNOWN' using errcode = '42501';
  end if;
  if nordla_runtime.fin_pilot_bound_merchant() is distinct from p_merchant then
    raise exception 'FIN_PILOT_MERCHANT_MISMATCH: this login is not bound to the requested merchant' using errcode = '42501';
  end if;
  select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication into r from pg_roles where oid = me_oid;
  if r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication then
    raise exception 'FIN_PILOT_LOGIN_PRIVILEGED' using errcode = '42501';
  end if;
  if exists (select 1 from pg_auth_members m where m.member = me_oid and m.roleid not in (issuer_oid, reader_oid)) then
    raise exception 'FIN_PILOT_LOGIN_MEMBERSHIP_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from pg_auth_members m where m.member = me_oid and m.roleid = target_oid) then
    raise exception 'FIN_PILOT_LOGIN_NOT_MEMBER' using errcode = '42501';
  end if;
end $$;

-- The issue role keeps its entry point (same name and meaning as in v4).
create or replace function nordla_runtime.fin_pilot_assert(p_merchant uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform nordla_runtime.fin_pilot_assert_role(p_merchant, 'nordla_fin_issuer_pilot');
end $$;

revoke all on function nordla_runtime.fin_pilot_assert_role(uuid, text) from public, anon, authenticated, service_role;
-- the issue role does not need EXECUTE on the role check: fin_pilot_assert (its entry point) calls it as the owner
grant execute on function nordla_runtime.fin_pilot_assert_role(uuid, text) to nordla_fin_reader_pilot;
grant execute on function nordla_runtime.fin_pilot_bound_merchant() to nordla_fin_reader_pilot;
grant usage on schema nordla_runtime to nordla_fin_reader_pilot;
grant usage on schema public to nordla_fin_reader_pilot;

-- Read set: exactly what the pre-issue reads need. Names are reviewed against src/metrics/load.js and src/finance/supabase-store.js.
do $$
declare
  t text;
  reads text[] := array['fin_documents', 'products', 'variants', 'orders', 'order_lines', 'order_attribution', 'refunds', 'refund_lines',
                        'product_costs', 'product_collections', 'locations', 'inventory_snapshots'];
begin
  foreach t in array reads loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select on table public.%I to nordla_fin_reader_pilot', t);
    execute format('drop policy if exists nordla_fin_reader_guard on public.%I', t);
    execute format('create policy nordla_fin_reader_guard on public.%I as restrictive for select to nordla_fin_reader_pilot using (merchant_id = nordla_runtime.fin_pilot_bound_merchant())', t);
    execute format('drop policy if exists nordla_fin_reader_rows on public.%I', t);
    execute format('create policy nordla_fin_reader_rows on public.%I as permissive for select to nordla_fin_reader_pilot using (merchant_id = nordla_runtime.fin_pilot_bound_merchant())', t);
  end loop;
end $$;

-- Reader audit: exact effective privileges of the reader role, attributes and memberships.
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

-- fail closed: any reader privilege outside the expected set aborts this migration
do $$
declare bad text;
begin
  select string_agg(check_name || ': ' || detail, ' | ') into bad from nordla_runtime.fin_pilot_reader_audit() where not ok;
  if bad is not null then raise exception 'FIN_READER_ROLE_UNSAFE: %', bad; end if;
end $$;

commit;
