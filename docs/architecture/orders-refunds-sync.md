# Phase 1C — Orders, order lines, refunds, refund lines runtime sync

Read-only against Shopify (`read_orders` scope only — no `read_all_orders`, no write scope). Runtime code only (`src/sync/orders.js`), no Claude/MCP dependency. No customer PII collected or stored.

## Scope decision: 60-day window, no `read_all_orders`

Shopify's `Order` GraphQL object exposes at most the **last 60 days** of orders unless the app also has `read_all_orders` (a protected-data scope). HABB's real order history at inspection time (2026-09-20): store created 2026-05-11, 70 orders total ever, 61 in the last 90 days, **45 in the last 60 days**. The owner explicitly chose the 60-day window and declined `read_all_orders`. `src/sync/orders.js` builds its Shopify search query as `created_at:>=<today-60d>` — it never assumes access beyond that window.

## Incremental sync strategy

**Chosen: refetch the full 60-day window every run, upsert everything idempotently by `source_id`.** This is not "reload entire history" — Shopify itself caps the window at 60 days regardless of what this code asks for. Reasons this is the simplest *safe* choice for V1, not a shortcut:

1. **Refunds arrive after order creation.** A "only fetch orders created since last run" cursor would permanently miss a refund added next week to an order from last month — the order itself wouldn't be "new" anymore. Refetching the window means every order still inside it gets its refund state re-checked every run.
2. **Volume is tiny.** ~45 orders currently; refetching costs nothing meaningful.
3. **Idempotency makes reruns free.** Every table upserts on its real Shopify `source_id` (see below), so refetching the same order twice never duplicates it.

**Documented upgrade path, not implemented now:** once order volume grows enough that refetching 60 days of orders on every run becomes expensive, switch to a persisted watermark (e.g. a small `sync_state` table storing the max `updatedAt` seen) with a safety overlap window, and query `updated_at:>=<watermark - overlap>` instead of the full window. Not built now — would be solving a problem 45 rows don't have.

## Idempotency keys

| Table | Upsert key |
|---|---|
| `orders` | `(merchant_id, source_system, source_id)` — Shopify Order GID |
| `order_lines` | `(order_id, source_system, source_id)` — Shopify LineItem GID |
| `refunds` | `(order_id, source_system, source_id)` — Shopify Refund GID |
| `refund_lines` | `(refund_id, order_line_id)` — `RefundLineItem.id` is itself nullable in Shopify's own schema (confirmed in Phase 1B inspection), so it cannot be the key; the composite of parent refund + the order line it affects is stable instead. |

## No customer PII

`src/shopify/queries.js`'s `ORDERS_PAGE_QUERY` does not select `email`, `phone`, `shippingAddress`, `billingAddress`, `customer`, or any name field — not "fetched then discarded", simply never part of the GraphQL selection. `src/sync/normalize.js`'s order/refund normalizers take no such fields as input and cannot forward what they never receive.

## Mapping report: data needed → Shopify availability

| Data needed | Availability | Notes |
|---|---|---|
| Order currency, taxesIncluded, financial status | **Available** | `currencyCode`, `taxesIncluded`, `displayFinancialStatus` |
| Order location (in-store vs online) | **Available** | `Order.retailLocation` — confirmed populated for HABB POS orders, `null` for online orders (correct, not missing data) |
| Line item title/sku/quantity/variant | **Available** | `LineItem.title/sku/quantity/variant.id` |
| Line item unit price (at order time) | **Available** | `LineItem.originalUnitPriceSet` |
| Line item discount | **Available** | `LineItem.totalDiscountSet` |
| Line item tax amount (real, not a rate) | **Available** | `LineItem.taxLines[].priceSet` — confirmed real BE TVA data in Phase 1A/1B inspection, reused here |
| Refund amount, per-line refund quantity/amount/tax | **Available** | `Refund.refundLineItems[]` — `quantity`, `subtotalSet`, `totalTaxSet`, `lineItem.id` (confirmed on a real refunded HABB order in Phase 1A) |
| Shipping charged to customer | **Available in Shopify** — `Order.shippingLine.originalPriceSet` | **Not persisted this phase** — no column exists for it in the current schema (`orders`/`order_lines`), and adding one is a schema change out of scope for "don't over-engineer yet, report first" |
| Shipping discounts | **Available in Shopify** — `ShippingLine.discountAllocations` | Same as above — not persisted |
| Payment gateway | **Available in Shopify** — `OrderTransaction.gateway`/`formattedGateway` (confirmed real values: `cash`, `shopify_payments`) | Not persisted this phase |
| Shopify Payments processing fees | **Available, partially** — `OrderTransaction.fees` (confirmed real data: e.g. 0.39 EUR fee on a 57 EUR order) | Only populated for `shopify_payments` transactions, not for `cash` or other gateways — this is a real gap in the data, not a sync limitation. Not persisted this phase. |

Shipping and payment-fee data exist and are confirmed real in Shopify; they are deliberately **not** added to the schema or sync in Phase 1C to avoid a schema change beyond this phase's stated scope. They are available to pull in a future phase without any further Shopify-side investigation.
