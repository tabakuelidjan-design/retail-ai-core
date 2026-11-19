# Shared helpers for the disposable replays (sourced, not executed).
# A PostgreSQL 17 container with Supabase-like roles and default grants, the repo migrations replayed in name order (each inside one
# transaction), plus the security tenant guard 20261119150000 (commit 029d204a, passed in as SEC_MIG). Never staging, never production.
# Passwords are random per run, kept in shell variables, never written to disk. Every docker cp uses RELATIVE names from $WORK.

REPLAY_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PILOT_MIG="20261119160000_analytics_reader_pilot_read.sql"
REPORT_MIG="20261119170000_analytics_report_roles.sql"
ACCESS_MIG="20261119180000_analytics_access_checker_roles.sql"

replay_start() {  # $1 = container name suffix; sets NAME, WORK, OWNER_PW; registers cleanup
  export MSYS_NO_PATHCONV=1
  NAME="nordla-replay-$1-$$"
  OWNER_PW="$(openssl rand -hex 16)"
  WORK="$REPLAY_REPO/db/staging-replay/.work-$1-$$"
  mkdir -p "$WORK"
  REPLAY_CLEANUP_NAME="$NAME"; REPLAY_CLEANUP_DIR="$WORK"
  trap 'docker rm -f "$REPLAY_CLEANUP_NAME" >/dev/null 2>&1 || true; rm -rf "$REPLAY_CLEANUP_DIR"' EXIT
  : "${SEC_MIG:?set SEC_MIG to the path of 20261119150000_security_client_tenant_guards.sql}"
  cp "$REPLAY_REPO"/supabase/migrations/*.sql "$WORK"/
  cp "$SEC_MIG" "$WORK/20261119150000_security_client_tenant_guards.sql"
  cd "$WORK"
  docker run -d --rm --name "$NAME" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$OWNER_PW" postgres:17-alpine >/dev/null
  for _ in $(seq 1 40); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done
}

psql_in() { docker exec -i "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_file() { docker cp "$1" "$NAME":/tmp/f.sql && docker exec "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -f /tmp/f.sql; }
owner_scalar() { docker exec "$NAME" psql -U postgres -tAX -c "$1"; }

replay_stubs() {
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
}

replay_migrations() {  # replays every repo migration except the pilot ones, then the security guard, as ONE script (one docker cp, one psql)
  local n=0 f base
  : > all.sql
  for f in $(ls ./*.sql | sort); do
    base="$(basename "$f")"
    case "$base" in all.sql|"$PILOT_MIG"|*.down.sql|tests*.sql|prep.sql|pilot*.sql|report*.sql|access*.sql|seed*.sql) continue ;; esac
    { printf '\\echo MIGRATION %s\n' "$base"; printf 'begin;\n'; cat "$base"; printf '\ncommit;\n'; } >> all.sql
    n=$((n+1))
  done
  local out
  if ! out="$(docker cp all.sql "$NAME":/tmp/all.sql && docker exec "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -f /tmp/all.sql 2>&1)"; then
    echo "REPLAY FAILED"; echo "$out" | tail -8; return 2
  fi
  REPLAYED="$n"
}

# Applies ONE pending migration explicitly (db/pending-migrations/, never supabase/migrations/), inside its own transaction.
replay_pending() {  # $1 = file name in db/pending-migrations (the file carries its own begin/commit)
  cp "$REPLAY_REPO/db/pending-migrations/$1" "pending-$1"
  docker cp "pending-$1" "$NAME":/tmp/pending.sql
  docker exec "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -f /tmp/pending.sql
}

# Copies a pending rollback next to the work folder (for psql_file).
replay_pending_down() {  # $1 = rollback file name in db/pending-migrations/rollback
  cp "$REPLAY_REPO/db/pending-migrations/rollback/$1" "down-$1"
  docker cp "down-$1" "$NAME":/tmp/down.sql
  docker exec "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -f /tmp/down.sql
}
