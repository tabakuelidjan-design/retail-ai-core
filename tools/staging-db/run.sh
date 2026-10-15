#!/usr/bin/env bash
# Supabase STAGING database operations through a direct PostgreSQL connection (GitHub Actions runner), in this order, each step
# stopping everything on failure:
#   1. guard     the connection is STAGING (project ref in the URL, never the production ref, staging's synthetic merchant present)
#   2. backup    pg_dump -Fc of the whole database, encrypted (AES-256, passphrase secret), kept as a workflow artifact
#   3. restore   public + supabase_migrations restored from the ENCRYPTED dump into a throw-away PostgreSQL 17, in ONE transaction,
#                stopping on the first error; data (row counts + content hashes) AND structure (constraints, indexes, functions, triggers,
#                policies, RLS, grants: tools/staging-db/structure.sql) must equal the live staging ones -> proven before anything changes.
#                Coverage is written out: auth + storage metadata are in the dump but their restore is not proven here; Storage FILES are
#                not in it at all
#   4. apply     each requested migration file, in order, skipped if its name is already in the migration history, otherwise in ONE
#                transaction with its history row (psql --single-transaction): all or nothing per migration
#   5. checks    identity tables + RLS, no privilege for anon / authenticated, no SECURITY DEFINER callable by them, functional run in a
#                transaction that is ROLLED BACK (owner bootstrap, module, session), and the pre-existing data unchanged
# Usage: STAGING_DATABASE_URL=... STAGING_BACKUP_PASSPHRASE=... RESTORE_URL=... tools/staging-db/run.sh ops/staging-db/request.json OUT_DIR
set -euo pipefail
# Never print the database address: a client error can echo part of it (2026-10-15: a password holding an unencoded '@' was split
# and a fragment reached the job log). Every line of this script's output goes through this mask.
exec > >(sed -u -E 's#postgres(ql)?://[^[:space:]"]*#<adresse masquée>#g; s#"[^"]*@[^"]*"#"<masqué>"#g; s#[^[:space:]"]*@[^[:space:]"]*supabase\.(com|co)[^[:space:]"]*#<masqué>#g') 2>&1
REQ="$1"; OUT="$2"; mkdir -p "$OUT"
PROD_REF='xbtzjabbseclmqfozjeo'
REF=$(jq -r .project_ref "$REQ"); MARKER=$(jq -r .staging_marker_merchant "$REQ")
DB="${STAGING_DATABASE_URL:?STAGING_DATABASE_URL secret missing}"; PASS="${STAGING_BACKUP_PASSPHRASE:?STAGING_BACKUP_PASSPHRASE secret missing}"
RESTORE="${RESTORE_URL:?RESTORE_URL (throw-away PostgreSQL) missing}"
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
q() { psql "$DB" -X -q -tA -v ON_ERROR_STOP=1 -c "$1"; }

# ---- 1. guard
# The address must parse unambiguously BEFORE any connection: exactly one '@', and no '/', '?' or '#' in the user / password part.
rest="${DB#*://}"; userinfo="${rest%@*}"
[[ "$DB" == postgres://* || "$DB" == postgresql://* ]] || { echo "STOP: the database URL must start with postgresql://"; exit 2; }
yn() { [[ "$userinfo" == *"$1"* ]] && echo yes || echo no; }
[[ $(tr -cd '@' <<<"$DB" | wc -c) -eq 1 && "$userinfo" != *[/?#]* && "$userinfo" != *[\[\]]* && "$DB" != *[[:space:]]* ]] || { echo "STOP: the database URL is ambiguous. Structure only (no value): '@' in the whole address: $(tr -cd '@' <<<"$DB" | wc -c) (expected 1); in the user:password part: '/' $(yn /), '?' $(yn '?'), '#' $(yn '#'), '[' or ']' $( [[ "$userinfo" == *[\[\]]* ]] && echo yes || echo no) (placeholder [YOUR-PASSWORD] not replaced?), whitespace anywhere: $( [[ "$DB" == *[[:space:]]* ]] && echo yes || echo no). Use a password with letters and digits only (or encode: @ = %40). Nothing was connected."; exit 2; }
[[ "$DB" == *"$REF"* ]] || { echo "STOP: the database URL does not name project $REF"; exit 2; }
[[ "$DB" != *"$PROD_REF"* ]] || { echo "STOP: the database URL names the PRODUCTION project"; exit 2; }
# Connection failure: the client's message can contain the address, so it is never printed; only its CATEGORY is.
if ! cerr=$(psql "$DB" -X -q -tA -c "select 1" 2>&1 >/dev/null); then
  case "$cerr" in
    *"password authentication failed"*) why='authentication refused: the PASSWORD in the address is not the database password (reset it, letters and digits only, and update the secret)';;
    *"could not translate host name"*|*"Name or service not known"*) why='host not found: the server part of the address is wrong';;
    *"timeout"*|*"timed out"*|*"Connection refused"*) why='server unreachable (timeout or refused): check host and port (Session pooler, 5432)';;
    *"Tenant or user not found"*|*"tenant"*) why='pooler does not know this user: the user must be postgres.<project ref>';;
    *"SSL"*|*"ssl"*) why='TLS negotiation failed';;
    *) why='other cause (details withheld)';;
  esac
  unset cerr; echo "STOP: cannot connect to the database - $why. Nothing was connected or changed."; exit 2
fi
[[ ${#PASS} -ge 16 ]] || { echo "STOP: backup passphrase shorter than 16 characters"; exit 2; }
[[ "$(q "select count(*) from public.merchants where id = '$MARKER'")" == 1 ]] || { echo "STOP: staging marker merchant absent: not the staging database"; exit 2; }
log "guard OK: project $REF, staging marker present, server $(q 'show server_version')"
if [[ "${CHECK_ONLY:-0}" == 1 ]]; then log "CHECK ONLY: address, connection, staging marker and passphrase verified; nothing else was done (no backup, no write)"; exit 0; fi

FP_SQL="do \$\$ declare r record; n bigint; h text; o text := ''; begin for r in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r' order by 1 loop execute format('select count(*), coalesce(md5(string_agg(md5(t::text), '''' order by md5(t::text))), ''empty'') from public.%I t', r.relname) into n, h; o := o || r.relname || '=' || n || ':' || h || E'\n'; end loop; raise notice '%', o; end \$\$;"
fingerprint() { psql "$1" -X -q -v ON_ERROR_STOP=1 -c "$FP_SQL" 2>&1 | sed -n 's/^NOTICE:  //p; /^[a-z_]*=[0-9]*:/p' | grep -E '^[a-z_0-9]+=' | sort; }

# ---- 2. backup: public + supabase_migrations (restore PROVEN below) and auth + storage METADATA (kept, restore NOT proven here)
fingerprint "$DB" > "$OUT/before.fingerprint"
psql "$DB" -X -q -tA -v ON_ERROR_STOP=1 -f tools/staging-db/structure.sql > "$OUT/before.structure"
log "fingerprint: $(wc -l < "$OUT/before.fingerprint") public tables, $(wc -l < "$OUT/before.structure") structural objects"
pg_dump "$DB" -Fc --no-owner --schema=public --schema=supabase_migrations --schema=auth --schema=storage -f "$OUT/staging.dump"
gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 --symmetric --cipher-algo AES256 -o "$OUT/staging.dump.gpg" "$OUT/staging.dump" 3<<<"$PASS"
sha256sum "$OUT/staging.dump.gpg" > "$OUT/staging.dump.gpg.sha256"
log "backup: $(du -h "$OUT/staging.dump.gpg" | cut -f1) encrypted, sha256 $(cut -c1-16 "$OUT/staging.dump.gpg.sha256")"
# coverage, said explicitly: what this backup contains, what is proven restorable, what is NOT in it at all
{
  echo "RESTORE PROVEN (data + structure compared): public, supabase_migrations"
  echo "IN THE DUMP, restore NOT proven by this job (Supabase-managed schemas): auth, storage (metadata rows only)"
  echo "NOT IN THE DUMP: Storage FILES (object bytes live outside PostgreSQL), and every other schema:"
  psql "$DB" -X -q -tA -v ON_ERROR_STOP=1 -c "select '  ' || nspname || ' (' || n || ' relations)' from (select n.nspname, count(c.oid) n from pg_namespace n left join pg_class c on c.relnamespace = n.oid where n.nspname not in ('public','supabase_migrations','auth','storage','pg_catalog','information_schema','pg_toast') and n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast_temp%' group by n.nspname) x order by 1"
  echo "Storage objects per bucket (files NOT backed up by this job):"
  psql "$DB" -X -q -tA -v ON_ERROR_STOP=1 -c "select '  ' || bucket_id || ': ' || n || ' object(s)' from (select bucket_id, count(*) n from storage.objects group by bucket_id) x order by 1"
} > "$OUT/coverage.txt"
cat "$OUT/coverage.txt"

# ---- 3. restore proof (from the ENCRYPTED file, as a real restore would): any error, any difference = STOP, nothing applied
gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 -d -o "$OUT/check.dump" "$OUT/staging.dump.gpg" 3<<<"$PASS"
psql "$RESTORE" -X -q -v ON_ERROR_STOP=1 -f tools/staging-db/restore-prereqs.sql
# every entry of the two schemas (TOC line: "<id>; <oid> <oid> <TYPE words> <schema> <name> <owner>"), the creation of the
# supabase_migrations schema and the grants on schema public; never auth / storage (Supabase-managed: restore not proven here)
pg_restore -l "$OUT/check.dump" | grep -E '^[0-9]+; [0-9]+ [0-9]+ [A-Z][A-Z ]* (public|supabase_migrations) |^[0-9]+; [0-9]+ [0-9]+ SCHEMA - supabase_migrations |^[0-9]+; [0-9]+ [0-9]+ ACL - SCHEMA public ' > "$OUT/restore.list"
[[ -s "$OUT/restore.list" ]] || { echo "STOP: the dump lists no public / supabase_migrations object"; exit 3; }
if ! pg_restore -d "$RESTORE" --no-owner --single-transaction --exit-on-error -L "$OUT/restore.list" "$OUT/check.dump" 2> "$OUT/restore.log"; then
  echo "STOP: pg_restore failed (single transaction, nothing kept in the copy); nothing is applied:"; cat "$OUT/restore.log"; exit 3
fi
rm -f "$OUT/check.dump" "$OUT/staging.dump"   # only the encrypted copy is kept
fingerprint "$RESTORE" > "$OUT/restored.fingerprint"
psql "$RESTORE" -X -q -tA -v ON_ERROR_STOP=1 -f tools/staging-db/structure.sql > "$OUT/restored.structure"
if ! diff -u "$OUT/before.fingerprint" "$OUT/restored.fingerprint" > "$OUT/restore.diff"; then echo "STOP: restored DATA differs from staging; nothing is applied:"; cat "$OUT/restore.diff"; exit 3; fi
if ! diff -u "$OUT/before.structure" "$OUT/restored.structure" > "$OUT/structure.diff"; then echo "STOP: restored STRUCTURE (constraints, indexes, functions, triggers, policies, RLS, grants) differs; nothing is applied:"; head -40 "$OUT/structure.diff"; exit 3; fi
log "restore proof OK: $(wc -l < "$OUT/restored.fingerprint") tables (rows + content hashes) and $(wc -l < "$OUT/restored.structure") structural objects identical"

# ---- 4. apply, one transaction per migration (file + history row)
n=$(jq '.migrations | length' "$REQ")
for i in $(seq 0 $((n - 1))); do
  name=$(jq -r ".migrations[$i].name" "$REQ"); file=$(jq -r ".migrations[$i].file" "$REQ"); want=$(jq -r ".migrations[$i].sha256_b64" "$REQ")
  got=$(openssl dgst -sha256 -binary "$file" | base64); [[ "$got" == "$want" ]] || { echo "STOP: $file SHA-256 $got differs from the approved $want"; exit 4; }
  if [[ "$(q "select count(*) from supabase_migrations.schema_migrations where name = '$name'")" != 0 ]]; then log "skip $name: already in the history"; continue; fi
  version=$(date -u +%Y%m%d%H%M%S); sleep 1
  psql "$DB" -X -q -v ON_ERROR_STOP=1 --single-transaction -v body="$(cat "$file")" -v version="$version" -v name="$name" <<SQL
set search_path = public, extensions;
\i $file
insert into supabase_migrations.schema_migrations (version, name, statements, created_by) values (:'version', :'name', array[:'body'], 'github-actions:staging-db-ops');
SQL
  log "applied $name as version $version (single transaction)"
done

# ---- 5. checks
fail=0; chk() { if [[ "$2" == "$3" ]]; then log "PASS $1"; else log "FAIL $1 (got '$2', want '$3')"; fail=1; fi; }
for t in app_sessions identity_events identity_rate_limits identity_auth_reservations merchant_members module_entitlements; do
  chk "table $t with RLS" "$(q "select relrowsecurity from pg_class where oid = 'public.$t'::regclass")" t
  for r in anon authenticated; do chk "$r has no privilege on $t" "$(q "select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = '$t' and grantee = '$r'")" 0; done
done
for r in anon authenticated; do chk "$r executes no SECURITY DEFINER function" "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and has_function_privilege('$r', p.oid, 'execute')")" 0; done
fn=$(psql "$DB" -X -q -tA -v ON_ERROR_STOP=1 <<SQL
begin;
set local search_path = public, extensions;
insert into auth.users (id, aud, role, email) values ('00000000-0000-4000-8000-0000000000aa', 'authenticated', 'authenticated', 'staging-check@invalid.example');
select (identity_member_bootstrap_owner('$MARKER', '00000000-0000-4000-8000-0000000000aa', now(), gen_random_uuid(), 'sourcing'))->>'code';
select (identity_module_set('$MARKER', 'sourcing', 'ACTIVE', 'provisioning:check', now(), gen_random_uuid()))->>'code';
select (identity_open_session('00000000-0000-4000-8000-0000000000aa', '$MARKER', 'sourcing', repeat('c', 64), now(), now() + interval '1 hour', gen_random_uuid()))->>'code';
rollback;
SQL
)
chk "functional run (rolled back)" "$(echo "$fn" | tr '\n' ' ' | xargs)" "BOOTSTRAPPED MODULE_ENABLED SESSION_OPENED"
chk "nothing left by the functional run" "$(q "select (select count(*) from merchant_members) + (select count(*) from identity_events) + (select count(*) from module_entitlements)")" 0
fingerprint "$DB" | grep -vE '^(app_sessions|identity_events|identity_rate_limits|identity_auth_reservations|merchant_members|module_entitlements)=' > "$OUT/after.fingerprint"
grep -vE '^(app_sessions|identity_events|identity_rate_limits|identity_auth_reservations|merchant_members|module_entitlements)=' "$OUT/before.fingerprint" > "$OUT/before-existing.fingerprint"
chk "pre-existing data unchanged" "$(diff -q "$OUT/before-existing.fingerprint" "$OUT/after.fingerprint" >/dev/null && echo same || echo different)" same
q "select version || ' ' || name from supabase_migrations.schema_migrations order by version" > "$OUT/history.txt"
exit $fail
