#!/usr/bin/env bash
# Disposable PostgreSQL 17 with the repo migrations replayed (including the report and access-checker role migrations), synthetic data,
# and three LOGIN roles (no superuser, no BYPASSRLS, member of their role; no SET ROLE): report reader, report writer, access checker.
# The Node integration tests then exercise the real clients against them. Container and folder are deleted at the end.
# Never staging, never production. Passwords are random per run, passed to node only through the environment, never written to disk.
# Usage: SEC_MIG=<path to 20261119150000_security_client_tenant_guards.sql> bash db/staging-replay/run-services.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/common.sh"
replay_start svc
replay_stubs
replay_migrations
# the two role migrations are pending review: applied here explicitly, on this disposable database only
replay_pending "$REPORT_MIG"
replay_pending "$ACCESS_MIG"
echo "pending role migrations applied explicitly: report, access"
echo "replay: ok, $REPLAYED migration files applied in order (pilot excluded)"

cp "$HERE/seed-services.sql" seed.sql
psql_file seed.sql
echo "owner view: merchants=$(owner_scalar 'select count(*) from public.merchants') orders=$(owner_scalar 'select count(*) from public.orders') products=$(owner_scalar 'select count(*) from public.products')"

RPW="$(openssl rand -hex 16)"; WPW="$(openssl rand -hex 16)"; APW="$(openssl rand -hex 16)"
printf "create role analytics_report_reader_login login nosuperuser nobypassrls inherit password :'pw' in role analytics_report_reader;\n" | psql_in -v pw="$RPW" -f - >/dev/null
printf "create role analytics_report_writer_login login nosuperuser nobypassrls inherit password :'pw' in role analytics_report_writer;\n" | psql_in -v pw="$WPW" -f - >/dev/null
printf "create role analytics_access_login login nosuperuser nobypassrls inherit password :'pw' in role analytics_access_checker;\n" | psql_in -v pw="$APW" -f - >/dev/null

PORT="$(docker port "$NAME" 5432/tcp | head -n1 | sed 's/.*://')"
cd "$REPLAY_REPO"
ANALYTICS_REPORT_READ_DATABASE_URL="postgresql://analytics_report_reader_login:${RPW}@127.0.0.1:${PORT}/postgres" \
ANALYTICS_REPORT_WRITE_DATABASE_URL="postgresql://analytics_report_writer_login:${WPW}@127.0.0.1:${PORT}/postgres" \
ANALYTICS_ACCESS_DATABASE_URL="postgresql://analytics_access_login:${APW}@127.0.0.1:${PORT}/postgres" \
  node --test test/analytics-services-integration.test.js
