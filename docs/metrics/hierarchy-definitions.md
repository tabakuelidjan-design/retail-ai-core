# Metric definitions — Hierarchical sales analytics (version `H1.1`)

Canonical definitions for `src/metrics/hierarchy.js`. If code and this file disagree, that is a bug. Changing a **formula** bumps `HIERARCHY_VERSION` (`src/metrics/config.js`) and needs an entry in `docs/decisions/`; changing a **threshold** (`DEFAULT_CONFIG.hierarchy`) does not. The LLM never computes, adjusts or rounds any of these numbers — it may only narrate what this layer produced.

## Purpose

Lets a merchant analyze performance by **product, variant, subcategory, category, product group / universe, collection, or sales channel** (e.g. `Tech — last 6 months`), and drill down one level at a time (e.g. `Tech → Earbuds → Product → Variant`), without re-deriving any arithmetic already validated in `sales.js` / `products.js`. Every figure returned here is produced by calling `aggregate()`, `stockValue()` or `buildProductPerformance()` from those modules — `hierarchy.js` only decides **which facts belong to which node**, never how to sum them.

## Source-agnosticism

`hierarchy.js` reads only the generic ledger (`buildLedger` output: `lineFacts`, `refundFacts`, `productById`, `variantById`, `stockByVariant`) plus a source-agnostic `enrichment` object:

```
enrichment = {
  categoryPathByProduct: Map<productId, string[]>   // broadest -> narrowest, e.g. ['Tech','Audio','Earbuds']
  collectionsByProduct:  Map<productId, {id, title}[]>   // many-valued: a product can be in several collections
  channelByOrder:        Map<orderId, {id, title}>
}
```

It never imports `sales-data-adapter.js` and contains no Shopify-specific field name (`product_type`, `product_collections`, `channel_handle`, …). A source system becomes usable by implementing a `SalesDataAdapter` (see `src/metrics/sales-data-adapter.js`) that produces this shape; Shopify is one such adapter (`createShopifySalesDataAdapter`, `deriveEnrichmentFromShopifyShape`), not part of the engine.

## Dimensions

| Dimension | Key | Notes |
|---|---|---|
| `universe` | `categoryPath[0]` | Broadest classification level. |
| `product_group` | `categoryPath[1]` | |
| `category` | `categoryPath[2]` | |
| `subcategory` | `categoryPath[3]` | |
| `product` | `productKeyOf(fact)` (see `products.js`) | Unmatched historical lines get an `unmatched:<title>` key, identical to the product performance report. |
| `variant` | `variantId`, or `unmatched:<title>` | |
| `collection` | collection id | **Many-valued**: a product in two collections contributes its sale to both nodes (this is documented, not a bug — collections are not a partition). |
| `channel` | channel id | From `channelByOrder`; transaction-scoped, so it has no catalog population of its own (see below). |

A product with no mapping for a given level, or a fact whose order has no mapped channel, is reported under the sentinel `Unclassified` — it is never dropped from totals.

## Windows and comparisons

- The analysis window is any window from `windows.js` (`buildWindows`, or a caller-built range) with `localStart`/`localEnd` set.
- **Comparison with the previous equivalent period**: `previousEquivalentWindow(window)` — the immediately preceding window of the same local-day length. A `net_sales_change_pct` / `units_change_pct` is `null` when the previous period's base value is `0` (a percentage change from zero is undefined, never fabricated as `∞` or `100%`).
- **Month-by-month trend**: `buildMonthBuckets(now, timeZone, months)` (default 6, `hierarchy.monthsOfTrend`) — consecutive local-calendar-month buckets ending at the current month, oldest first. The current month is included as a `partial: true` bucket rather than silently omitted.

## Per-node metrics

Each row (one per distinct dimension value in scope) is produced by re-slicing that node's own fact pool (see "Implementation note" below) through `aggregate()`:

| Field | Formula | Source |
|---|---|---|
| `net_sales_ex_tax`, `units_sold`, `units_refunded`, `refunds`, `gross_profit` | unchanged from `aggregate()` (`sales.js`) | same cost-status/caveat model as the product report — `gross_profit.status` is `UNCLASSIFIED`/`PARTIAL`/`CALCULATED`/`NO_SALES`, never a silently estimated number |
| `order_count` | distinct `orderId` among the node's lines in-window | |
| `aov` | `net_sales / order_count` (always computed when `order_count > 0`) | |
| `aov_meaningful` | `order_count >= hierarchy.aovMinOrders` (default 3) | AOV is never suppressed, only flagged when the sample is thin |
| `stock_units`, `inventory_value_at_cost` | `stockValue()` (`products.js`) over the node's variant ids | same `NO_STOCK`/`UNCLASSIFIED`/`PARTIAL`/`CALCULATED` status model |
| `sales_velocity_units_per_day` | `units_sold / window_length_days` | |
| `product_count`, `variant_count` | distinct ids among the node's lines | |
| `comparison_previous_period` | `{window, net_sales_ex_tax, units_sold, net_sales_change_pct, units_change_pct}` | see above |
| `monthly_trend` | `[{month, partial, net_sales_ex_tax, units_sold}, ...]` | see above |
| `top_products`, `declining_products`, `no_recent_sales` | **only for dimensions coarser than product/variant** (i.e. `universe`…`channel`) | reused from `buildProductPerformance()`, filtered to the node's product ids; never reimplemented |

### Top / declining / no-recent-sales products

- `top_products`: node's products with `units_sold > 0`, ranked by `net_sales_ex_tax` then `units_sold`, top `hierarchy.topN` (default 10).
- `declining_products`: node's products whose `units_sold` in the window is lower than in the previous equivalent period (previous period must have had `units_sold > 0`), ranked by the most negative `units_change_pct`.
- `no_recent_sales`: node's **catalog** products (matched, not unmatched historical lines) with `units_sold = 0` in the window and `stock_units > 0`, ranked by `stock_units` descending.

For `universe`/`product_group`/`category`/`subcategory`/`collection`, the node's product population includes catalog products that belong there **even if they have never sold a single unit in the whole order history** — sourced from `enrichment` directly (`categoryPathByProduct` / `collectionsByProduct`), not only from products with sales facts. Without this, a product that never sold would never appear as a fact and would be silently invisible to `no_recent_sales`, defeating its purpose. `channel` has no such catalog population (a product is not intrinsically "in" a channel outside of a transaction), so its breakdown is limited to products that have actually sold or been refunded through that channel.

## Implementation note (not part of the contract, but keeps this cheap)

`analyzeDimension` scopes `lineFacts`/`refundFacts` to the caller's `filter` **once**, groups them by dimension key **once**, and then derives the main window, every month bucket, and the previous-period window by filtering each key's own small fact pool — it does not rescan the whole ledger per bucket per key.
