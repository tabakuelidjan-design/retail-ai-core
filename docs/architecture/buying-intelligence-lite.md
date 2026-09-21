# Phase 2C — Buying Intelligence Lite

Answers one question for a merchant looking at a new product from a supplier: **is it worth testing?** It compares a merchant-entered candidate with the merchant's own demand and stock facts (Phase 2B). Merchant-generic; no supplier database, no purchasing, no forecasting, no numeric score, no LLM. Nothing in it names a merchant, a region or a trade event.

Run: `npm run buying:evaluate -- <candidate.json> [--policy file] [--stock-verification file]` → `reports/buying-<candidate_id>-<date>.json` (gitignored). Candidate files are the only persistence until a Decision Ledger exists. Merchant policy and stock counts live in `data/local/` (gitignored).

## Verdict

Exactly one of `TEST CANDIDATE`, `NEED MORE DATA`, `AVOID FOR NOW`, from a decision table over named checks — never a blended score.

1. **AVOID FOR NOW** if any *required* check that is allowed to reject has status `FAIL_ROBUST`.
2. Else **NEED MORE DATA** if any required check is `INCOMPLETE`, `BLOCKED` or `FAIL_CONDITIONAL`. The result lists exactly what unlocks each (`unlocks`).
3. Else **TEST CANDIDATE**, with `test_type` = `EVIDENCE_SUPPORTED`, or `EXPLORATORY` (only if the merchant enabled it and no usable peer benchmark exists), the test quantity, and the capital at risk — which is also the maximum loss.

A trustworthy rejection stands even while other questions are open.

### Check statuses and the reliability rule

| Status | Meaning |
|---|---|
| `PASS` | Met; the uncertainty it rests on is listed in `conditional_on`. |
| `FAIL_ROBUST` | Fails **even under the most favourable reading of every uncertain input**, on evidence trustworthy enough to reject on. The only status that can produce AVOID. |
| `FAIL_CONDITIONAL` | Fails on the values entered, but uncertainty could change that → NEED MORE DATA. |
| `INCOMPLETE` | A required input or merchant policy is missing. |
| `BLOCKED` | The evidence is not trustworthy enough to conclude anything. |
| `WAIVED` / `NOT_APPLICABLE` | Replaced by the exploratory path / nothing to check. |

Every input has a **basis**: `QUOTED`, `ESTIMATED`, `ASSUMPTION` (or missing). Money and quantity checks are computed at **best / nominal / worst**: quoted values stay fixed; estimated values move ±`estimateTolerancePct`; a missing component is **0 in the best case** and makes the worst case unknown. A derived value is never more certain than its weakest input.

| Check | Can reject (AVOID)? | `FAIL_ROBUST` requires |
|---|---|---|
| `unit_margin` | yes | Below hurdle at the best-case landed cost **and** the retail price is `DECIDED` **and** any tax conversion is trusted **and** no cost component is an `ASSUMPTION`. An assumed price never supports a rejection. |
| `test_capital` | yes | The minimum purchase exceeds the budget at best-case cost, with a quoted MOQ and no assumed cost. |
| `peer_exposure` | yes | Peer stock is **TRUSTED** (below) and saturated. |
| `capability_fit` | yes | The supplier states "no" to a required capability. |
| `lead_time` | yes | The *quoted* lead time exceeds the limit. |
| `sell_through` | no | Fails only conditionally: reports the largest quantity the horizon supports at peer-median velocity. |
| `peer_benchmark`, `inputs_complete` | no | — |

## Stock trust hierarchy (peer exposure)

Per peer set, unit-weighted from the peers' variant stock:

| Peer stock | Effect on `peer_exposure` |
|---|---|
| **TRUSTED** (≥ 80% of units physically counted and still reconciling) | May `PASS` or `FAIL_ROBUST` (AVOID). |
| **UNVERIFIED** (Shopify-reported, never counted) | May inform. Favourable → `PASS` with caveat `PEER_STOCK_UNVERIFIED` (switchable: `stockTrust.unverifiedMaySupportPass`). Unfavourable → `FAIL_CONDITIONAL` → NEED MORE DATA, with the largest unverified variants to count. |
| **BLOCKED** (≥ 20% of units suspect-round, stale or missing) | `BLOCKED`. |

Exposure is "saturated" when the no-sale share ≥ `exposure.noSaleShare`, cover ≥ `exposure.coverWeeks` (or no demand at all), and the MOQ alone exceeds the sell-through horizon at peer-median velocity. It is judged in **units**: value-based exposure stays `BLOCKED` while the Phase 2B capital gate is `GATED`.

A physical count is a record `{variant_id, counted_units, counted_at}`. It makes a quantity VERIFIED only while it reconciles: counted units − units sold since = Shopify stock now, the count is recent, and stock was synced after the count. Any mismatch leaves it unverified.

## Candidate contract (`docs/examples/buying-candidate.example.json`)

Required for a verdict: `candidate_id` (merchant-assigned), `unit_price`, `moq`, **`expected_retail_price`** (required from the merchant — the peer median is comparison context only and is never used as the price), and a peer set (unless exploratory tests are on). Also used: `landed_cost` components (`freight_per_unit`, `duties_per_unit`, `other_per_unit`, or `not_applicable`), `lead_time_days`, `variants_planned` (when the MOQ is per variant), `test_quantity`, `required_capabilities` / `supplier_capabilities`, `fx_rate_assumption` (if the currency differs; never fetched), `sample_available`, `external_signals`.

Plain numbers get conservative default bases: `unit_price`, `moq`, `lead_time_days` → `QUOTED`; landed components → `ESTIMATED`; `expected_retail_price` → `ASSUMPTION` (use `"basis": "DECIDED"` once the price is fixed). Identity is `candidate_id`; supplier item codes are free text; SKU fields are ignored with a warning. Peer sets are named by the merchant: exactly one of `reference_product_ids`, `collection_ids` (Shopify ids) or an exact `product_type`; nothing is matched by title or text.

## Products with no internal history

A candidate's own history is always empty; demand comes from the merchant-chosen peers, only those observable ≥ 4 weeks and ACTIVE. Sets with fewer than `minPeersForBenchmark` selling peers are `THIN` (individual values listed, no median); with none selling, `NO_DEMAND_EVIDENCE`; with no observable peers, `NONE`. Demand is shown as conditional ranges ("if it sells like the p25/median/p75 peer") plus counts ("4 of 6 sold anything"), never as a forecast. Several peer sets are evaluated separately, never blended; the most severe result decides. Exploratory tests (off by default, `allowExploratoryTests`) waive the peer-demand checks and cap capital at `exploratoryBudget`; margin, capability, lead time and capital still apply.

## Merchant policy (never defaulted)

`buying.testBudget`, `minUnitMarginPct`, `paymentCostPct` are merchant policy: if unset the checks are `INCOMPLETE` — the system does not invent a budget or a hurdle. Structural defaults: `maxSellThroughWeeks` 12, `estimateTolerancePct` 0.25, exposure thresholds 0.6 / 26 weeks, exploratory off, `maxLeadTimeDays` unset (check not applicable). `requiredChecks` is editable.

## Always blocked (stated in every result)

- **Seasonal fit** — internal history is too short; only external multi-year signals could move it to `LIMITED`, never override an internal gate.
- **Margin versus existing products** and **capital exposure value** — while Phase 2B gates are not open.

## Not built

Supplier records and comparison, purchasing, multi-candidate ranking, seasonality, price scraping, LLM narration, persistence beyond files.
