-- BEFORE the pilot migration: the role analytics_reader and its SELECT grants exist, but there is NO permissive policy yet.
-- With RLS enabled and no permissive policy, the reader sees no rows at all. This file is run as the owner (postgres).
create role analytics_reader nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
grant usage on schema public to analytics_reader;
grant select on public.merchants, public.merchant_connectors, public.sync_runs to analytics_reader;
