-- NORDLA GROWTH - PREPARED, NOT APPLIED (supabase/migrations-pending/). Proposal for the Infrastructure session (owner of supabase/**).
--
-- Server-side follow-up of Growth (Développement des ventes), per merchant: the plans, applied actions and review results of Opportunités, and the requests /
-- quotes / sales of "Suite commerciale". One row per entry of the screen (entry_key = the key the screen used in the browser), so the screen's logic is unchanged.
-- Read and written ONLY by the hosted Growth server (service role), which takes the merchant from the Core session, never from a request: no policy, no direct access.
-- Each entry carries a version: a write names the version it read, and a different current version is refused (two browsers never overwrite each other silently).
-- Applied NOWHERE: local file only. Reversible: drop table public.growth_follow_up (the browsers' own copies are never deleted by Growth).

create table if not exists public.growth_follow_up (
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  entry_key text not null check (length(entry_key) between 1 and 400 and entry_key like 'nordla.growth.%'),
  value jsonb not null check (jsonb_typeof(value) = 'object' and pg_column_size(value) <= 262144),
  version integer not null default 1 check (version >= 1),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (merchant_id, entry_key)
);

alter table public.growth_follow_up enable row level security;  -- no policy: service role only
revoke all on public.growth_follow_up from anon, authenticated;
