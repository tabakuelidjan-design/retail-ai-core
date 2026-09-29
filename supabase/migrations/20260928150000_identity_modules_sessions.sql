-- Core C3 (ADR 0004): modules enabled per merchant, and the only way to open a Nordla session.
-- NOT APPLIED anywhere (neither staging nor production): written for review only. Applying it needs the owner's explicit approval.
-- Additive: one table, guard triggers, two functions, and one privilege change on app_sessions (C1a, never applied either).
--
--   module_entitlements        which module each merchant may use. Closed registry: finance | analytics | growth (the same list as
--                              src/identity/modules.js; a new module needs a migration AND a code change, both tested). 'core' is
--                              not a sellable module and never gets an entitlement.
--   identity_module_set()      INTERNAL provisioning / billing operation only (no actor: no OWNER or ADMIN of a merchant can call
--                              it through any client path). Change + MODULE_ENABLED / MODULE_SUSPENDED journal entry in ONE transaction.
--   identity_open_session()    the ONLY way to create an app_sessions row: in ONE transaction, under the same per-merchant lock as
--                              the membership and module changes, it re-checks the ACTIVE membership and the ACTIVE module, inserts
--                              the session (token hash only) and the SESSION_OPENED entry. If the entry cannot be written, no
--                              session exists. The service role loses its direct INSERT on app_sessions.

create table module_entitlements (
  merchant_id uuid not null references merchants(id) on delete restrict,
  module_code text not null check (module_code in ('finance', 'analytics', 'growth')),
  status text not null check (status in ('ACTIVE', 'SUSPENDED')),
  enabled_at timestamptz not null,        -- first activation
  suspended_at timestamptz,               -- set if and only if SUSPENDED
  created_at timestamptz not null,
  updated_at timestamptz not null,
  source text not null check (source ~ '^[a-z][a-z0-9_]{1,31}:[a-z0-9_-]{1,64}$'),   -- provenance, e.g. provisioning:manual
  last_operation_id uuid not null,        -- correlation id of the last change (the journal entry carries the same id)
  primary key (merchant_id, module_code),
  constraint module_entitlements_suspended_ck check ((status = 'SUSPENDED') = (suspended_at is not null)),
  constraint module_entitlements_times_ck check (updated_at >= created_at and enabled_at >= created_at)
);

create index module_entitlements_active_idx on module_entitlements (merchant_id) where status = 'ACTIVE';

comment on table module_entitlements is
  'Modules enabled per merchant (ADR 0004, C3). Changed only by identity_module_set (internal provisioning / billing); never deleted.';

create function module_entitlements_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'module_entitlements: an entitlement is never deleted (suspend it instead)' using errcode = 'insufficient_privilege';
  end if;
  if new.merchant_id is distinct from old.merchant_id or new.module_code is distinct from old.module_code
     or new.created_at is distinct from old.created_at or new.enabled_at is distinct from old.enabled_at then
    raise exception 'module_entitlements: merchant, module and dates of creation are immutable' using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $$;
create trigger module_entitlements_guard_trg before update or delete on module_entitlements for each row execute function module_entitlements_guard();

create function module_entitlements_no_truncate() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'module_entitlements: TRUNCATE is not allowed' using errcode = 'insufficient_privilege';
end $$;
create trigger module_entitlements_no_truncate_trg before truncate on module_entitlements for each statement execute function module_entitlements_no_truncate();

-- Internal provisioning / billing: enable (ACTIVE) or suspend (SUSPENDED) one module of one merchant.
-- Returns { ok, code }: MODULE_ENABLED | MODULE_SUSPENDED | NO_CHANGE | NOT_ENABLED | MERCHANT_UNKNOWN | MODULE_UNKNOWN | STATUS_INVALID.
create function identity_module_set(p_merchant uuid, p_module text, p_status text, p_source text, p_now timestamptz, p_correlation uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cur public.module_entitlements;
  kind text;
begin
  if p_merchant is null or p_now is null or p_correlation is null or p_source is null then
    raise exception 'identity_module_set: missing argument' using errcode = 'invalid_parameter_value';
  end if;
  if p_module is null or p_module not in ('finance', 'analytics', 'growth') then return jsonb_build_object('ok', false, 'code', 'MODULE_UNKNOWN'); end if;
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

-- Open a Nordla session for a user whose identity the server has ALREADY verified (C1b). Re-checks, in the same transaction and under
-- the per-merchant lock: ACTIVE membership (C2) and ACTIVE module (C3). Then inserts the session (token hash only) and SESSION_OPENED.
-- Refusals are journalled (SESSION_ACCESS_DENIED / MODULE_ACCESS_DENIED) with a precise, non-sensitive code; the caller turns them
-- into ONE generic public answer. Returns { ok, code, session_id?, role? }.
create function identity_open_session(
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
  if p_module is null or p_module not in ('finance', 'analytics', 'growth') then return jsonb_build_object('ok', false, 'code', 'MODULE_UNKNOWN'); end if;
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

alter table module_entitlements enable row level security;  -- no policy: no browser path
revoke all on table module_entitlements from anon, authenticated;
revoke insert, update, delete, truncate on table module_entitlements from service_role;
-- sessions are opened only through identity_open_session (the service role keeps SELECT and UPDATE for validation / revocation)
revoke insert on table app_sessions from service_role;
revoke execute on function identity_module_set(uuid, text, text, text, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function identity_open_session(uuid, uuid, text, text, timestamptz, timestamptz, uuid) from public, anon, authenticated;
