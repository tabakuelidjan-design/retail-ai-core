-- Paramètres -> Notifications (staging module NORDLA_NOTIFICATIONS_MODULE). Additive, reversible (see supabase/rollback/20261118150000_notifications_down.sql).
-- Two new tables, no existing table is touched. The browser has no path (RLS on, no policy): only the server (service role) reads and writes.
--   notifications            one row per (merchant, recipient, event). The unique key makes a replayed event a no-op, so a re-run never adds a second alert.
--   notification_preferences the personal choice of one member for one alert type in one merchant (absent row = the default, which is ON for "in Nordla").
-- A notification carries NO free text and NO link: the wording and the target page come from the code's registry by `type`, and `data` holds only small
-- non-secret references (provider id). The server re-checks the recipient's current membership and role before showing a row.

create table notifications (
  id uuid primary key,
  merchant_id uuid not null references merchants(id) on delete restrict,
  recipient_user_id uuid not null,
  type text not null check (type ~ '^[a-z][a-z0-9_]{2,60}$'),
  dedupe_key text not null check (length(dedupe_key) between 3 and 200),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and length(data::text) <= 1000),
  created_at timestamptz not null,
  read_at timestamptz,
  constraint notifications_recipient_fk foreign key (merchant_id, recipient_user_id) references merchant_members (merchant_id, user_id) on delete restrict
);
create unique index notifications_dedupe_uq on notifications (merchant_id, recipient_user_id, dedupe_key);
create index notifications_inbox_idx on notifications (merchant_id, recipient_user_id, created_at desc);
alter table notifications enable row level security;

create table notification_preferences (
  merchant_id uuid not null references merchants(id) on delete restrict,
  user_id uuid not null,
  type text not null check (type ~ '^[a-z][a-z0-9_]{2,60}$'),
  in_app boolean not null,
  updated_at timestamptz not null,
  primary key (merchant_id, user_id, type),
  constraint notification_preferences_member_fk foreign key (merchant_id, user_id) references merchant_members (merchant_id, user_id) on delete restrict
);
alter table notification_preferences enable row level security;

revoke all on notifications, notification_preferences from anon, authenticated;
