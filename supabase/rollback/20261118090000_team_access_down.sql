-- Rollback of 20261118090000_team_access.sql. Only safe while no invitation / removal of value exists (check first: select count(*) from merchant_invitations; select count(*) from merchant_members where removed_at is not null).
-- A removed member would silently become a plain SUSPENDED member (still without access): nothing is reopened.
drop function if exists team_invitation_accept(text, uuid, timestamptz, uuid, text);
drop function if exists team_user_by_email(text);
drop function if exists team_invitation_lookup(text, timestamptz);
drop function if exists team_invitation_cancel(uuid, uuid, uuid, timestamptz, uuid, text);
drop function if exists team_invitation_resend(uuid, uuid, uuid, text, timestamptz, timestamptz, uuid, text);
drop function if exists team_invitation_create(uuid, uuid, text, text, text, timestamptz, timestamptz, uuid, text);
drop function if exists team_member_remove(uuid, uuid, uuid, timestamptz, uuid, text);
drop function if exists team_list_members(uuid);
drop function if exists team_actor_role(uuid, uuid);
drop function if exists team_journal(uuid, uuid, text, text, text, uuid, text, text, jsonb, timestamptz);
drop table if exists merchant_invitations;
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
alter table merchant_members drop constraint if exists merchant_members_removed_ck;
alter table merchant_members drop column if exists removed_at, drop column if exists removed_by;
