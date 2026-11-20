# Fixed-merchant PostgreSQL principals — prepared and locally tested

Status: NOT applied remotely. No runtime credential generated remotely, no service converted by this branch alone. Preserve the separate session-assurance releases.

Builds on the Analytics PG pilot at 0616546f; the original pilot worktree was left intact. Apply its three pending SQL files first, then 20261120010000_runtime_principal_binding.sql using a real PostgreSQL administrator. Neither Supabase service_role nor the public Data API has the required role/schema DDL authority. The Supabase CLI in this session has no Management API login.

Each LOGIN is bound immutably to one merchant and one purpose. The binding is based on session_user, not a browser field or freely changeable application setting. A forged app.merchant_id fails. Groups have no LOGIN, SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE or REPLICATION. Provision creates a NOLOGIN principal; credential creation and activation are deliberately separate. Use a unique random credential per service/merchant, verified TLS and no credential logging. Disable a binding for immediate containment on its next database operation. Never grant extra role membership or table ownership.

Roles: Analytics source reader, report reader, report flag writer, identity checker; Finance runtime; Core business reader; reserved Growth runtime. The Growth business grants and writes are not finished. Core identity/admin/auth and private object storage are not converted. This is not a claim that service_role has been removed from all of Nordla.

The new src/security/tenant-pg-client.js validates a fixed tenant/purpose on EVERY transaction, uses parameterized SQL and scoped grants, refuses unfiltered updates/deletes and privileged Finance routines. Invoice issue routines remain SECURITY INVOKER. The MFA wrapper exposes only the current active member and no factor secret. Session/journal reads omit token hashes. The PostgreSQL pool must use the provisioned ordinary LOGIN, never an administrator or service_role.

Local proof: use the Core security recovery drill with this worktree as optional fifth argument:

node test/security-recovery-native.mjs PATH_TO_PG_NATIVE PATH_TO_PG_MODULE PATH_TO_PG_CLIENTS PATH_TO_THIS_WORKTREE

The native test replays 50 Nordla migrations plus the four prepared role migrations, creates seven REAL LOGIN principals, and proves: no-filter A/B isolation; missing/forged context refusal; no SET ROLE to service_role/postgres; no binding mutation; Finance own writes and cross-tenant refusal; actual invoice issuance without service_role; Core/report read-only rights; flag-writer isolation; session-secret column refusal; MFA cross-tenant refusal; disabling a principal invalidates pooled use. It then restores database and originals and compares document totals, hashes, RLS and privileged function ACLs. Auth/Storage schemas are minimal local stubs. Global database roles already exist in the same test cluster; this does not prove a fresh hosted Supabase recovery, which must provision roles separately.

Activation sequence: obtain the existing staging SQL-admin connection securely; inventory grants against the live schema; apply and provision test-only principals; install driver/configuration on one service at a time with restricted mode REQUIRED and no silent legacy fallback; repeat functional and cross-tenant tests; remove the corresponding ordinary-data service-key paths. Keep administrative Auth/Storage operations separate and audited. No production change or paid project is authorized here.

Emergency containment script in db/rollback disables bindings without dropping guards. It intentionally closes services rather than silently restoring unrestricted access.

The additional reference-owner trigger guards single UUID foreign keys from Finance tables to merchant-scoped parents. A credit note cannot reference another merchant’s invoice even though an ordinary foreign key would accept the UUID. Upsert and filtered-update behavior is tested against the real schema, alongside a deliberately missing update filter. Native final result: 54 migrations, seven ordinary LOGIN principals, five issued documents and four originals, 45 seconds; evidence is stored in docs/evidence.
