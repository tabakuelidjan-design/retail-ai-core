# Nordla — Marketing M2 · BUILD V1 (contract)

- **Status:** IMPLEMENTED LOCALLY / UNDER AUDIT (architect audit corrections applied) — not pushed, not COMPLETE until push and CI
- **Version:** `marketing-m2-build.v1`
- **Builds on:** [M1 UNDERSTAND](./marketing-m1-understand-contract.md) and [M1.5 signal producers](./marketing-m1-5-signal-producers.md) (both COMPLETE, unchanged)
- **Parent architecture:** [`marketing-v1-architecture.md`](./marketing-v1-architecture.md) §6 and §14
- **Code:** `src/marketing/{m2-constants,m2-validation,lever-fitness,resource-requirements,measurement-plan,push-proposal,socle-decision-package,m2}.js` — public surface `src/marketing/m2.js`
- **Tests:** `test/marketing-m2-build.test.js` · **CI:** `Marketing V1` (covers `src/marketing/**` and `test/marketing*.test.js` automatically)

> **M2 PROPOSES. The Socle DECIDES.**

M2 turns a `MarketingFinding` that is really `READY_FOR_BUILD` into structured Marketing **options**, with their needs, limits, planned measurement and uncertainties, and hands them to the Socle:

```text
MarketingFinding (READY_FOR_BUILD)
   → LeverFitness · AudienceIntent · ResourceRequirements · lead-time fit · MeasurementPlan · Reversibility
   → MarketingPushProposal[]
   → SocleDecisionPackage  (+ DO_NOTHING, + TEST_SMALL explicitly considered)
   → SOCLE
```

It never decides: no approval, no ranking, no winner, no execution, no budget authority, no creative, no price, no stock.

## 1. Rules common to every M2 contract

Same discipline as M1: pure and deterministic (no network, filesystem, database, LLM/VLM, `Date.now()`, random id, environment); **closed schemas** (an unknown key is refused, `MKT_UNKNOWN_KEY`); deep-frozen outputs; caller inputs never mutated or frozen; deterministic ids (`mpp_…`, `mpk_…`, sha256 of the normalized content); opaque references only (no space, `@`, `?`, `&`); explicit ISO-8601 timestamps with an offset. M2 reuses the M1 error class and the M1 codes for shape/scope/timestamp errors; M2-specific conditions have their own `MKT_M2_*` codes (`M2_ERROR`).

**One clock.** The explicit `asOf` is both the Push's `created_at` and the evaluation time of everything computed at build (Finding gate, lead-time fit, readiness).

**Trust boundary.** Tenant, Brand Identity, Finding and all refs come from trusted server-side adapters. M2 validates shape, scope and coherence; it does no authentication or cryptographic verification.

## 2. Finding gate

A Push or a package is built from the **complete** Finding. The builder re-validates it with the M1 contract (`normalizeMarketingFinding`, including tenant/brand scope — a forged materiality `overall` is refused there) and applies the M1 gate **unchanged**: `evaluateFindingReadiness(finding, asOf)` must be `READY_FOR_BUILD`. `STALE`, `REFER_TO_DOMAIN`, `NOT_MEASURABLE` and `NO_MATERIAL_SIGNAL` are refused with `MKT_M2_FINDING_NOT_READY` (the reason is in `error.detail.readiness`). No second readiness logic exists.

`merchant_id` and `brand_id` come from the validated Finding, never from the caller (passing them is refused). An optional resolved Brand Identity is checked against the Finding's brand scope by M1. `finding_ref` is the Finding's `finding_id`. `hypothesis_ref` is optional and must be one of `finding.hypotheses` (`MKT_M2_HYPOTHESIS_UNKNOWN`).

## 3. Lever registry

Closed families: `VISIBILITY`, `OFFER`, `CRM_LIFECYCLE`, `SEARCH_LOCAL`, `PAID_ACQUISITION`. `lever_variant` is an optional UPPER_SNAKE token, extensible and logic-free (examples only: `ORGANIC_SOCIAL`, `STORE_FRONT`, `EMAIL`, `PAID_SEARCH`, `PAID_SOCIAL`, `LOCAL_LISTING`, `BUNDLE`, `CROSS_SELL`). Owned by other domains and therefore refused as family, variant **or channel** (`MKT_M2_LEVER_FORBIDDEN`): `B2B`, `PARTNERSHIP`, `PROSPECTING`, `DIRECT_SALES`, `PRICING`. No price field exists, so Marketing cannot express a pricing authority. `action_mode` is exactly `TEST_SMALL | ACTION`; `DO_NOTHING` is **not** an action mode (it lives in the package).

## 4. Lever Fitness

Four visible axes — `FINDING_FIT`, `AUDIENCE_FIT`, `CHANNEL_FIT`, `MEASUREMENT_FIT` — each `{ status: FIT | NOT_FIT | UNKNOWN | NOT_APPLICABLE, reason_codes[], evidence_refs[] }`. `FIT` / `NOT_FIT` require evidence; `UNKNOWN` / `NOT_APPLICABLE` require a reason. Aggregation (NDR-006: no score, no weight, no number):

```text
any NOT_FIT -> NOT_FIT ; else any UNKNOWN -> UNKNOWN ; else all applicable FIT (>= 1) -> FIT ; else -> UNKNOWN
```

An unassessed axis is `UNKNOWN` (`AXIS_NOT_ASSESSED`), never silently `FIT`. `overall` and `deciding_axes` are recomputed on re-validation; a forged `overall` is refused. M2 computes no fitness itself: the statuses come from evidenced assessments.

## 5. Audience intent

Modes: `GENERAL` (no segment, no criteria), `SEGMENT_REF` (opaque `segment_ref` mandatory, owned by Customers), `DEFINITION` (non-executable: ≥ 1 `criteria_ref`, optional `exclusion_refs`, `materialization_required` is always `true` — Customers must materialize it before any use). A field that does not belong to the mode is refused (`MKT_M2_AUDIENCE_FIELD_NOT_ALLOWED`). No profile, list, PII or query language can be expressed: the schema is closed and every value is an opaque ref.

## 6. Resource requirements

Describes what a Push would **consume**, never whether it is available. All parts optional; `{}` is valid. `cash` `{currency (ISO 4217 shape), min, max, basis, evidence_refs}` with `0 ≤ min ≤ max`; `human_time` `{min_minutes, max_minutes, basis, evidence_refs}`; plus opaque ref lists `operational_capacity_refs`, `inventory_requirement_refs`, `creative_capacity_refs`, `contact_capacity_refs`, `other_resource_refs`. Numbers must be finite, non-negative JSON numbers (not strings).

**Every material number needs a `basis`** from a closed list: `OWNER_DECIDED`, `DOMAIN_FACT`, `DETERMINISTIC_CALCULATION`, `EXTERNAL_QUOTE`, `PLANNED_LIMIT`. `AI_ESTIMATE` / `MODEL_GUESS` do not exist and are refused (`MKT_M2_INVALID_BASIS`). A basis that points at a source (`DOMAIN_FACT`, `DETERMINISTIC_CALCULATION`, `EXTERNAL_QUOTE`) also needs ≥ 1 evidence ref (`MKT_M2_RESOURCE_EVIDENCE_REQUIRED`). Marketing computes no cash available, no acceptable CAC, no maximum spend, no profit, no stock or capacity verdict; keys such as `available`, `sufficient`, `max_spend` do not exist.

## 7. Lead time and execution window

`estimated_lead_time` `{ value ≥ 0 (≤ 100000), unit: HOURS | DAYS, basis, evidence_refs }`, `valid_execution_window` `{ start, end }` with `end > start`. Deterministic fit with an explicit clock:

```text
candidate_start = max(asOf, window.start)
completion      = candidate_start + lead_time
completion <= window.end  ->  FIT      otherwise  ->  NOT_FIT
```

**DAYS = 24 hours exactly** (V1): no business days, no calendar, no timezone or daylight-saving arithmetic; **the arithmetic is exact** — `HOURS → value × 60 × 60 × 1000 ms`, `DAYS → value × 24 × 60 × 60 × 1000 ms`, so `1.5 HOURS = 90 minutes` and `1.5 DAYS = 36 hours`. The declared value is never rounded or otherwise altered; the FIT / NOT_FIT comparison uses the exact completion, and only the displayed `completion` timestamp is truncated to the millisecond (so `72.0000001 HOURS` is `NOT_FIT` even though its displayed completion equals `window.end`). The result `{ status, as_of, candidate_start, completion }` is stored in the Push as `lead_time_fit` (a snapshot at `created_at`) and **re-evaluated at each live `asOf`** by `evaluatePushReadiness` (a Push that fit yesterday can stop fitting today).

## 8. Measurement plan and reversibility

`MeasurementPlan`: `baseline_ref`, `primary_metric_ref`, `guardrail_metric_refs[]`, `observation_window {start,end}`, `control_method`, `eligibility_status`, `eligibility_evidence_refs[]`, `success_criterion_ref`, `failure_criterion_ref`, `stop_rule_refs[]`. **Refs only — no formula, no DSL, no statistical-power computation.**

`control_method`: exactly `NONE | TIME | HOLDOUT`. `HOLDOUT` requires `eligibility_status = ELIGIBLE` **and** a non-empty `eligibility_evidence_refs` (`MKT_M2_MEASUREMENT_HOLDOUT_NOT_ELIGIBLE`, `…_EVIDENCE_REQUIRED`). The derived `incrementality_candidate` is `true` only for `HOLDOUT` + `ELIGIBLE`; an input value that disagrees is refused. **It never means causality is proven.** For M4 (STEER), documented here and not implemented:

| `control_method` | Future STEER consequence |
|---|---|
| `NONE` | no incremental claim |
| `TIME` | future ceiling `SUGGESTIVE` |
| `HOLDOUT` + `ELIGIBLE` | incrementality may be measurable later |

`Reversibility`: `FULLY_REVERSIBLE | PARTIALLY_REVERSIBLE | HARD_TO_REVERSE | UNKNOWN`, with ≥ 1 `reason_codes` and `evidence_refs[]`. No score.

## 9. MarketingPushProposal

```text
push_id (mpp_…)  schema_version  merchant_id  brand_id?  finding_ref  hypothesis_ref?
action_mode  lever_family  lever_variant?  objective (≤ 300, human text, never parsed)
subject_refs[≥1]  audience  channels[≥1, UPPER_SNAKE]
lever_fitness  resource_requirements  estimated_lead_time  valid_execution_window  lead_time_fit
measurement_plan  claim_refs[]  policy_requirement_refs[]  consent_requirement_refs[]  promotion_rule_refs[]
risk_refs[]  unknown_refs[]  reversibility  created_at (= asOf)  expires_at  readiness
```

Derived and therefore refused as input: `push_id`, `schema_version`, `merchant_id`, `brand_id`, `finding_ref`, `lead_time_fit`, `created_at`, `readiness`. Claims, policy, consent, promotion rules, risks and unknowns are **opaque refs**: Marketing validates no compliance, consent or availability — it lists what the Socle must resolve.

**Freshness.** `created_at < expires_at ≤ finding.expires_at` (`MKT_M2_PUSH_INVALID_EXPIRY`, `MKT_M2_PUSH_OUTLIVES_FINDING`); at `asOf ≥ expires_at` a Push is `STALE`.

**Re-validation.** `normalizeMarketingPushProposal(stored, { tenant, finding })` rebuilds the Push from its own non-derived fields at its own `created_at` and compares it with the stored object: a forged `readiness`, `push_id`, `lead_time_fit` or `finding_ref` is refused (`MKT_M2_PUSH_DERIVED_MISMATCH`). This validates **form and derivable values** at `created_at`; it never, by itself, authorizes a live conclusion (§10).

## 10. Push readiness

Exactly `READY_FOR_SOCLE | NEEDS_EVIDENCE | NOT_ELIGIBLE | STALE`, precedence **STALE > NOT_ELIGIBLE > NEEDS_EVIDENCE > READY_FOR_SOCLE**:

| Status | When |
|---|---|
| `STALE` | `expires_at ≤ asOf` (also implies a stale Finding, since a Push never outlives its Finding) |
| `NOT_ELIGIBLE` | fitness `NOT_FIT`, **or** lead time `NOT_FIT` at `asOf`, **or** `TEST_SMALL` + `HARD_TO_REVERSE` |
| `NEEDS_EVIDENCE` | fitness `UNKNOWN`, **or** measurement `eligibility_status = UNKNOWN` |
| `READY_FOR_SOCLE` | fresh, fitness `FIT`, lead time `FIT`, valid MeasurementPlan |

**`READY_FOR_SOCLE` ≠ approved ≠ executable ≠ budget authorized ≠ inventory reserved ≠ policy cleared.** It means "worth the Socle's arbitration", nothing more. A `TEST_SMALL` has no universal definition of "small" (no amount threshold anywhere); the only structural rule is that a hard-to-reverse test is not eligible. An `ACTION` that is `HARD_TO_REVERSE` is not excluded by M2: the Socle weighs it, with the reversibility visible.

### Persisted object ≠ live readiness authority

A stored (serialized) Push carries a `readiness` field. **That field is a snapshot at `created_at` and is never an authority.** The only live answer is

```text
evaluatePushReadiness(push, { tenant, finding, asOf, brand? })
```

which needs the **original `MarketingFinding` and an explicit `asOf`** (no Finding, no clock or no tenant is refused; the old `(push, asOf)` call shape no longer exists) and recomputes everything:

1. the Finding is re-validated by M1 (`normalizeMarketingFinding`, so a forged materiality is refused) and passes the M1 gate `evaluateFindingReadiness` at `asOf` — `STALE` is reported (`FINDING_EXPIRED`), any other non-`READY_FOR_BUILD` state is refused (`MKT_M2_FINDING_NOT_READY`);
2. the Push is re-validated against that Finding by `normalizeMarketingPushProposal` (every derived field recomputed; a Push is bound to **its** Finding — another one gives `MKT_M2_PUSH_DERIVED_MISMATCH`; a forged `readiness`, `lever_fitness`, `lead_time_fit` or `measurement_plan` is refused the same way);
3. proposal freshness, lever fitness, **lead-time fit at `asOf`** and measurement state are evaluated on the validated Push.

So a stored `READY_FOR_SOCLE` is `STALE` once the clock passes `expires_at`, becomes `NOT_ELIGIBLE` when the lead time no longer fits, and can never be forced onto a Push whose fields do not produce it.

## 11. DO_NOTHING and TEST_SMALL in the package

`do_nothing` `{ reason_codes (≥ 1), evidence_refs (≥ 1) }` is **always present**, separate from the proposals, and **always needs non-empty reasons and non-empty evidence** — whether the package holds zero proposals or several `READY_FOR_SOCLE` ones (`MKT_M2_PACKAGE_DO_NOTHING_REQUIRED`, `MKT_M2_PACKAGE_DO_NOTHING_EVIDENCE_REQUIRED`). `DO_NOTHING` is a first-class option, not an administrative box. `test_small_disposition` is always present: `INCLUDED { proposal_ref }` (must point at a `TEST_SMALL` proposal **of this package**; an `ACTION` is refused) or `NOT_APPLICABLE { reason_codes ≥ 1, evidence_refs ≥ 1 }` (refused if the package contains a `TEST_SMALL`). So `TEST_SMALL` is never silently skipped.

## 12. SocleDecisionPackage

```text
package_id (mpk_…)  schema_version  merchant_id  brand_id?  finding_ref  created_at  expires_at
proposals[≤ 10]  do_nothing  test_small_disposition  unresolved_requirement_refs[]  review_signals[]  package_status
```

- **Recommends nothing.** No `winner`, `best_option`, `recommended_option`, `selected_option`, `ranking_score`, rank, score or priority exists (all refused as unknown keys). Proposals are stored in a canonical order (by `push_id`) that carries **no** meaning; the same set in any order gives the same `package_id`.
- **Scope.** Every proposal must have the package's merchant, brand and Finding (`MKT_M2_PACKAGE_SCOPE_MISMATCH`, `detail.scope`); duplicate `push_id` refused; each proposal is re-validated (forged derived fields refused); at most 10 proposals.
- **Expiry.** `package.expires_at ≤ finding.expires_at` and `≤ min(proposal.expires_at)`; with no proposal, `≤ finding.expires_at`.
- **Status** (a state, **not** a decision): `STALE` once the Finding or the package has expired; else `READY_FOR_SOCLE` if ≥ 1 proposal is `READY_FOR_SOCLE`; else `NEEDS_EVIDENCE` if ≥ 1 needs evidence; else `NO_ELIGIBLE_MARKETING_ACTION` (all proposals `NOT_ELIGIBLE`, **or** no proposal at all). A package with **zero** proposals is justified by the same mandatory `do_nothing` reasons and evidence.
- **Persisted package ≠ live authority.** A stored package's `package_status` is a snapshot at `created_at`, never an authority. The live status is `evaluatePackageStatus(pkg, { tenant, finding, asOf, brand? })`: it needs the **original Finding and an explicit `asOf`**, re-validates the Finding (M1 gate + freshness), re-validates the whole package against it with `normalizeSocleDecisionPackage` (rebuilds it from its own non-derived fields at its own `created_at`: a forged `package_status`, `package_id`, `review_signals` or embedded proposal is refused, `MKT_M2_PACKAGE_DERIVED_MISMATCH` / `MKT_M2_PUSH_DERIVED_MISMATCH`; a package is bound to **its** Finding, `MKT_M2_PACKAGE_SCOPE_MISMATCH`), then evaluates each proposal live (freshness, lever fitness, lead-time fit at `asOf`, measurement state). The stored status is never read.
- **What is still unresolved is made visible, not resolved.** `unresolved_requirement_refs` is the de-duplicated union of the claim/policy/consent/promotion/unknown refs, the capacity/inventory/creative/contact/other resource refs and the audience segment/criteria refs of the proposals. `review_signals` (fixed order) lists which verdicts the Socle still owes: `FINANCE_VERDICT_REQUIRED` (any cash), `INVENTORY_VERDICT_REQUIRED`, `CAPACITY_VERDICT_REQUIRED` (operational/creative/contact capacity or human time), `POLICY_CLEARANCE_REQUIRED`, `REVERSIBILITY_UNKNOWN`, `HARD_TO_REVERSE_PRESENT`.

## 13. Domain boundaries

| Domain | M2 behaviour |
|---|---|
| Finance | declares a cash requirement; computes no cash available, CAC, maximum spend or profit |
| Inventory / Operations | declares need refs; concludes nothing about stock or capacity |
| Customers | carries an audience intent (segment ref / non-executable definition); never a profile |
| Branding / Creative | no Brand Guardian, Fidelity, Creative or generation call; no import of those modules (tested) |
| Sales Development | `B2B`, `PARTNERSHIP`, `PROSPECTING`, `DIRECT_SALES` refused as levers |
| Socle | everything consequential: decision, approval, policy, budget, capacity arbitration, contact pressure |

## 14. Non-goals (not built)

Socle decision engine, final recommendation engine, approval flow, execution, `CreativeBrief`, Creative Intelligence, `ActivationManifest`, `MarketingRun`, `MarketingLearning`, Social Trend Radar, Store Experience, full experiment engine, statistical power, budget optimizer, media buying, pricing engine, inventory planner, customer segmentation, policy engine, contact-pressure engine, migrations, persistence, UI, LLM/VLM calls, web/API calls.

## 15. Open dependencies (not resolved here)

Socle Decision engine · Socle Evidence Registry · Decision Ledger · policy engine · compliance resolution · contact-pressure arbitration · resource availability / capacity arbitration · Customers segment materialization · Finance budget verdict · Inventory availability verdict · M3 CREATE · M4 STEER · persistence · execution.

## 16. Deviations and choices (documented)

1. **`created_at` is the explicit `asOf`** (one clock), not a separate input; `created_at` supplied by the caller is refused.
2. **Sourced bases need evidence**: `DOMAIN_FACT`, `DETERMINISTIC_CALCULATION` and `EXTERNAL_QUOTE` require ≥ 1 evidence ref (the mandate lists `evidence_refs[]` without a rule). A number that claims a source but cites none is unauditable.
3. **Forbidden lever tokens are checked on family, variant and channel**, not only on the family, so that a forbidden domain cannot be reintroduced as a variant.
4. **`subject_refs` and `channels` are mandatory (≥ 1)** on a Push; `subject_refs` is not forced to be a subset of the Finding's (left to the Socle).
5. **A `TEST_SMALL` NOT_APPLICABLE that contradicts a `TEST_SMALL` proposal in the same package is refused**, and `INCLUDED` must point at a `TEST_SMALL` of the same package.
6. **`review_signals` and `unresolved_requirement_refs` are derived** (the mandate names them without defining them); they are deterministic summaries, never a verdict.
7. **`schema_version` is an output field** of the Push and of the package.
8. **`ACTION` + `HARD_TO_REVERSE` is not excluded** by M2 (only `TEST_SMALL` is, per the mandate); the reversibility stays visible to the Socle.
9. **Building a package requires a `READY_FOR_BUILD` Finding at `asOf`**; staleness of an existing package is evaluated afterwards by `evaluatePackageStatus`, with the original Finding.
10. **Measurement `eligibility_status` other than `UNKNOWN` does not block** a `NONE` / `TIME` plan (`NOT_ELIGIBLE` simply means no controlled design is available); only `UNKNOWN` yields `NEEDS_EVIDENCE`.
11. **Audit corrections (applied on top of the first M2 commit):** (a) lead-time arithmetic is exact, no rounding; (b) `do_nothing` evidence is mandatory in every package — the former special case "zero proposals needs an evidenced justification" (`MKT_M2_PACKAGE_EMPTY_NEEDS_JUSTIFICATION`) became redundant and was removed; (c) live readiness / package status can no longer be read from a stored object: `evaluatePushReadiness` and `evaluatePackageStatus` now take `{ tenant, finding, asOf }` (a signature change, because the previous `(object, asOf)` form trusted the stored `lever_fitness`, `measurement_plan` and similar fields), and `normalizeSocleDecisionPackage` was added as the package counterpart of `normalizeMarketingPushProposal`.

## 17. Test coverage — mandate cases 1–151, plus audit additions 152+

One row per numbered case of the M2 mandate (§32). Several cases share a test function when it asserts them together; `test/marketing-m2-build.test.js` enforces that this table is contiguous (the mandate numbering 1–151 is never reshuffled), that it contains the audit additions, and that every named test exists. Case 151 is the full suite, run by the `Marketing V1` workflow. **Cases 152 and above were added by the architect's final audit** (exact lead time, `do_nothing` evidence, persisted object ≠ live authority).

<!-- coverage-matrix:start -->
| Mandate case | Behaviour | Test (`test/marketing-m2-build.test.js` unless noted) |
|---:|---|---|
| 1 | READY Finding accepted | Finding gate: only a READY_FOR_BUILD Finding builds a Push; STALE, REFER_TO_DOMAIN, NOT_MEASURABLE and NO_MATERIAL_SIGNAL are refused |
| 2 | STALE Finding refused | Finding gate: only a READY_FOR_BUILD Finding builds a Push; STALE, REFER_TO_DOMAIN, NOT_MEASURABLE and NO_MATERIAL_SIGNAL are refused |
| 3 | REFER_TO_DOMAIN Finding refused | Finding gate: only a READY_FOR_BUILD Finding builds a Push; STALE, REFER_TO_DOMAIN, NOT_MEASURABLE and NO_MATERIAL_SIGNAL are refused |
| 4 | NOT_MEASURABLE Finding refused | Finding gate: only a READY_FOR_BUILD Finding builds a Push; STALE, REFER_TO_DOMAIN, NOT_MEASURABLE and NO_MATERIAL_SIGNAL are refused |
| 5 | NO_MATERIAL_SIGNAL Finding refused | Finding gate: only a READY_FOR_BUILD Finding builds a Push; STALE, REFER_TO_DOMAIN, NOT_MEASURABLE and NO_MATERIAL_SIGNAL are refused |
| 6 | tenant mismatch refused | Finding gate: tenant and brand scope come from the Finding and are verified, never supplied |
| 7 | brand scope kept | Finding gate: tenant and brand scope come from the Finding and are verified, never supplied |
| 8 | brand mismatch refused | Finding gate: tenant and brand scope come from the Finding and are verified, never supplied |
| 9 | existing hypothesis_ref accepted | Finding gate: hypothesis_ref must exist in the Finding when given |
| 10 | absent hypothesis_ref accepted | Finding gate: hypothesis_ref must exist in the Finding when given |
| 11 | unknown hypothesis_ref refused | Finding gate: hypothesis_ref must exist in the Finding when given |
| 12 | FIT | Lever Fitness: deterministic aggregation, visible axes, no score |
| 13 | NOT_FIT dominates | Lever Fitness: deterministic aggregation, visible axes, no score |
| 14 | UNKNOWN dominates FIT | Lever Fitness: deterministic aggregation, visible axes, no score |
| 15 | NOT_APPLICABLE ignored | Lever Fitness: deterministic aggregation, visible axes, no score |
| 16 | all NOT_APPLICABLE -> UNKNOWN | Lever Fitness: deterministic aggregation, visible axes, no score |
| 17 | FIT requires evidence | Lever Fitness: evidence and reasons are required where they carry meaning; axes and statuses are closed |
| 18 | NOT_FIT requires evidence | Lever Fitness: evidence and reasons are required where they carry meaning; axes and statuses are closed |
| 19 | UNKNOWN requires a reason | Lever Fitness: evidence and reasons are required where they carry meaning; axes and statuses are closed |
| 20 | unknown axis refused | Lever Fitness: evidence and reasons are required where they carry meaning; axes and statuses are closed |
| 21 | unknown status refused | Lever Fitness: evidence and reasons are required where they carry meaning; axes and statuses are closed |
| 22 | no score | Lever Fitness: no score or weight anywhere; deep-frozen; a forged overall is refused when re-validated |
| 23 | deep freeze | Lever Fitness: no score or weight anywhere; deep-frozen; a forged overall is refused when re-validated |
| 24 | 5 families valid | Lever: five families, optional extensible variant, mandatory for TEST_SMALL and ACTION |
| 25 | unknown family refused | Lever: five families, optional extensible variant, mandatory for TEST_SMALL and ACTION |
| 26 | valid variant | Lever: five families, optional extensible variant, mandatory for TEST_SMALL and ACTION |
| 27 | invalid variant refused | Lever: five families, optional extensible variant, mandatory for TEST_SMALL and ACTION |
| 28 | TEST_SMALL requires a family | Lever: five families, optional extensible variant, mandatory for TEST_SMALL and ACTION |
| 29 | ACTION requires a family | Lever: five families, optional extensible variant, mandatory for TEST_SMALL and ACTION |
| 30 | B2B / prospecting refused | Lever: B2B, partnership, prospecting, direct sales and pricing are not Marketing levers (family, variant or channel) |
| 31 | pricing authority refused | Lever: B2B, partnership, prospecting, direct sales and pricing are not Marketing levers (family, variant or channel) |
| 32 | GENERAL | Audience: GENERAL, SEGMENT_REF and DEFINITION, each with its own requirements |
| 33 | SEGMENT_REF requires a ref | Audience: GENERAL, SEGMENT_REF and DEFINITION, each with its own requirements |
| 34 | DEFINITION requires criteria | Audience: GENERAL, SEGMENT_REF and DEFINITION, each with its own requirements |
| 35 | materialization_required = true | Audience: GENERAL, SEGMENT_REF and DEFINITION, each with its own requirements |
| 36 | GENERAL without a segment | Audience: GENERAL, SEGMENT_REF and DEFINITION, each with its own requirements |
| 37 | SEGMENT_REF without a definition | Audience: GENERAL, SEGMENT_REF and DEFINITION, each with its own requirements |
| 38 | profile keys refused | Audience privacy: no customer profile, no list, no PII, no query language can be expressed |
| 39 | PII refused | Audience privacy: no customer profile, no list, no PII, no query language can be expressed |
| 40 | empty object valid | Resources: an empty object is valid; cash is a declared requirement with a currency, a range and a basis |
| 41 | valid cash | Resources: an empty object is valid; cash is a declared requirement with a currency, a range and a basis |
| 42 | min > max refused | Resources: an empty object is valid; cash is a declared requirement with a currency, a range and a basis |
| 43 | negative refused | Resources: an empty object is valid; cash is a declared requirement with a currency, a range and a basis |
| 44 | invalid currency refused | Resources: an empty object is valid; cash is a declared requirement with a currency, a range and a basis |
| 45 | unknown basis refused | Resources: every material number needs a closed basis; a model guess is not a basis; sourced bases need evidence |
| 46 | AI_ESTIMATE refused | Resources: every material number needs a closed basis; a model guess is not a basis; sourced bases need evidence |
| 47 | valid human time | Resources: human time, opaque refs, closed schema, and no availability conclusion |
| 48 | human min > max refused | Resources: human time, opaque refs, closed schema, and no availability conclusion |
| 49 | human negative refused | Resources: human time, opaque refs, closed schema, and no availability conclusion |
| 50 | opaque refs | Resources: human time, opaque refs, closed schema, and no availability conclusion |
| 51 | unknown keys refused | Resources: human time, opaque refs, closed schema, and no availability conclusion |
| 52 | no availability conclusion | Resources: human time, opaque refs, closed schema, and no availability conclusion |
| 53 | HOURS | Lead time: HOURS and DAYS, closed unit, non-negative value, mandatory basis |
| 54 | DAYS | Lead time: HOURS and DAYS, closed unit, non-negative value, mandatory basis |
| 55 | unknown unit refused | Lead time: HOURS and DAYS, closed unit, non-negative value, mandatory basis |
| 56 | negative refused | Lead time: HOURS and DAYS, closed unit, non-negative value, mandatory basis |
| 57 | basis mandatory | Lead time: HOURS and DAYS, closed unit, non-negative value, mandatory basis |
| 58 | FIT computed | Lead time fit: candidate_start = max(asOf, window.start); completion = start + lead time; completion <= window.end is FIT |
| 59 | NOT_FIT computed | Lead time fit: candidate_start = max(asOf, window.start); completion = start + lead time; completion <= window.end is FIT |
| 60 | future window start | Lead time fit: candidate_start = max(asOf, window.start); completion = start + lead time; completion <= window.end is FIT |
| 61 | no implicit clock | Lead time: explicit clock only, DAYS = 24 hours exactly, no business days |
| 62 | DAYS = 24h documented | Lead time: explicit clock only, DAYS = 24 hours exactly, no business days |
| 63 | NONE | MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window |
| 64 | TIME | MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window |
| 65 | HOLDOUT + ELIGIBLE | MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window |
| 66 | HOLDOUT + UNKNOWN refused | MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window |
| 67 | HOLDOUT + NOT_ELIGIBLE refused | MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window |
| 68 | eligibility evidence required | MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window |
| 69 | primary metric | MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window |
| 70 | baseline | MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window |
| 71 | observation window | MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window |
| 72 | invalid window refused | MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window |
| 73 | success criterion | MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window |
| 74 | failure criterion | MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window |
| 75 | stop rule | MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window |
| 76 | incrementality false for NONE | MeasurementPlan: incrementality_candidate is derived and is never a causal claim |
| 77 | incrementality false for TIME | MeasurementPlan: incrementality_candidate is derived and is never a causal claim |
| 78 | incrementality true for eligible HOLDOUT | MeasurementPlan: incrementality_candidate is derived and is never a causal claim |
| 79 | no causal claim | MeasurementPlan: incrementality_candidate is derived and is never a causal claim |
| 80 | 4 statuses | Reversibility: four statuses, mandatory reasons, evidence kept, no score |
| 81 | unknown status refused | Reversibility: four statuses, mandatory reasons, evidence kept, no score |
| 82 | reasons required | Reversibility: four statuses, mandatory reasons, evidence kept, no score |
| 83 | evidence kept | Reversibility: four statuses, mandatory reasons, evidence kept, no score |
| 84 | no score | Reversibility: four statuses, mandatory reasons, evidence kept, no score |
| 85 | ACTION valid | Push: an ACTION and a TEST_SMALL are valid; ids are deterministic and sensitive to the lever |
| 86 | TEST_SMALL valid | Push: an ACTION and a TEST_SMALL are valid; ids are deterministic and sensitive to the lever |
| 87 | deterministic id | Push: an ACTION and a TEST_SMALL are valid; ids are deterministic and sensitive to the lever |
| 88 | same input, same id | Push: an ACTION and a TEST_SMALL are valid; ids are deterministic and sensitive to the lever |
| 89 | different lever, different id | Push: an ACTION and a TEST_SMALL are valid; ids are deterministic and sensitive to the lever |
| 90 | merchant / brand derived | Push: merchant, brand, finding_ref and created_at are derived - supplying any of them is refused |
| 91 | merchant input refused | Push: merchant, brand, finding_ref and created_at are derived - supplying any of them is refused |
| 92 | brand input refused | Push: merchant, brand, finding_ref and created_at are derived - supplying any of them is refused |
| 93 | finding_ref derived | Push: merchant, brand, finding_ref and created_at are derived - supplying any of them is refused |
| 94 | expires_at <= finding.expires_at | Push freshness: expires_at must be after creation and cannot outlive the Finding |
| 95 | outliving the Finding refused | Push freshness: expires_at must be after creation and cannot outlive the Finding |
| 96 | stale | Push freshness: expires_at must be after creation and cannot outlive the Finding |
| 97 | fitness NOT_FIT -> NOT_ELIGIBLE | Push readiness: NOT_FIT / NOT_FIT lead time / UNKNOWN fitness / READY, with the precedence STALE > NOT_ELIGIBLE > NEEDS_EVIDENCE > READY |
| 98 | lead time NOT_FIT -> NOT_ELIGIBLE | Push readiness: NOT_FIT / NOT_FIT lead time / UNKNOWN fitness / READY, with the precedence STALE > NOT_ELIGIBLE > NEEDS_EVIDENCE > READY |
| 99 | fitness UNKNOWN -> NEEDS_EVIDENCE | Push readiness: NOT_FIT / NOT_FIT lead time / UNKNOWN fitness / READY, with the precedence STALE > NOT_ELIGIBLE > NEEDS_EVIDENCE > READY |
| 100 | READY_FOR_SOCLE | Push readiness: NOT_FIT / NOT_FIT lead time / UNKNOWN fitness / READY, with the precedence STALE > NOT_ELIGIBLE > NEEDS_EVIDENCE > READY |
| 101 | TEST_SMALL + HARD_TO_REVERSE -> NOT_ELIGIBLE | Push readiness: NOT_FIT / NOT_FIT lead time / UNKNOWN fitness / READY, with the precedence STALE > NOT_ELIGIBLE > NEEDS_EVIDENCE > READY |
| 102 | claims / policy refs | Push: claims, policy, consent, promotion rules, risks and unknowns are opaque refs - Marketing validates none of them |
| 103 | risks / unknowns | Push: claims, policy, consent, promotion rules, risks and unknowns are opaque refs - Marketing validates none of them |
| 104 | no execution | Push: no execution, no approval, no budget authority can be expressed; READY_FOR_SOCLE is not approval |
| 105 | no approval | Push: no execution, no approval, no budget authority can be expressed; READY_FOR_SOCLE is not approval |
| 106 | deep freeze | Push: deep-frozen output, caller inputs untouched, JSON round-trip re-validates, a forged field is refused |
| 107 | input unmutated | Push: deep-frozen output, caller inputs untouched, JSON round-trip re-validates, a forged field is refused |
| 108 | do_nothing required | DO_NOTHING: always present in the package, separate from the proposals, with reasons |
| 109 | do_nothing reasons required | DO_NOTHING: always present in the package, separate from the proposals, with reasons |
| 110 | INCLUDED points at a TEST_SMALL | TEST_SMALL is always explicitly considered: INCLUDED points at a TEST_SMALL proposal, NOT_APPLICABLE is reasoned and evidenced |
| 111 | INCLUDED -> ACTION refused | TEST_SMALL is always explicitly considered: INCLUDED points at a TEST_SMALL proposal, NOT_APPLICABLE is reasoned and evidenced |
| 112 | NOT_APPLICABLE requires reasons | TEST_SMALL is always explicitly considered: INCLUDED points at a TEST_SMALL proposal, NOT_APPLICABLE is reasoned and evidenced |
| 113 | NOT_APPLICABLE requires evidence | TEST_SMALL is always explicitly considered: INCLUDED points at a TEST_SMALL proposal, NOT_APPLICABLE is reasoned and evidenced |
| 114 | TEST_SMALL always considered | TEST_SMALL is always explicitly considered: INCLUDED points at a TEST_SMALL proposal, NOT_APPLICABLE is reasoned and evidenced |
| 115 | valid package | Decision package: valid, deterministic, one finding, one tenant, one brand |
| 116 | deterministic id | Decision package: valid, deterministic, one finding, one tenant, one brand |
| 117 | same finding | Decision package: valid, deterministic, one finding, one tenant, one brand |
| 118 | same tenant | Decision package: valid, deterministic, one finding, one tenant, one brand |
| 119 | same brand | Decision package: valid, deterministic, one finding, one tenant, one brand |
| 120 | duplicate push refused | Decision package: duplicates, count, forged proposals and expiry are enforced |
| 121 | expiry <= finding | Decision package: duplicates, count, forged proposals and expiry are enforced |
| 122 | expiry <= proposal | Decision package: duplicates, count, forged proposals and expiry are enforced |
| 123 | one READY -> READY_FOR_SOCLE | Decision package status: READY / NEEDS_EVIDENCE / NO_ELIGIBLE_MARKETING_ACTION / STALE are states, never decisions |
| 124 | no READY + NEEDS -> NEEDS_EVIDENCE | Decision package status: READY / NEEDS_EVIDENCE / NO_ELIGIBLE_MARKETING_ACTION / STALE are states, never decisions |
| 125 | all NOT_ELIGIBLE -> NO_ELIGIBLE_MARKETING_ACTION | Decision package status: READY / NEEDS_EVIDENCE / NO_ELIGIBLE_MARKETING_ACTION / STALE are states, never decisions |
| 126 | zero proposals only with an explicit justification | Decision package status: READY / NEEDS_EVIDENCE / NO_ELIGIBLE_MARKETING_ACTION / STALE are states, never decisions |
| 127 | stale -> STALE | Decision package status: READY / NEEDS_EVIDENCE / NO_ELIGIBLE_MARKETING_ACTION / STALE are states, never decisions |
| 128 | no winner | Decision package: no winner, no ranking, no score, no selected or recommended option; order carries no meaning |
| 129 | no score | Decision package: no winner, no ranking, no score, no selected or recommended option; order carries no meaning |
| 130 | no selected_option | Decision package: no winner, no ranking, no score, no selected or recommended option; order carries no meaning |
| 131 | do_nothing present | Decision package: no winner, no ranking, no score, no selected or recommended option; order carries no meaning |
| 132 | test_small considered | Decision package: no winner, no ranking, no score, no selected or recommended option; order carries no meaning |
| 133 | deep freeze | Decision package: no winner, no ranking, no score, no selected or recommended option; order carries no meaning |
| 134 | no Finance calculation | Domain boundaries: M2 exposes proposal contracts only - no finance, inventory, customer, creative, guardian, publish, send, ads, price, stock or approval function |
| 135 | no Inventory calculation | Domain boundaries: M2 exposes proposal contracts only - no finance, inventory, customer, creative, guardian, publish, send, ads, price, stock or approval function |
| 136 | no customer profile | Audience privacy: no customer profile, no list, no PII, no query language can be expressed |
| 137 | no Creative | Domain boundaries: M2 exposes proposal contracts only - no finance, inventory, customer, creative, guardian, publish, send, ads, price, stock or approval function |
| 138 | no Guardian | Domain boundaries: M2 exposes proposal contracts only - no finance, inventory, customer, creative, guardian, publish, send, ads, price, stock or approval function |
| 139 | no publish | Domain boundaries: M2 exposes proposal contracts only - no finance, inventory, customer, creative, guardian, publish, send, ads, price, stock or approval function |
| 140 | no send | Domain boundaries: M2 exposes proposal contracts only - no finance, inventory, customer, creative, guardian, publish, send, ads, price, stock or approval function |
| 141 | no ad buying | Domain boundaries: M2 exposes proposal contracts only - no finance, inventory, customer, creative, guardian, publish, send, ads, price, stock or approval function |
| 142 | no price change | Domain boundaries: M2 exposes proposal contracts only - no finance, inventory, customer, creative, guardian, publish, send, ads, price, stock or approval function |
| 143 | no stock change | Domain boundaries: M2 exposes proposal contracts only - no finance, inventory, customer, creative, guardian, publish, send, ads, price, stock or approval function |
| 144 | no approval | Domain boundaries: M2 exposes proposal contracts only - no finance, inventory, customer, creative, guardian, publish, send, ads, price, stock or approval function |
| 145 | no network | Static scope: no clock, randomness, network, database, filesystem, LLM or merchant-specific code in any M2 file |
| 146 | no database | Static scope: no clock, randomness, network, database, filesystem, LLM or merchant-specific code in any M2 file |
| 147 | no LLM / VLM | Static scope: no clock, randomness, network, database, filesystem, LLM or merchant-specific code in any M2 file |
| 148 | M1 unchanged | Non-regression: M1, M1.5 and Measurement keep exactly their public surface; M2 added no field to them |
| 149 | M1.5 unchanged | Non-regression: M1, M1.5 and Measurement keep exactly their public surface; M2 added no field to them |
| 150 | Measurement unchanged | Non-regression: M1, M1.5 and Measurement keep exactly their public surface; M2 added no field to them |
| 151 | full suite green | (CI) full suite `npm test`, run by the `Marketing V1` workflow |
| 152 | HOURS / DAYS are exactly 3 600 000 / 86 400 000 ms | Lead time: exact arithmetic - fractional values are never rounded (1.5 HOURS = 90 minutes, 1.5 DAYS = 36 hours) |
| 153 | 1.5 DAYS = 36 hours, 1.5 HOURS = 90 minutes (no rounding) | Lead time: exact arithmetic - fractional values are never rounded (1.5 HOURS = 90 minutes, 1.5 DAYS = 36 hours) |
| 154 | fractional values: FIT / NOT_FIT around the window end | Lead time: exact arithmetic - fractional values are never rounded (1.5 HOURS = 90 minutes, 1.5 DAYS = 36 hours) |
| 155 | a sub-millisecond lead time is not rounded up | Lead time: exact arithmetic - fractional values are never rounded (1.5 HOURS = 90 minutes, 1.5 DAYS = 36 hours) |
| 156 | do_nothing without evidence_refs refused | DO_NOTHING evidence: reasons AND evidence are always required, even with several READY proposals |
| 157 | do_nothing with empty evidence_refs refused | DO_NOTHING evidence: reasons AND evidence are always required, even with several READY proposals |
| 158 | do_nothing with evidence accepted (also with several READY proposals) | DO_NOTHING evidence: reasons AND evidence are always required, even with several READY proposals |
| 159 | a stored Push readiness is a snapshot, not an authority | Persisted Push is never a live authority: its stored readiness is a snapshot; the live answer needs the original Finding and an explicit asOf |
| 160 | live Push evaluation requires the original Finding and an explicit asOf | Persisted Push is never a live authority: its stored readiness is a snapshot; the live answer needs the original Finding and an explicit asOf |
| 161 | a forged stored Push (readiness, fitness, lead time, measurement) is refused live | Persisted Push is never a live authority: its stored readiness is a snapshot; the live answer needs the original Finding and an explicit asOf |
| 162 | live Push readiness re-evaluates lead time, fitness and measurement at the clock | Persisted Push is never a live authority: its stored readiness is a snapshot; the live answer needs the original Finding and an explicit asOf |
| 163 | a stored package_status is a snapshot; the live status needs the Finding and asOf and re-validates the package | Persisted package is never a live authority: stored package_status is a snapshot; the live status needs the original Finding and an explicit asOf |
| 164 | live evaluation passes through the M1 Finding gate and never reads the stored status (source check) | Live evaluation goes through the M1 Finding gate, never through the stored object alone (source check) |
<!-- coverage-matrix:end -->
