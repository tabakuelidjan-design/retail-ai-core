-- Analytics pilot: a read-only, merchant-scoped role for the three tables the Analytics read path needs.
-- NOT APPLIED anywhere by this file. Apply only after review, on staging first, then production (see the rollback file).
--
-- Scope: merchants, merchant_connectors, sync_runs - SELECT only, filtered by the merchant set per transaction with
--   select set_config('app.merchant_id', '<uuid>', true)
-- Nothing else is granted: no INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER, no other table, no function to
-- anon, authenticated or PUBLIC. The login (password) is NOT created here: create a LOGIN role out of band, member of this role.
--
-- Existing rules are unchanged: RLS stays enabled, the restrictive policies of 20261119150000 (anon deny, authenticated tenant
-- guard) apply only to anon/authenticated and so do not restrict this role; service_role keeps its bypass.
-- A missing or invalid merchant context raises an error (it never returns rows silently).
begin;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'analytics_reader') then
    create role analytics_reader nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
  end if;
end $$;

create schema if not exists analytics_access;
revoke all on schema analytics_access from public;
grant usage on schema analytics_access to analytics_reader;

-- The merchant in context. Raises when it is unset or not a UUID: a query without a merchant fails, it does not return an empty list.
create or replace function analytics_access.current_merchant_strict() returns uuid
  language plpgsql stable set search_path = '' as $$
declare
  v text := nullif(current_setting('app.merchant_id', true), '');
begin
  if v is null then raise exception 'MERCHANT_CONTEXT_REQUIRED'; end if;
  if v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'MERCHANT_CONTEXT_INVALID'; end if;
  return v::uuid;
end $$;
revoke all on function analytics_access.current_merchant_strict() from public, anon, authenticated;
grant execute on function analytics_access.current_merchant_strict() to analytics_reader;

-- Permissive policies apply to analytics_reader only (TO clause). They are additive to the existing restrictive ones.
create policy analytics_reader_read on public.merchants as permissive for select to analytics_reader
  using (id = analytics_access.current_merchant_strict());
create policy analytics_reader_read on public.merchant_connectors as permissive for select to analytics_reader
  using (merchant_id = analytics_access.current_merchant_strict());
create policy analytics_reader_read on public.sync_runs as permissive for select to analytics_reader
  using (merchant_id = analytics_access.current_merchant_strict());

grant select on public.merchants, public.merchant_connectors, public.sync_runs to analytics_reader;
-- Explicit refusals (no-ops today, kept so that a future grant cannot slip in unnoticed).
revoke insert, update, delete, truncate, references, trigger on public.merchants, public.merchant_connectors, public.sync_runs from analytics_reader;

commit;
