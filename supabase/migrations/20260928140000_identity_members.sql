-- Core C2 (ADR 0004): merchant memberships and roles.
-- NOT APPLIED anywhere (neither staging nor production): written for review only. Applying it needs the owner's explicit approval.
-- Additive only: one table, guard triggers and two functions. No existing table is touched.
--
-- Answers only: does this person belong to this merchant, is the membership active, which role, may they manage members.
-- It opens no module (C3) and creates no Nordla session.
--
-- Write path: the service role has NO direct INSERT / UPDATE / DELETE on merchant_members. Every change goes through one of two
-- SECURITY DEFINER functions, which (in ONE transaction) take a per-merchant advisory lock, re-read the actor's own membership,
-- apply the role rules, change the row AND append the matching identity_events entry. If the journal entry cannot be written, the
-- whole change is rolled back. Reads (SELECT) stay available to the service role.
--
-- The last ACTIVE OWNER of a merchant can never be suspended, demoted or deleted: enforced by a trigger that takes the same
-- per-merchant lock, so even two concurrent demotions of the only two owners cannot leave the merchant without an owner.
-- Physical deletion is refused altogether (a person leaves a merchant by being suspended).

create table merchant_members (
  merchant_id uuid not null references merchants(id) on delete restrict,
  -- RESTRICT (not cascade): deleting the Supabase user of a member is refused until the membership is handled - an
  -- ACTIVE OWNER could otherwise disappear silently.
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null check (role in ('OWNER', 'ADMIN', 'COLLABORATOR', 'VIEWER', 'ACCOUNTANT')),
  status text not null check (status in ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  suspended_at timestamptz,
  -- technical actor ids (auth.users ids), deliberately without foreign keys so the history never breaks; null = system bootstrap
  created_by uuid,
  updated_by uuid,
  primary key (merchant_id, user_id),                       -- one membership per merchant and user
  constraint merchant_members_suspended_ck check ((status = 'SUSPENDED') = (suspended_at is not null)),
  constraint merchant_members_times_ck check (updated_at >= created_at)
);

-- "the active merchants of a user" (C3 / later session choice)
create index merchant_members_user_idx on merchant_members (user_id) where status = 'ACTIVE';
-- counting the active owners of a merchant (last-owner rule)
create index merchant_members_active_owners_idx on merchant_members (merchant_id) where status = 'ACTIVE' and role = 'OWNER';

comment on table merchant_members is
  'Who belongs to which merchant, with which role (ADR 0004, C2). Changed only through identity_member_bootstrap_owner / identity_member_apply; never deleted.';

-- Per-merchant serialisation key shared by the functions and the trigger.
create function identity_member_lock(p_merchant uuid) returns void language sql volatile set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('nordla.merchant_members:' || p_merchant::text, 0));
$$;

-- Guard: no physical delete; identity columns immutable; the last ACTIVE OWNER cannot stop being one.
create function merchant_members_guard() returns trigger language plpgsql set search_path = '' as $$
declare
  remaining integer;
begin
  if tg_op = 'DELETE' then
    raise exception 'merchant_members: a membership is never deleted (suspend it instead)' using errcode = 'insufficient_privilege';
  end if;
  if new.merchant_id is distinct from old.merchant_id or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by then
    raise exception 'merchant_members: merchant, user and creation are immutable' using errcode = 'integrity_constraint_violation';
  end if;
  if old.role = 'OWNER' and old.status = 'ACTIVE' and (new.role <> 'OWNER' or new.status <> 'ACTIVE') then
    perform public.identity_member_lock(old.merchant_id);
    select count(*) into remaining from public.merchant_members
     where merchant_id = old.merchant_id and role = 'OWNER' and status = 'ACTIVE' and user_id <> old.user_id;
    if remaining = 0 then
      raise exception 'merchant_members: the last active owner of a merchant cannot be suspended or demoted' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger merchant_members_guard_trg before update or delete on merchant_members for each row execute function merchant_members_guard();

create function merchant_members_no_truncate() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'merchant_members: TRUNCATE is not allowed' using errcode = 'insufficient_privilege';
end $$;
create trigger merchant_members_no_truncate_trg before truncate on merchant_members for each statement execute function merchant_members_no_truncate();

-- First OWNER of a merchant that has no membership yet. Exactly one of several concurrent calls can succeed (advisory lock + the
-- "no member" check inside the same transaction). Journals MEMBER_BOOTSTRAPPED (or MEMBER_ACTION_DENIED) in the same transaction.
-- Returns { ok, code }: BOOTSTRAPPED | ALREADY_INITIALIZED | MERCHANT_UNKNOWN | USER_UNKNOWN.
create function identity_member_bootstrap_owner(p_merchant uuid, p_user uuid, p_now timestamptz, p_correlation uuid, p_module text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_merchant is null or p_user is null or p_now is null or p_correlation is null then
    raise exception 'identity_member_bootstrap_owner: missing argument' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.merchants where id = p_merchant) then
    return jsonb_build_object('ok', false, 'code', 'MERCHANT_UNKNOWN');
  end if;
  perform public.identity_member_lock(p_merchant);
  if exists (select 1 from public.merchant_members where merchant_id = p_merchant) then
    insert into public.identity_events (occurred_at, merchant_id, user_id, module, event_type, outcome, correlation_id, entity_type, entity_id, detail)
    values (p_now, p_merchant, null, p_module, 'MEMBER_ACTION_DENIED', 'DENIED', p_correlation, 'user', p_user::text,
            jsonb_build_object('action', 'BOOTSTRAP', 'code', 'ALREADY_INITIALIZED'));
    return jsonb_build_object('ok', false, 'code', 'ALREADY_INITIALIZED');
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    return jsonb_build_object('ok', false, 'code', 'USER_UNKNOWN');
  end if;
  insert into public.merchant_members (merchant_id, user_id, role, status, created_at, updated_at, suspended_at, created_by, updated_by)
  values (p_merchant, p_user, 'OWNER', 'ACTIVE', p_now, p_now, null, null, null);
  insert into public.identity_events (occurred_at, merchant_id, user_id, module, event_type, outcome, correlation_id, entity_type, entity_id, detail)
  values (p_now, p_merchant, null, p_module, 'MEMBER_BOOTSTRAPPED', 'SUCCESS', p_correlation, 'user', p_user::text,
          jsonb_build_object('toRole', 'OWNER', 'toStatus', 'ACTIVE'));
  return jsonb_build_object('ok', true, 'code', 'BOOTSTRAPPED');
end $$;

-- Every other membership change, decided and applied under the per-merchant lock:
--   p_action  ADD (p_role) | CHANGE_ROLE (p_role) | SUSPEND | REACTIVATE
-- Role rules (same matrix as src/identity/members.js MEMBER_RULES):
--   OWNER        may manage every role, including other OWNERs and ADMINs (last-owner rule always applies)
--   ADMIN        may manage only COLLABORATOR / VIEWER / ACCOUNTANT (both the target's current role and the new role), never itself
--   COLLABORATOR / VIEWER / ACCOUNTANT   may manage nobody
-- Returns { ok, code }. Every refusal on a known merchant is journalled as MEMBER_ACTION_DENIED; codes never describe another
-- merchant (a target that is not a member HERE is TARGET_NOT_MEMBER, whatever it is elsewhere).
create function identity_member_apply(
  p_merchant uuid, p_actor uuid, p_target uuid, p_action text, p_role text, p_now timestamptz, p_correlation uuid, p_module text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor public.merchant_members;
  target public.merchant_members;
  managed constant text[] := array['COLLABORATOR', 'VIEWER', 'ACCOUNTANT'];
  rank_of constant jsonb := '{"OWNER": 5, "ADMIN": 4, "ACCOUNTANT": 3, "COLLABORATOR": 2, "VIEWER": 1}';
  deny text := null;
  owners integer;
  kind text;
  detail jsonb;
begin
  if p_merchant is null or p_actor is null or p_target is null or p_now is null or p_correlation is null or p_action is null then
    raise exception 'identity_member_apply: missing argument' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.merchants where id = p_merchant) then
    return jsonb_build_object('ok', false, 'code', 'MERCHANT_UNKNOWN');
  end if;
  perform public.identity_member_lock(p_merchant);
  select * into actor from public.merchant_members where merchant_id = p_merchant and user_id = p_actor;
  select * into target from public.merchant_members where merchant_id = p_merchant and user_id = p_target;

  if p_action not in ('ADD', 'CHANGE_ROLE', 'SUSPEND', 'REACTIVATE') then deny := 'ACTION_INVALID';
  elsif p_action in ('ADD', 'CHANGE_ROLE') and (p_role is null or p_role not in ('OWNER', 'ADMIN', 'COLLABORATOR', 'VIEWER', 'ACCOUNTANT')) then deny := 'ROLE_INVALID';
  elsif actor.user_id is null then deny := 'ACTOR_NOT_MEMBER';
  elsif actor.status <> 'ACTIVE' then deny := 'ACTOR_SUSPENDED';
  elsif actor.role not in ('OWNER', 'ADMIN') then deny := 'FORBIDDEN';
  elsif p_action = 'ADD' and target.user_id is not null then deny := 'TARGET_ALREADY_MEMBER';
  elsif p_action = 'ADD' and not exists (select 1 from auth.users where id = p_target) then deny := 'USER_UNKNOWN';
  elsif p_action <> 'ADD' and target.user_id is null then deny := 'TARGET_NOT_MEMBER';
  elsif p_action = 'CHANGE_ROLE' and p_actor = p_target and (rank_of ->> p_role)::int > (rank_of ->> actor.role)::int then deny := 'SELF_PROMOTION';
  elsif actor.role = 'ADMIN' and (p_actor = p_target
        or (target.user_id is not null and not (target.role = any (managed)))
        or (p_action in ('ADD', 'CHANGE_ROLE') and not (p_role = any (managed)))) then deny := 'FORBIDDEN';
  elsif p_action = 'SUSPEND' and target.status <> 'ACTIVE' then deny := 'ALREADY_SUSPENDED';
  elsif p_action = 'REACTIVATE' and target.status <> 'SUSPENDED' then deny := 'ALREADY_ACTIVE';
  elsif p_action = 'CHANGE_ROLE' and target.role = p_role then deny := 'NO_CHANGE';
  elsif target.role = 'OWNER' and target.status = 'ACTIVE' and (p_action = 'SUSPEND' or (p_action = 'CHANGE_ROLE' and p_role <> 'OWNER')) then
    select count(*) into owners from public.merchant_members
     where merchant_id = p_merchant and role = 'OWNER' and status = 'ACTIVE' and user_id <> p_target;
    if owners = 0 then deny := 'LAST_OWNER'; end if;
  end if;

  if deny is not null then
    insert into public.identity_events (occurred_at, merchant_id, user_id, module, event_type, outcome, correlation_id, entity_type, entity_id, detail)
    values (p_now, p_merchant, p_actor, p_module, 'MEMBER_ACTION_DENIED', 'DENIED', p_correlation, 'user', p_target::text,
            jsonb_build_object('action', p_action, 'code', deny));
    return jsonb_build_object('ok', false, 'code', deny);
  end if;

  if p_action = 'ADD' then
    insert into public.merchant_members (merchant_id, user_id, role, status, created_at, updated_at, suspended_at, created_by, updated_by)
    values (p_merchant, p_target, p_role, 'ACTIVE', p_now, p_now, null, p_actor, p_actor);
    kind := 'MEMBER_ADDED'; detail := jsonb_build_object('toRole', p_role, 'toStatus', 'ACTIVE');
  elsif p_action = 'CHANGE_ROLE' then
    update public.merchant_members set role = p_role, updated_at = greatest(updated_at, p_now), updated_by = p_actor
     where merchant_id = p_merchant and user_id = p_target;
    kind := 'MEMBER_ROLE_CHANGED'; detail := jsonb_build_object('fromRole', target.role, 'toRole', p_role);
  elsif p_action = 'SUSPEND' then
    update public.merchant_members set status = 'SUSPENDED', suspended_at = p_now, updated_at = greatest(updated_at, p_now), updated_by = p_actor
     where merchant_id = p_merchant and user_id = p_target;
    kind := 'MEMBER_SUSPENDED'; detail := jsonb_build_object('role', target.role, 'fromStatus', 'ACTIVE', 'toStatus', 'SUSPENDED');
  else
    update public.merchant_members set status = 'ACTIVE', suspended_at = null, updated_at = greatest(updated_at, p_now), updated_by = p_actor
     where merchant_id = p_merchant and user_id = p_target;
    kind := 'MEMBER_REACTIVATED'; detail := jsonb_build_object('role', target.role, 'fromStatus', 'SUSPENDED', 'toStatus', 'ACTIVE');
  end if;
  insert into public.identity_events (occurred_at, merchant_id, user_id, module, event_type, outcome, correlation_id, entity_type, entity_id, detail)
  values (p_now, p_merchant, p_actor, p_module, kind, 'SUCCESS', p_correlation, 'user', p_target::text, detail);
  return jsonb_build_object('ok', true, 'code', kind);
end $$;

alter table merchant_members enable row level security;  -- no policy: no browser path; the service role reads, functions write
revoke all on table merchant_members from anon, authenticated;
revoke insert, update, delete, truncate on table merchant_members from service_role;
-- functions are executable by PUBLIC by default: only the server (service role) may call them; the lock helper is internal
revoke execute on function identity_member_lock(uuid) from public, anon, authenticated, service_role;
revoke execute on function identity_member_bootstrap_owner(uuid, uuid, timestamptz, uuid, text) from public, anon, authenticated;
revoke execute on function identity_member_apply(uuid, uuid, uuid, text, text, timestamptz, uuid, text) from public, anon, authenticated;
