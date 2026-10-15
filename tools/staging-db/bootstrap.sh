#!/usr/bin/env bash
# Supabase STAGING ONLY: runs ops/staging-db/bootstrap-habb-test.sql (one transaction, its own guards and final checks) and proves,
# from the database itself, that NOTHING pre-existing changed:
#   - before / after fingerprint (row count + content hash) of every public table, the HABB test merchant row and the identity tables
#     (merchant_members, module_entitlements, identity_events: written by the bootstrap) set aside; storage buckets other than
#     nordla-backups and every storage object (metadata) included;
#   - then the expected end state, read back: test merchant, exactly one ACTIVE OWNER = the single confirmed Auth account, module
#     sourcing ACTIVE, bucket nordla-backups private with no storage policy, events recorded, marker merchant untouched.
# Never prints the database address nor any e-mail (masked). Called by .github/workflows/staging-db-ops.yml after run.sh succeeded.
# Usage: STAGING_DATABASE_URL=... [STAGING_OWNER_EMAIL=...] tools/staging-db/bootstrap.sh OUT_DIR
set -euo pipefail
exec > >(sed -u -E 's#postgres(ql)?://[^[:space:]"]*#<adresse masquée>#g; s#"[^"]*@[^"]*"#"<masqué>"#g; s#[^[:space:]"]*@[^[:space:]"]*supabase\.(com|co)[^[:space:]"]*#<masqué>#g; s#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#<e-mail masqué>#g') 2>&1
OUT="$1"; mkdir -p "$OUT"
DB="${STAGING_DATABASE_URL:?STAGING_DATABASE_URL secret missing}"
REF='fvhiammdskpcnfodsnrc'; PROD_REF='xbtzjabbseclmqfozjeo'
MARKER='4159734e-27be-4772-bb7c-6c5f24fbafcc'; TEST='67646dbb-5e2e-4cd7-aad6-0ab289b068cb'
[[ "$DB" == *"$REF"* ]] || { echo "STOP: not the staging project"; exit 2; }
[[ "$DB" != *"$PROD_REF"* ]] || { echo "STOP: production refused"; exit 2; }
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
q() { psql "$DB" -X -q -tA -v ON_ERROR_STOP=1 -c "$1"; }

FP_SQL="do \$\$ declare r record; n bigint; h text; o text := ''; begin
  for r in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r'
           and c.relname not in ('merchant_members', 'module_entitlements', 'identity_events') order by 1 loop
    execute format('select count(*), coalesce(md5(string_agg(md5(t::text), '''' order by md5(t::text))), ''empty'') from public.%I t'
                   || case when r.relname = 'merchants' then ' where id <> ''$TEST''' else '' end, r.relname) into n, h;
    o := o || r.relname || '=' || n || ':' || h || E'\n';
  end loop;
  select count(*), coalesce(md5(string_agg(md5(b::text), '' order by md5(b::text))), 'empty') into n, h from storage.buckets b where id <> 'nordla-backups';
  o := o || 'storage.buckets(other)=' || n || ':' || h || E'\n';
  select count(*), coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), 'empty') into n, h from storage.objects x;
  o := o || 'storage.objects=' || n || ':' || h || E'\n';
  raise notice '%', o; end \$\$;"
fingerprint() { psql "$DB" -X -q -v ON_ERROR_STOP=1 -c "$FP_SQL" 2>&1 | sed -n 's/^NOTICE:  //p; /^[a-z_.()]*=[0-9]*:/p' | grep -E '^[a-z_.()0-9]+=' | sort; }

fingerprint > "$OUT/bootstrap-before.fingerprint"
[[ -s "$OUT/bootstrap-before.fingerprint" ]] || { echo "STOP: empty fingerprint, nothing done"; exit 2; }
log "before: $(wc -l < "$OUT/bootstrap-before.fingerprint") fingerprinted sets (public tables, other buckets, storage objects)"

set -o pipefail
if [[ -n "${STAGING_OWNER_EMAIL:-}" ]]; then psql "$DB" -X -v ON_ERROR_STOP=1 -v owner_email="$STAGING_OWNER_EMAIL" -f ops/staging-db/bootstrap-habb-test.sql > "$OUT/bootstrap.txt" 2>&1 || rc=$?
else psql "$DB" -X -v ON_ERROR_STOP=1 -f ops/staging-db/bootstrap-habb-test.sql > "$OUT/bootstrap.txt" 2>&1 || rc=$?; fi
sed -i -E 's#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#<e-mail masqué>#g; s#postgres(ql)?://[^[:space:]"]*#<adresse masquée>#g' "$OUT/bootstrap.txt"
cat "$OUT/bootstrap.txt"
if [[ -n "${rc:-}" ]]; then echo "STOP: bootstrap refused or failed (psql exit $rc): its single transaction was rolled back"; fi

fingerprint > "$OUT/bootstrap-after.fingerprint"
fail=0; chk() { if [[ "$2" == "$3" ]]; then log "PASS $1"; else log "FAIL $1 (got '$2', want '$3')"; fail=1; fi; }
chk "pre-existing data unchanged (public tables, merchants other than the test one, other buckets, storage objects)" \
  "$(diff -q "$OUT/bootstrap-before.fingerprint" "$OUT/bootstrap-after.fingerprint" >/dev/null && echo same || echo different)" same
[[ -z "${rc:-}" ]] || exit 3
chk "test merchant present, own id" "$(q "select name from public.merchants where id = '$TEST'")" "HABB (test staging)"
chk "exactly one confirmed Auth account" "$(q "select count(*) from auth.users where email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until < now())")" 1
chk "one ACTIVE OWNER, the confirmed account" "$(q "select count(*) from public.merchant_members m join auth.users u on u.id = m.user_id where m.merchant_id = '$TEST' and m.role = 'OWNER' and m.status = 'ACTIVE' and u.email_confirmed_at is not null")" 1
chk "no other member" "$(q "select count(*) from public.merchant_members where merchant_id = '$TEST'")" 1
chk "module sourcing ACTIVE" "$(q "select status from public.module_entitlements where merchant_id = '$TEST' and module_code = 'sourcing'")" ACTIVE
chk "no other module" "$(q "select count(*) from public.module_entitlements where merchant_id = '$TEST'")" 1
chk "bucket nordla-backups private" "$(q "select public::text from storage.buckets where id = 'nordla-backups'")" false
chk "no storage policy names nordla-backups" "$(q "select count(*) from pg_policies where schemaname = 'storage' and (coalesce(qual, '') || coalesce(with_check, '')) like '%nordla-backups%'")" 0
chk "identity events recorded (>= 2)" "$(q "select (count(*) >= 2)::text from public.identity_events where merchant_id = '$TEST'")" true
chk "marker merchant: no member, no module" "$(q "select (select count(*) from public.merchant_members where merchant_id = '$MARKER') + (select count(*) from public.module_entitlements where merchant_id = '$MARKER')")" 0
for r in anon authenticated; do chk "$r cannot read merchant_members" "$(q "select has_table_privilege('$r', 'public.merchant_members', 'SELECT')::text")" false; done
exit $fail
