# Buying rehearsal workflow

Goal: before a sourcing trip, evaluate a few real supplier products one at a time and learn what the tool needs from you. Each candidate is judged **independently** (no ranking). The tool answers "is a small test justified?" — it does not buy, forecast seasonality or compare suppliers.

## One-time setup

1. Copy the policy template to `data/local/buying-policy.json` and fill in the decisions you have made. Leave undecided values `null`: the result will say exactly what is missing (`docs/operations/buying-policy-calibration.md`).
2. `npm run sync:all` (fresh stock and sales), then `npm run buying:peer-sets` to see the peer sets you can name.

## Per candidate (about five minutes)

1. Copy the candidate template; one file per supplier product; give it a `candidate_id` you choose.
2. **Enter what you know; leave the rest `null`.** Unknown is allowed — the result lists what it blocks.
3. `npm run buying:evaluate -- data/.../my-candidate.json` → read `reports/buying-<id>-<date>.json`.
4. Read the verdict (below), act on `unlocks`, edit the file and run again. Repeat until the verdict is stable.

## What you enter

| Field | Required? | Notes |
|---|---|---|
| `candidate_id`, `name` | id required | Free text name; never an identifier. Supplier codes go in `supplier_item_ref` (free text). No SKU logic. |
| `unit_price` | yes | `basis` `QUOTED` when the supplier stated it. |
| `moq` (+ `per`, `variants_planned`) | yes | `per_order` or `per_variant`; for per-variant also the number of variants you would buy. |
| `expected_retail_price` | **yes — from you** | The tool never uses the peer median as your price. `tax_basis` incl/excl. |
| `landed_cost` freight / duties | may stay unknown | Missing = lower bound, never zero. Use `not_applicable` only if it truly is zero. |
| `lead_time_days` | may stay unknown | Needed only if you set a lead-time limit. |
| `test_quantity` | optional | Defaults to the MOQ; cannot be below it. |
| `required_capabilities` / `supplier_capabilities` | optional | `yes` / `no` / `unknown` per capability. A supplier "no" rejects; "unknown" asks you to ask. |
| `currency` + `fx_rate_assumption` | if not in the merchant currency | Never fetched. |
| `peer_sets` | **yes** (unless exploratory tests are on) | See below. |

**What must be `DECIDED`:** only the expected retail price, and only if you want it able to support an `AVOID`. `basis: "DECIDED"` means the price is actually fixed. While it is `ASSUMPTION` (the default), a margin failure can only produce `NEED MORE DATA` ("confirm the price").
**Bases:** `QUOTED` (supplier's number), `ESTIMATED` (your estimate), `ASSUMPTION` (a guess). A rejection cannot rest on an `ASSUMPTION`, and an estimate is tested at ±the policy tolerance to see whether the conclusion could flip.

## Choosing peer sets

The tool never matches by title or SKU: **you** name the existing items the candidate should be compared with.
- `reference_product_ids` — best: a few existing products you consider similar (Shopify product ids: the `gid://…` from `npm run buying:peer-sets -- --products`, or the number in the admin URL).
- `collection_ids` — a collection that holds the same kind of product (ids from `buying:peer-sets`).
- `product_type` — an exact product type (not `UNCLASSIFIED`).

You can list several sets; each is evaluated separately and the most severe result decides. A set must have enough *selling* peers to count: `USABLE` (≥ the configured minimum selling peers), `THIN` (facts shown, no median), `NO_DEMAND_EVIDENCE` or `NONE`. A brand-new kind of product has no peers: it can only become an `EXPLORATORY` test if you switched exploratory tests on and set a strict exploratory budget.

## When physical stock verification is required

Stock only affects the verdict through the **peer exposure** check.
- Peer stock is Shopify-reported and never counted → it can pass, but a "too much stock" finding becomes `NEED MORE DATA` and lists the variants to count.
- Suspect / stale / missing quantities → the check is `BLOCKED` until you count.
- To allow a stock-based `AVOID`, count enough of the peer set (policy `trustedShare`): `npm run buying:peer-sets -- --count-sheet <collection id or product type>` writes a sheet of the largest variants; fill `counted_units` and `counted_at`, **correct Shopify to the counted numbers, run the sync**, and save the sheet as `data/local/stock-verification.json`. A count only holds while it reconciles with Shopify (counted − sold since = stock now); a mismatch leaves the stock unverified.

## Reading the verdict

| Verdict | Meaning | What to do |
|---|---|---|
| **TEST CANDIDATE** | Every required check passed. `test_type` is `EVIDENCE_SUPPORTED` (usable peer benchmark) or `EXPLORATORY`. The capital at risk is also the maximum loss. | Read `caveats` and `conditions`; buy no more than the stated test quantity. It is not a forecast: seasonality is never assessed. |
| **NEED MORE DATA** | Something is missing, blocked, or fails only on uncertain values. | Read `unlocks`: each item says exactly what to supply, count or confirm. Nothing negative is being claimed. |
| **AVOID FOR NOW** | A check fails **even under the most favourable reading of every uncertain input**, on trustworthy evidence (`FAIL_ROBUST`), e.g. quoted lead time over the limit, verified peer over-stock, a supplier "no" to a required capability, margin below the hurdle at a decided price. | The reason code names the check. Change the underlying fact (a lower MOQ, another price) and re-run; "for now" means it can change. |

Always present in the result: `blocked_conclusions` (seasonal fit; margin and capital value versus existing products) — these are not assessed and never silently assumed.

## Rehearsal checklist (3–5 real products)

- [ ] Policy decided (or consciously left `null`) and saved in `data/local/buying-policy.json`.
- [ ] Fresh sync done today; `buying:peer-sets` reviewed; unclassified products noted.
- [ ] Pick 3–5 real products, ideally: one in a category with strong internal sales, one in a saturated category, one genuinely new, one with an unknown landed cost.
- [ ] For each: enter only what you truly know; run; read verdict, `unlocks`, `caveats`.
- [ ] Fill one unknown at a time and re-run to see which input changes the verdict.
- [ ] For at least one peer set, run a count sheet and complete a physical count; confirm the stock becomes `TRUSTED` (or find out why it does not reconcile).
- [ ] Note every field you could not fill at the supplier and why; that is the real input list for the trip.
