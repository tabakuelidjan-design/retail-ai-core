-- Team access hygiene (branch fix/team-removal-revokes-sessions). NOT applied anywhere: awaiting owner review.
-- Today a member who is removed or suspended is refused at once (the access layer re-reads the membership on EVERY request), but their app_sessions rows stay
-- "open" (revoked_at null) until that session makes one more request. If the same person is later reactivated or re-invited within the session lifetime (12 h at most,
-- see app_sessions_expiry_ck), an OLD cookie would work again without a new sign-in.
-- This closes every open session of that member in that merchant, in the SAME transaction as the status change, whoever changed it (team_member_remove, identity_member_apply, SQL).
-- Additive and reversible (see supabase/rollback). Touches no existing function or table definition; sessions of other merchants are untouched.
create or replace function merchant_members_revoke_sessions() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.app_sessions
     set revoked_at = new.updated_at, revoked_reason = 'MEMBER_ACCESS_ENDED'
   where merchant_id = new.merchant_id and user_id = new.user_id and revoked_at is null;
  return null;
end $$;
revoke execute on function merchant_members_revoke_sessions() from public, anon, authenticated;

create trigger merchant_members_revoke_sessions_trg
  after update of status on merchant_members
  for each row when (new.status = 'SUSPENDED' and old.status is distinct from 'SUSPENDED')
  execute function merchant_members_revoke_sessions();
