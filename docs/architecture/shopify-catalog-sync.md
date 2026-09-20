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

## Merchant identity fix (`phase1_merchant_identity` migration)

The idempotency test found a real bug: `merchants` had no unique constraint on `name` (or any natural key), so `on conflict do nothing` had nothing to target and silently inserted a new row on every run — 2 orphan duplicate `HABB` rows were created and deleted manually.

**Rejected fix:** `unique(name)` — a display name is not a technical identity; two different future merchants could share a name, and this one merchant's own name could change.

**Applied fix:** a separate, additive migration (`supabase/migrations/20260920132500_phase1_merchant_identity.sql`) adds:
- `source_system` (e.g. `'shopify'`)
- `source_id` — the Shopify **Shop GID** (`gid://shopify/Shop/98815246684`), fetched read-only via `shop { id }`. This is what the sync now upserts on: `on conflict (source_system, source_id) do update ...`.
- `source_domain` (e.g. `zmb5jr-wf.myshopify.com`) — **informational only**, not part of identity or uniqueness. A domain can change (custom domain setup, platform migration) independently of the merchant itself, so keying on it would be as fragile as keying on `name`. It exists purely so a human reading the table doesn't have to decode a GID to recognize which store a row is.
- `unique (source_system, source_id)` constraint.

`name` remains a plain display field — never unique, never used for sync identity.

Verified before migration: exactly 1 `HABB` merchant row existed. After migration: still exactly 1 row, now carrying the real identity. The catalog sync's merchant upsert was updated to key on `(source_system, source_id)`, never `name`.

## Idempotency test — post-fix (2 full runs)

| | merchants | locations | products | variants |
|---|---|---|---|---|
| Run 1 | 1 | 1 | 175 | 339 |
| Run 2 | 1 | 1 | 175 | 339 |

0 new rows of any kind on the second run. No diagnosis needed — clean pass.

## Data-quality observations (reported only — nothing written to `data_quality_flags` yet, per Phase 1A scope)

- 213 of 339 variants (63%) have a `null` SKU.
- 126 variants have a non-null SKU, but only distinct across a fraction of them: 28 SKU values are reused across 2–7 different variants each (e.g. `GEN-016` appears on 7 different variants across different "coffret cadeau" products). SKUs at HABB are **not** a reliable identity — confirms the schema decision to never key on `sku`.
- 0 products with zero variants.
- 0 products with a missing/empty handle.
- 1 Shopify location ("Habb"), `type` set to `'unknown'` — Shopify's `Location` object has no field cleanly mapping to store/warehouse/online, and this location both has a physical address and `fulfillsOnlineOrders: true`, so inventing a type would violate "never fabricate missing data."
