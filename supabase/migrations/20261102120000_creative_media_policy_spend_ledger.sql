-- Creative Production: standing tenant media-processing policy (ADR 0007-A, PROPOSED), atomic spending reservations and the media-transmission
-- audit trail. Additive only: three tables, their guards and SECURITY DEFINER functions. Touches no existing table.
-- Nothing here activates a policy: a policy exists only once a tenant OWNER/ADMIN accepts it, and the application refuses to transmit media
-- without an accepted, unrevoked, current version. Money columns are reservations of an APPLICATION ceiling, never provider billing.
-- Rollback: drop the functions, then the three tables (no data elsewhere depends on them) - see docs/creative-autonomy/creative-ledger.md.

-- ---------------------------------------------------------------- policies: one row per accepted version, immutable content
create table creative_media_policies (
  merchant_id uuid not null references merchants(id) on delete restrict,
  policy_id text not null check (policy_id ~ '^[A-Za-z0-9][A-Za-z0-9:_./@#-]{0,199}$'),
  version integer not null check (version >= 1),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  per_run_max_eur numeric(12, 4) not null check (per_run_max_eur >= 0),
  monthly_max_eur numeric(12, 4) not null check (monthly_max_eur >= per_run_max_eur),
  accepted_by uuid not null,
  accepted_role text not null check (accepted_role in ('OWNER', 'ADMIN')),
  accepted_at timestamptz not null,
  superseded_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  primary key (merchant_id, policy_id, version),
  constraint creative_media_policies_revocation_ck check ((revoked_at is null) = (revoked_by is null))
);
-- at most one CURRENT version per tenant and policy
create unique index creative_media_policies_current_uq on creative_media_policies (merchant_id, policy_id) where superseded_at is null and revoked_at is null;

-- content and acceptance are immutable; superseded_at / revoked_at / revoked_by may only go from null to a value, once; no delete
create function creative_media_policies_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'creative_media_policies: an accepted policy version is never deleted' using errcode = 'integrity_constraint_violation'; end if;
  if new.merchant_id is distinct from old.merchant_id or new.policy_id is distinct from old.policy_id or new.version is distinct from old.version
     or new.content is distinct from old.content or new.content_sha256 is distinct from old.content_sha256
     or new.per_run_max_eur is distinct from old.per_run_max_eur or new.monthly_max_eur is distinct from old.monthly_max_eur
     or new.accepted_by is distinct from old.accepted_by or new.accepted_role is distinct from old.accepted_role or new.accepted_at is distinct from old.accepted_at then
    raise exception 'creative_media_policies: an accepted version is immutable' using errcode = 'integrity_constraint_violation';
  end if;
  if (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at)
     or (old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at or new.revoked_by is distinct from old.revoked_by)) then
    raise exception 'creative_media_policies: supersession and revocation are final' using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $$;
create trigger creative_media_policies_guard_trg before update or delete on creative_media_policies for each row execute function creative_media_policies_guard();

-- ---------------------------------------------------------------- spending reservations: one row per run, the whole ceiling reserved at once
create table creative_spend_reservations (
  merchant_id uuid not null references merchants(id) on delete restrict,
  run_id text not null check (run_id ~ '^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$'),
  policy_id text not null,
  policy_version integer not null,
  month date not null check (extract(day from month) = 1),
  ceiling_eur numeric(12, 4) not null check (ceiling_eur > 0),
  -- RESERVED: counts its ceiling. RECONCILE_REQUIRED: provider work may have happened and the outcome is not settled; still counts its ceiling.
  -- SETTLED: counts the settled amount. RELEASED: counts nothing (no media was ever attempted).
  status text not null default 'RESERVED' check (status in ('RESERVED', 'RECONCILE_REQUIRED', 'SETTLED', 'RELEASED')),
  settled_eur numeric(12, 4) check (settled_eur is null or settled_eur >= 0),
  settlement_basis text check (settlement_basis is null or settlement_basis ~ '^[A-Z_]{1,64}$'),
  release_reason text check (release_reason is null or release_reason ~ '^[A-Z_]{1,64}$'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (merchant_id, run_id),
  foreign key (merchant_id, policy_id, policy_version) references creative_media_policies (merchant_id, policy_id, version) on delete restrict,
  constraint creative_spend_settled_ck check ((status = 'SETTLED') = (settled_eur is not null and settlement_basis is not null)),
  constraint creative_spend_released_ck check ((status = 'RELEASED') = (release_reason is not null))
);
create index creative_spend_reservations_month_idx on creative_spend_reservations (merchant_id, month);

create function creative_spend_reservations_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'creative_spend_reservations: a reservation is never deleted' using errcode = 'integrity_constraint_violation'; end if;
  if new.merchant_id is distinct from old.merchant_id or new.run_id is distinct from old.run_id or new.policy_id is distinct from old.policy_id
     or new.policy_version is distinct from old.policy_version or new.month is distinct from old.month or new.ceiling_eur is distinct from old.ceiling_eur
     or new.created_at is distinct from old.created_at then
    raise exception 'creative_spend_reservations: the identity and ceiling of a reservation are immutable' using errcode = 'integrity_constraint_violation';
  end if;
  if old.status in ('SETTLED', 'RELEASED') then raise exception 'creative_spend_reservations: a settled or released reservation is final' using errcode = 'integrity_constraint_violation'; end if;
  return new;
end $$;
create trigger creative_spend_reservations_guard_trg before update or delete on creative_spend_reservations for each row execute function creative_spend_reservations_guard();

-- ---------------------------------------------------------------- media-transmission audit: append-only lifecycle events
create table creative_media_transmissions (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants(id) on delete restrict,
  run_id text not null,
  operation text not null check (operation in ('VISION_CRITIQUE', 'IMAGE_EDIT')),
  -- the provider-side operation id of ONE call attempt; 'run' for the run-level events (AUTHORIZED, RESERVED, CANCELLED)
  attempt_ref text not null check (attempt_ref ~ '^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$'),
  event text not null check (event in ('AUTHORIZED', 'RESERVED', 'ATTEMPTED', 'SENT', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  policy_id text not null,
  policy_version integer not null,
  authorization_id text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  provider_id text not null,
  region text not null,
  provider_request_id text check (provider_request_id is null or length(provider_request_id) <= 200),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  at timestamptz not null,
  -- a retried write of the same event is a no-op, never a second accounting line
  constraint creative_media_transmissions_once_uq unique (merchant_id, run_id, operation, attempt_ref, event),
  foreign key (merchant_id, run_id) references creative_spend_reservations (merchant_id, run_id) on delete restrict
);

create function creative_media_transmissions_append_only() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'creative_media_transmissions: the audit trail is append-only' using errcode = 'integrity_constraint_violation';
end $$;
create trigger creative_media_transmissions_append_only_trg before update or delete on creative_media_transmissions for each row execute function creative_media_transmissions_append_only();
create trigger creative_media_transmissions_no_truncate_trg before truncate on creative_media_transmissions for each statement execute function creative_media_transmissions_append_only();
create trigger creative_spend_reservations_no_truncate_trg before truncate on creative_spend_reservations for each statement execute function creative_media_transmissions_append_only();
create trigger creative_media_policies_no_truncate_trg before truncate on creative_media_policies for each statement execute function creative_media_transmissions_append_only();

-- one transaction-scoped lock per tenant and month: serialises reservations across every application instance sharing this database
create function creative_spend_lock(p_merchant uuid, p_month date) returns void language sql volatile set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('nordla.creative_spend:' || p_merchant::text || ':' || p_month::text, 0));
$$;
create function creative_policy_lock(p_merchant uuid, p_policy text) returns void language sql volatile set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('nordla.creative_policy:' || p_merchant::text || ':' || p_policy, 0));
$$;

-- ---------------------------------------------------------------- policy acceptance / revocation / read
-- Accept a policy content for a tenant. Only an ACTIVE OWNER or ADMIN of THAT tenant. Same content as the current version: returns it (idempotent).
-- Any change: a new version, the previous one superseded - the new content is in force only through this explicit acceptance.
create function creative_media_policy_accept(p_merchant uuid, p_actor uuid, p_policy_id text, p_content jsonb, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_role text; v_sha text; v_cur public.creative_media_policies; v_next integer; v_run numeric; v_month numeric;
begin
  perform public.creative_policy_lock(p_merchant, p_policy_id);
  select m.role into v_role from public.merchant_members m where m.merchant_id = p_merchant and m.user_id = p_actor and m.status = 'ACTIVE';
  if v_role is null or v_role not in ('OWNER', 'ADMIN') then return jsonb_build_object('status', 'REFUSED', 'reason', 'ACTOR_NOT_TENANT_ADMIN'); end if;
  if (p_content -> 'tenant' ->> 'merchant_id') is distinct from p_merchant::text then return jsonb_build_object('status', 'REFUSED', 'reason', 'TENANT_MISMATCH'); end if;
  if (p_content ->> 'policy_id') is distinct from p_policy_id then return jsonb_build_object('status', 'REFUSED', 'reason', 'POLICY_ID_MISMATCH'); end if;
  begin
    v_run := (p_content -> 'spend' ->> 'per_run_max')::numeric; v_month := (p_content -> 'spend' ->> 'monthly_max')::numeric;
  exception when others then return jsonb_build_object('status', 'REFUSED', 'reason', 'SPEND_LIMITS_INVALID'); end;
  if v_run is null or v_month is null or v_run < 0 or v_month < v_run or (p_content -> 'spend' ->> 'currency') is distinct from 'EUR' then
    return jsonb_build_object('status', 'REFUSED', 'reason', 'SPEND_LIMITS_INVALID');
  end if;
  v_sha := encode(extensions.digest(convert_to(p_content::text, 'UTF8'), 'sha256'), 'hex');
  select * into v_cur from public.creative_media_policies p where p.merchant_id = p_merchant and p.policy_id = p_policy_id and p.superseded_at is null and p.revoked_at is null;
  if found and v_cur.content_sha256 = v_sha then
    return jsonb_build_object('status', 'ALREADY_ACCEPTED', 'version', v_cur.version, 'content_sha256', v_sha);
  end if;
  if found then update public.creative_media_policies set superseded_at = p_now where merchant_id = p_merchant and policy_id = p_policy_id and version = v_cur.version; end if;
  select coalesce(max(version), 0) + 1 into v_next from public.creative_media_policies where merchant_id = p_merchant and policy_id = p_policy_id;
  insert into public.creative_media_policies (merchant_id, policy_id, version, content, content_sha256, per_run_max_eur, monthly_max_eur, accepted_by, accepted_role, accepted_at)
  values (p_merchant, p_policy_id, v_next, p_content, v_sha, v_run, v_month, p_actor, v_role, p_now);
  return jsonb_build_object('status', 'ACCEPTED', 'version', v_next, 'content_sha256', v_sha);
end $$;

create function creative_media_policy_revoke(p_merchant uuid, p_actor uuid, p_policy_id text, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role text; v_ver integer;
begin
  perform public.creative_policy_lock(p_merchant, p_policy_id);
  select m.role into v_role from public.merchant_members m where m.merchant_id = p_merchant and m.user_id = p_actor and m.status = 'ACTIVE';
  if v_role is null or v_role not in ('OWNER', 'ADMIN') then return jsonb_build_object('status', 'REFUSED', 'reason', 'ACTOR_NOT_TENANT_ADMIN'); end if;
  update public.creative_media_policies set revoked_at = p_now, revoked_by = p_actor
   where merchant_id = p_merchant and policy_id = p_policy_id and superseded_at is null and revoked_at is null returning version into v_ver;
  if v_ver is null then return jsonb_build_object('status', 'NOTHING_TO_REVOKE'); end if;
  return jsonb_build_object('status', 'REVOKED', 'version', v_ver);
end $$;

-- The version in force (accepted, neither superseded nor revoked), or null.
create function creative_media_policy_current(p_merchant uuid, p_policy_id text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('version', p.version, 'content', p.content, 'content_sha256', p.content_sha256, 'accepted_by', p.accepted_by,
    'accepted_role', p.accepted_role, 'accepted_at', p.accepted_at, 'per_run_max_eur', p.per_run_max_eur, 'monthly_max_eur', p.monthly_max_eur)
  from public.creative_media_policies p where p.merchant_id = p_merchant and p.policy_id = p_policy_id and p.superseded_at is null and p.revoked_at is null;
$$;

-- ---------------------------------------------------------------- spending
-- Reserve the WHOLE run ceiling atomically. Idempotent on (tenant, run): the same request again returns the same reservation; a different one for
-- the same run is refused. The policy version must still be in force at reservation time (a revocation blocks new runs).
create function creative_spend_reserve(p_merchant uuid, p_run_id text, p_policy_id text, p_policy_version integer, p_ceiling_eur numeric, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_month date := date_trunc('month', p_now at time zone 'UTC')::date; v_pol public.creative_media_policies; v_res public.creative_spend_reservations; v_committed numeric;
begin
  if p_ceiling_eur is null or p_ceiling_eur <= 0 then return jsonb_build_object('status', 'REFUSED', 'reason', 'CEILING_INVALID'); end if;
  perform public.creative_spend_lock(p_merchant, v_month);
  select * into v_res from public.creative_spend_reservations r where r.merchant_id = p_merchant and r.run_id = p_run_id;
  if found then
    if v_res.ceiling_eur = p_ceiling_eur and v_res.policy_id = p_policy_id and v_res.policy_version = p_policy_version then
      return jsonb_build_object('status', 'ALREADY_RESERVED', 'run_status', v_res.status, 'ceiling_eur', v_res.ceiling_eur);
    end if;
    return jsonb_build_object('status', 'REFUSED', 'reason', 'RUN_ID_ALREADY_USED_WITH_OTHER_TERMS');
  end if;
  select * into v_pol from public.creative_media_policies p where p.merchant_id = p_merchant and p.policy_id = p_policy_id and p.version = p_policy_version;
  if not found or v_pol.superseded_at is not null or v_pol.revoked_at is not null then return jsonb_build_object('status', 'REFUSED', 'reason', 'POLICY_NOT_IN_FORCE'); end if;
  if p_ceiling_eur > v_pol.per_run_max_eur then return jsonb_build_object('status', 'REFUSED', 'reason', 'PER_RUN_LIMIT'); end if;
  select coalesce(sum(case when r.status in ('RESERVED', 'RECONCILE_REQUIRED') then r.ceiling_eur when r.status = 'SETTLED' then r.settled_eur else 0 end), 0)
    into v_committed from public.creative_spend_reservations r where r.merchant_id = p_merchant and r.month = v_month;
  if v_committed + p_ceiling_eur > v_pol.monthly_max_eur then
    return jsonb_build_object('status', 'REFUSED', 'reason', 'MONTHLY_LIMIT', 'committed_eur', v_committed, 'monthly_max_eur', v_pol.monthly_max_eur);
  end if;
  insert into public.creative_spend_reservations (merchant_id, run_id, policy_id, policy_version, month, ceiling_eur, created_at, updated_at)
  values (p_merchant, p_run_id, p_policy_id, p_policy_version, v_month, p_ceiling_eur, p_now, p_now);
  return jsonb_build_object('status', 'RESERVED', 'ceiling_eur', p_ceiling_eur, 'committed_eur', v_committed + p_ceiling_eur, 'monthly_max_eur', v_pol.monthly_max_eur);
end $$;

-- Settle with the APPLICATION's measured amount (basis says which); idempotent for the same amount and basis.
create function creative_spend_settle(p_merchant uuid, p_run_id text, p_settled_eur numeric, p_basis text, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_res public.creative_spend_reservations;
begin
  select * into v_res from public.creative_spend_reservations r where r.merchant_id = p_merchant and r.run_id = p_run_id for update;
  if not found then return jsonb_build_object('status', 'REFUSED', 'reason', 'NO_RESERVATION'); end if;
  if v_res.status = 'SETTLED' then
    if v_res.settled_eur = p_settled_eur and v_res.settlement_basis = p_basis then return jsonb_build_object('status', 'ALREADY_SETTLED'); end if;
    return jsonb_build_object('status', 'REFUSED', 'reason', 'ALREADY_SETTLED_WITH_OTHER_AMOUNT');
  end if;
  if v_res.status = 'RELEASED' then return jsonb_build_object('status', 'REFUSED', 'reason', 'RELEASED'); end if;
  if p_settled_eur is null or p_settled_eur < 0 then return jsonb_build_object('status', 'REFUSED', 'reason', 'AMOUNT_INVALID'); end if;
  update public.creative_spend_reservations set status = 'SETTLED', settled_eur = p_settled_eur, settlement_basis = p_basis, updated_at = p_now
   where merchant_id = p_merchant and run_id = p_run_id;
  return jsonb_build_object('status', 'SETTLED', 'settled_eur', p_settled_eur, 'over_ceiling', p_settled_eur > v_res.ceiling_eur);
end $$;

-- Release only a reservation under which NO media call was ever attempted; otherwise it must be settled.
create function creative_spend_release(p_merchant uuid, p_run_id text, p_reason text, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_res public.creative_spend_reservations;
begin
  select * into v_res from public.creative_spend_reservations r where r.merchant_id = p_merchant and r.run_id = p_run_id for update;
  if not found then return jsonb_build_object('status', 'REFUSED', 'reason', 'NO_RESERVATION'); end if;
  if v_res.status = 'RELEASED' then return jsonb_build_object('status', 'ALREADY_RELEASED'); end if;
  if v_res.status <> 'RESERVED' then return jsonb_build_object('status', 'REFUSED', 'reason', 'NOT_RELEASABLE_' || v_res.status); end if;
  if exists (select 1 from public.creative_media_transmissions t where t.merchant_id = p_merchant and t.run_id = p_run_id and t.event = 'ATTEMPTED') then
    return jsonb_build_object('status', 'REFUSED', 'reason', 'MEDIA_WAS_ATTEMPTED_SETTLE_INSTEAD');
  end if;
  update public.creative_spend_reservations set status = 'RELEASED', release_reason = p_reason, updated_at = p_now where merchant_id = p_merchant and run_id = p_run_id;
  return jsonb_build_object('status', 'RELEASED');
end $$;

-- Reconciliation of runs that never finished (crash, timeout): no attempt -> RELEASED (STALE_NO_ATTEMPT); an attempt -> RECONCILE_REQUIRED
-- (its ceiling keeps counting until an operator settles it from evidence). Never frees money that may have been spent.
create function creative_spend_reconcile_stale(p_merchant uuid, p_older_than timestamptz, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_released integer; v_flagged integer;
begin
  with stale as (
    select r.run_id, exists (select 1 from public.creative_media_transmissions t where t.merchant_id = r.merchant_id and t.run_id = r.run_id and t.event = 'ATTEMPTED') attempted
      from public.creative_spend_reservations r where r.merchant_id = p_merchant and r.status = 'RESERVED' and r.updated_at < p_older_than for update of r
  ), rel as (
    update public.creative_spend_reservations s set status = 'RELEASED', release_reason = 'STALE_NO_ATTEMPT', updated_at = p_now
      from stale where s.merchant_id = p_merchant and s.run_id = stale.run_id and not stale.attempted returning 1
  ), fl as (
    update public.creative_spend_reservations s set status = 'RECONCILE_REQUIRED', updated_at = p_now
      from stale where s.merchant_id = p_merchant and s.run_id = stale.run_id and stale.attempted returning 1
  )
  select (select count(*) from rel), (select count(*) from fl) into v_released, v_flagged;
  return jsonb_build_object('released', v_released, 'reconcile_required', v_flagged);
end $$;

-- ---------------------------------------------------------------- transmission events
-- Append one lifecycle event. ATTEMPTED needs a live reservation and the AUTHORIZED event of the same operation, source and policy version;
-- SENT / SUCCEEDED / FAILED need the ATTEMPTED event of the same attempt. A repeated event is a no-op (status DUPLICATE).
create function creative_media_transmission_record(p_merchant uuid, p_run_id text, p_operation text, p_attempt_ref text, p_event text, p_policy_id text,
  p_policy_version integer, p_authorization_id text, p_source_sha256 text, p_provider_id text, p_region text, p_request_id text, p_detail jsonb, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_status text; v_id bigint;
begin
  select r.status into v_status from public.creative_spend_reservations r where r.merchant_id = p_merchant and r.run_id = p_run_id;
  if v_status is null then return jsonb_build_object('status', 'REFUSED', 'reason', 'NO_RESERVATION'); end if;
  if p_event = 'ATTEMPTED' then
    if v_status <> 'RESERVED' then return jsonb_build_object('status', 'REFUSED', 'reason', 'RESERVATION_NOT_LIVE'); end if;
    if not exists (select 1 from public.creative_media_transmissions t where t.merchant_id = p_merchant and t.run_id = p_run_id and t.operation = p_operation
      and t.event = 'AUTHORIZED' and t.source_sha256 = p_source_sha256 and t.policy_id = p_policy_id and t.policy_version = p_policy_version) then
      return jsonb_build_object('status', 'REFUSED', 'reason', 'NOT_AUTHORIZED_FOR_THIS_SOURCE');
    end if;
  elsif p_event in ('SENT', 'SUCCEEDED', 'FAILED') then
    if not exists (select 1 from public.creative_media_transmissions t where t.merchant_id = p_merchant and t.run_id = p_run_id and t.operation = p_operation
      and t.attempt_ref = p_attempt_ref and t.event = 'ATTEMPTED') then
      return jsonb_build_object('status', 'REFUSED', 'reason', 'NO_ATTEMPT');
    end if;
  end if;
  insert into public.creative_media_transmissions (merchant_id, run_id, operation, attempt_ref, event, policy_id, policy_version, authorization_id, source_sha256,
    provider_id, region, provider_request_id, detail, at)
  values (p_merchant, p_run_id, p_operation, p_attempt_ref, p_event, p_policy_id, p_policy_version, p_authorization_id, p_source_sha256, p_provider_id, p_region,
    p_request_id, coalesce(p_detail, '{}'::jsonb), p_now)
  on conflict on constraint creative_media_transmissions_once_uq do nothing returning id into v_id;
  return jsonb_build_object('status', case when v_id is null then 'DUPLICATE' else 'RECORDED' end);
end $$;

-- ---------------------------------------------------------------- access: the application (service role) goes through the functions only
alter table creative_media_policies enable row level security;
alter table creative_spend_reservations enable row level security;
alter table creative_media_transmissions enable row level security;
revoke all on table creative_media_policies, creative_spend_reservations, creative_media_transmissions from anon, authenticated;
revoke all on table creative_media_policies, creative_spend_reservations, creative_media_transmissions from service_role; -- incl. TRIGGER / REFERENCES from default privileges
grant select on table creative_media_policies, creative_spend_reservations, creative_media_transmissions to service_role;
revoke execute on function creative_spend_lock(uuid, date), creative_policy_lock(uuid, text) from public, anon, authenticated, service_role;
-- trigger functions: only ever run as triggers; no role needs to call them (PostgreSQL grants execute to PUBLIC by default)
revoke execute on function creative_media_policies_guard(), creative_spend_reservations_guard(), creative_media_transmissions_append_only() from public, anon, authenticated, service_role;
revoke execute on function creative_media_policy_accept(uuid, uuid, text, jsonb, timestamptz), creative_media_policy_revoke(uuid, uuid, text, timestamptz),
  creative_media_policy_current(uuid, text), creative_spend_reserve(uuid, text, text, integer, numeric, timestamptz), creative_spend_settle(uuid, text, numeric, text, timestamptz),
  creative_spend_release(uuid, text, text, timestamptz), creative_spend_reconcile_stale(uuid, timestamptz, timestamptz),
  creative_media_transmission_record(uuid, text, text, text, text, text, integer, text, text, text, text, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function creative_media_policy_accept(uuid, uuid, text, jsonb, timestamptz), creative_media_policy_revoke(uuid, uuid, text, timestamptz),
  creative_media_policy_current(uuid, text), creative_spend_reserve(uuid, text, text, integer, numeric, timestamptz), creative_spend_settle(uuid, text, numeric, text, timestamptz),
  creative_spend_release(uuid, text, text, timestamptz), creative_spend_reconcile_stale(uuid, timestamptz, timestamptz),
  creative_media_transmission_record(uuid, text, text, text, text, text, integer, text, text, text, text, text, jsonb, timestamptz) to service_role;
