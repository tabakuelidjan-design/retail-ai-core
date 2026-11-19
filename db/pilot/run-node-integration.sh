#!/usr/bin/env bash
# Phase 3 PILOT - runs the Node integration tests against a disposable PostgreSQL 17 container, deleted at the end.
# Never staging, never production. The reader password is random per run, kept in shell variables and passed to node
# ONLY through the environment (ANALYTICS_DATABASE_URL). Nothing is written to disk and the URL is never printed.
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NAME="nordla-pilot-node-$$"
OWNER_PW="$(openssl rand -hex 16)"
READER_PW="$(openssl rand -hex 16)"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$NAME" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$OWNER_PW" postgres:17-alpine >/dev/null
for _ in $(seq 1 40); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done

# 1. schema and fictitious rows, as the owner of the disposable database
cd "$HERE"  # relative file names only: docker cp must not receive MSYS-style paths (same rule as run-local.sh)
docker cp analytics-reader.sql "$NAME":/tmp/schema.sql
docker exec "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -f /tmp/schema.sql </dev/null

# 2. the login password of the reader, set at run time
printf "alter role analytics_reader password :'pw';\n" | docker exec -i "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -v pw="$READER_PW" -f - >/dev/null

# 3. the host port Docker chose (127.0.0.1 only)
PORT="$(docker port "$NAME" 5432/tcp | head -n1 | sed 's/.*://')"

# 4. node tests, as the real login role over TCP with its password (in the environment of this process only)
cd "$REPO"
ANALYTICS_DATABASE_URL="postgresql://analytics_reader:${READER_PW}@127.0.0.1:${PORT}/postgres" \
  node --test test/analytics-pg-integration.test.js
