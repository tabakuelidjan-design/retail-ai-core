# Phase 2E — Customer Intelligence Lite

Deterministic, **order-level** customer-behaviour facts. Observed behaviour only: no prediction, no segmentation, no labels, no recommendations. Run: `npm run customers:report` → `reports/customer-facts-<date>.json` (gitignored).

## The identity constraint

The app is read-only with the `read_orders` scope. Shopify returns **no customer identifier** (not even an opaque id) without `read_customers`; a probe returned `ACCESS_DENIED`. So **no customer identity is stored, read, or reported**, and every metric that needs to know *who* bought is `BLOCKED` rather than estimated. What remains is each order's recorded position in its customer's history (`orders.customer_order_index`, from the source's journey summary) and its lines.

## What is implemented

| Fact | Basis | Status |
|---|---|---|
| New vs returning: orders, order share, revenue share (ex tax), units, AOV | order index | Implemented, order-level |
| Repeat order share (returning orders ÷ orders with a known index) | order index | Implemented; a **lower bound**, not a customer repeat rate |
| Basket size, multi-product share, units per order | order lines | Implemented |
| Co-purchase pairs (products, product types) | order lines | Implemented, listed only above sample thresholds |
| Customers with 1 / 2 / 3+ orders, customer repeat rate, time between purchases | needs a customer key | **BLOCKED** |
| Revenue / orders / units per customer | needs a customer key | **BLOCKED** |
| Top-customer revenue share, concentration risk | needs a customer key | **BLOCKED** |

**Group definitions** (what the recorded index can prove): `returning` = index above 1 on any channel (an earlier order provably exists). `new` = online order with index 1. `first_recorded_pos` = POS order with index 1 — POS is often anonymous, so it is **not** counted as new. `unknown` = no index.

## Provenance and gates

Every block carries: `observation_window`, `completeness`, `sample_size`, `history_limitations` (`SHORT_HISTORY` under `customers.shortHistoryDays`; the source read window; lifetime index vs the visible dataset), `limitations`, `evidence_kind`, and `safe_for_phase3 { safe, reasons }`.

- New-vs-returning is safe only when **both** groups have at least `customers.minOrdersPerGroup` orders.
- Basket pairs need at least `customers.basket.minOrders` orders **and** a pair with `minPairSupport` orders together; otherwise no pair is listed and the block is not safe.
- Repeat behaviour is never safe while customer-level metrics are blocked.
- `src/customers/phase3-contract.js` (`phase3CustomerInputs`) returns a block's facts only when it is safe; otherwise `GATED` with reasons and no numbers.

## Privacy

No customer name, email, phone, address or identifier is fetched (`src/shopify/queries.js` requests none), stored (no column), or reported. Reports contain aggregates plus internal catalogue product ids in basket pairs. Tests assert no `@`, no platform ids and no order ids in the output. Fixtures are synthetic.

## Unlocking the blocked metrics (owner decision, not done)

Granting `read_customers` (plus protected-customer-data approval where required) would allow storing a **pseudonymous key** (a keyed hash of the customer id, key kept in a local secret, never the id itself). That would unlock repeat-rate, time between purchases, per-customer value and concentration, all still aggregate in reports. Not implemented: it widens the app's access, which is the owner's call.

## Out of scope

Predictive CLV, churn prediction, demographic segmentation, email automation, loyalty, CRM, LLM-generated labels, recommendation engine.
