-- Removing a member (team_member_remove sets removed_at, and status = 'SUSPENDED' only if it was not already) must close the member's open sessions
-- even when the member was ALREADY suspended: in that case the status does not change, so the previous trigger (status only) stayed silent and a
-- session opened between the suspension and the removal survived. The function is unchanged; only the trigger event and condition are widened.
-- Idempotent: safe to run twice. Staging has the trigger from its own earlier migration (member_suspension_revokes_sessions): this file is added, that one is not rewritten.
create or replace function public.merchant_members_revoke_sessions()
 returns trigger language plpgsql security definer set search_path to ''
as $function$
begin
  update public.app_sessions
     set revoked_at = new.updated_at, revoked_reason = 'REVOKED'
   where merchant_id = new.merchant_id and user_id = new.user_id and revoked_at is null;
  return null;
end $function$;

drop trigger if exists merchant_members_revoke_sessions_trg on public.merchant_members;
create trigger merchant_members_revoke_sessions_trg
after update of status, removed_at on public.merchant_members
for each row
when ((new.status = 'SUSPENDED' and old.status is distinct from 'SUSPENDED')
   or (new.removed_at is not null and old.removed_at is null))
execute function public.merchant_members_revoke_sessions();

-- Trigger function: called by the trigger only; no role may call it directly (ACL = postgres + service_role, as on staging).
revoke execute on function public.merchant_members_revoke_sessions() from public, anon, authenticated;
