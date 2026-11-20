-- Rollback of 20261120140000_fin_archive_narrow_role.sql (v7). Restores the v5/v6 identity check (issue and reader roles only), removes the
-- archive role's policies, grants and audit function, then the archive role itself. Tables fin_artifacts, fin_seller_profile_versions and
-- fin_events keep their rows and their own policies: only the archive role's policies are dropped. Row Level Security is left enabled
-- (it may have been enabled before v7).
-- The role drop is cluster-wide: run only after this rollback is applied to every database that received the migration.
begin;

-- restore the identity check exactly as v5 defined it (issue and reader roles only)
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

drop function if exists nordla_runtime.fin_pilot_archive_audit();

do $$
declare t text;
begin
  foreach t in array array['fin_artifacts', 'fin_seller_profile_versions', 'fin_events'] loop
    execute format('drop policy if exists nordla_fin_archive_guard on public.%I', t);
    execute format('drop policy if exists nordla_fin_archive_rows on public.%I', t);
  end loop;
end $$;

revoke all on public.fin_artifacts from nordla_fin_archive_pilot;
revoke all on public.fin_seller_profile_versions from nordla_fin_archive_pilot;
revoke all on public.fin_events from nordla_fin_archive_pilot;
revoke execute on function public.fin_seller_profile_record(uuid, jsonb, text, jsonb, timestamptz) from nordla_fin_archive_pilot;
revoke execute on function public.fin_vcs_valid(text) from nordla_fin_archive_pilot;
revoke execute on function nordla_runtime.fin_pilot_assert_role(uuid, text) from nordla_fin_archive_pilot;
revoke execute on function nordla_runtime.fin_pilot_bound_merchant() from nordla_fin_archive_pilot;
revoke usage on schema nordla_runtime from nordla_fin_archive_pilot;
revoke usage on schema public from nordla_fin_archive_pilot;

drop role if exists nordla_fin_archive_pilot;

commit;
