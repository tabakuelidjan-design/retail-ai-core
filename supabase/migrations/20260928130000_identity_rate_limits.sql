-- Core C1b (ADR 0004): limitation of repeated failed identity verifications (e-mail + password).
-- NOT APPLIED anywhere (neither staging nor production): written for review only. Applying it needs the owner's explicit approval.
-- Additive only: one table and one function. No existing table is touched.
--
-- Nothing identifying is stored in clear: subject_hmac = HMAC-SHA-256(NORDLA_IDENTITY_RATE_LIMIT_KEY, "<dimension>:<normalised value>")
-- computed by the server (src/identity/rate-limit.js). Never the e-mail address, never the IP address, never a plain SHA-256 of
-- either (a plain hash of an e-mail address can be reversed by guessing; an HMAC cannot without the secret key).
-- Two independent dimensions: 'email' (normalised address) and 'ip' (normalised client address, IPv6 grouped by /64).

create table identity_rate_limits (
  dimension text not null check (dimension in ('email', 'ip')),
  subject_hmac text not null check (subject_hmac ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,           -- start of the current fixed counting window
  failures integer not null check (failures between 0 and 1000000),
  blocked_until timestamptz,                         -- set when the window reaches the maximum; null = never blocked
  updated_at timestamptz not null,
  primary key (dimension, subject_hmac)              -- the check before each verification is a primary-key lookup
);

-- future clean-up of old windows (no job is created in C1b)
create index identity_rate_limits_updated_idx on identity_rate_limits (updated_at);
create index identity_rate_limits_blocked_idx on identity_rate_limits (blocked_until) where blocked_until is not null;

comment on table identity_rate_limits is
  'Failed identity verifications per HMAC subject (ADR 0004, C1b). Keyed HMAC only: no e-mail or IP address, no plain hash.';

-- Records ONE failure atomically (single INSERT ... ON CONFLICT, safe under concurrency) and returns blocked_until (null when the
-- subject is not blocked). A window older than p_window_seconds starts again at 1. Reaching p_max_failures inside the window blocks
-- the subject until p_now + p_block_seconds. The server passes its own clock (p_now) so the rule is testable and deterministic.
create function identity_rate_limit_record_failure(
  p_dimension text, p_subject text, p_now timestamptz, p_window_seconds integer, p_max_failures integer, p_block_seconds integer
) returns timestamptz language plpgsql security invoker set search_path = '' as $$
declare
  r public.identity_rate_limits;
begin
  if p_now is null or p_window_seconds is null or p_max_failures is null or p_block_seconds is null
     or p_window_seconds not between 60 and 86400 or p_max_failures not between 1 and 1000 or p_block_seconds not between 60 and 86400 then
    raise exception 'identity_rate_limit_record_failure: invalid limits' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.identity_rate_limits as t (dimension, subject_hmac, window_started_at, failures, updated_at)
  values (p_dimension, p_subject, p_now, 1, p_now)
  on conflict (dimension, subject_hmac) do update set
    failures = case when t.window_started_at <= p_now - make_interval(secs => p_window_seconds) then 1 else t.failures + 1 end,
    window_started_at = case when t.window_started_at <= p_now - make_interval(secs => p_window_seconds) then p_now else t.window_started_at end,
    updated_at = greatest(t.updated_at, p_now)
  returning * into r;
  if r.failures >= p_max_failures then
    update public.identity_rate_limits
       set blocked_until = greatest(coalesce(blocked_until, p_now), p_now + make_interval(secs => p_block_seconds))
     where dimension = r.dimension and subject_hmac = r.subject_hmac
    returning * into r;
  end if;
  return case when r.blocked_until > p_now then r.blocked_until else null end;
end $$;

alter table identity_rate_limits enable row level security;  -- no policy: service role only
revoke all on table identity_rate_limits from anon, authenticated;
-- functions are executable by PUBLIC by default: only the server (service role) may record failures
revoke execute on function identity_rate_limit_record_failure(text, text, timestamptz, integer, integer, integer) from public, anon, authenticated;
