# M2 - removal of the legacy merchant identity (runbook)

Migration: `supabase/migrations/20260929170000_merchants_drop_legacy_identity.sql`. Companion files: `m2-preflight.sql` (read only),
`m2-rollback.sql`. Decision: ADR 0003 section 7 (owner decision 2026-09-29: M2 drops the columns instead of only relaxing them).

**Status: prepared locally, applied nowhere.** Nothing in this runbook is to be run without the owner's explicit approval.

## What M2 removes, and only that

| Object | Created by | After M2 |
|---|---|---|
| `merchants.source_system` (text, NOT NULL) | `20260920132500_phase1_merchant_identity.sql` | dropped |
| `merchants.source_id` (text, NOT NULL, column comment) | same | dropped |
| `merchants.source_domain` (text, nullable, column comment) | same | dropped |
| `merchants_source_unique` UNIQUE (source_system, source_id) + its index | same | dropped |

Kept: `merchants.id / name / vertical / created_at` (no UUID changes), every `merchant_connectors` row (M1, unchanged), every business
table - their own `source_system / source_id` columns identify synced rows (products, orders, ...), not the merchant.
Verified on the real schemas (read-only, 2026-09-29): production `xbtzjabbseclmqfozjeo` and staging `fvhiammdskpcnfodsnrc` have exactly
these objects; no view, trigger, policy, publication or function depends on the three columns; each has one merchant with exactly one
matching `shopify` connector and the same domain.

## Prerequisites (all required, in this order)

1. **C6-F deployed** on Core, Finance and Analytics in production and stable: no running code reads or writes `merchants.source_*`.
   Production today still runs Finance `21dc924` and Analytics `e593475`, which identify the merchant through `merchants.source_id`:
   M2 before their switch **breaks them**.
2. **No old code can come back**: the production services are still linked to GitHub branches whose heads are pre-C6 code
   (`feature/core-sync-cron` = b7973dd, `feature/finance-shipping-vat-fix` = 21dc924, `feature/explorer-period-selector` = e593475).
   After M2 a push / "Deploy latest commit" / "Redeploy" of one of them would **crash** that service (old Core upserts
   `merchants.source_*`; old Finance / Analytics select by `source_id`). Disconnect or re-point those sources first (owner decision).
3. **Staging first**, with the same procedure, then production.
4. `scripts/finance-db-concurrency-check.mjs` (staging tool, kept, never run on production) inserts a scratch merchant with
   `source_system / source_id`: after M2 on staging it must insert `{ name }` only (one-line change, owner approval) before its next use.

## Pre-application check

1. Run `docs/runbooks/m2-preflight.sql` (selects only): it must return **no row**. Each row is a blocker M2 itself would raise on:
   `CONNECTOR_OF_ANOTHER_MERCHANT`, `NO_MATCHING_CONNECTOR`, `SEVERAL_CONNECTORS_OF_IDENTITY_KIND`, `DUPLICATED_LEGACY_IDENTITY`,
   `DOMAIN_NOT_REBUILDABLE`, `NON_REBUILDABLE_LEGACY_VALUE`, `OTHER_DEPENDENT_OBJECT`, `FUNCTION_MAY_USE_LEGACY_COLUMNS`.
2. The migration list shows M1 once and no M2.
3. The latest Core sync finished (apply between two cycles; the lock timeout is 5 s).

## Proofs to keep before applying (outside the repository, with a sha256 of each file)

- `select id, name, vertical, created_at, source_system, source_id, source_domain from public.merchants order by id` (full export - the
  only exact source for the rollback of a merchant whose connectors changed after M2);
- the full `merchant_connectors` export (all columns);
- a content fingerprint of every public table (row count + md5 of the rows, as used for M1 / C6-C);
- the `merchants` schema (columns, constraints, indexes, comments) and the migration list;
- the sha256 of the M2 file actually applied.

## Behaviour on an anomaly

M2 is one transaction. Every check runs before the first drop; any anomaly raises `P0001` with an explicit message naming the merchant
id(s) (never an external value, never a secret), and **nothing is changed** - no partial state. It never picks a connector or a merchant.
The drop is RESTRICT: an unknown dependent object also aborts everything. A second run is refused ("not in the expected state").

## Rollback (`docs/runbooks/m2-rollback.sql`, owner approval only)

Restores the three columns, their NOT NULL, `merchants_source_unique` and the column comments, in one transaction, without touching
`merchant_connectors`, any business table or any merchant id. Values come, per merchant, from:

1. **the pre-M2 proof** if it is loaded first into the temporary table `m2_proof` (same session) - exact by definition;
2. otherwise **merchant_connectors**: the single connector of a kind with a natural id (`shopify`, `woocommerce`, `prestashop`, `odoo`)
   -> `(kind, external_id, external_domain)`;
3. otherwise the canonical placeholder `('nordla', 'nordla:' || id, null)`.

Exact automatically: every merchant that existed before M2 whose connectors did not change since (M2 only ran when each merchant was
exactly case 2 or case 3). **Ambiguous - the proof is required:**
- a merchant that gained a second external connector after M2 -> the rollback **refuses** without the proof;
- a merchant whose identity connector was deleted after M2 -> it would silently become the placeholder: load the proof;
- a merchant created after M2 has no legacy value by definition -> it gets the placeholder (correct for a merchant without Shopify).

After a rollback, M2 can be re-applied as is. The rollback only serves pre-C6 code; C6-F code does not need the columns.

## Validation (local, throwaway PostgreSQL 18 - PGlite)

All 27 migrations before M2, then M2, on synthetic data, both as one implicit transaction and inside an explicit BEGIN/COMMIT (44/44
each): normal migration, merchant without Shopify intact, three merchants isolated, refusals (missing connector, connector of another
merchant, ambiguity, domain, non-rebuildable value, dependent view / index / function), nothing changed after a refusal, preflight
reports each blocker, UUIDs / connectors / business tables byte-identical, exact disappearance of the columns / constraint / index,
exact rollback (with and without proof), rollback refusal on ambiguity, re-application after rollback. 14 SQL mutants (each check
disabled, CASCADE, data writes, rollback weakened) are all killed. PostgreSQL 18 records NOT NULL as constraints: M2 accepts them
(they are the columns' own); production (older) does not have them.
