-- NORDLA GROWTH - "Où les visiteurs abandonnent": the merchant's last funnel snapshot (aggregates only: counts per step, device and product; no visitor, no session id,
-- no photo, no file name). Read ONLY by the hosted Growth server (service role), merchant taken from the server context, never from a request: no policy, no direct access.
-- Reversible: drop table public.growth_funnel_snapshot.
create table if not exists public.growth_funnel_snapshot (
  merchant_id uuid primary key references public.merchants (id) on delete cascade,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 524288),
  updated_at timestamptz not null default now()
);
alter table public.growth_funnel_snapshot enable row level security;  -- no policy: service role only
revoke all on public.growth_funnel_snapshot from anon, authenticated;
