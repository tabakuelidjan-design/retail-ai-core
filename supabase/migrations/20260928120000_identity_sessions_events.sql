-- Core C1a (ADR 0004): Nordla application sessions and the identity/security event journal.
-- NOT APPLIED anywhere (neither staging nor production): written for review only. Applying it needs the owner's explicit approval.
-- Additive only: two new tables, their guard functions and triggers. No existing table is touched.
--
-- Access model (ADR 0004 section 2.4, D8): RLS enabled and NO policy - only the servers (service role) read and write; the browser
-- has no path to these tables. anon / authenticated get no privilege at all.

-- ---------------------------------------------------------------------------------------------------------------------------
-- app_sessions: one row per Nordla session, opened in ONE module/service for ONE user in ONE merchant.
-- The session token itself (>= 32 random bytes) is never stored: only its SHA-256 (64 lower-case hex characters).
-- Lifetime: absolute expiry fixed at creation (at most 12 hours, enforced below); inactivity (2 hours by default) is computed by the
-- server from last_seen_at, which is rewritten at most once every few minutes (src/identity/config.js).
-- ---------------------------------------------------------------------------------------------------------------------------
create table app_sessions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  module text not null check (module ~ '^[a-z][a-z0-9_-]{1,39}$'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or revoked_reason ~ '^[A-Z][A-Z0-9_]{2,39}$'),
  constraint app_sessions_token_hash_uq unique (token_hash),
  -- absolute lifetime: after creation, and never more than 12 hours (ADR 0004, D5)
  constraint app_sessions_expiry_ck check (expires_at > created_at and expires_at <= created_at + interval '12 hours'),
  constraint app_sessions_last_seen_ck check (last_seen_at >= created_at),
  -- a revocation always carries its reason, and a reason never exists without a revocation
  constraint app_sessions_revocation_ck check ((revoked_at is null) = (revoked_reason is null))
);

-- "log out everywhere": the user's still-active sessions
create index app_sessions_user_active_idx on app_sessions (user_id) where revoked_at is null;
-- merchant-scoped lookups (a merchant's sessions, a user's sessions in one merchant)
create index app_sessions_merchant_user_idx on app_sessions (merchant_id, user_id);
-- future clean-up (no job is created in C1a): absolute expiry, inactivity, and revoked rows
create index app_sessions_expires_idx on app_sessions (expires_at);
create index app_sessions_last_seen_active_idx on app_sessions (last_seen_at) where revoked_at is null;
create index app_sessions_revoked_idx on app_sessions (revoked_at) where revoked_at is not null;
-- (the lookup by token hash uses the unique index of app_sessions_token_hash_uq)

-- A session's identity and lifetime never change; last_seen_at only moves forward; a revocation is final (revoking again is a no-op
-- for the caller, which filters on revoked_at is null, and is refused here if it tries to rewrite it).
create function app_sessions_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.merchant_id is distinct from old.merchant_id or new.user_id is distinct from old.user_id
     or new.module is distinct from old.module or new.token_hash is distinct from old.token_hash
     or new.created_at is distinct from old.created_at or new.expires_at is distinct from old.expires_at then
    raise exception 'app_sessions: identity and expiry of a session are immutable' using errcode = 'integrity_constraint_violation';
  end if;
  if new.last_seen_at < old.last_seen_at then
    raise exception 'app_sessions: last_seen_at cannot move backwards' using errcode = 'integrity_constraint_violation';
  end if;
  if old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at or new.revoked_reason is distinct from old.revoked_reason) then
    raise exception 'app_sessions: a revocation is final' using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $$;
create trigger app_sessions_guard_trg before update on app_sessions for each row execute function app_sessions_guard();

comment on table app_sessions is
  'Nordla server sessions (ADR 0004). token_hash = SHA-256 of the opaque session token; the token itself is never stored. No Supabase token is stored (D6).';

alter table app_sessions enable row level security;  -- no policy: service role only
revoke all on table app_sessions from anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------
-- identity_events: append-only security journal. Technical identifiers only (never an e-mail address), no password, token,
-- cookie, secret or API key (enforced in src/identity/events.js; a coarse e-mail check is repeated here).
-- Deliberately no foreign keys on user_id / session_id: an entry must outlive the user or the session it describes.
-- ---------------------------------------------------------------------------------------------------------------------------
create table identity_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  merchant_id uuid not null references merchants(id) on delete restrict,
  user_id uuid,                                   -- null for a system event
  session_id uuid,
  module text not null check (module ~ '^[a-z][a-z0-9_-]{1,39}$'),
  event_type text not null check (event_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  outcome text not null check (outcome in ('SUCCESS', 'FAILURE', 'DENIED')),
  correlation_id uuid not null,
  entity_type text check (entity_type is null or entity_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  entity_id text check (entity_id is null or (length(entity_id) between 1 and 200)),
  detail jsonb not null default '{}'::jsonb,
  constraint identity_events_entity_ck check ((entity_type is null) = (entity_id is null)),
  constraint identity_events_detail_ck check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 4096),
  -- defence in depth: no e-mail address anywhere in the entity or the detail
  constraint identity_events_no_email_ck check (
    detail::text !~* '[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}'
    and (entity_id is null or entity_id !~* '[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}'))
);

create index identity_events_merchant_time_idx on identity_events (merchant_id, occurred_at desc);
create index identity_events_user_time_idx on identity_events (user_id, occurred_at desc) where user_id is not null;
create index identity_events_correlation_idx on identity_events (correlation_id);

-- Append-only at the database level: UPDATE, DELETE and TRUNCATE are refused for every role, service role included
-- (a trigger is not bypassed by the service role; privileges are revoked as well).
create function identity_events_append_only() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'identity_events is append-only: % is not allowed', tg_op using errcode = 'insufficient_privilege';
end $$;
create trigger identity_events_no_update_delete_trg before update or delete on identity_events for each row execute function identity_events_append_only();
create trigger identity_events_no_truncate_trg before truncate on identity_events for each statement execute function identity_events_append_only();

comment on table identity_events is
  'Append-only Nordla identity/security journal (ADR 0004). A correction is a NEW entry; nothing is updated or deleted.';

alter table identity_events enable row level security;  -- no policy: service role only
revoke all on table identity_events from anon, authenticated;
revoke update, delete, truncate on table identity_events from service_role;
