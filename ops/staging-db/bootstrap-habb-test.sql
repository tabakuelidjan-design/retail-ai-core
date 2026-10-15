-- Supabase STAGING ONLY (fvhiammdskpcnfodsnrc): the HABB TEST merchant, its OWNER, the `sourcing` module and the private backup bucket.
-- Prerequisites: identity migrations 1-5 applied; the owner created HIS OWN account in Supabase Auth (dashboard) - nothing here creates
-- or guesses an account. One transaction, stops at the first error (nothing half-done). Re-running it changes nothing.
--   psql "$STAGING_DATABASE_URL" -X -v ON_ERROR_STOP=1 [-v owner_email='<the e-mail the owner used>'] -f ops/staging-db/bootstrap-habb-test.sql
-- The test merchant has its OWN id (never the production HABB id), so a staging server can never match real HABB rows by mistake.
\set merchant_id '67646dbb-5e2e-4cd7-aad6-0ab289b068cb'
begin;

-- 0. guards: staging marker present, owner account present and confirmed (created by the owner himself)
do $$ begin
  if not exists (select 1 from public.merchants where id = '4159734e-27be-4772-bb7c-6c5f24fbafcc') then raise exception 'STOP: not the staging database (marker merchant missing)'; end if;
  if to_regclass('public.merchant_members') is null or to_regclass('public.module_entitlements') is null then raise exception 'STOP: identity migrations 2-5 are not applied'; end if;
end $$;
-- Without -v owner_email: the owner is the ONLY confirmed account of this staging Auth (0 or several = STOP, nothing guessed).
\if :{?owner_email}
\else
  select count(*) = 1 as single_owner from auth.users where email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until < now()) \gset
  \if :single_owner
    select email as owner_email from auth.users where email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until < now()) \gset
  \else
    do $$ begin raise exception 'STOP: no e-mail given and staging Auth does not hold exactly one confirmed account'; end $$;
  \endif
\endif
select count(*) = 1 as owner_found from auth.users where lower(email) = lower(:'owner_email') and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until < now()) \gset
\if :owner_found
\else
  do $$ begin raise exception 'STOP: no confirmed Supabase Auth account with that e-mail (the owner creates it himself in the dashboard)'; end $$;
\endif

-- 1. the HABB test merchant (data configuration only: no production row is copied)
insert into public.merchants (id, name, vertical, source_system, source_id, source_domain)
values (:'merchant_id', 'HABB (test staging)', 'general_retail', 'nordla-staging', 'habb-test', null)
on conflict (id) do nothing;

-- 2. the owner: the identity function itself records the event; refused (and audited) if the merchant already has members
select public.identity_member_bootstrap_owner(:'merchant_id', (select id from auth.users where lower(email) = lower(:'owner_email') and email_confirmed_at is not null and deleted_at is null), now(), gen_random_uuid(), 'sourcing') as owner_bootstrap
where not exists (select 1 from public.merchant_members where merchant_id = :'merchant_id');

-- 3. module sourcing ACTIVE (NO_CHANGE when already active)
select public.identity_module_set(:'merchant_id', 'sourcing', 'ACTIVE', 'provisioning:manual', now(), gen_random_uuid()) as module_sourcing;

-- 4. private backup bucket: no policy at all = no access for anon / authenticated; only the server's service role writes
insert into storage.buckets (id, name, public) values ('nordla-backups', 'nordla-backups', false) on conflict (id) do nothing;

-- 5. checks (any false = rollback)
do $$ declare m uuid := '67646dbb-5e2e-4cd7-aad6-0ab289b068cb'; begin
  if (select count(*) from public.merchant_members where merchant_id = m and role = 'OWNER' and status = 'ACTIVE') <> 1 then raise exception 'STOP: exactly one ACTIVE OWNER expected'; end if;
  if not exists (select 1 from public.module_entitlements where merchant_id = m and module_code = 'sourcing' and status = 'ACTIVE') then raise exception 'STOP: module sourcing not ACTIVE'; end if;
  if (select public from storage.buckets where id = 'nordla-backups') is distinct from false then raise exception 'STOP: bucket nordla-backups missing or public'; end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and (qual like '%nordla-backups%' or with_check like '%nordla-backups%')) then raise exception 'STOP: a storage policy opens nordla-backups'; end if;
end $$;
commit;
select m.id as merchant, m.name, (select count(*) from public.merchant_members where merchant_id = m.id) as members,
       (select string_agg(module_code || ':' || status, ',') from public.module_entitlements where merchant_id = m.id) as modules
from public.merchants m where m.id = :'merchant_id';
