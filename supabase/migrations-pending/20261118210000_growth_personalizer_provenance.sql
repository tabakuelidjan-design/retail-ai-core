-- NORDLA GROWTH - provenance of every personalizer event (test | live | unknown). STAGING first; production only on the owner's explicit approval.
--
-- The provenance is assigned by the hosted Growth SERVER from its own collection-channel configuration (server/collect-personalizer.js: collectChannels / channelProvenance),
-- never from a value the browser claims. Existing rows get 'unknown': a row's provenance is never guessed. A row that is KNOWN to be a test is reclassified by an explicit,
-- reviewed statement naming it (see the staging runbook in docs/growth/DROPOFF_EVENTS.md), never by this migration.
-- The customer figures count provenance = 'live' only; tests and unknown are counted apart.
-- Reversible: supabase/rollback/20261118210000_growth_personalizer_provenance.down.sql.

alter table public.growth_personalizer_events
  add column if not exists provenance text not null default 'unknown' check (provenance in ('test', 'live', 'unknown'));

create index if not exists growth_personalizer_events_prov_idx on public.growth_personalizer_events (merchant_id, provenance, received_at desc);
