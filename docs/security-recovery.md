# Nordla — encrypted recovery procedure (19 November 2026)

## Status and scope

The tool is tested locally, not yet connected to a hosted PostgreSQL backup schedule. No production approval is implied. Existing Sourcing backups do not include the whole database or all Finance originals.

Use `node tools/security-recovery.mjs capture NEW_DIRECTORY` to capture PostgreSQL, Finance storage, Sourcing archive objects and roles without passwords. Files, their names, database bytes and metadata are encrypted with AES-256-GCM and a scrypt-derived key. No unencrypted database dump is written to disk. A completion descriptor is written last. Limits: 256 MiB per record, 512 MiB total, 50,000 files. Exceeding a limit fails; increase deliberately after capacity review.

Required environment names only:

- NORDLA_BACKUP_DATABASE_URL: dedicated database backup connection. This is absent on current staging; a service-role API key cannot substitute for it.
- NORDLA_RECOVERY_PASSPHRASE: independent recovery passphrase (24-character minimum; use at least 32 random bytes). Keep recovery material separately from the application and the workstation.
- SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: capture only. These must never be exposed to a browser or included in logs.
- NORDLA_PG_DUMP, NORDLA_PG_DUMPALL, NORDLA_PG_RESTORE, NORDLA_PSQL: official PostgreSQL client binaries, compatible with the server major version.
- NORDLA_PGSSLROOTCERT when the system trust store does not validate the remote database certificate.

Remote database capture requires TLS with certificate and hostname verification. Database passwords are passed to child processes through their environment, never command-line arguments. Child environments exclude unrelated application secrets. pg_dump retains ACLs. Roles are exported without passwords for a reviewed rebuild; they are not blindly recreated.

## Verification and isolated restore

1. Run `node tools/security-recovery.mjs verify BUNDLE_DIRECTORY` using the separately held passphrase. Every encrypted record is authenticated and its content hash checked before any restore effect.
2. Create a disposable, isolated PostgreSQL database on loopback, named `nordla_recovery_...`. It must contain no user tables/views. Set NORDLA_RECOVERY_LOCAL_DRILL=1 and NORDLA_RESTORE_DATABASE_URL for that database.
3. Pre-create the reviewed roles needed by the dump, with their intended privileges. Never turn an application role into a superuser/BYPASSRLS role to make restoration easier.
4. Run `node tools/security-recovery.mjs restore BUNDLE_DIRECTORY EMPTY_FILES_DIRECTORY`.
5. Verify invoice numbers, tax, balances, document snapshot hashes, row counts per merchant, RLS policies, privileged-function ACLs and original file bytes. Check storage references against the captured object inventory.
6. Reconstruct private storage buckets on an isolated matching Supabase stack and upload the restored originals. Match Auth/Storage versions and managed-schema permissions to the provider's supported recovery procedure.
7. Test real authentication, per-merchant reads/writes, private downloads and backup freshness before approving use. Revoke old sessions and rotate compromised credentials if restoring after an incident.

The tool refuses remote database restores and populated file/database targets. pg_restore runs in a transaction with ACLs retained and ownership assigned to the restore user. The database restore and filesystem writes are **not one atomic transaction**. A failed file phase requires discarding the isolated target and retrying, never routing users to it. A hostile dump can execute SQL: restore only trusted captures in an isolated drill environment.

A PostgreSQL snapshot and object-store downloads are not one shared transaction. Schedule a capture in a controlled write window or implement a snapshot/reference reconciliation procedure; compare all document-to-object references before declaring a complete capture.

## Actual evidence

- Existing private Sourcing archive from 19 November restored: 74 files, journal OK. This is file-archive recovery, not database recovery.
- PostgreSQL 17.12 native TCP test, clients 17.2: 48 pinned production-preparation migrations at 054bab81 + Peppol + tenant guards = 50 applied; four fictitious merchants, four issued invoices and four PDF originals.
- Encrypted dump restored into a new database. Numbers, tax, totals, document snapshot hashes, RLS policies, SECURITY DEFINER ACLs and PDF bytes were identical. Source data and other merchants were unchanged. A populated target was refused.
- The local Supabase Auth/Storage schemas are minimal test stubs. This does not prove restoration of the hosted Supabase service or a single-merchant production restore.
- Six recovery unit tests cover encryption, wrong passphrase, changed ciphertext, occupied/unsafe paths, remote restore refusal and storage byte preservation.

## Operational work still required

No hosted full-database capture has run: the backup database connection is missing. No independent immutable or offline copy has been configured and tested. A copy in the same Supabase account, accessible with the same administrative authority, is not ransomware isolation. No paid product is required by this patch and none was purchased.

Keep encrypted copies plus documented recovery keys in a separately controlled location, and test a real provider-compatible rebuild. Set the recovery point and maximum outage targets with actual business needs; the 40-second synthetic database drill and two-second archive drill are not production recovery guarantees.
