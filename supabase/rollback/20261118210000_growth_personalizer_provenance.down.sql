-- Rollback of 20261118210000_growth_personalizer_provenance.sql: removes the provenance column (the screen then cannot separate tests from customers: do not roll back after go-live).
drop index if exists public.growth_personalizer_events_prov_idx;
alter table public.growth_personalizer_events drop column if exists provenance;
