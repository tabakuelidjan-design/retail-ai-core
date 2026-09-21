# Demand & inventory definitions (version `2B.1`)

Deterministic facts implemented in `src/demand/`. Labels describe observed data; none is a recommendation. Thresholds live in `DEFAULT_CONFIG.demand` / `.gates` (`src/metrics/config.js`) and are overridable per merchant; changing a *rule* below bumps `DEMAND_VERSION`. Sales measures reuse the Phase 2A definitions (`definitions.md`); nothing here recomputes money differently.

## Window and exposure

- **Window:** 8 weekly buckets of 7 merchant-local days, ending at today's local midnight (DST-safe). Today's partial day is not in the weekly series.
- **Units:** gross units sold (`order_lines.quantity`) from countable orders (not test, not `VOIDED`); refunds are reported as `units_refunded_8w`, not netted, because a refunded unit was still demand.
- **Exposure weeks:** the fraction of each bucket the entity existed (`source_created_at`, and never before the merchant's first order), summed. `observable_weeks` counts buckets with at least half exposure. A product added last week is measured over last week only and is never called slow.
- **Identity:** product = Shopify product id, variant = Shopify variant id, category = `product_type` value or `UNCLASSIFIED`, collection = source collection id. SKU is never a key.

## Per product / variant / category

| Fact | Rule |
|---|---|
| `velocity_8w` | units ÷ exposure weeks (null under 1 exposure week). `velocity_4w` uses the last 4 buckets and their exposure. |
| `orders_8w`, `units_per_order` | Distinct orders; median and max units per order for the entity. |
| `pattern` | `NO_SALES` (0 units) · `INSUFFICIENT_HISTORY` (observable weeks < 4) · `SINGLE_ORDER` (one order, however many units) · `ONE_OFF_SPIKE` (all sales in one week, or ≥ 4 units with ≥ 60% in one week) · `CONSISTENT` (active weeks ≥ max(3, half of observable weeks)) · `INTERMITTENT` (otherwise). Evidence numbers are returned with the label. |
| `trend` | Recent half vs equally long prior half of the observable weeks. Needs ≥ 6 observable weeks and ≥ 4 units, else `INSUFFICIENT_DATA` with the reason. `UP`/`DOWN` need a change of ≥ 50% and ≥ 2 units; otherwise `FLAT`. Recent/prior unit counts are returned. |
| `weeks_of_cover` | stock ÷ `velocity_8w`. Statuses: `CALCULATED`, `NO_STOCK`, `NO_DEMAND_OBSERVED` (never "infinite"), `INSUFFICIENT_SALES_SAMPLE` (< 3 units), `INSUFFICIENT_HISTORY`. |
| `sell_through` | units sold ÷ (units sold + current stock), sales counted through the stock-snapshot moment (Shopify's own definition; status `PARTIAL` because ending stock is unverified). |
| `inventory_class` | `NO_STOCK` · `TOO_NEW` · `NO_SALE_IN_WINDOW` · `LIMITED_SALES_SAMPLE` · `SLOW_COVER` (≥ 26 weeks) · `LOW_COVER` (< 4 weeks) · `ACTIVE_COVER`, evaluated in that order. |
| `stock_quality` | `NO_STOCK_DATA` · `STALE` (snapshot > 36h) · `UNRELIABLE_NEGATIVE` · `SUSPECT_ROUND_QUANTITY` (a variant holds ≥ 100 units and a multiple of 50 — descriptive marker of possibly uncounted stock) · `UNVERIFIED`. **Never `VERIFIED`**: the data holds no physical-count evidence. |
| `avg_net_unit_price_ex_tax` | Σ line revenue ex tax ÷ units, for items that sold. |
| `reorder_facts.status` | `SUFFICIENT` only if pattern is `CONSISTENT`/`INTERMITTENT`, ≥ 3 distinct orders, cover is `CALCULATED`, and stock quality is not stale/missing/negative/suspect. Otherwise `LIMITED` with reason codes. "Sufficient" means the facts are adequate to reason about — it is not a reorder recommendation. |

## Category dimensions

- `product_type` is a partition; empty stays `UNCLASSIFIED` (never guessed). `collection` memberships overlap, so collection totals are not additive (`overlapping: true`). An order is counted once per category even when several of its products belong to it.
- Category `benchmarks` (median weekly units per selling product, median units per order, median net unit price) are `USABLE` only with ≥ 3 selling products, else `THIN`.
- `revenue_share`, `stock_value_share`, `sell_rate`, `no_sale_stock_share`, category-level pattern/trend/cover use the same rules as products.

## Portfolio

- **Concentration** (`concentrationOf`): top 1/3/5/10 share, number of items to reach 50%/80%, HHI — over products (revenue, units) and product types (revenue).
- **Stock exposure:** units and value at cost by inventory class and by stock quality, with `units_without_cost` kept out of the value (`value_status: PARTIAL`), top-N concentration.

## Provenance and gates (on every record)

`input_status`: `sales_history` (`VERIFIED` only if sales reconciled with the source *and* history ≥ 90 days; `PARTIAL` if reconciled but shorter; `UNVERIFIED` otherwise), `inventory` (stock quality), `cost_on_sales`, `cost_on_stock`, and per product `category` / `product_age`.

`gates` — a consumer must check these before using a fact for a decision:

| Gate | Opens when |
|---|---|
| `demand` | Sales are reconciled, the entity has enough history and sample. `LIMITED` otherwise, with reasons. |
| `margin` | Revenue costs are complete **and** verified (≥ 80%) **and** the merchant has set `gates.unitCostIsAllInVariableCost` (unit cost includes every variable cost). Payment fees are always listed as a caveat until modelled. |
| `capital_exposure_value` | Every stocked unit has a verified cost and the stock quantity is not suspect/stale/negative/missing. Carries `STOCK_QUANTITY_NOT_PHYSICALLY_VERIFIED` when the quantity is merely `UNVERIFIED`. |
| `cover` | Stock quality is not suspect/stale/missing and cover is `CALCULATED`. |

## Not available (declared, not guessed)

Supplier price, minimum order quantity, lead time, incoming stock, restock history, seasonality (history is ~8 weeks), and retail price for items that never sold.
