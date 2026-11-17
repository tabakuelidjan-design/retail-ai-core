-- Settings > Security V2: one-time recovery codes for the second factor (used when the authenticator is lost).
-- Only a SHA-256 of the code is stored (the codes carry ~60 random bits and are shown once). Service role only: RLS on, no policy, no grant.
-- Reversible: see supabase/rollback/20261118120000_security_mfa_recovery_codes_down.sql (drops only this table).
create table if not exists mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  constraint mfa_recovery_codes_user_hash_uq unique (user_id, code_hash)
);
create index if not exists mfa_recovery_codes_user_idx on mfa_recovery_codes (user_id) where used_at is null;
alter table mfa_recovery_codes enable row level security;
revoke all on table mfa_recovery_codes from anon, authenticated;
comment on table mfa_recovery_codes is 'Nordla MFA recovery codes (Security V2): sha-256 only, one use each, service role only.';
