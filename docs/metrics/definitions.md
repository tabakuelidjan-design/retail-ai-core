# Metric definitions — Sales & Profit (version `2A.1`)

Canonical definitions for the deterministic metric layer in `src/metrics/`. If code and this file disagree, that is a bug. Changing a **formula** bumps `METRICS_VERSION` (`src/metrics/config.js`) and needs an entry in `docs/decisions/`; changing a **threshold** (`DEFAULT_CONFIG`) does not. The LLM never computes, adjusts or rounds any of these numbers — it may only narrate what this layer produced.

## Conventions

- **Pricing basis.** Each order carries `taxes_included`. When true, `unit_price` and refund line `amount` already contain tax (TTC); when false they are ex-tax. No metric ever applies a tax rate: the real per-line `tax_amount` captured from the source is used.
- **Line quantities.** `qty = order_lines.quantity`. `gross(line) = qty × unit_price`.
- **Which orders count.** Orders with `is_test = true` (source-system test orders) and orders in a status listed in `excludedOrderStatuses` (default `VOIDED`) are not sales: excluded from every metric and reported under `order_history.orders_excluded`. Orders in another currency than the merchant's main currency are excluded (never FX-converted) and counted.
- **Order date vs refund date.** Sales measures belong to the window containing `orders.ordered_at`. Refund measures belong to the window containing `refunds.refunded_at` (Shopify's convention: money goes back in the period it is returned). Cohort attribution (refund → its order's window) is used only for validation.
- **Rounding.** Sums are exact; each reported figure is rounded to 2 decimals (ratios to 4) once, at output.
- **Windows** (merchant timezone, half-open `[start, end)`): `yesterday`, `last_7_days`, `last_30_days` are complete local calendar days ending at today's local midnight; `available_window` is the last 60 local days through now (Shopify exposes about 60 days of orders without `read_all_orders`). The timezone is `MERCHANT_TIMEZONE`, never hardcoded.

## Cost status (the missing-cost rule)

`resolveUnitCost` (`src/metrics/costs.js`) returns one of:

| Status | Meaning | Effect |
|---|---|---|
| `VERIFIED` | `product_costs.validation_status = verified` | Only status that can yield a `certain` profit figure. |
| `UNVERIFIED` | row exists, not verified (all Shopify `unitCost` imports today) | Number computed, never `certain`, caveat `COST_UNVERIFIED`. |
| `ESTIMATED` / `STALE` | as stored | Number computed, never `certain`, caveat `COST_ESTIMATED_OR_STALE`. |
| `MISSING` | no cost row, cost ≤ 0, or cost currency ≠ order currency | **Never estimated, defaulted, averaged or borrowed.** Line revenue stays valid; its cost/profit is `UNCLASSIFIED`. |

Cost choice for a sale: latest row with `effective_from ≤ ordered_at`; if every row is dated after the sale (cost tracking began later), the earliest row is used and the caveat `COST_IS_CURRENT_COST_APPLIED_TO_HISTORY` is attached.

Every profit figure is an object: `value` (null when `UNCLASSIFIED`), `status` (`CALCULATED` all lines costed · `PARTIAL` some lines uncosted · `UNCLASSIFIED` none costed · `NO_SALES`), `margin_pct`, `cost_confidence` (`VERIFIED`/`UNVERIFIED`/`ESTIMATED_OR_STALE`/`NONE`), `certain` (true only for `CALCULATED` + `VERIFIED` + no caveat), `covered_revenue_ex_tax`, `unclassified_revenue_ex_tax`, `caveats[]`. A `PARTIAL` value covers only the costed revenue and says so.

## Metrics

Notation: sums run over the lines / refund lines in the window. `tax_incl` = order has `taxes_included`.

| Metric | Exact formula | Source fields | Refunds | Discounts | Taxes | Missing cost |
|---|---|---|---|---|---|---|
| **gross_sales** | Σ `qty × unit_price` | `order_lines.quantity`, `unit_price` | not deducted | not deducted | as recorded (TTC if `tax_incl`) | n/a |
| **discounts** | Σ `discount_amount` | `order_lines.discount_amount` = Σ Shopify `discountAllocations` on the line (not `totalDiscountSet`, which is 0 for manual POS discounts) | n/a | itself | as recorded | n/a |
| **refunds** | Σ refund-line `amount` (refund date in window) | `refund_lines.amount`, `refunds.refunded_at` | itself (product lines only) | n/a | as recorded | n/a |
| **refunds_non_product** | Σ (`refunds.amount` − mapped product-line amounts) — shipping / manual adjustments | `refunds.amount`, `refund_lines` | reported apart | n/a | n/a | n/a |
| **net_sales** | `gross_sales − discounts − refunds` | above | deducted | deducted | as recorded | n/a |
| **tax** | Σ `tax_amount` − Σ refund-line `tax_amount` | `order_lines.tax_amount`, `refund_lines.tax_amount` | tax on refunded lines removed | already net of discount (captured after discount) | real captured amounts only | n/a |
| **net_sales_ex_tax** | Σ line (`tax_incl ? gross − discount − tax : gross − discount`) − Σ refund line (`tax_incl ? amount − tax : amount`) | above | deducted ex tax | deducted | removed only when `tax_incl` | n/a |
| **units_sold** | Σ `qty` | `order_lines.quantity` | gross units; `units_refunded` reported separately | n/a | n/a | n/a |
| **order_count** | count of countable orders with `ordered_at` in window | `orders` | a fully refunded order still counts (its refund is in refunds) | n/a | n/a | n/a |
| **aov** | `net_sales / order_count` (null if 0 orders); `aov_ex_tax` uses `net_sales_ex_tax` | above | net of refunds by refund date | net | as noted | n/a |
| **product_revenue** | `net_sales_ex_tax` grouped by `variants.product_id` (unmatched historical items get their own bucket) | + `variants.product_id` | as above | as above | as above | revenue stays valid |
| **variant_revenue** | `net_sales_ex_tax` grouped by `variant_id` | as above | as above | as above | as above | revenue stays valid |
| **COGS** | Σ over **costed** lines `qty × unit_cost`; `null` when no line is costed | `product_costs.unit_cost` via cost resolution | default `no_recovery`: refunded units stay in COGS (a refund is not a restock). Config `cogsRefundTreatment = restocked` subtracts refunded units' cost | n/a | cost taken as stored (ex-tax) | uncosted lines are excluded and counted in `unclassified_revenue_ex_tax` |
| **cost_coverage_pct** | costed line revenue ex tax ÷ total line revenue ex tax (before refunds) | — | n/a | net of discounts | ex tax | this **is** the missing-cost measure; `verified_cost_coverage_pct` counts `VERIFIED` only |
| **gross_profit** | Σ costed line revenue ex tax (after discounts, before refunds) − COGS | above | not yet deducted (see CM) | deducted | ex tax | `UNCLASSIFIED` / `PARTIAL` as above |
| **contribution_margin_v0** | `gross_profit − Σ costed refund lines ex tax − payment_fees` where `payment_fees` is **omitted** (see below) | above | deducted (ex tax, cost not recovered by default) | deducted | ex tax | as above |

`margin_pct` = value ÷ costed revenue base (gross profit: costed line revenue ex tax; CM: costed net sales ex tax).

### Contribution margin v0 — what is and is not in it

Included (reliable today): net sales ex tax, product COGS, discounts, product-line refunds.

**Omitted, documented:** payment / transaction fees. The Phase 1C sync does not persist them; Shopify exposes `OrderTransaction.fees` only for `shopify_payments` transactions (none for cash/other gateways), so a sync today would give partial coverage, not a reliable figure. Every CM value therefore carries `PAYMENT_FEES_NOT_INCLUDED` and is never `certain`; `payment_fees.status = UNAVAILABLE`. Also deliberately excluded: marketing spend, labour, UV ink/consumables, machine depreciation, shipping landed cost, shipping revenue. Shipping-only refunds are reported as `refunds_non_product` and are not part of CM (shipping revenue is not tracked either).

## Product performance and signals

Facts first. Segments (`src/metrics/products.js`) echo their exact criteria; signals (`src/signals/`) are threshold checks over those facts. All thresholds live in `DEFAULT_CONFIG` and are overridable per merchant. None of it labels a product "good" or "bad", none is a recommendation.

- **Rankings:** top by `net_sales_ex_tax`, `units_sold`, `gross_profit`, `contribution_margin_v0` (profit rankings skip `UNCLASSIFIED` rows).
- **Segments:** low-selling inventory · stock with no recent sales · sales with missing cost · high refunds · strong sales + margin + stock.
- **`COMMERCIAL_CANDIDATE`:** units ≥ `minUnits` **and** CM margin ≥ `minMarginPct` **and** stock ≥ `minStock` **and** refund rate ≤ `maxRefundRate`, with a computable margin. Reason codes list each passed check plus the cost caveat. Confidence: `VERIFIED` cost → HIGH, `UNVERIFIED` → MEDIUM, estimated/stale → LOW; partial cost coverage → LOW; fewer than `highConfidenceUnits` sold → one level lower. A product with no reliable cost is never a candidate.
- **`CASH_RISK_SIGNAL`** reason codes: `NO_RECENT_SALES_WITH_STOCK`, `HIGH_STOCK_LOW_VELOCITY`, `MISSING_COST`, `LOW_MARGIN`, `NEGATIVE_MARGIN`. Evidence includes stock units and stock value at cost (with its cost confidence; `UNCLASSIFIED` when no stocked unit has a cost).

## Validation

`npm run metrics:validate` recomputes the engine's order-cohort totals and compares them with Shopify's own order-level totals (`subtotalPriceSet`, `totalDiscountsSet`, `totalTaxSet` minus shipping tax, `totalRefundedSet`, `currentSubtotalPriceSet`) for every window: order count, gross sales, discounts, product refunds, total refunds, product tax, net sales. Differences are printed, exit code 2 if any exceed 0.005. Results contain real merchant figures and are therefore kept in the gitignored `reports/` directory and the phase review, not in this repository.
