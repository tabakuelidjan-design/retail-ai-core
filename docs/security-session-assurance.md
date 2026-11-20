# Session assurance — 20 November 2026

Hosted Core tickets now carry the exact Core session ID. Finance and Analytics require a live matching Core session on entry and every protected request. Growth records its verified Core parent in the existing append-only identity journal and checks it before data reads. Existing downstream sessions without a parent must reconnect through Core.

A verified factor enrolled on an account does not prove MFA for a particular session. The checker correlates SESSION_OPENED with one AUTH_SUCCEEDED for the same merchant, person, module and correlation ID, allowing TOTP or RECOVERY_CODE only. Missing, duplicate, stale, future, revoked or ambiguous evidence fails closed. Database errors are unavailable, never an MFA exemption.

Only OWNER can change the team MFA rule. Both enabling and disabling require this exact session to have MFA evidence no older than 15 minutes. Administrators cannot change this rule. A privileged member cannot remove their factor while mandatory MFA is enabled. Personal factor enrolment still requires the person’s authenticator; do not claim mandatory MFA is active until its rule and each privileged account have been verified.

No schema migration is needed for this phase. Deploy Core first, then Finance, Analytics and Growth. Old downstream cookies without a linked source are rejected: reconnect through Core. No secrets or OTP values are logged. The existing Core idle limit also applies to its dependent sessions; downstream use does not extend Core activity.

Validation: Core 262/262; Finance 29/29; Analytics 67/67; Growth selected 30/30. Native PostgreSQL drill replays 50 migrations, proves real session journal correlation and cascading Core→Growth revocation, then restores the database and four synthetic originals with their ACLs and RLS intact. This is a local native PostgreSQL drill with minimal managed-schema stubs, not a hosted Supabase backup or browser acceptance test.

Runtime PostgreSQL principal binding is a separate prepared migration and adapter. It is not activated by this deployment. Service-role access remains a material isolation limitation until restricted logins are provisioned and all runtime data paths converted.

Additional validation: real staging Supabase Auth + REST with one newly created fictitious merchant/user. A real TOTP factor and fresh login prove policy activation, refusal of a pre-enrolment session, Finance/Analytics access and parent-session revocation through Growth. Executed via local application functions, not browser UI. The fictitious account remains for immutable audit dependencies, is Auth-banned, has zero open sessions and four suspended modules. Existing real/test merchant accounts were not modified.

Offline shell caches in Sourcing and Procurement now retain only explicitly precached shell files. Unknown URLs are not added; query-bearing URLs are excluded. Old caches of the same application are purged at worker activation without deleting unrelated applications’ caches. The separate local IndexedDB business/offline queue remains an open isolation review; this change does not claim to clear every local business record. Tests: 27/27 shell/server checks, plus Procurement 22 passed and 1 skipped.

The prepared runtime role implementation is on security/runtime-roles-20261120 at 706b11588e73a45dd0d8b70c06eb489ca9981fa3. Native extended drill passes: 54 migrations, seven LOGIN principals, four synthetic merchants, five issued documents and four originals; source log reports 45 seconds. It also refuses cross-merchant Finance UUID references. This work is not applied remotely.
