-- Rollback of 20261118220000_member_removal_revokes_sessions.sql: restores the previous trigger condition (status becomes SUSPENDED only).
-- Sessions already closed by the wider trigger stay closed. The function itself is unchanged.
drop trigger if exists merchant_members_revoke_sessions_trg on public.merchant_members;
create trigger merchant_members_revoke_sessions_trg
after update of status on public.merchant_members
for each row
when (new.status = 'SUSPENDED' and old.status is distinct from 'SUSPENDED')
execute function public.merchant_members_revoke_sessions();
revoke execute on function public.merchant_members_revoke_sessions() from public, anon, authenticated;
