# Phase 1A — Shopify Catalog Sync (merchant, locations, products, variants)

Status: executed manually this session via the Shopify + Supabase MCP connectors (interactive/dev channel — see `CLAUDE.md` §6 on why this is a development convenience, not the production integration path). No automated/headless script runs unattended yet; this document is the reference implementation to build that script from.

## Scope (Phase 1A only)

Imported: `merchants` (HABB only), `locations`, `products`, `variants`.
Explicitly NOT imported: `inventory_snapshots`, `orders`, `order_lines`, `refunds`, `refund_lines`, `product_costs`, `data_quality_flags`.

## Source

Shopify Admin GraphQL API, read-only. No product/inventory/metafield/order/config mutation was ever called. Queries used:
- `locations(first: 20) { id name isActive fulfillsOnlineOrders address { country } }`
- `products(first: 50, after: $cursor, sortKey: ID) { id title handle variants(first: 50) { id title sku } }`, paginated via `pageInfo.hasNextPage`/`endCursor` until exhausted.

## Idempotency design

- Every synced table is keyed by `(merchant_id, source_system, source_id)` (or `(merchant_id, source_system, source_id)` for `variants` per the multi-merchant-safety fix) and upserted via `insert ... on conflict (...) do update set ...` — re-running with the same Shopify data updates in place, never duplicates.
- `merchant_id` is resolved once per run via `select id from merchants where name = 'HABB' limit 1`.

## Known issue found by the idempotency test (must fix before Phase 1B)

`merchants` has **no unique constraint on `name`** (or any natural key). `insert into merchants (...) on conflict do nothing` has no constraint to target, so it silently does nothing to prevent duplicates — it just inserts a new row every time. Discovered when the second sync run created 2 extra orphan `HABB` merchant rows (cleaned up manually this session — the 2 duplicates had zero FK references and were deleted).

**Fix needed (not yet applied — requires its own migration/approval):** add `unique (name)` to `merchants`, or better, a `merchant_key` slug column with a unique constraint, since a display `name` isn't guaranteed stable long-term. Until fixed, any real automated re-run of this sync is at risk of creating duplicate merchant rows.

## Data-quality observations (reported only — nothing written to `data_quality_flags` yet, per Phase 1A scope)

- 213 of 339 variants (63%) have a `null` SKU.
- 126 variants have a non-null SKU, but only distinct across a fraction of them: 28 SKU values are reused across 2–7 different variants each (e.g. `GEN-016` appears on 7 different variants across different "coffret cadeau" products). SKUs at HABB are **not** a reliable identity — confirms the schema decision to never key on `sku`.
- 0 products with zero variants.
- 0 products with a missing/empty handle.
- 1 Shopify location ("Habb"), `type` set to `'unknown'` — Shopify's `Location` object has no field cleanly mapping to store/warehouse/online, and this location both has a physical address and `fulfillsOnlineOrders: true`, so inventing a type would violate "never fabricate missing data."
