# Phase 2B — Demand & inventory signals

Merchant-generic facts about what sells, how consistently, and what stock stands behind it. Deterministic, provenance-carrying, facts only: **no recommendations, no supplier logic, no buying logic, no LLM.** Formulas: `docs/metrics/demand-inventory-definitions.md`.

## Where this sits

Pipeline: data → data quality → **metrics (2A sales/profit, 2B demand/inventory)** → rules/decision engine (not built) → LLM explanation → human → ledger. The repository had no written Phase 2 spec beyond this pipeline; 2B was earlier described as growth/marketing-centred. That work is deferred, not dropped: these facts feed growth as well as buying.

## Scope (2B.1)

1. Category dimension: `products.product_type`, `source_created_at`, `source_status`, and `product_collections` (additive migration `20260921120000_catalog_demand_dimensions.sql`; catalog sync fills them; removed memberships are retired, never deleted). Vendor and tags are deliberately not captured — they are supplier / free-form concepts outside this phase.
2. Per product and variant: weekly series, velocity, sales pattern, trend, stock, cover, sell-through, inventory class, reorder-relevant facts.
3. Per category and collection: demand, benchmarks, exposure.
4. Portfolio: revenue concentration, stock exposure.
5. Provenance (`input_status`) and gates on every record.

Run `npm run metrics:demand` (reconciles sales with Shopify first, then writes `reports/demand-facts-<date>.json`, gitignored: it contains real merchant figures).

## Outputs a future Buying Intelligence layer would read

The future question — *"the merchant sees a product at a supplier; how does the proposed purchase compare with real demand, stock, capital exposure and related products?"* — maps to fields (also listed in the output's `contract` block):

| Part of the question | Facts that answer it |
|---|---|
| Real historical demand | `demand.*` (velocity, pattern, trend, units per order, price), `reorder_facts` |
| Existing stock | `inventory.*` (units, cover, sell-through, class, quality), `stock_exposure` |
| Capital exposure | `inventory.stock_value_at_cost`, `stock_exposure.value_at_cost`, category `stock_value_share`, `gates.capital_exposure_value` |
| Related product performance | `categories.product_type[]`, `categories.collection[]` benchmarks; product `category` and `collections` — the way to reason about an item that has no history of its own |
| Can I trust it? | `input_status`, `gates`, `data_limitations` |

A comparison for a *new* item needs the merchant to supply, at the time of the question: supplier unit price, MOQ, lead time and quantity considered. Those inputs do not exist in the system and are not part of Phase 2B.

## Gating rules (unchanged principle from 2A)

Revenue-side facts (`demand`) are usable now because sales reconcile with the source. Margin, capital-value and cash-based facts stay `GATED` until costs are verified, complete and confirmed all-in, and stock quantities are trustworthy. A consumer must read the gate, not infer trust from the number.

## Missing data that limits these outputs

- Order history is limited to ~60 days without `read_all_orders`: no seasonality, no year-over-year, thin per-product samples (most products sold from a single order).
- Stock quantities are Shopify-reported and never physically verified; round quantities are marked suspect.
- Costs: unverified, dated after most sales, no production/payment cost model (see `cost-model.md`).
- Category quality depends on the merchant's own `product_type` hygiene; empty stays `UNCLASSIFIED`, and collections overlap.
- No incoming-stock, restock history, supplier price, MOQ or lead time.
- Variant retail price is not stored, so price facts exist only for items that have sold.

## Design choices worth knowing

- A product is judged only over the weeks it existed (`TOO_NEW`, `INSUFFICIENT_HISTORY`); "no sale" never applies to a product added days ago.
- "Consistent" is about *distinct orders across weeks*, not units: five units in one order is `SINGLE_ORDER`.
- Cover is `NO_DEMAND_OBSERVED`, never infinite; sell-through uses Shopify's definition and was checked against Shopify's own reported figure.
- Merchant knowledge is configuration: `gates.unitCostIsAllInVariableCost`, thresholds — never code.
