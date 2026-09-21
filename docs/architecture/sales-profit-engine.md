# Phase 2A — Sales & Profit engine

Turns the synced Shopify rows (Phases 1A–1C) into deterministic facts and signals. **No LLM anywhere in this layer**; nothing here is a recommendation, dashboard, or autonomous action.

## Layers (all under `src/`)

```
supabase rows ──load.js──▶ ledger.js ──▶ sales.js ─────────▶ per-window metrics
 (only I/O)      (pure)   join + facts    products.js ───────▶ rankings / segments
                                          signals/*.js ──────▶ COMMERCIAL_CANDIDATE / CASH_RISK_SIGNAL
                          quality/rules.js ─▶ quality/flags.js ─▶ data_quality_flags (idempotent)
                          validate.js ─────▶ engine vs Shopify order totals
                          report/build.js ─▶ report/render.js ─▶ reports/*.{json,md} (gitignored)
```

- `metrics/config.js` — versioned generic defaults + `mergeConfig()`. Merchant overrides are data, not code.
- `metrics/windows.js` — merchant-timezone windows, DST-safe; timezone is always a parameter.
- `metrics/costs.js` — the single place that decides whether a cost is usable (`MISSING` → `UNCLASSIFIED`).
- Everything except `load.js`, `flags.js` persistence and the CLI is pure: same rows + same `now` ⇒ same output.

Generic vs merchant: nothing in this layer names or special-cases any merchant. HABB-specific costs (UV ink, labour, depreciation) will arrive later as a vertical cost module + merchant config feeding `product_costs`/cost lines — they are not part of Phase 2A formulas.

## Data-quality flags

Rules in `quality/rules.js` (`MISSING_COST`, `DUPLICATE_SKU_OBSERVATION`, `SUSPICIOUS_FINANCIAL_VALUE`, `UNMATCHED_HISTORICAL_VARIANT`, `REFUND_WITHOUT_EXPECTED_MAPPING`, `STALE_INVENTORY_SNAPSHOT`). Each flag: `rule_code`, entity, `severity`, `details` (evidence), `detected_at`, `status`. Anti-noise choices: missing cost only for variants that sold or hold stock; one duplicate-SKU flag per SKU, not per variant; one stale-inventory flag per merchant. Persistence never duplicates an open flag, respects `ignored`, marks a cleared condition `resolved`, and reopens (new row) if it returns. No schema change was needed for flags.

## Findings that changed earlier phases

1. **Discount mapping (Phase 1C bug, fixed).** `LineItem.totalDiscountSet` is 0 for manual POS discounts; `discountAllocations` carries the real amount and equals Shopify's order-level `totalDiscounts`. The sync now sums `discountAllocations`.
2. **Test orders (schema, additive).** Shopify Analytics excludes test orders; the sync stored one as revenue. Migration `20260921090000_orders_is_test.sql` adds `orders.is_test`; the sync fills it from `Order.test`; every metric excludes it. No data deleted.

## Phase 2A.1 — economic data triage

Engine status (validated against Shopify) is separate from economic-data status (inputs may be incomplete).

- `src/analysis/triage.js`: missing-cost priority groups (P0 sold in window, P1 unsold but stocked, P2 neither), revenue split by cost trust (verified / unverified / estimated / missing), production-cost exposure (reported as an upper bound because the affected subset is not identifiable from synced data), and largest stock positions for physical-count verification.
- `src/analysis/payment-fees.js`: read-only measure of which gateways expose processor fees. Not used in any metric.
- `MISSING_COST` flags carry `priority`; an open flag whose severity/evidence changes is updated in place.
- SKU audit: no sync, join, cost history, inventory mapping or metric uses SKU as identity. The one unsafe use (grouping unmatched historical lines by SKU) was removed; such lines are grouped by title for display only. `DUPLICATE_SKU_OBSERVATION` is an observation, not a key.
- Cost model design note: `cost-model.md`.

Run `npm run metrics:triage` (writes `reports/triage-<date>.json`, gitignored).

## Known limits (deliberate)

- Payment fees not included in CM v0 (see `definitions.md`).
- Costs today are Shopify `unitCost` imports, all `unverified`, and dated after most sales, so profit figures are caveated and never `certain`.
- Order history is what Shopify exposes without `read_all_orders` (~60 days). Windows longer than the history are truncated by the data, not extended.
- Inventory has snapshots, not movements: "no recent sales" compares sales to current stock, it does not know about restocks.

## Commands

```
npm run metrics:report     # reports/report-<date>.{json,md}
npm run metrics:validate   # engine vs Shopify order totals, per window
npm run quality:flags      # detect + persist data_quality_flags
npm run metrics:all        # all three
```
(Run with `node --env-file=.env` — see `.env.example`.)
