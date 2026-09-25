-- One row per Shopify -> Supabase synchronisation attempt, so every module can say factually when the data was last refreshed,
-- whether the last attempt worked, and how much it touched. Report generation is NOT a sync and never writes here.
create table if not exists sync_runs (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  mode text not null,
  status text not null check (status in ('RUNNING', 'SUCCESS', 'FAILED')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb,
  error text
);
create index if not exists sync_runs_merchant_started_idx on sync_runs (merchant_id, started_at desc);
alter table sync_runs enable row level security; -- no policies: only the service role reads/writes, like every other table
