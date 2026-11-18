-- NORDLA GROWTH - the shop's personalizer TECHNICAL events (Où les visiteurs abandonnent). STAGING first; production only on the owner's explicit approval.
--
-- One row per (attempt, step, n). NOTHING that identifies a person or their content is stored: no photo, no URL, no file name, no text typed by the visitor, no contact detail,
-- no IP address, no user agent, no visitor/cookie id. attempt_id is a random token made by the visitor's browser for ONE visit of a product page (see dropoff/personalizer.js):
-- it only links the steps of the same attempt and makes a re-sent event idempotent (primary key). Written by the hosted Growth server (service role) after the visitor's analytics
-- consent; read ONLY by it, for the server's merchant. Retention: the screen reads 90 days; rows older than that are removed by the purge statement at the bottom (to schedule).
-- Reversible: supabase/rollback/20261118200000_growth_personalizer_events.down.sql (drops the table: events are aggregates of technical steps, nothing else depends on them).

create table if not exists public.growth_personalizer_events (
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  attempt_id text not null check (attempt_id ~ '^[a-f0-9]{16,32}$'),
  step text not null check (step in ('submit_blocked_no_photo','photo_chosen','send_clicked','design_ready','cart_submit','export_failed','cart_confirmed','cart_not_found')),
  status text not null check (status in ('ok','load_error','no_photo','export_error','not_found')),
  device text not null check (device in ('mobile','desktop')),
  product text check (product is null or product ~ '^[a-z0-9][a-z0-9-]{0,119}$'),
  n smallint not null check (n between 1 and 20),
  received_at timestamptz not null default now(),
  primary key (merchant_id, attempt_id, step, n)
);

create index if not exists growth_personalizer_events_received_idx on public.growth_personalizer_events (merchant_id, received_at desc);

alter table public.growth_personalizer_events enable row level security;  -- no policy: service role only
revoke all on public.growth_personalizer_events from anon, authenticated;

-- Purge (to run on a schedule; not run by the app): delete from public.growth_personalizer_events where received_at < now() - interval '90 days';
