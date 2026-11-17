-- Paramètres -> Préférences: PERSONAL display preferences (interface language, regional format) and saved views, one set per (merchant, person).
-- ADDITIVE: two new tables, nothing existing is altered. A preference grants NO right: no role, permission or access rule reads these tables.
--   member_preferences  one row per (merchant, user): language ('fr'|'nl'|'en') and region ('fr-BE'|'nl-BE'|'en-GB'); NULL = "default" (the behaviour before this table existed).
--   member_saved_views  named views of a business screen (module + filters), at most one default per (merchant, user, module).
-- Service role only, like every other table: RLS with no policy + no table privilege for anon / authenticated. The server always filters on the SESSION's merchant AND user.
-- Rollback: supabase/rollback/20261118140000_member_preferences_down.sql

create table member_preferences (
  merchant_id uuid not null references merchants(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  language text check (language in ('fr', 'nl', 'en')),
  region text check (region in ('fr-BE', 'nl-BE', 'en-GB')),
  updated_at timestamptz not null default now(),
  primary key (merchant_id, user_id)
);

create table member_saved_views (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  module text not null check (module ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  filters jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  is_default boolean not null default false,
  is_favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index member_saved_views_owner_idx on member_saved_views (merchant_id, user_id, module);
create unique index member_saved_views_one_default on member_saved_views (merchant_id, user_id, module) where is_default;

alter table member_preferences enable row level security;
alter table member_saved_views enable row level security;
revoke all on table member_preferences from anon, authenticated;
revoke all on table member_saved_views from anon, authenticated;
