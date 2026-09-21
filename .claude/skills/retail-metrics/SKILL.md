---
name: retail-metrics
description: Canonical, versioned definitions of retail-ai-core's business metrics. Use whenever a metric is calculated, displayed, or discussed, to ensure the same definition is used everywhere.
---

# Retail Metrics

Canonical definitions for the metrics this system computes. This Skill **documents** definitions — it does not compute them. All actual calculation happens in deterministic SQL/code (see `metric_definitions` / `metric_values` in the Supabase schema proposal at `supabase/proposal/schema.md`).

## Rules

- Calculations must ultimately live in deterministic SQL/code, never be improvised by the LLM at answer time.
- This document is the source of truth for what each metric means. If code and this document disagree, that is a bug — fix one to match the other, don't silently pick one.
- Metric definitions are versioned. Changing a definition (not just its implementation) is a breaking change: bump the version, record why in `docs/decisions/`, and never silently reinterpret historical values under the old definition.
- Claude may not invent a new metric definition ad hoc. A new metric is proposed here first, reviewed, then implemented.

## Exact formulas

As of Phase 2A the exact formulas, source fields and refund/discount/tax/missing-cost treatment for every metric below are versioned in [`docs/metrics/definitions.md`](../../../docs/metrics/definitions.md) (currently `2A.1`) and implemented in `src/metrics/`. That file is the reference for formulas; this Skill remains the reference for intent. Where the bullets below are looser (e.g. "Gross revenue"), the definitions file is the precise version.

## V1 metrics (initial set — do not add advanced metrics without approval)

- **Gross revenue** — total order value before deductions (refunds, discounts already netted per order-line as applicable), summed over the period. Currency-explicit; no implicit FX conversion.
- **Net revenue** — gross revenue minus refunds and discounts for the period.
- **COGS (Cost of Goods Sold)** — the direct cost of the goods sold in the period, per unit cost sourced from `product_costs`. If a product's cost is missing, that line contributes `UNCLASSIFIED`, not zero and not an estimate — it must not silently reduce or inflate COGS.
- **Contribution Margin v0** — `net sales ex tax − COGS` for the period, with **payment fees currently omitted** because the synced data does not carry them reliably (every CM value carries the caveat `PAYMENT_FEES_NOT_INCLUDED` and is never `certain`; see `docs/metrics/definitions.md`). This is v0: it excludes fulfillment, marketing spend, and other overhead by design; do not read it as full net profit. Any order line with `UNCLASSIFIED` COGS makes the whole margin figure `UNCLASSIFIED` for that line, not silently excluded.
- **Payment fees** — the processor fees actually charged for the period's transactions, from the payment provider's data, not estimated from a flat percentage unless that is the only data available (in which case mark the figure as an estimate explicitly).
- **Refunds** — total value refunded in the period, linked to the original order. A refund without a matching original order is a data-quality issue (see `data-quality-rules`), not a valid refund figure.
- **Inventory quantity** — current on-hand quantity per variant per location, as of the last successful sync. Always timestamped with sync recency.
- **Stock coverage** — on-hand quantity ÷ average daily sales velocity over a defined trailing window (window length is a versioned parameter, not a hardcoded constant). `UNCLASSIFIED` when velocity is zero/undefined (e.g. new product with no sales history) rather than shown as infinite or zero.
- **Low stock** — stock coverage below a merchant-configurable threshold. The threshold lives in merchant config, never hardcoded to a single retailer's assumptions.
- **Dead stock** — inventory with no sales over a merchant-configurable trailing window. Same rule: threshold and window are configurable, not hardcoded.

Nothing beyond this list is in scope for V1. Proposing a new metric means adding it here with a full definition and getting it reviewed before any code computes it.
