-- Activation & Channel Execution V1: channel_execution_jobs - the durable outbox of external channel actions.
-- Additive only: one table, two functions, two triggers. Touches no existing table. No secret column: a job holds refs and codes,
-- never a token, a signed URL, a raw provider payload or a caption. Secrets stay in a credential store (open dependency).

create table channel_execution_jobs (
  id uuid primary key default gen_random_uuid(),
  -- RESTRICT: a merchant / connector that still has jobs cannot be deleted (history of what was published is kept).
  merchant_id uuid not null references merchants(id) on delete restrict,
  connector_id uuid not null references merchant_connectors(id) on delete restrict,
  brand_id uuid,
  activation_manifest_ref text not null check (btrim(activation_manifest_ref) <> ''),
  manifest_delivery_ref text not null check (btrim(manifest_delivery_ref) <> ''),
  provider text not null check (provider in ('instagram', 'tiktok', 'google_business_profile')),
  -- deterministic keys: the same intent can only ever exist once
  idempotency_key text not null check (btrim(idempotency_key) <> ''),
  request_fingerprint text not null check (btrim(request_fingerprint) <> ''),
  state text not null default 'PLANNED' check (state in ('PLANNED', 'READY', 'SUBMITTING', 'PROCESSING', 'PUBLISHED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED', 'SUBMISSION_UNKNOWN')),
  publish_mode text not null check (publish_mode in ('PUBLISH_NOW', 'SCHEDULE_INTERNAL', 'INTERACTIVE_CONFIRMATION')),
  publish_at timestamptz,
  deadline_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  -- the provider's SUBMISSION id (e.g. a TikTok publish_id, an Instagram container id): never a post id
  provider_submission_id text,
  -- only post ids the provider REALLY returned; may be empty (a private TikTok post is PUBLISH_COMPLETE without a public post id)
  provider_post_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(provider_post_ids) = 'array'),
  -- evidence reference of an explicit reconciliation of a SUBMISSION_UNKNOWN job (a human / the provider's own record)
  reconciliation_ref text check (reconciliation_ref is null or reconciliation_ref ~ '^[A-Za-z0-9][A-Za-z0-9:_./#-]*$'),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  status_poll_count integer not null default 0 check (status_poll_count >= 0),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  last_error_class text check (last_error_class is null or last_error_class ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata) = 'object'),
  -- one external action per (merchant, manifest, delivery, connector): a race between two enqueues loses on this constraint
  constraint channel_execution_jobs_intent_uq unique (merchant_id, activation_manifest_ref, manifest_delivery_ref, connector_id),
  constraint channel_execution_jobs_idempotency_uq unique (merchant_id, idempotency_key),
  -- PUBLISHED only with proof: a publication time and the provider's submission id or at least one real post id
  constraint channel_execution_jobs_published_proof check (
    state <> 'PUBLISHED' or (published_at is not null and (provider_submission_id is not null or jsonb_array_length(provider_post_ids) > 0))
  )
);

-- "what is due for this tenant" lookups
create index channel_execution_jobs_due_idx on channel_execution_jobs (merchant_id, state, next_attempt_at);

-- The connector must belong to the job's merchant (no cross-merchant execution), checked on insert.
create function channel_execution_jobs_insert_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.merchant_connectors c where c.id = new.connector_id and c.merchant_id = new.merchant_id) then
    raise exception 'channel_execution_jobs: the connector does not belong to the merchant' using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $$;
create trigger channel_execution_jobs_insert_guard_trg before insert on channel_execution_jobs for each row execute function channel_execution_jobs_insert_guard();

-- Identity never changes; PUBLISHED, FAILED_FINAL and CANCELLED are terminal (no re-publication, no resurrection); SUBMISSION_UNKNOWN is
-- left only by an explicit reconciliation; updated_at follows.
create function channel_execution_jobs_update_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.merchant_id is distinct from old.merchant_id or new.connector_id is distinct from old.connector_id
     or new.activation_manifest_ref is distinct from old.activation_manifest_ref or new.manifest_delivery_ref is distinct from old.manifest_delivery_ref
     or new.provider is distinct from old.provider or new.idempotency_key is distinct from old.idempotency_key
     or new.request_fingerprint is distinct from old.request_fingerprint then
    raise exception 'channel_execution_jobs: the identity of a job is immutable' using errcode = 'integrity_constraint_violation';
  end if;
  if old.state in ('PUBLISHED', 'FAILED_FINAL', 'CANCELLED') then
    raise exception 'channel_execution_jobs: a terminal job cannot change' using errcode = 'integrity_constraint_violation';
  end if;
  -- SUBMISSION_UNKNOWN (the outcome of a call that may have reached the provider is unknown) halts the automatic worker: only an explicit
  -- reconciliation, with its evidence reference, can move it to PUBLISHED or FAILED_FINAL
  if old.state = 'SUBMISSION_UNKNOWN' and new.state <> 'SUBMISSION_UNKNOWN' then
    if new.state not in ('PUBLISHED', 'FAILED_FINAL') or new.reconciliation_ref is null then
      raise exception 'channel_execution_jobs: a SUBMISSION_UNKNOWN job needs an explicit reconciliation' using errcode = 'integrity_constraint_violation';
    end if;
  end if;
  if new.state = 'PUBLISHED' and old.state not in ('SUBMITTING', 'PROCESSING', 'SUBMISSION_UNKNOWN') then
    raise exception 'channel_execution_jobs: a job is published only after a submission' using errcode = 'integrity_constraint_violation';
  end if;
  new.updated_at = now();
  return new;
end $$;
create trigger channel_execution_jobs_update_guard_trg before update on channel_execution_jobs for each row execute function channel_execution_jobs_update_guard();

comment on table channel_execution_jobs is
  'Durable outbox of channel actions (Instagram / TikTok / Google Business Profile). Refs and codes only: no token, no signed URL, no raw provider payload.';

alter table channel_execution_jobs enable row level security;  -- no policy: service role only, like every other table
