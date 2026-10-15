-- NORDLA CORE P0 - PREPARED, NOT APPLIED (supabase/migrations-pending/). Proposal by Core P0 for the Infrastructure session (owner of supabase/**).
--
-- Registers China Sourcing as an identity module ('sourcing'), so its hosted server can use the Core identity (Supabase Auth + membership +
-- module entitlement + Nordla session) instead of a development token. Same pattern as finance / analytics / growth:
--   - the CHECK of module_entitlements.module_code accepts 'sourcing';
--   - identity_module_set and identity_open_session accept 'sourcing' (bodies otherwise IDENTICAL to 20260928150000, regenerated from it).
-- Depends on the identity migrations 20260928120000..20260929170000 (not applied on any live project as of 2026-10-15: both Supabase
-- projects stop at merchant_connectors / product_image). Nothing enables the module: an owner runs identity_module_set(merchant, 'sourcing', 'ACTIVE', ...).
-- Reversible: restore the three-value CHECK and the previous function bodies (20260928150000) after removing any 'sourcing' entitlement.

alter table public.module_entitlements drop constraint if exists module_entitlements_module_code_check;
alter table public.module_entitlements add constraint module_entitlements_module_code_check check (module_code in ('finance', 'analytics', 'growth', 'sourcing'));

create or replace function identity_module_set(p_merchant uuid, p_module text, p_status text, p_source text, p_now timestamptz, p_correlation uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cur public.module_entitlements;
  kind text;
begin
  if p_merchant is null or p_now is null or p_correlation is null or p_source is null then
    raise exception 'identity_module_set: missing argument' using errcode = 'invalid_parameter_value';
  end if;
  if p_module is null or p_module not in ('finance', 'analytics', 'growth', 'sourcing') then return jsonb_build_object('ok', false, 'code', 'MODULE_UNKNOWN'); end if;
  if p_status is null or p_status not in ('ACTIVE', 'SUSPENDED') then return jsonb_build_object('ok', false, 'code', 'STATUS_INVALID'); end if;
  if not exists (select 1 from public.merchants where id = p_merchant) then return jsonb_build_object('ok', false, 'code', 'MERCHANT_UNKNOWN'); end if;
  perform public.identity_member_lock(p_merchant);   -- same per-merchant lock as memberships and session opening
  select * into cur from public.module_entitlements where merchant_id = p_merchant and module_code = p_module;
  if cur.merchant_id is null and p_status = 'SUSPENDED' then return jsonb_build_object('ok', false, 'code', 'NOT_ENABLED'); end if;
  if cur.merchant_id is not null and cur.status = p_status then return jsonb_build_object('ok', false, 'code', 'NO_CHANGE'); end if;
  if cur.merchant_id is null then
    insert into public.module_entitlements (merchant_id, module_code, status, enabled_at, suspended_at, created_at, updated_at, source, last_operation_id)
    values (p_merchant, p_module, 'ACTIVE', p_now, null, p_now, p_now, p_source, p_correlation);
  else
    update public.module_entitlements
       set status = p_status, suspended_at = case when p_status = 'SUSPENDED' then p_now else null end,
           updated_at = greatest(updated_at, p_now), source = p_source, last_operation_id = p_correlation
     where merchant_id = p_merchant and module_code = p_module;
  end if;
  kind := case when p_status = 'ACTIVE' then 'MODULE_ENABLED' else 'MODULE_SUSPENDED' end;
  insert into public.identity_events (occurred_at, merchant_id, user_id, module, event_type, outcome, correlation_id, entity_type, entity_id, detail)
  values (p_now, p_merchant, null, 'core', kind, 'SUCCESS', p_correlation, 'module', p_module,
          jsonb_build_object('fromStatus', coalesce(cur.status, 'NONE'), 'toStatus', p_status, 'source', p_source));
  return jsonb_build_object('ok', true, 'code', kind);
end $$;

create or replace function identity_open_session(
  p_user uuid, p_merchant uuid, p_module text, p_token_hash text, p_now timestamptz, p_expires_at timestamptz, p_correlation uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  m public.merchant_members;
  e public.module_entitlements;
  sid uuid;
  deny text := null;
  deny_kind text;
begin
  if p_user is null or p_merchant is null or p_token_hash is null or p_now is null or p_expires_at is null or p_correlation is null then
    raise exception 'identity_open_session: missing argument' using errcode = 'invalid_parameter_value';
  end if;
  if p_module is null or p_module not in ('finance', 'analytics', 'growth', 'sourcing') then return jsonb_build_object('ok', false, 'code', 'MODULE_UNKNOWN'); end if;
  if not exists (select 1 from public.merchants where id = p_merchant) then return jsonb_build_object('ok', false, 'code', 'MERCHANT_UNKNOWN'); end if;
  perform public.identity_member_lock(p_merchant);
  select * into m from public.merchant_members where merchant_id = p_merchant and user_id = p_user;
  select * into e from public.module_entitlements where merchant_id = p_merchant and module_code = p_module;
  if m.user_id is null then deny := 'NOT_MEMBER'; deny_kind := 'SESSION_ACCESS_DENIED';
  elsif m.status <> 'ACTIVE' then deny := 'MEMBER_SUSPENDED'; deny_kind := 'SESSION_ACCESS_DENIED';
  elsif e.merchant_id is null then deny := 'MODULE_NOT_ENABLED'; deny_kind := 'MODULE_ACCESS_DENIED';
  elsif e.status <> 'ACTIVE' then deny := 'MODULE_SUSPENDED'; deny_kind := 'MODULE_ACCESS_DENIED';
  end if;
  if deny is not null then
    insert into public.identity_events (occurred_at, merchant_id, user_id, module, event_type, outcome, correlation_id, entity_type, entity_id, detail)
    values (p_now, p_merchant, p_user, p_module, deny_kind, 'DENIED', p_correlation, 'module', p_module, jsonb_build_object('code', deny));
    return jsonb_build_object('ok', false, 'code', deny);
  end if;
  insert into public.app_sessions (merchant_id, user_id, module, token_hash, created_at, last_seen_at, expires_at)
  values (p_merchant, p_user, p_module, p_token_hash, p_now, p_now, p_expires_at)
  returning id into sid;
  insert into public.identity_events (occurred_at, merchant_id, user_id, session_id, module, event_type, outcome, correlation_id, entity_type, entity_id, detail)
  values (p_now, p_merchant, p_user, sid, p_module, 'SESSION_OPENED', 'SUCCESS', p_correlation, 'session', sid::text, jsonb_build_object('role', m.role));
  return jsonb_build_object('ok', true, 'code', 'SESSION_OPENED', 'session_id', sid, 'role', m.role);
end $$;

revoke execute on function identity_module_set(uuid, text, text, text, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function identity_open_session(uuid, uuid, text, text, timestamptz, timestamptz, uuid) from public, anon, authenticated;
