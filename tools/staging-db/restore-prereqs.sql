-- What a plain PostgreSQL needs before a Supabase public schema can be restored into it: the Supabase roles (grants refer to them),
-- the extensions schema, and the auth objects the public schema references (auth.users ids, auth.uid()). Nothing here is staging data.
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'authenticator', 'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin', 'dashboard_user', 'pgbouncer', 'supabase_replication_admin', 'supabase_read_only_user', 'supabase_realtime_admin', 'supabase_etl_admin', 'supabase_privileged_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
  end loop;
end $$;
alter role service_role bypassrls;
create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;
create extension if not exists "uuid-ossp" schema extensions;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, aud text, role text, email text);
create or replace function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
create or replace function auth.role() returns text language sql stable as $f$ select nullif(current_setting('request.jwt.claim.role', true), '') $f$;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
