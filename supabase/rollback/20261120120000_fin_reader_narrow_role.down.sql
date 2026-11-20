-- Rollback of 20261120120000_fin_reader_narrow_role.sql (v5). Restores the v4 identity check (issue role only) and removes the
-- reader role, its policies and grants. The issue role and the v4 objects are not touched.
begin;

-- restore the v4 entry point exactly as it was applied on staging (member of the issue role, of nothing else)
create or replace function nordla_runtime.fin_pilot_assert(p_merchant uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  r record;
  pilot_oid oid := (select oid from pg_roles where rolname = 'nordla_fin_issuer_pilot');
  me_oid oid := (select oid from pg_roles where rolname = session_user::name);
begin
  if nordla_runtime.fin_pilot_bound_merchant() is distinct from p_merchant then
    raise exception 'FIN_PILOT_MERCHANT_MISMATCH: this login is not bound to the requested merchant' using errcode = '42501';
  end if;
  select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication into r from pg_roles where oid = me_oid;
  if r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication then
    raise exception 'FIN_PILOT_LOGIN_PRIVILEGED' using errcode = '42501';
  end if;
  if exists (select 1 from pg_auth_members m where m.member = me_oid and m.roleid <> pilot_oid) then
    raise exception 'FIN_PILOT_LOGIN_MEMBERSHIP_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from pg_auth_members m where m.member = me_oid and m.roleid = pilot_oid) then
    raise exception 'FIN_PILOT_LOGIN_NOT_MEMBER' using errcode = '42501';
  end if;
end $$;

drop function if exists nordla_runtime.fin_pilot_reader_audit();
drop function if exists nordla_runtime.fin_pilot_assert_role(uuid, text);

do $$
declare
  t text;
  reads text[] := array['fin_documents', 'products', 'variants', 'orders', 'order_lines', 'order_attribution', 'refunds', 'refund_lines',
                        'product_costs', 'product_collections', 'locations', 'inventory_snapshots'];
begin
  foreach t in array reads loop
    execute format('drop policy if exists nordla_fin_reader_guard on public.%I', t);
    execute format('drop policy if exists nordla_fin_reader_rows on public.%I', t);
    execute format('revoke select on table public.%I from nordla_fin_reader_pilot', t);
  end loop;
end $$;

revoke execute on function nordla_runtime.fin_pilot_bound_merchant() from nordla_fin_reader_pilot;
revoke usage on schema nordla_runtime from nordla_fin_reader_pilot;
revoke usage on schema public from nordla_fin_reader_pilot;

-- Role drop: cluster-wide. Run only after this rollback has been applied to every database that received the migration,
-- and after removing the reader role from every login.
drop role if exists nordla_fin_reader_pilot;

commit;
