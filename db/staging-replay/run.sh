#!/usr/bin/env bash
# Disposable PostgreSQL 17 replay of the repo migrations (+ the security tenant guard 20261119150000 from commit 029d204a), with
# Supabase-like roles and default grants. Phases: BEFORE the pilot migration -> APPLY it -> AFTER -> ROLLBACK -> check.
# The login role analytics_login is a real LOGIN role (not superuser, no BYPASSRLS), member of analytics_reader, and the tests run as it.
# Container and work folder are deleted at the end. Never staging, never production. Passwords: random per run, never written to disk.
# Usage: SEC_MIG=<path to 20261119150000_security_client_tenant_guards.sql> bash db/staging-replay/run.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NAME="nordla-replay-$$"
PILOT="20261119160000_analytics_reader_pilot_read.sql"
DOWN="20261119160000_analytics_reader_pilot_read.down.sql"
OWNER_PW="$(openssl rand -hex 16)"
LOGIN_PW="$(openssl rand -hex 16)"
SEC_MIG="${SEC_MIG:?set SEC_MIG to the path of 20261119150000_security_client_tenant_guards.sql}"
WORK="$HERE/.work-$$"
mkdir -p "$WORK"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

# every docker cp uses RELATIVE names from inside $WORK (MSYS paths are not understood by docker on Windows)
cp "$REPO"/supabase/migrations/*.sql "$WORK"/
cp "$SEC_MIG" "$WORK/20261119150000_security_client_tenant_guards.sql"
cp "$REPO/db/pending-migrations/rollback/$DOWN" "$WORK/$DOWN"
cp "$REPO/db/pending-migrations/$PILOT" "$WORK/$PILOT"
cp "$HERE"/prep.sql "$HERE"/tests_before.sql "$HERE"/tests.sql "$HERE"/tests_rollback.sql "$WORK"/
cd "$WORK"

docker run -d --rm --name "$NAME" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$OWNER_PW" postgres:17-alpine >/dev/null
for _ in $(seq 1 40); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done
psql_in() { docker exec -i "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_file() { docker cp "$1" "$NAME":/tmp/f.sql && docker exec "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -f /tmp/f.sql; }
as_login() { docker cp "$1" "$NAME":/tmp/t.sql && docker exec -e PGPASSWORD="$LOGIN_PW" "$NAME" psql -h 127.0.0.1 -U analytics_login -d postgres -X -q -f /tmp/t.sql; }

# 1. Supabase-like roles, storage/auth stubs, default grants of a Supabase public schema
psql_in <<'SQL'
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text unique not null, owner uuid, created_at timestamptz default now(), updated_at timestamptz default now(), public boolean default false, avif_autodetection boolean default false, file_size_limit bigint, allowed_mime_types text[], owner_id text, type text not null default 'STANDARD');
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, created_at timestamptz default now(), updated_at timestamptz default now(), last_accessed_at timestamptz default now(), metadata jsonb, path_tokens text[], version text, owner_id text);
alter table storage.objects enable row level security;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb, raw_app_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now(), updated_at timestamptz default now(), phone text, banned_until timestamptz, deleted_at timestamptz);
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id), status text, factor_type text, friendly_name text, secret text, created_at timestamptz default now(), updated_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
SQL

# 2. replay the repo migrations in name order (pilot excluded), then the security migration, each inside one transaction
n=0
for f in $(ls ./*.sql | sort); do
  base="$(basename "$f")"
  case "$base" in "$PILOT"|"$DOWN"|tests*.sql|prep.sql) continue ;; esac
  { printf 'begin;\n'; cat "$base"; printf '\ncommit;\n'; } > wrapped.sql
  if ! out="$(docker cp wrapped.sql "$NAME":/tmp/mig.sql && docker exec "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -f /tmp/mig.sql 2>&1)"; then
    echo "REPLAY FAILED: $base"; echo "$out" | tail -5; exit 2
  fi
  n=$((n+1))
done
echo "replay: ok, $n migration files applied in order (pilot excluded)"

# 3. fictitious data as the owner (rows exist in the table, whatever the reader sees)
psql_in <<'SQL'
insert into public.merchants (id, name, vertical) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'Replay A (fictif)', 'general_retail'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'Replay B (fictif)', 'general_retail');
insert into public.merchant_connectors (merchant_id, kind, status) values ('bbbbbbbb-0000-4000-8000-00000000000b', 'shopify', 'CONFIGURED');
insert into public.sync_runs (merchant_id, mode, status) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'orders', 'SUCCESS'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'orders', 'FAILED');
SQL
echo "owner view (rows that exist): merchants=$(docker exec "$NAME" psql -U postgres -tA -c 'select count(*) from public.merchants') sync_runs=$(docker exec "$NAME" psql -U postgres -tA -c 'select count(*) from public.sync_runs')"

# 4. PREPARE the reader role, its SELECT grants and the LOGIN role (no policy yet), then the BEFORE tests
psql_file prep.sql
printf "create role analytics_login login nosuperuser nobypassrls inherit password :'pw' in role analytics_reader;\n" \
  | psql_in -v pw="$LOGIN_PW" -f - >/dev/null
echo "=== BEFORE the pilot migration (no permissive policy) ==="
as_login tests_before.sql

# 5. APPLY the pilot migration (owner)
psql_file "$PILOT"
echo "=== pilot migration applied ==="

# 6. AFTER: the same reader, valid context, isolation, refusals, transaction behaviour
echo "=== AFTER the pilot migration ==="
as_login tests.sql

# 7. ROLLBACK (owner), then the checks: as the login role, and as the owner for leftovers
psql_file "$DOWN"
echo "=== AFTER the rollback ==="
as_login tests_rollback.sql
echo "leftovers (owner): functions=$(docker exec "$NAME" psql -U postgres -tA -c "select count(*) from pg_proc where proname = 'current_merchant_strict'")  schema=$(docker exec "$NAME" psql -U postgres -tA -c "select count(*) from pg_namespace where nspname = 'analytics_access'")  policies=$(docker exec "$NAME" psql -U postgres -tA -c "select count(*) from pg_policy where polname = 'analytics_reader_read'")  acl_refs=$(docker exec "$NAME" psql -U postgres -tA -c "select count(*) from pg_class where relacl::text like '%analytics_reader%'")"
