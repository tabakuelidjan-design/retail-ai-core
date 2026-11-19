-- Phase 3 PILOT - Analytics read path, LOCAL DISPOSABLE DATABASE ONLY. Not applied to staging or production.
-- Scope (from the code inventory): merchants (tenant resolution), merchant_connectors (sales-source check), sync_runs (sync status).
-- NOT in this pilot: the report refresh child process (reads 11 tables and writes data_quality_flags) - a later step.
--
-- The application connects with the LOGIN role analytics_reader: not a superuser, no BYPASSRLS, not the owner of any table,
-- and only SELECT on the three tables above. Its password is set at run time by db/pilot/run-local.sh, never stored here.

drop schema if exists analytics_pilot cascade;
create schema analytics_pilot;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'nordla_pilot_owner') then create role nordla_pilot_owner nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'analytics_reader') then
    create role analytics_reader login nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
  end if;
end $$;

create table analytics_pilot.merchants (
  id uuid primary key,
  name text not null,
  vertical text not null default 'general_retail'
);
-- Columns mirror supabase/migrations (20260927100000_merchant_connectors.sql, 20260926100000_sync_runs.sql), not a subset.
create table analytics_pilot.merchant_connectors (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references analytics_pilot.merchants(id) on delete restrict,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  external_id text check (external_id is null or btrim(external_id) <> ''),
  external_domain text,
  status text not null default 'NOT_CONFIGURED' check (status in ('CONFIGURED', 'NOT_CONFIGURED', 'MISCONFIGURED')),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_connectors_kind_external_uq unique (kind, external_id)
);
create table analytics_pilot.sync_runs (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references analytics_pilot.merchants(id),
  mode text not null,
  status text not null check (status in ('RUNNING', 'SUCCESS', 'FAILED')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb,
  error text
);

alter table analytics_pilot.merchants owner to nordla_pilot_owner;
alter table analytics_pilot.merchant_connectors owner to nordla_pilot_owner;
alter table analytics_pilot.sync_runs owner to nordla_pilot_owner;
alter schema analytics_pilot owner to nordla_pilot_owner;

-- The reader gets SELECT only, on these three tables, and nothing else in the schema.
grant usage on schema analytics_pilot to analytics_reader;
grant select on analytics_pilot.merchants, analytics_pilot.merchant_connectors, analytics_pilot.sync_runs to analytics_reader;
revoke all on analytics_pilot.merchants from public;
revoke all on analytics_pilot.merchant_connectors from public;
revoke all on analytics_pilot.sync_runs from public;

alter table analytics_pilot.merchants enable row level security;
alter table analytics_pilot.merchants force row level security;
alter table analytics_pilot.merchant_connectors enable row level security;
alter table analytics_pilot.merchant_connectors force row level security;
alter table analytics_pilot.sync_runs enable row level security;
alter table analytics_pilot.sync_runs force row level security;

-- The merchant in context, set per transaction by the application (set_config(..., true)). Unset or empty = no merchant.
create or replace function analytics_pilot.current_merchant() returns uuid
  language sql stable as $$ select nullif(current_setting('app.merchant_id', true), '')::uuid $$;

-- For reads only: the reader cannot write, so no insert/update/delete policies are needed (and none are granted).
create policy tenant_read on analytics_pilot.merchants for select to analytics_reader
  using (id = analytics_pilot.current_merchant());
create policy tenant_read on analytics_pilot.merchant_connectors for select to analytics_reader
  using (merchant_id = analytics_pilot.current_merchant());
create policy tenant_read on analytics_pilot.sync_runs for select to analytics_reader
  using (merchant_id = analytics_pilot.current_merchant());

-- Test data (fictitious merchants), loaded as the owner.
insert into analytics_pilot.merchants (id, name) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'Pilote A (fictif)'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'Pilote B (fictif)');
insert into analytics_pilot.merchant_connectors (merchant_id, kind, status) values
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'shopify', 'CONFIGURED');
insert into analytics_pilot.sync_runs (merchant_id, mode, status) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'orders', 'SUCCESS'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'orders', 'FAILED');
