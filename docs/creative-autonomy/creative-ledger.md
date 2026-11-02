# Creative media policy and spending ledger (ADR 0007-A, PROPOSED)

State on 2026-11-02, branch `fix/creative-production-v1-stabilization-20261102`. **Offline only. Not applied to any shared or production database. Not active.**

## What it is
The durable authority for three things the Creative production route needs before any product photo can leave Nordla:

| Concern | Table | Written only through |
|---|---|---|
| Standing tenant media-processing policy (accepted once by a tenant admin, versioned, revocable) | `creative_media_policies` | `creative_media_policy_accept`, `creative_media_policy_revoke` |
| Spending reservation per run (whole ceiling, per-run and monthly caps, idempotent) | `creative_spend_reservations` | `creative_spend_reserve`, `creative_spend_settle`, `creative_spend_release`, `creative_spend_reconcile_stale` |
| Media-transmission lifecycle (append-only, evidence-backed) | `creative_media_transmissions` | `creative_media_transmission_record` |

Migration: `supabase/migrations/20261102120000_creative_media_policy_spend_ledger.sql`. Application side: `src/creative-autonomy/creative-ledger.js` (Supabase adapter, `durable: true`; in-memory twin for tests, `durable: false`) and `src/creative-autonomy/transmission-recorder.js`.

JSONL journals (`MediaTransmissionJournal`, `provider-calls.jsonl`) remain **diagnostic mirrors only**. They are never the authority for spending or authorization.

## Guarantees and where they are proven
| Guarantee | Mechanism | Proof |
|---|---|---|
| Only an ACTIVE `OWNER`/`ADMIN` of the tenant accepts a policy | membership check in `creative_media_policy_accept` | `test/pg/97` acceptance test |
| Policy rows are immutable; supersede / revoke happen once; no delete or truncate | `creative_media_policies_guard` + no-truncate triggers | `test/pg/97` immutability test |
| A policy change needs a new acceptance | content SHA-256 differs → new version, previous superseded | `test/pg/97`, `test/creative-product-media.test.js` |
| Revocation blocks new reservations and new attempts | `POLICY_NOT_IN_FORCE` in `reserve` and `record` | `test/pg/97`, E2E `revoked` |
| No overspend under concurrency, across instances | `pg_advisory_xact_lock` per tenant-month; committed = live ceilings + settled amounts | `test/pg/97`: 40 concurrent runs on 20 connections against a EUR 2.00 month → exactly 4 reserved |
| Idempotent retries, duplicate protection | PK `(merchant_id, run_id)`; same terms → `ALREADY_RESERVED`; other terms → `RUN_ID_ALREADY_USED_WITH_OTHER_TERMS`; unique event key → `DUPLICATE` | `test/pg/97` |
| Tenant isolation | every key starts with `merchant_id`; functions scope by it | `test/pg/97` |
| `ATTEMPTED` refused (request not sent) without a live reservation and an `AUTHORIZED` event for the same operation, source SHA and policy version | `creative_media_transmission_record` + recorder throws `TransmissionRefused` | `test/pg/97`, `test/creative-product-media.test.js` |
| `SENT` only with a provider request ID; a failure without one is recorded with `transmission: UNKNOWN` | recorder | `test/creative-product-media.test.js`, E2E |
| Media attempted → reservation cannot be released, only settled; unknown outcome settles at the full ceiling | `creative_spend_release` refusal; `CEILING_OUTCOME_UNKNOWN` basis | `test/pg/97`, `test/creative-product-media.test.js` |
| Crashed runs are reconciled | `creative_spend_reconcile_stale`: no attempt → `RELEASED/STALE_NO_ATTEMPT`; attempt → `RECONCILE_REQUIRED` (still counts against the month) | `test/pg/97` |
| Least privilege | RLS on; `service_role` has `select` only on the tables and `execute` on the functions; no grant to `anon` / `authenticated` | `test/pg/97` grants test |

## Activation prerequisites (owner decisions, none taken)
1. Owner accepts ADR 0007 Part A (status today: PROPOSED).
2. Migration reviewed, then applied through the normal migration process to a **non-production** Supabase branch first; production only with explicit owner approval (CLAUDE.md §6).
3. Tenant onboarding text and the admin acceptance screen (not built).
4. Real provider execution stays blocked by NDR-D02 (`creative.call_live_provider` is `BLOCKED`; `produce_product_visual` refuses non-simulated providers). An NDR-D02 exception is ADR 0007 Part B, also PROPOSED.

## Rollback
The migration only adds objects; nothing existing is altered. Rollback, before any real data exists:
```sql
drop function if exists creative_media_transmission_record, creative_spend_reconcile_stale, creative_spend_release, creative_spend_settle,
  creative_spend_reserve, creative_media_policy_current, creative_media_policy_revoke, creative_media_policy_accept, creative_policy_lock, creative_spend_lock;
drop table if exists creative_media_transmissions, creative_spend_reservations, creative_media_policies;  -- truncate triggers go with the tables
drop function if exists creative_media_transmissions_append_only, creative_spend_reservations_guard, creative_media_policies_guard;
```
Once real audit rows exist, dropping them is a destructive operation and needs explicit owner approval; export first. Operational stop without schema change: revoke the tenant policy.

## Known limits
- Timestamps (`p_now`) are passed by the caller (service role only) so tests are deterministic; a production wrapper should pin them to the database clock (P2).
- The ledger bounds **application-side** spending. The provider invoice is still checked by hand.
- The local bench uses PostgreSQL 17 with a PostgREST stand-in; Supabase-specific behaviour (pooler, real PostgREST) is not exercised.
