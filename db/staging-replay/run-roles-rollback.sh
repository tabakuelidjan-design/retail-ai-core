#!/usr/bin/env bash
# Apply and roll back the two pending role migrations (report, access checker) on a DISPOSABLE PostgreSQL 17, and prove that nothing
# unexpected is left: the policies, grants, column grants, ACLs, default ACLs, roles, memberships, schemas and functions of the
# relevant tables are compared before the apply and after the rollback. Never staging, never production, no remote change.
# Usage: SEC_MIG=<path to 20261119150000_security_client_tenant_guards.sql> bash db/staging-replay/run-roles-rollback.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/common.sh"
REPORT_DOWN="20261119170000_analytics_report_roles.down.sql"
ACCESS_DOWN="20261119180000_analytics_access_checker_roles.down.sql"

replay_start roles
replay_stubs
replay_migrations
echo "replay: ok, $REPLAYED repo migrations (pending role migrations NOT yet applied)"

# snapshot of everything the two migrations could touch: policies, table ACLs, column ACLs, default ACLs, roles, memberships, schemas, functions
cat > snapshot.sql <<'SQL'
select 'policy' as k, tablename||'|'||policyname||'|'||cmd||'|'||permissive||'|'||coalesce(array_to_string(roles, ','),'') as v
  from pg_policies where schemaname = 'public'
union all select 'tacl', relname||'|'||coalesce(relacl::text,'') from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
union all select 'colacl', c.relname||'.'||a.attname||'|'||a.attacl::text from pg_attribute a join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and a.attacl is not null
union all select 'defacl', defaclrole::regrole::text||'|'||defaclnamespace::text||'|'||defaclobjtype::text||'|'||defaclacl::text from pg_default_acl
union all select 'role', rolname from pg_roles where rolname like 'analytics%' or rolname like 'nordla%'
union all select 'member', g.rolname||'<-'||m.rolname from pg_auth_members am join pg_roles g on g.oid = am.roleid join pg_roles m on m.oid = am.member
union all select 'schema', nspname from pg_namespace where nspname like 'analytics%'
union all select 'function', n.nspname||'.'||p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname like 'analytics%'
union all select 'shdep', count(*)::text from pg_shdepend d join pg_roles r on r.oid = d.refobjid where r.rolname like 'analytics%'
order by 1, 2;
SQL
snap() { docker cp snapshot.sql "$NAME":/tmp/snap.sql && docker exec "$NAME" psql -U postgres -tAX -f /tmp/snap.sql; }

snap > before.txt
echo "snapshot before: $(wc -l < before.txt) lines"

# 1. apply the report migration, check its objects
replay_pending "$REPORT_MIG"
R_ROLES=$(owner_scalar "select count(*) from pg_roles where rolname in ('analytics_report_reader','analytics_report_writer')")
R_POL=$(owner_scalar "select count(*) from pg_policy where polname like 'analytics_report_%'")
R_FN=$(owner_scalar "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='analytics_report'")
echo "applied report: roles=$R_ROLES (expect 2) policies=$R_POL (expect 16) functions=$R_FN (expect 1)"

# 2. apply the access migration, check its objects
replay_pending "$ACCESS_MIG"
A_ROLES=$(owner_scalar "select count(*) from pg_roles where rolname = 'analytics_access_checker'")
A_POL=$(owner_scalar "select count(*) from pg_policy where polname = 'analytics_checker_member' or polname = 'analytics_checker_entitlement'")
A_FN=$(owner_scalar "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='analytics_checker'")
echo "applied access: roles=$A_ROLES (expect 1) policies=$A_POL (expect 2) functions=$A_FN (expect 2)"

# 3. roll back the report migration only; the access objects must remain intact
replay_pending_down "$REPORT_DOWN"
echo "rolled back report: roles=$(owner_scalar "select count(*) from pg_roles where rolname like 'analytics_report%'") (expect 0), schema=$(owner_scalar "select count(*) from pg_namespace where nspname='analytics_report'") (expect 0), access role still=$(owner_scalar "select count(*) from pg_roles where rolname='analytics_access_checker'") (expect 1)"

# 4. roll back the access migration
replay_pending_down "$ACCESS_DOWN"

snap > after.txt
echo "snapshot after: $(wc -l < after.txt) lines"
if diff before.txt after.txt > diff.txt; then
  echo "DIFF before vs after rollback: NONE (identical policies, ACLs, column and default ACLs, roles, memberships, schemas, functions)"
else
  echo "DIFF before vs after rollback:"; cat diff.txt
fi

# 5. a removed role must not be left in any dependency
echo "leftovers: roles=$(owner_scalar "select count(*) from pg_roles where rolname like 'analytics_report%' or rolname = 'analytics_access_checker'") memberships=$(owner_scalar "select count(*) from pg_auth_members am join pg_roles r on r.oid=am.roleid where r.rolname like 'analytics_report%' or r.rolname='analytics_access_checker'") schemas=$(owner_scalar "select count(*) from pg_namespace where nspname in ('analytics_report','analytics_checker')") policies=$(owner_scalar "select count(*) from pg_policy where polname like 'analytics_report_%' or polname like 'analytics_checker_%'")"
