#!/usr/bin/env bash
# Phase 3 PILOT runner - a disposable PostgreSQL 17 container, deleted at the end. Never staging, never production.
# Passwords are random at each run and kept in shell variables only; nothing is written to disk.
# The reader connects over TCP (127.0.0.1) with its password, so the real password path is exercised.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"  # relative file names only: docker cp must not receive MSYS-style paths
NAME="nordla-pilot-$$"
OWNER_PW="$(openssl rand -hex 16)"
READER_PW="$(openssl rand -hex 16)"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD="$OWNER_PW" postgres:17-alpine >/dev/null
for _ in $(seq 1 40); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done

docker cp analytics-reader.sql "$NAME":/tmp/schema.sql
docker cp analytics-reader-tests.sql "$NAME":/tmp/tests.sql

# 1. schema (as the owner of the disposable database)
docker exec "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -f /tmp/schema.sql </dev/null

# 2. the login password of the reader, set at run time (not in any file)
printf "alter role analytics_reader password :'pw';\n" | docker exec -i "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -v pw="$READER_PW" -f - >/dev/null

# 3. the tests, through a real password login as analytics_reader
docker exec -e PGPASSWORD="$READER_PW" "$NAME" psql -h 127.0.0.1 -U analytics_reader -d postgres -X -q -f /tmp/tests.sql </dev/null
