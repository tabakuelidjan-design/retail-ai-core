# ADR 0002 — Sales & Profit metric definitions (2A.1)

**Status:** accepted for review, Phase 2A.

## Decisions

1. **Deterministic layer, no LLM.** All financial numbers come from `src/metrics/`; an LLM may only narrate them.
2. **Missing cost is `UNCLASSIFIED`.** A line/product without a reliable cost (no row, cost ≤ 0, currency mismatch) keeps valid revenue but has no profit. Aggregates are `PARTIAL` and state their cost coverage. Unverified/estimated/stale costs produce numbers that are never `certain` and carry their caveat.
3. **Net sales convention follows Shopify:** `gross − discounts − refunds`, refunds recognised on the refund date, product-line refunds only; shipping/adjustment refunds are reported separately. Validated to the cent against Shopify order totals and Shopify Analytics.
4. **Tax:** real captured per-line tax only; ex-tax figures subtract it only for tax-inclusive orders.
5. **Refunds do not recover cost by default** (`cogsRefundTreatment = no_recovery`): a refund is not evidence of a restock. Configurable.
6. **Contribution margin v0 omits payment fees** because they are not persisted and Shopify only reports them for Shopify Payments transactions; omission is stated on every value. Marketing, labour, consumables, depreciation and shipping landed cost are excluded until reliable generic or vertical data exists.
7. **Test orders are not sales** (`orders.is_test`, additive migration).
8. **Discount source is `discountAllocations`** (Phase 1C mapping corrected).

## Consequences

Changing any formula above bumps `METRICS_VERSION` and adds an ADR. Thresholds for segments/signals are configuration and may change without a version bump.
