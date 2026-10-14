-- Analyses Phase 0 - truth foundation. ADDITIVE ONLY: nothing dropped, no row rewritten, no existing column changed.
-- Apply BEFORE deploying the code that reads/writes the new order columns (the loader selects them, the sync writes them).
-- No production migration is run by this repository.
--
--   1. orders: cancellation as the source reports it (cancelled_at, closed_at, cancel_reason) and lines_truncated (a nested Shopify page could not be completed).
--   2. indexes for the refund boundary and for period reads: orders (merchant_id, ordered_at), refunds (refunded_at) per merchant through its orders.
--   3. merchant_profile: the minimum shared Business Profile (timezone, currency, country, exclusion list, channel handles/aliases). The timezone is
--      mandatory and validated: Analytics fails closed without it instead of silently using UTC.

alter table orders add column cancelled_at timestamptz;
alter table orders add column closed_at timestamptz;
alter table orders add column cancel_reason text;
alter table orders add column lines_truncated boolean not null default false;

create index orders_merchant_ordered_at_idx on orders (merchant_id, ordered_at);

-- refunds carries merchant_id (migration 20260922230000); the refund boundary reads by refunded_at inside one merchant.
create index refunds_merchant_refunded_at_idx on refunds (merchant_id, refunded_at);

create table merchant_profile (
  -- RESTRICT: a tenant that still has a profile cannot be deleted implicitly.
  merchant_id uuid primary key references merchants(id) on delete restrict,
  -- an IANA zone name from pg_timezone_names (not an abbreviation such as EST, not a POSIX string): validated by the guard below.
  timezone text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  -- NULL = use the code defaults. When given: a JSON array of upper-case order statuses that are not sales.
  excluded_order_statuses jsonb check (excluded_order_statuses is null or (jsonb_typeof(excluded_order_statuses) = 'array')),
  online_channel_handles jsonb check (online_channel_handles is null or (jsonb_typeof(online_channel_handles) = 'array')),
  pos_channel_handles jsonb check (pos_channel_handles is null or (jsonb_typeof(pos_channel_handles) = 'array')),
  -- source handle -> canonical handle (for example point_of_sale -> pos); an object, never free text.
  channel_aliases jsonb not null default '{}'::jsonb check (jsonb_typeof(channel_aliases) = 'object'),
  fiscal_year_start_month smallint not null default 1 check (fiscal_year_start_month between 1 and 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function merchant_profile_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'merchant_profile: % is not an IANA time zone name', new.timezone using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' then
    if new.merchant_id is distinct from old.merchant_id then
      raise exception 'merchant_profile: merchant_id is immutable' using errcode = 'integrity_constraint_violation';
    end if;
    new.created_at = old.created_at;
    new.updated_at = now();
  end if;
  return new;
end $$;
create trigger merchant_profile_guard_trg before insert or update on merchant_profile for each row execute function merchant_profile_guard();

comment on table merchant_profile is
  'Minimum shared Business Profile of a tenant (timezone, currency, country, exclusion list, channel handles). Owned by Core. Not the Finance seller legal profile, not AI memory. No secret.';

alter table merchant_profile enable row level security;  -- no policy: service role only, like every other table
