-- Paramètres -> Général: the merchant's commercial profile, written ONLY by the Général service and read by the modules.
-- ADDITIVE: two new tables, nothing existing is altered, no row of any other table is touched.
--   merchant_general_sections  one row per merchant and section (profile, activity, selling_modes, legal), optimistic version.
--   merchant_establishments    one row per establishment (stable Nordla id; the link to a supplier location goes through Connexions later).
-- Name stays in merchants.name and time zone / currency / country stay in merchant_profile (their readers are unchanged): the service writes them there.
-- Rollback: drop table merchant_establishments; drop table merchant_general_sections;   (no other object depends on them)
-- Service role only, like every other table: RLS with no policy + no table privilege for anon / authenticated.

create table merchant_general_sections (
  merchant_id uuid not null references merchants(id),
  section text not null check (section in ('profile', 'activity', 'selling_modes', 'legal')),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (merchant_id, section)
);

create table merchant_establishments (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  is_primary boolean not null default false,
  archived_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);
create index merchant_establishments_merchant_idx on merchant_establishments (merchant_id);
-- at most ONE primary establishment per merchant among the active ones
create unique index merchant_establishments_one_primary on merchant_establishments (merchant_id) where is_primary and archived_at is null;

alter table merchant_general_sections enable row level security;
alter table merchant_establishments enable row level security;
revoke all on table merchant_general_sections from anon, authenticated;
revoke all on table merchant_establishments from anon, authenticated;
