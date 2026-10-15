-- ROLLBACK of the Sourcing go-live identity sequence (NOT a migration: run by hand ONLY after the owner's explicit decision).
-- Undoes, in reverse order:
--   supabase/migrations-pending/20261015093000_identity_module_sourcing.sql
--   supabase/migrations/20260928150000_identity_modules_sessions.sql
--   supabase/migrations/20260928140000_identity_members.sql
--   supabase/migrations/20260928130000_identity_rate_limits.sql
--   supabase/migrations/20260928120000_identity_sessions_events.sql
-- These five are additive (new tables / functions only; merchants and every Finance / Analytics table untouched), so the rollback
-- only drops what they created. WARNING: it DELETES the identity data written since (members, module rights, sessions, identity
-- journal): everyone is signed out and the owner account must be re-attached. Supabase Auth users (auth.users) are NOT touched.
-- Proven locally: schema after (23 applied + sequence + this file) == schema of the 23 applied migrations (pg_dump -s diff empty).
begin;
-- one transaction: everything or nothing
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'identity_open_session', 'identity_module_set', 'module_entitlements_guard', 'module_entitlements_no_truncate',
             'identity_member_apply', 'identity_member_bootstrap_owner', 'identity_member_lock', 'merchant_members_guard', 'merchant_members_no_truncate',
             'identity_auth_reserve', 'identity_auth_settle', 'identity_rate_limit_check_args',
             'app_sessions_guard', 'identity_events_append_only')
  loop
    execute format('drop function %s cascade', r.sig);
  end loop;
end $$;
drop table if exists public.module_entitlements;
drop table if exists public.merchant_members;
drop table if exists public.identity_auth_reservations;
drop table if exists public.identity_rate_limits;
drop table if exists public.app_sessions;
drop table if exists public.identity_events;
commit;
