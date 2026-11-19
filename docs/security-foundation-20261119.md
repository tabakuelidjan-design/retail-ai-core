# Nordla security foundation — 19 November 2026

Scope: test environment only. No subscription, production migration, real merchant data change, invitation or external message.

## Applied database protection

Staging project: fvhiammdskpcnfodsnrc. Migration 20261119150000_security_client_tenant_guards.

- Before: 56 public tables with RLS, zero policies.
- After: 56 tables with RLS, 112 restrictive policies, zero permissive policies.
- Anonymous access stays closed. Authenticated client access stays closed by default.
- Future permissive policies are bounded by ACTIVE membership with removed_at IS NULL.
- The membership helper cannot be executed by anon.
- finance-inbox and nordla-backups are private.
- SQL source in the migration registry matches this file after CRLF normalization:
  MD5 6e721a0c7b3f9e39204928f57107e399. This is a source equality check, not a cryptographic security control.

**Limit:** service_role/BYPASSRLS still bypasses these policies. This migration does not establish database-enforced isolation for current server requests.

The optional PostgreSQL/PGlite drill runs the actual migration, replays it, then deliberately adds an overly broad permissive policy. Fifteen checks cover missing filters, anonymous access, missing identity, cross-merchant insert/update/delete, removed and suspended members, and the service-role bypass. No remote access or HABB data.

## Application protection

- A failed or malformed MFA-policy lookup refuses business requests. It no longer silently disables the rule.
- Hosted Core checks the rule even when the enrolment interface flag is disabled. Authentication/enrolment routes remain reachable.
- Finance and Analytics recheck the rule for personal SSO tickets and existing SSO sessions.
- A rule-screen read failure cannot be displayed as “MFA disabled”.
- NORDLA_SSO_ONLY=1 disables shared-token access to Finance and Analytics. Finance also refuses persisted legacy token sessions.
- SSO-only startup refuses an invalid/incomplete personal-SSO configuration. Keep the existing dedicated SSO keys.
- The private Finance attachment adapter requires a fixed merchant and refuses foreign/traversal references before any storage request.
- Security denials produce bounded, allow-listed log events. No identity, URL, filename, password or token is included.
- Core assistant Finance/Analytics reads use the same role and entitlement decisions as opening these modules. A forbidden reader is never called.
- Core's Analytics reader requires its merchant, rejects a directory already bound to another merchant, and refuses foreign or unstamped report files.

Growth's separate identity path has not been changed by this patch. Its MFA-policy enforcement still needs verification.

## Validation

- Targeted application tests: 136 passed, zero failed.
- Broader security/access/backup set: 324 tests; 323 passed, one skipped, zero failed.
- PostgreSQL/PGlite migration drill: 15 checks passed.
- Restore tests use synthetic cases, photos, journal, approvals and visual files. They do not prove restoration of the hosted PostgreSQL database or the hosted Finance storage bucket.
- An earlier broad runner did not produce a final result. Its follow-up was blocked by automatic review over Microsoft telemetry. The final 324-test run used direct Node execution, a minimal environment without application secrets, and documented PowerShell/.NET telemetry opt-outs.

## Personal activation still required

A staging read found two ACTIVE OWNER/ADMIN members, one with a verified factor. The merchant requirement was OFF.
Do not claim MFA is mandatory until owners/admins enrol, recover safely and the requirement is enabled and tested.
Never store an authenticator secret, recovery code or password in this report.
After enforcement is enabled, retire pre-enforcement sessions and verify fresh MFA-protected sign-in across modules.

## Remaining work before real use / other merchants

1. Replace service-role access for ordinary business data with a restricted database role/token and verify the real production adapters using two synthetic merchants and an intentionally missing filter. Keep privileged administration separate.
2. Exercise a complete encrypted PostgreSQL AND storage backup/restore, with a copy outside the application's deletion privileges. Existing Sourcing archive drills cover only the files included in those archives.
3. Verify MFA enforcement in Growth and fresh/old sessions after activation.
4. Verify private PDF/export downloads in the deployed applications and complete browser acceptance.
5. Add operational alert routing and response procedures; log signals alone are not a monitored incident service.
6. Review the owner's computer, email, GitHub, Railway and Supabase administrator MFA. A compromised workstation is a separate risk.

No multi-merchant launch approval is implied by this foundation.

## Deployment / rollback

Deploy only from service release branches and preserve their latest changes. Finance receives only its security patch, not the Core tree.

- Core base: f879e21f.
- Finance base: b1253994.
- Analytics base: a361315e (preserve SameSite=Lax).
- Keep production untouched.
- Set NORDLA_SSO_ONLY=1 only on Finance and Analytics after validating personal SSO configuration.
- Code rollback: redeploy the recorded base SHA; the restrictive SQL migration can remain.
- SQL rollback is supplied separately and refuses to remove guards if permissive policies have since been added.

## Integration after latest Claude releases

Core: 340 tests, 339 passed, one skipped. Finance: 61 passed. Analytics: 239 passed. Zero failures. Latest permission matrix, version endpoints and test-data labels are preserved. These are targeted integration suites, not a claim that the entire repository suite passed.
