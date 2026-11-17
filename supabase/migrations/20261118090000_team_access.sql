-- Paramètres -> Équipe et accès (staging module NORDLA_TEAM_MODULE). Additive, reversible (see supabase/rollback/20261118090000_team_access_down.sql).
-- Touches: merchant_members (two nullable columns + a stricter guard), one new table merchant_invitations, new SECURITY DEFINER functions
-- team_* (service role only). identity_member_apply / identity_member_bootstrap_owner / identity_open_session are NOT changed.
--
-- "Retirer l'accès" = the membership is SUSPENDED and marked removed (removed_at). The row, its history and every identity_events entry
-- stay; the person's access to OTHER merchants is untouched (memberships are per merchant); every session of this merchant refuses at
-- once (the access layer re-reads the membership on each request). A removed person comes back only through a NEW invitation.
-- Invitations: only a SHA-256 hash of the one-time token is stored. A resend replaces the hash (the old link stops working), accepting
-- consumes the row under a row lock (single use), the account e-mail must equal the invited e-mail, merchant and role come from the row.
-- The journal never receives an e-mail address or a token (entity = the invitation id); the e-mail lives only in merchant_invitations.

alter table merchant_members add column removed_at timestamptz, add column removed_by uuid;
alter table merchant_members add constraint merchant_members_removed_ck check (removed_at is null or status = 'SUSPENDED');

-- Guard (same rules as before + a removed membership can neither change role nor status; only team_invitation_accept lifts it, clearing removed_at).
create or replace function merchant_members_guard() returns trigger language plpgsql set search_path = '' as $$
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
  if old.removed_at is not null and new.removed_at is not null and (new.role <> old.role or new.status <> old.status) then
    raise exception 'merchant_members: a removed membership only returns through a new invitation' using errcode = 'check_violation';
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

create table merchant_invitations (
  id uuid primary key,
  merchant_id uuid not null references merchants(id) on delete restrict,
  email text not null check (email = lower(email) and length(email) between 5 and 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('OWNER', 'ADMIN', 'VIEWER')),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELLED')),
  created_at timestamptz not null,
  sent_at timestamptz not null,          -- last (re)issue of the link
  expires_at timestamptz not null,
  send_count integer not null default 1,
  invited_by uuid not null,
  accepted_at timestamptz, accepted_by uuid,
  cancelled_at timestamptz, cancelled_by uuid,
  constraint merchant_invitations_states_ck check ((status = 'ACCEPTED') = (accepted_at is not null) and (status = 'CANCELLED') = (cancelled_at is not null))
);
create unique index merchant_invitations_pending_uq on merchant_invitations (merchant_id, email) where status = 'PENDING';
create unique index merchant_invitations_token_uq on merchant_invitations (token_hash);
create index merchant_invitations_merchant_idx on merchant_invitations (merchant_id, created_at desc);
alter table merchant_invitations enable row level security;  -- no policy: the browser has no path; only the functions below write
revoke all on table merchant_invitations from anon, authenticated;
revoke insert, update, delete, truncate on table merchant_invitations from service_role;

create function team_journal(p_merchant uuid, p_user uuid, p_module text, p_type text, p_outcome text, p_correlation uuid, p_entity_type text, p_entity text, p_detail jsonb, p_now timestamptz)
returns void language sql security definer set search_path = '' as $$
  insert into public.identity_events (occurred_at, merchant_id, user_id, module, event_type, outcome, correlation_id, entity_type, entity_id, detail)
  values (p_now, p_merchant, p_user, p_module, p_type, p_outcome, p_correlation, p_entity_type, p_entity, p_detail);
$$;

-- the actor must be an ACTIVE OWNER / ADMIN of the merchant; returns its role or null
create function team_actor_role(p_merchant uuid, p_actor uuid) returns text language sql stable security definer set search_path = '' as $$
  select m.role from public.merchant_members m
   where m.merchant_id = p_merchant and m.user_id = p_actor and m.status = 'ACTIVE' and m.role in ('OWNER', 'ADMIN');
$$;

-- Members of ONE merchant with their name / e-mail (auth.users is not readable through the API). Never another merchant.
create function team_list_members(p_merchant uuid)
returns table (user_id uuid, email text, display_name text, role text, status text, created_at timestamptz, suspended_at timestamptz, removed_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.user_id, u.email::text, nullif(coalesce(u.raw_user_meta_data ->> 'name', u.raw_user_meta_data ->> 'full_name'), ''), m.role, m.status, m.created_at, m.suspended_at, m.removed_at
    from public.merchant_members m join auth.users u on u.id = m.user_id
   where m.merchant_id = p_merchant order by m.created_at, m.user_id;
$$;

create function team_member_remove(p_merchant uuid, p_actor uuid, p_target uuid, p_now timestamptz, p_correlation uuid, p_module text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_role text; target public.merchant_members; owners integer; deny text;
begin
  if p_merchant is null or p_actor is null or p_target is null or p_now is null or p_correlation is null then
    raise exception 'team_member_remove: missing argument' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.merchants where id = p_merchant) then return jsonb_build_object('ok', false, 'code', 'MERCHANT_UNKNOWN'); end if;
  perform public.identity_member_lock(p_merchant);
  actor_role := public.team_actor_role(p_merchant, p_actor);
  select * into target from public.merchant_members where merchant_id = p_merchant and user_id = p_target;
  if actor_role is null then deny := 'FORBIDDEN';
  elsif target.user_id is null then deny := 'TARGET_NOT_MEMBER';
  elsif target.removed_at is not null then deny := 'ALREADY_REMOVED';
  elsif actor_role = 'ADMIN' and (p_actor = p_target or target.role not in ('COLLABORATOR', 'VIEWER', 'ACCOUNTANT')) then deny := 'FORBIDDEN';
  elsif target.role = 'OWNER' and target.status = 'ACTIVE' then
    select count(*) into owners from public.merchant_members where merchant_id = p_merchant and role = 'OWNER' and status = 'ACTIVE' and user_id <> p_target;
    if owners = 0 then deny := 'LAST_OWNER'; end if;
  end if;
  if deny is not null then
    perform public.team_journal(p_merchant, p_actor, p_module, 'MEMBER_ACTION_DENIED', 'DENIED', p_correlation, 'user', p_target::text, jsonb_build_object('action', 'REMOVE', 'code', deny), p_now);
    return jsonb_build_object('ok', false, 'code', deny);
  end if;
  update public.merchant_members
     set status = 'SUSPENDED', suspended_at = coalesce(suspended_at, p_now), removed_at = p_now, removed_by = p_actor, updated_at = greatest(updated_at, p_now), updated_by = p_actor
   where merchant_id = p_merchant and user_id = p_target;
  perform public.team_journal(p_merchant, p_actor, p_module, 'MEMBER_REMOVED', 'SUCCESS', p_correlation, 'user', p_target::text, jsonb_build_object('role', target.role, 'fromStatus', target.status), p_now);
  return jsonb_build_object('ok', true, 'code', 'MEMBER_REMOVED');
end $$;

create function team_invitation_create(p_merchant uuid, p_actor uuid, p_email text, p_role text, p_token_hash text, p_now timestamptz, p_expires timestamptz, p_correlation uuid, p_module text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_role text; deny text; existing uuid; new_id uuid := gen_random_uuid(); mail text := lower(trim(p_email));
begin
  if p_merchant is null or p_actor is null or p_email is null or p_role is null or p_token_hash is null or p_now is null or p_expires is null or p_correlation is null then
    raise exception 'team_invitation_create: missing argument' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.merchants where id = p_merchant) then return jsonb_build_object('ok', false, 'code', 'MERCHANT_UNKNOWN'); end if;
  perform public.identity_member_lock(p_merchant);
  actor_role := public.team_actor_role(p_merchant, p_actor);
  update public.merchant_invitations set status = 'EXPIRED' where merchant_id = p_merchant and status = 'PENDING' and expires_at <= p_now;
  if actor_role is null then deny := 'FORBIDDEN';
  elsif p_role not in ('OWNER', 'ADMIN', 'VIEWER') then deny := 'ROLE_INVALID';
  elsif mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(mail) > 254 then deny := 'EMAIL_INVALID';
  elsif actor_role = 'ADMIN' and p_role <> 'VIEWER' then deny := 'FORBIDDEN';      -- an administrator delegates only what it may manage (COLLABORATOR / VIEWER / ACCOUNTANT; only VIEWER is offered)
  elsif exists (select 1 from public.merchant_members m join auth.users u on u.id = m.user_id where m.merchant_id = p_merchant and m.removed_at is null and lower(u.email) = mail) then deny := 'ALREADY_MEMBER';
  else
    select id into existing from public.merchant_invitations where merchant_id = p_merchant and email = mail and status = 'PENDING';
    if existing is not null then
      perform public.team_journal(p_merchant, p_actor, p_module, 'INVITATION_DENIED', 'DENIED', p_correlation, 'invitation', existing::text, jsonb_build_object('code', 'DUPLICATE_PENDING'), p_now);
      return jsonb_build_object('ok', false, 'code', 'DUPLICATE_PENDING', 'invitation_id', existing);
    end if;
  end if;
  if deny is not null then
    perform public.team_journal(p_merchant, p_actor, p_module, 'INVITATION_DENIED', 'DENIED', p_correlation, null, null, jsonb_build_object('code', deny), p_now);   -- no invitation exists yet: identity_events_entity_ck wants type and id together, or neither
    return jsonb_build_object('ok', false, 'code', deny);
  end if;
  insert into public.merchant_invitations (id, merchant_id, email, role, token_hash, status, created_at, sent_at, expires_at, send_count, invited_by)
  values (new_id, p_merchant, mail, p_role, p_token_hash, 'PENDING', p_now, p_now, p_expires, 1, p_actor);
  perform public.team_journal(p_merchant, p_actor, p_module, 'INVITATION_CREATED', 'SUCCESS', p_correlation, 'invitation', new_id::text, jsonb_build_object('role', p_role), p_now);
  return jsonb_build_object('ok', true, 'code', 'INVITATION_CREATED', 'invitation_id', new_id);
end $$;

create function team_invitation_resend(p_merchant uuid, p_actor uuid, p_invitation uuid, p_token_hash text, p_now timestamptz, p_expires timestamptz, p_correlation uuid, p_module text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_role text; inv public.merchant_invitations; deny text;
begin
  if p_merchant is null or p_actor is null or p_invitation is null or p_token_hash is null or p_now is null or p_expires is null or p_correlation is null then
    raise exception 'team_invitation_resend: missing argument' using errcode = 'invalid_parameter_value';
  end if;
  perform public.identity_member_lock(p_merchant);
  actor_role := public.team_actor_role(p_merchant, p_actor);
  select * into inv from public.merchant_invitations where id = p_invitation and merchant_id = p_merchant for update;   -- another merchant's invitation is NOT_FOUND here
  if actor_role is null then deny := 'FORBIDDEN';
  elsif inv.id is null then deny := 'NOT_FOUND';
  elsif actor_role = 'ADMIN' and inv.role <> 'VIEWER' then deny := 'FORBIDDEN';
  elsif inv.status not in ('PENDING', 'EXPIRED') then deny := 'NOT_RESENDABLE';
  elsif exists (select 1 from public.merchant_members m join auth.users u on u.id = m.user_id where m.merchant_id = p_merchant and m.removed_at is null and lower(u.email) = inv.email) then deny := 'ALREADY_MEMBER';
  end if;
  if deny is not null then
    perform public.team_journal(p_merchant, p_actor, p_module, 'INVITATION_DENIED', 'DENIED', p_correlation, 'invitation', p_invitation::text, jsonb_build_object('code', deny, 'action', 'RESEND'), p_now);
    return jsonb_build_object('ok', false, 'code', deny);
  end if;
  update public.merchant_invitations set token_hash = p_token_hash, status = 'PENDING', sent_at = p_now, expires_at = p_expires, send_count = send_count + 1 where id = p_invitation;
  perform public.team_journal(p_merchant, p_actor, p_module, 'INVITATION_RESENT', 'SUCCESS', p_correlation, 'invitation', p_invitation::text, jsonb_build_object('role', inv.role), p_now);
  return jsonb_build_object('ok', true, 'code', 'INVITATION_RESENT', 'invitation_id', p_invitation);
end $$;

create function team_invitation_cancel(p_merchant uuid, p_actor uuid, p_invitation uuid, p_now timestamptz, p_correlation uuid, p_module text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_role text; inv public.merchant_invitations; deny text;
begin
  if p_merchant is null or p_actor is null or p_invitation is null or p_now is null or p_correlation is null then
    raise exception 'team_invitation_cancel: missing argument' using errcode = 'invalid_parameter_value';
  end if;
  perform public.identity_member_lock(p_merchant);
  actor_role := public.team_actor_role(p_merchant, p_actor);
  select * into inv from public.merchant_invitations where id = p_invitation and merchant_id = p_merchant for update;
  if actor_role is null then deny := 'FORBIDDEN';
  elsif inv.id is null then deny := 'NOT_FOUND';
  elsif actor_role = 'ADMIN' and inv.role <> 'VIEWER' then deny := 'FORBIDDEN';
  elsif inv.status <> 'PENDING' then deny := 'NOT_CANCELLABLE';
  end if;
  if deny is not null then
    perform public.team_journal(p_merchant, p_actor, p_module, 'INVITATION_DENIED', 'DENIED', p_correlation, 'invitation', p_invitation::text, jsonb_build_object('code', deny, 'action', 'CANCEL'), p_now);
    return jsonb_build_object('ok', false, 'code', deny);
  end if;
  update public.merchant_invitations set status = 'CANCELLED', cancelled_at = p_now, cancelled_by = p_actor where id = p_invitation;
  perform public.team_journal(p_merchant, p_actor, p_module, 'INVITATION_CANCELLED', 'SUCCESS', p_correlation, 'invitation', p_invitation::text, jsonb_build_object('role', inv.role), p_now);
  return jsonb_build_object('ok', true, 'code', 'INVITATION_CANCELLED', 'invitation_id', p_invitation);
end $$;

-- Public side (no session): what the acceptance page may show for a token, and the acceptance itself. Both take the HASH only.
create function team_invitation_lookup(p_token_hash text, p_now timestamptz)
returns table (invitation_id uuid, merchant_id uuid, merchant_name text, email text, role text, status text, expires_at timestamptz, account_exists boolean)
language sql stable security definer set search_path = '' as $$
  select i.id, i.merchant_id, m.name, i.email, i.role,
         case when i.status = 'PENDING' and i.expires_at <= p_now then 'EXPIRED' else i.status end, i.expires_at,
         exists (select 1 from auth.users u where lower(u.email) = i.email)
    from public.merchant_invitations i join public.merchants m on m.id = i.merchant_id where i.token_hash = p_token_hash;
$$;

create function team_user_by_email(p_email text) returns uuid language sql stable security definer set search_path = '' as $$
  select id from auth.users where lower(email) = lower(trim(p_email)) limit 1;
$$;

create function team_invitation_accept(p_token_hash text, p_user uuid, p_now timestamptz, p_correlation uuid, p_module text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  inv public.merchant_invitations; mail text; cur public.merchant_members; deny text;
begin
  if p_token_hash is null or p_user is null or p_now is null or p_correlation is null then
    raise exception 'team_invitation_accept: missing argument' using errcode = 'invalid_parameter_value';
  end if;
  select * into inv from public.merchant_invitations where token_hash = p_token_hash for update;     -- the row lock makes the link single use
  if inv.id is null then return jsonb_build_object('ok', false, 'code', 'INVITATION_INVALID'); end if;
  perform public.identity_member_lock(inv.merchant_id);
  select lower(email) into mail from auth.users where id = p_user;
  select * into cur from public.merchant_members where merchant_id = inv.merchant_id and user_id = p_user;
  if inv.status <> 'PENDING' then deny := 'INVITATION_' || inv.status;
  elsif inv.expires_at <= p_now then
    update public.merchant_invitations set status = 'EXPIRED' where id = inv.id;
    deny := 'INVITATION_EXPIRED';
  elsif mail is null or mail <> inv.email then deny := 'EMAIL_MISMATCH';
  elsif cur.user_id is not null and cur.removed_at is null then deny := 'ALREADY_MEMBER';
  end if;
  if deny is not null then
    perform public.team_journal(inv.merchant_id, p_user, p_module, 'INVITATION_DENIED', 'DENIED', p_correlation, 'invitation', inv.id::text, jsonb_build_object('code', deny, 'action', 'ACCEPT'), p_now);
    return jsonb_build_object('ok', false, 'code', deny);
  end if;
  if cur.user_id is null then
    insert into public.merchant_members (merchant_id, user_id, role, status, created_at, updated_at, suspended_at, created_by, updated_by)
    values (inv.merchant_id, p_user, inv.role, 'ACTIVE', p_now, p_now, null, inv.invited_by, inv.invited_by);
  else   -- a person who was removed earlier: the same row (history kept), reopened with the invited role
    update public.merchant_members set role = inv.role, status = 'ACTIVE', suspended_at = null, removed_at = null, removed_by = null, updated_at = greatest(updated_at, p_now), updated_by = inv.invited_by
     where merchant_id = inv.merchant_id and user_id = p_user;
  end if;
  update public.merchant_invitations set status = 'ACCEPTED', accepted_at = p_now, accepted_by = p_user where id = inv.id;
  perform public.team_journal(inv.merchant_id, p_user, p_module, 'INVITATION_ACCEPTED', 'SUCCESS', p_correlation, 'invitation', inv.id::text, jsonb_build_object('role', inv.role), p_now);
  perform public.team_journal(inv.merchant_id, inv.invited_by, p_module, 'MEMBER_ADDED', 'SUCCESS', p_correlation, 'user', p_user::text, jsonb_build_object('toRole', inv.role, 'toStatus', 'ACTIVE', 'via', 'invitation'), p_now);
  return jsonb_build_object('ok', true, 'code', 'INVITATION_ACCEPTED', 'merchant_id', inv.merchant_id, 'role', inv.role);
end $$;

revoke execute on function team_journal(uuid, uuid, text, text, text, uuid, text, text, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke execute on function team_actor_role(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function team_list_members(uuid) from public, anon, authenticated;
revoke execute on function team_member_remove(uuid, uuid, uuid, timestamptz, uuid, text) from public, anon, authenticated;
revoke execute on function team_invitation_create(uuid, uuid, text, text, text, timestamptz, timestamptz, uuid, text) from public, anon, authenticated;
revoke execute on function team_invitation_resend(uuid, uuid, uuid, text, timestamptz, timestamptz, uuid, text) from public, anon, authenticated;
revoke execute on function team_invitation_cancel(uuid, uuid, uuid, timestamptz, uuid, text) from public, anon, authenticated;
revoke execute on function team_invitation_lookup(text, timestamptz) from public, anon, authenticated;
revoke execute on function team_user_by_email(text) from public, anon, authenticated;
revoke execute on function team_invitation_accept(text, uuid, timestamptz, uuid, text) from public, anon, authenticated;
