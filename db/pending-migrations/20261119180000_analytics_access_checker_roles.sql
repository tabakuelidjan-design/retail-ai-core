-- Analytics access checker: a least-privilege role replacing the service key for the SSO access check (createAccessChecker).
-- Not applied anywhere by this file. Apply only after review (staging first), then production; see db/rollback for the way back.
--
-- analytics_access_checker reads ONLY:
--   * merchant_members: the columns role, status, removed_at (+ merchant_id, user_id for the filter), and ONLY the row of the
--     person in context (app.user_id) in the merchant in context (app.merchant_id);
--   * module_entitlements: the columns module_code, status (+ merchant_id), and ONLY the merchant in context;
--   * the MFA status of that same person, through analytics_checker.mfa_status(), which refuses any pair that is not the context.
-- The verified identity (SSO) is what the application puts in context: this role never chooses a person by itself.
-- Writes are refused (no privilege). Missing or invalid context raises an error.
begin;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'analytics_access_checker') then
    create role analytics_access_checker nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
  end if;
end $$;

create schema if not exists analytics_checker;
revoke all on schema analytics_checker from public;
grant usage on schema analytics_checker to analytics_access_checker;

create or replace function analytics_checker.ctx_uuid(p_key text) returns uuid
  language plpgsql stable set search_path = '' as $$
declare v text := nullif(current_setting(p_key, true), '');
begin
  if v is null then raise exception 'CHECKER_CONTEXT_REQUIRED'; end if;
  if v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'CHECKER_CONTEXT_INVALID'; end if;
  return v::uuid;
end $$;
revoke all on function analytics_checker.ctx_uuid(text) from public, anon, authenticated;
grant execute on function analytics_checker.ctx_uuid(text) to analytics_access_checker;

-- The MFA rule for ONE pair only: the arguments must equal the context, otherwise it refuses. Runs with the owner's rights to read
-- the same status the service key reads today (public.security_mfa_status), and nothing else.
create or replace function analytics_checker.mfa_status(p_merchant uuid, p_user uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
begin
  if p_merchant is distinct from analytics_checker.ctx_uuid('app.merchant_id')
     or p_user is distinct from analytics_checker.ctx_uuid('app.user_id') then
    raise exception 'CHECKER_PAIR_OUT_OF_CONTEXT';
  end if;
  return public.security_mfa_status(p_merchant, p_user);
end $$;
revoke all on function analytics_checker.mfa_status(uuid, uuid) from public, anon, authenticated;
grant execute on function analytics_checker.mfa_status(uuid, uuid) to analytics_access_checker;

-- Column-level read grants only.
grant select (merchant_id, user_id, role, status, removed_at) on public.merchant_members to analytics_access_checker;
grant select (merchant_id, module_code, status) on public.module_entitlements to analytics_access_checker;

create policy analytics_checker_member on public.merchant_members as permissive for select to analytics_access_checker
  using (merchant_id = analytics_checker.ctx_uuid('app.merchant_id') and user_id = analytics_checker.ctx_uuid('app.user_id'));
create policy analytics_checker_entitlement on public.module_entitlements as permissive for select to analytics_access_checker
  using (merchant_id = analytics_checker.ctx_uuid('app.merchant_id'));

-- explicit refusals: no writes of any kind
revoke insert, update, delete, truncate, references, trigger on public.merchant_members, public.module_entitlements from analytics_access_checker;

commit;
