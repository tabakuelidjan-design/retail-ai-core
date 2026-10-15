-- PROVISIONING (not a migration) for the Supabase STAGING project only (fvhiammdskpcnfodsnrc) - run ONCE, after the owner's explicit go,
-- and only after the identity sequence (docs/infrastructure/sourcing-railway-go-live.md §1) is applied THERE.
-- Why: the Railway service `sourcing-staging` signs people in against staging, never production. Its journal, cases and photos are tied
-- to NORDLA_MERCHANT_ID; giving the staging merchant row the SAME id as production HABB means the volume can later be served against
-- production identity without any data change (the Core journal refuses a different merchant id by design).
-- Production is not read or written by this file. Rollback: delete from merchants where id = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5'
-- (only before any identity row references it; afterwards suspend the module instead - see habb-owner-sourcing.sql).
-- The legacy external-identity columns are still NOT NULL on staging (M2 not applied): they get an explicit non-Shopify marker.
insert into public.merchants (id, name, source_system, source_id)
values ('36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5', 'HABB (staging identity for Sourcing)', 'nordla-staging', 'habb-sourcing-staging')
on conflict (id) do nothing;
-- Then: the owner creates their account in the STAGING Auth (Authentication > Users > Add user), and supabase/provisioning/habb-owner-sourcing.sql
-- is run on staging with that account id.
