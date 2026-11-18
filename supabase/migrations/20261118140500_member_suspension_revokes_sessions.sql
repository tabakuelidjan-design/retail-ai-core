create or replace function public.merchant_members_revoke_sessions()
 returns trigger language plpgsql security definer set search_path to ''
as $function$
begin
  update public.app_sessions
     set revoked_at = new.updated_at, revoked_reason = 'REVOKED'
   where merchant_id = new.merchant_id and user_id = new.user_id and revoked_at is null;
  return null;
end $function$;
create trigger merchant_members_revoke_sessions_trg
after update of status on public.merchant_members
for each row
when (new.status = 'SUSPENDED' and old.status is distinct from 'SUSPENDED')
execute function public.merchant_members_revoke_sessions();
