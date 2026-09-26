# One canonical Shopify sync for Analytics and Finance (proposal - NOT implemented)

Status: proposal, written 2026-09-26 after the shipping / refund / VAT work. Nothing below is implemented yet.

## Problem

`retail-ai-core` is one repository, but Analytics and Finance were developed on two long-lived branch lines that both carry their own copy of the
Core code (Shopify sync, metrics ledger, Supabase client, migrations). The copies have drifted:

| Piece | Analytics line | Finance line |
|---|---|---|
| Order sync window / backfill (`history.js`, `--full-history`, coverage marker) | missing (60-day window only, plus a light `--since`) | present |
| `order_lines.tax_rate_bp` capture (needed for VAT by rate in the Pack) | missing | present |
| Shipping, refund shipping, order reference, `sync_runs` run log | identical (same commit was cherry-picked) | identical |
| Explorer / Customers / Products report modules | present | absent |

Real consequence (2026-09-26): a sync run from the Analytics line wrote order lines WITHOUT `tax_rate_bp`, which made the Pack VAT PARTIAL until the
Finance-line sync was re-run. Two implementations of the same Shopify interpretation is the exact risk to remove.

## Target

`retail-ai-core` `src/sync`, `src/shopify`, `src/supabase`, the shared metrics inputs (`src/metrics/load.js`, `ledger.js`, `sales.js`, `windows.js`) and
`supabase/migrations` exist ONCE. Analytics and Finance only READ what Core wrote to Supabase. Only the Railway Core service runs the sync.

## Smallest safe migration (four steps, each reversible)

1. **Canonical branch, no behaviour change.** Create `core/canonical` from the Finance line (it is the superset for sync: backfill + tax rate + shipping +
   run log + scheduler). Add ONE guard test: it lists the canonical paths above and fails if any file differs from a checked-in manifest of SHA-256
   hashes. Run the existing suites (Finance 602 tests, Analytics 400 tests) against it.
2. **Analytics consumes it.** On a new Analytics branch, replace those paths with the canonical versions (`git checkout core/canonical -- <paths>`), keep
   every Analytics-only file. Run the Analytics suite; re-run the 90-day Shopify reconciliation (script kept in the validation notes); deploy to staging.
   The Analytics service never runs `src/sync` (it only reads reports built from Supabase), so nothing else changes.
3. **Finance consumes it.** Same operation on the Finance branch (it is already identical, so this is a no-op plus the guard test).
4. **Railway.** The Core service deploys `core/canonical` only. Analytics and Finance services deploy their module branches, which contain the same
   canonical files verified by the guard test. Then delete the old sync copies from history-facing docs and mark the two old branches as superseded (tags,
   not deletion).

Why not a package or a monorepo right now: the guard-test approach needs no build tooling change and is fully reversible. When a third module appears,
the same canonical paths can move to an internal package (`@nordla/core`) consumed by all modules; that is a mechanical follow-up, not a prerequisite.

## Rules that keep it single

- Sync business logic changes only on `core/canonical`; module branches take them by merge, never by edit. The guard test enforces it in CI/`npm test`.
- Migrations live only in the canonical `supabase/migrations`; they are applied to the dev project first, then reviewed for production.
- Modules never call Shopify for order data. Analytics and Finance read Supabase; anything they still fetch live (for example catalogue prices in
  Finance) is listed in the guard manifest as an explicit exception with an owner.

## Risks and rollback

- Risk: the Analytics line loses no behaviour because it never depended on its own (older) sync for correctness; the risk is only merge conflicts in
  `src/metrics/*` (Analytics adds report modules on top). Mitigation: step 2 replaces only the listed paths and keeps a diff review.
- Rollback: each step is a branch; the services can be pointed back to their previous branches (kept as tags) in the Railway dashboard.
- Data: no data migration. The `sync_runs` table and shipping columns already exist in dev.
