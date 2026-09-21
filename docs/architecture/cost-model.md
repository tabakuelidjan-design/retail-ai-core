# Cost model — minimum future components (design note, not implemented)

**Status:** design only. Phase 2A.1 deliberately builds no production-cost system. This note fixes the *shape* so later work stays merchant-generic and does not change the definitions in `docs/metrics/definitions.md` (which stay valid: cost enters the engine through `product_costs`, with a trust status).

## Why this matters

Today the only cost the core knows is one purchased unit cost per variant (`product_costs.unit_cost`, imported from the source system, `validation_status = unverified`). For a merchant that customises or produces items in-house, that number omits real variable cost, so gross profit and contribution margin v0 are **upper bounds**, not margins. The engine already says so (`certain = false`, caveats); the components below are what is needed to shrink that gap.

## Minimum components the core should be able to represent

Each component: an amount, a currency, a **basis** (how it scales), `effective_from`, a `source`, and its own `validation_status` (`verified` / `unverified` / `estimated` / `stale`). A missing component is `MISSING` — never defaulted to zero, never estimated.

| Component | Basis | Generic meaning |
|---|---|---|
| Purchased unit cost | per unit | What the merchant paid for the finished good or blank. (Exists today.) |
| Inbound / landed extras | per unit or % of purchase | Freight, duties, handling — optional, only when material. |
| Production consumables | per unit | Materials consumed to produce or customise one unit (ink, film, adhesive, etc.). |
| Variable production cost | per unit or per minute × minutes | Labour and machine time that scale with volume, if the merchant chooses to treat them as variable. Fixed overhead and depreciation are **not** variable cost. |
| Packaging | per unit or per order | Box, wrap, insert, label. |
| Transaction / payment cost | % of order + fixed per order | Processor fees actually charged. Basis is the *order*, not the unit. |
| Waste / remake allowance | % of units | Only if the merchant records it; otherwise absent, not guessed. |

Shipping landed cost, marketing spend and overhead stay out of variable cost (they belong to later contribution-margin extensions).

## How it fits without a rewrite

- `product_costs.source` already allows `vertical_module_computed`. A vertical module (e.g. "in-house production") can compute an **all-in variable unit cost** from merchant configuration and write it as a normal `product_costs` row. The metric engine needs no change: it already resolves, dates, trust-labels and carries caveats for that row.
- The row's `validation_status` must be the **weakest** status of its components (one unverified component makes the total unverified). Component-level detail would live in the row's provenance or a future `cost_components` table — added only when a merchant actually needs component reporting.
- Per-order components (payment cost, per-order packaging) attach to orders, not variants. They enter contribution margin as a separate deduction, exactly like `payment_fees` is reserved today (`status: UNAVAILABLE` until persisted).

## Generic core vs vertical module vs merchant configuration

- **Core:** the component vocabulary, dating, trust status, `MISSING`/`UNCLASSIFIED` rules, and the arithmetic. Nothing named after a merchant or a process.
- **Vertical module** (only for merchants that opt in, e.g. in-house production): the formula that turns configured inputs into a variable unit cost.
- **Merchant configuration** (`config/merchants/<merchant>/`): the *values* — consumable usage per product family, minutes per item, packaging per order, which products are subject to production cost.

## Prerequisite that the core cannot infer

Deciding which products carry a production cost needs a classification the synced data does not contain (product type / tag / "customised" flag). Until the merchant supplies it, "revenue affected by missing production cost" can only be reported as an upper bound (all costed revenue). Providing that classification is a merchant-configuration task, not an engine change.
