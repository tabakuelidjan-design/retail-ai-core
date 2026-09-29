# M2 - legacy merchant identity made optional and deprecated (runbook)

Migration: `supabase/migrations/20260929170000_merchants_deprecate_legacy_identity.sql`. Companion files: `m2-preflight.sql` (read
only), `m2-rollback.sql`. Decision: ADR 0003 section 7 - **no column is dropped in M2**.

**Status: prepared locally, applied nowhere.** Nothing in this runbook is to be run without the owner's explicit approval.

## What M2 changes, and only that

| Object | Before M2 | After M2 |
|---|---|---|
| `merchants.source_system` (text) | NOT NULL | **nullable**, kept, values unchanged, comment `DEPRECATED` |
| `merchants.source_id` (text) | NOT NULL | **nullable**, kept, values unchanged, comment `DEPRECATED` |
| `merchants.source_domain` (text) | nullable | unchanged (nullable), values unchanged, comment `DEPRECATED` |
| `merchants_source_unique` UNIQUE (source_system, source_id) + index | present | **kept, unchanged** |

Effect: a Nordla merchant can be created with no external identity (the three values NULL); several such merchants are accepted
(NULLs are distinct in a PostgreSQL unique constraint) while two identical non-null external identities are still refused. No row of
any table is written, no merchant UUID changes, `merchant_connectors` and business tables are untouched. Dropping the columns is not
part of M2: it would be a separate, later migration after a much longer stable period and a new explicit decision.

Verified on the real schemas (read-only, 2026-09-29): production `xbtzjabbseclmqfozjeo` and staging `fvhiammdskpcnfodsnrc` have
exactly the expected starting state (source_system / source_id NOT NULL, source_domain nullable, `merchants_source_unique` =
`UNIQUE (source_system, source_id)`), one merchant each with its exact `shopify` connector.

## Prerequisites

1. **C6-F deployed** on Core, Finance and Analytics in production and stable. Old code (Finance `21dc924`, Analytics `e593475`,
   Core `b7973dd`) keeps working with nullable columns as long as the existing values are there (M2 changes none), but only C6-F code is
   ready for a merchant **without** external identity - so no such merchant is created before the switch.
2. **Staging first**, same procedure, then production, between two Core sync cycles (lock timeout 5 s).

## Pre-application check

Run `docs/runbooks/m2-preflight.sql` (selects only): it must return **no row**. Blockers (M2 raises on the same): `M1_MISSING`,
`UNEXPECTED_COLUMN_STATE` (e.g. M2 already applied), `UNEXPECTED_UNIQUE_CONSTRAINT`, `CONNECTOR_OF_ANOTHER_MERCHANT`,
`NO_MATCHING_CONNECTOR`. The migration list must show M1 once and no M2.

## Proofs to keep before applying

The `merchants` export (all columns), the `merchant_connectors` export, the content fingerprint of every public table, the `merchants`
schema (columns, nullability, constraints, indexes, comments) and the migration list; the sha256 of the M2 file actually applied.

## Behaviour on an anomaly

One transaction; every check runs before the first ALTER; any anomaly raises `P0001` naming merchant ids only (never an external
value, never a secret) and **nothing is changed**. It never picks a connector or a merchant. A second run is refused (the columns are
no longer NOT NULL: "not in the expected state").

## Rollback (`docs/runbooks/m2-rollback.sql`, owner approval only)

Restores the two NOT NULL constraints, nothing else. It first checks that no merchant has a NULL `source_system` or `source_id`; if
one does (typically a merchant created without Shopify after M2), it **refuses** with an explicit message naming those merchants and
changes nothing - it never chooses a connector and never invents or rebuilds an identity; such a merchant needs an explicit owner
decision first. Values, `merchants_source_unique`, `merchant_connectors` and business tables are untouched. After a rollback M2 can be
applied again as is.

## Validation (local, throwaway PostgreSQL 18 - PGlite)

All 27 migrations before M2, then M2, on synthetic data, as one implicit transaction and inside an explicit BEGIN/COMMIT: the three
columns remain, source_system / source_id nullable, source_domain unchanged, `merchants_source_unique` unchanged, every value, UUID,
connector and business row identical, DEPRECATED comments, merchants with the three values NULL accepted (several), identical non-null
identities refused, refusals (missing connector, connector of another merchant, unexpected schema or constraint, second run) with
nothing changed and reported by the preflight, rollback success without NULL and explicit refusal with a NULL, re-application after
rollback. SQL mutants (each check disabled, destructive or data-writing variants, rollback weakened) are all killed.
