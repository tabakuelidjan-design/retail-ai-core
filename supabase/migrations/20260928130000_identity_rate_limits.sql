-- Core C1b (ADR 0004): limitation of repeated failed identity verifications (e-mail + password).
-- NOT APPLIED anywhere (neither staging nor production): written for review only. Applying it needs the owner's explicit approval.
-- Additive only: two tables and two functions. No existing table is touched.
-- Revision (C1b concurrency fix, same unapplied file): the first version checked "blocked?" with a plain read and counted the failure
-- only AFTER calling Supabase Auth, so simultaneous attempts all passed the check (20 of 20 reached Supabase in the tests). Attempts
-- are now RESERVED atomically in the database BEFORE Supabase is called, then settled.
--
-- Nothing identifying is stored in clear: subjects = HMAC-SHA-256(NORDLA_IDENTITY_RATE_LIMIT_KEY, "<dimension>:<normalised value>")
-- computed by the server (src/identity/rate-limit.js). Never the e-mail address, never the IP address, never a plain SHA-256.
-- Two independent dimensions: 'email' (normalised address) and 'ip' (normalised client address, IPv6 grouped by /64).
--
-- Rule, per dimension: failures counted in a fixed window + attempts currently in flight (unexpired reservations) may never exceed
-- the maximum; reaching the maximum with failures blocks the subject for a fixed time.
--   reserve  (before Supabase)  one call = one transaction; the two counter rows are locked (FOR UPDATE, always e-mail then IP: no
--            deadlock) so concurrent reservations for a subject are serialised, across processes and instances.
--   settle   FAILURE  -> the reservation becomes a counted failure (on both dimensions)
--            SUCCESS  -> the reservation is released and the e-mail failures are reset; the IP failures are NOT touched
--            RELEASE  -> (Supabase unavailable) the reservation is released, nothing is counted
--   A reservation never settled (crash, interrupted request) expires by itself (lease, default 30 s) and stops counting.

create table identity_rate_limits (
  dimension text not null check (dimension in ('email', 'ip')),
  subject_hmac text not null check (subject_hmac ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,           -- start of the current fixed counting window
  failures integer not null check (failures between 0 and 1000000),
  blocked_until timestamptz,                         -- set when the window reaches the maximum; null = never blocked
  updated_at timestamptz not null,
  primary key (dimension, subject_hmac)              -- the counter rows are found (and locked) by primary key
);

-- future clean-up of old windows (no job is created in C1b)
create index identity_rate_limits_updated_idx on identity_rate_limits (updated_at);
create index identity_rate_limits_blocked_idx on identity_rate_limits (blocked_until) where blocked_until is not null;

comment on table identity_rate_limits is
  'Failed identity verifications per HMAC subject (ADR 0004, C1b). Keyed HMAC only: no e-mail or IP address, no plain hash.';

-- Attempts in flight: one row per verification between reserve and settle. Expired rows no longer count and are purged lazily.
create table identity_auth_reservations (
  id uuid primary key default gen_random_uuid(),
  email_subject text not null check (email_subject ~ '^[0-9a-f]{64}$'),
  ip_subject text not null check (ip_subject ~ '^[0-9a-f]{64}$'),
  reserved_at timestamptz not null,
  expires_at timestamptz not null,
  constraint identity_auth_reservations_lease_ck check (expires_at > reserved_at and expires_at <= reserved_at + interval '5 minutes')
);
create index identity_auth_reservations_email_idx on identity_auth_reservations (email_subject, expires_at);
create index identity_auth_reservations_ip_idx on identity_auth_reservations (ip_subject, expires_at);
create index identity_auth_reservations_expires_idx on identity_auth_reservations (expires_at);  -- future clean-up

comment on table identity_auth_reservations is
  'Identity verifications in flight (ADR 0004, C1b): reserved before Supabase Auth is called, settled or expired after. HMAC subjects only.';

-- Shared validation of the limits (not callable from outside: EXECUTE revoked below).
create function identity_rate_limit_check_args(p_now timestamptz, p_window_seconds integer, p_max_email integer, p_max_ip integer, p_block_seconds integer)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_now is null or p_window_seconds is null or p_max_email is null or p_max_ip is null or p_block_seconds is null
     or p_window_seconds not between 60 and 86400 or p_max_email not between 1 and 1000 or p_max_ip not between 1 and 1000
     or p_block_seconds not between 60 and 86400 then
    raise exception 'identity rate limits: invalid limits' using errcode = 'invalid_parameter_value';
  end if;
end $$;

-- Reserve one attempt for (e-mail subject, IP subject). Returns the reservation id, or NULL when the attempt must be refused
-- (blocked, or failures + attempts in flight already at the maximum on either dimension). Atomic: one transaction, rows locked.
create function identity_auth_reserve(
  p_email_subject text, p_ip_subject text, p_now timestamptz, p_window_seconds integer, p_max_email integer, p_max_ip integer,
  p_block_seconds integer, p_lease_seconds integer
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  e public.identity_rate_limits;
  i public.identity_rate_limits;
  in_flight_email integer;
  in_flight_ip integer;
  rid uuid;
begin
  perform public.identity_rate_limit_check_args(p_now, p_window_seconds, p_max_email, p_max_ip, p_block_seconds);
  if p_lease_seconds is null or p_lease_seconds not between 5 and 300 then
    raise exception 'identity rate limits: invalid lease' using errcode = 'invalid_parameter_value';
  end if;
  -- make sure both counter rows exist, then lock them in a fixed order (email before ip)
  insert into public.identity_rate_limits (dimension, subject_hmac, window_started_at, failures, updated_at)
  values ('email', p_email_subject, p_now, 0, p_now), ('ip', p_ip_subject, p_now, 0, p_now)
  on conflict (dimension, subject_hmac) do nothing;
  select * into e from public.identity_rate_limits where dimension = 'email' and subject_hmac = p_email_subject for update;
  select * into i from public.identity_rate_limits where dimension = 'ip' and subject_hmac = p_ip_subject for update;
  -- a block that is over starts a fresh window (the subject gets its full allowance again, as before the block)
  if e.blocked_until is not null and e.blocked_until <= p_now then
    update public.identity_rate_limits set failures = 0, window_started_at = p_now, blocked_until = null, updated_at = greatest(updated_at, p_now)
     where dimension = 'email' and subject_hmac = p_email_subject returning * into e;
  end if;
  if i.blocked_until is not null and i.blocked_until <= p_now then
    update public.identity_rate_limits set failures = 0, window_started_at = p_now, blocked_until = null, updated_at = greatest(updated_at, p_now)
     where dimension = 'ip' and subject_hmac = p_ip_subject returning * into i;
  end if;
  -- expired reservations stop counting (purged here for these subjects)
  delete from public.identity_auth_reservations
   where expires_at <= p_now and (email_subject = p_email_subject or ip_subject = p_ip_subject);
  if (e.blocked_until is not null and e.blocked_until > p_now) or (i.blocked_until is not null and i.blocked_until > p_now) then
    return null;
  end if;
  select count(*) into in_flight_email from public.identity_auth_reservations where email_subject = p_email_subject and expires_at > p_now;
  select count(*) into in_flight_ip from public.identity_auth_reservations where ip_subject = p_ip_subject and expires_at > p_now;
  -- failures of an expired window no longer count
  if (case when e.window_started_at <= p_now - make_interval(secs => p_window_seconds) then 0 else e.failures end) + in_flight_email >= p_max_email
     or (case when i.window_started_at <= p_now - make_interval(secs => p_window_seconds) then 0 else i.failures end) + in_flight_ip >= p_max_ip then
    return null;
  end if;
  insert into public.identity_auth_reservations (email_subject, ip_subject, reserved_at, expires_at)
  values (p_email_subject, p_ip_subject, p_now, p_now + make_interval(secs => p_lease_seconds))
  returning id into rid;
  return rid;
end $$;

-- Settle a reservation: 'FAILURE' (refused credentials), 'SUCCESS' (verified) or 'RELEASE' (Supabase unavailable). Idempotent: an
-- unknown or already settled reservation changes nothing. Returns blocked_until when this failure blocked a subject, else NULL.
create function identity_auth_settle(
  p_reservation uuid, p_outcome text, p_now timestamptz, p_window_seconds integer, p_max_email integer, p_max_ip integer, p_block_seconds integer
) returns timestamptz language plpgsql security invoker set search_path = '' as $$
declare
  r public.identity_auth_reservations;
  e public.identity_rate_limits;
  i public.identity_rate_limits;
  blocked timestamptz;
begin
  perform public.identity_rate_limit_check_args(p_now, p_window_seconds, p_max_email, p_max_ip, p_block_seconds);
  if p_outcome is null or p_outcome not in ('FAILURE', 'SUCCESS', 'RELEASE') then
    raise exception 'identity rate limits: invalid outcome' using errcode = 'invalid_parameter_value';
  end if;
  delete from public.identity_auth_reservations where id = p_reservation returning * into r;
  if not found or p_outcome = 'RELEASE' then
    return null;
  end if;
  -- same lock order as identity_auth_reserve
  select * into e from public.identity_rate_limits where dimension = 'email' and subject_hmac = r.email_subject for update;
  select * into i from public.identity_rate_limits where dimension = 'ip' and subject_hmac = r.ip_subject for update;
  if p_outcome = 'SUCCESS' then
    -- the verified address starts again from zero; the IP counter (other addresses' failures) is left as it is
    update public.identity_rate_limits set failures = 0, window_started_at = p_now, blocked_until = null, updated_at = greatest(updated_at, p_now)
     where dimension = 'email' and subject_hmac = r.email_subject;
    return null;
  end if;
  -- FAILURE: +1 on both dimensions (a window older than p_window_seconds starts again at 1); the maximum blocks the subject
  update public.identity_rate_limits t set
    failures = case when t.window_started_at <= p_now - make_interval(secs => p_window_seconds) then 1 else t.failures + 1 end,
    window_started_at = case when t.window_started_at <= p_now - make_interval(secs => p_window_seconds) then p_now else t.window_started_at end,
    updated_at = greatest(t.updated_at, p_now)
   where (t.dimension = 'email' and t.subject_hmac = r.email_subject) or (t.dimension = 'ip' and t.subject_hmac = r.ip_subject);
  update public.identity_rate_limits t set
    blocked_until = greatest(coalesce(t.blocked_until, p_now), p_now + make_interval(secs => p_block_seconds))
   where ((t.dimension = 'email' and t.subject_hmac = r.email_subject and t.failures >= p_max_email)
       or (t.dimension = 'ip' and t.subject_hmac = r.ip_subject and t.failures >= p_max_ip));
  select max(blocked_until) into blocked from public.identity_rate_limits
   where ((dimension = 'email' and subject_hmac = r.email_subject) or (dimension = 'ip' and subject_hmac = r.ip_subject)) and blocked_until > p_now;
  return blocked;
end $$;

alter table identity_rate_limits enable row level security;        -- no policy: service role only
alter table identity_auth_reservations enable row level security;  -- no policy: service role only
revoke all on table identity_rate_limits from anon, authenticated;
revoke all on table identity_auth_reservations from anon, authenticated;
-- functions are executable by PUBLIC by default: only the server (service role) may reserve / settle; the helper is internal
revoke execute on function identity_rate_limit_check_args(timestamptz, integer, integer, integer, integer) from public, anon, authenticated;
revoke execute on function identity_auth_reserve(text, text, timestamptz, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke execute on function identity_auth_settle(uuid, text, timestamptz, integer, integer, integer, integer) from public, anon, authenticated;
