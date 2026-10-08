# Marketing M4 — STEER contract (V1)

- **Status:** M4 — STEER COMPLETE (audited, pushed, CI green)
- **Version:** `marketing-m4-steer.v1` (`MARKETING_STEER_VERSION`)
- **Code:** `src/marketing/m4.js` (public surface) · `m4-constants.js` · `m4-validation.js` · `execution-receipt.js` · `marketing-run.js` · `run-evidence.js` · `run-result.js` · `marketing-learning.js` · `follow-up-proposal.js` · `steer-package.js`
- **Tests:** `test/marketing-m4-steer.test.js` (+ shared fixtures `test/marketing-m4-fixtures.js`)
- **Builds on:** M1 UNDERSTAND, M1.5, M2 BUILD ([`marketing-m2-build-contract.md`](./marketing-m2-build-contract.md)), M3 CREATE ([`marketing-m3-create-contract.md`](./marketing-m3-create-contract.md)); overview in [`marketing-v1-architecture.md`](./marketing-v1-architecture.md)

## 1. Purpose

M4 lets Nordla move from *"a Marketing action was really executed"* to *"here is what was observed, what is only attributed, what is incremental if the design allows it, what we learned, and the follow-up options to submit to the Socle"* — and never to *"the marketing caused this"* when the proof does not allow it.

```text
ActivationManifest + SocleExecutionAuthorization + MarketingExecutionReceipt (both produced ELSEWHERE) + original Push
   -> MarketingRun
   -> RunEvidenceBundle   (refs to results produced by the measurement layer / a trusted adapter)
   -> MarketingRunResult  (OBSERVED / ATTRIBUTED / OFFLINE_ATTRIBUTED / INCREMENTAL - only for an eligible HOLDOUT)
   -> MarketingLearning
   -> MarketingFollowUpProposal[]
   -> MarketingSteerPackage
   -> SOCLE (outside M4)
```

```text
OBSERVED != ATTRIBUTED != INCREMENTAL != CAUSAL
UNKNOWN (we do not have the expected data yet) != NOT_MEASURABLE (the design or the data cannot conclude)
```

M4 builds pure, deterministic **contracts**: it executes, publishes, schedules, scales, stops, re-budgets or rewrites nothing; connects to no ad, analytics or POS source; runs no statistics; scores and ranks nothing; and mutates no M1 object. READY_FOR_SOCLE never means approved, executed, scaled or stopped.

## 2. Invariants

- **Stored ≠ live authority.** Every stored object (Run, result, Learning, follow-up, package) is a snapshot. A live answer is recomputed from the originals and an explicit `asOf`; a stored `outcome`, `direction`, `readiness` or `package_status` is never read as an authority, and a forged object (id no longer matching its content, or out of scope) is refused.
- **Closed schemas**, deterministic content-derived ids (`mrn_` Run, `moa_` offline observation, `mre_` evidence bundle, `mrr_` result, `mlg_` Learning, `mfu_` follow-up, `msp_` Steer Package), deep-frozen outputs, opaque refs only (no URL, no whitespace, no `@`), explicit clock, no randomness.
- **Trust boundary.** The authorization, the receipt, the measured results, the criterion assessments and the offline observations come from trusted server-side adapters; M4 validates form and coherence, with no authentication or cryptography.
- **No number is computed here.** Results stay in `*_result_ref` / `evidence_refs`; there is no `confidence_score`, `success_score`, `causal_score`, `learning_score` or `scale_score`. The strength of the proof is visible in `evidence_class`, `outcome`, `incrementality_status`, `data_state` and `limitations`.
- **No winner.** No `winner`, `selected_follow_up`, `recommended_follow_up`, `best_follow_up`, ranking or score exists (refused anywhere in an input).
- **Privacy by construction.** No customer name, e-mail, phone, recipient, profile or conversation key is accepted anywhere; a self-report stores a *ref* to its evidence, never the raw answer.

## 3. SocleExecutionAuthorization (form only)

`authorization_ref · decision_ref · activation_manifest_ref · push_ref · scope · status · authorized_at · expires_at` — V1: `scope = EXECUTE`, `status = APPROVED`. `activation_manifest_ref == manifest.activation_manifest_id`, `push_ref == manifest.push_ref`, `authorized_at ≤ expires_at`. M4 never creates, issues or infers one (`normalizeSocleExecutionAuthorization` validates a form already produced by the Socle / Policy / a human).

## 4. MarketingExecutionReceipt (form only)

`execution_ref · execution_authorization_ref · activation_manifest_ref · merchant_id · brand_id · push_ref · execution_status · activated_at · delivery_execution_refs[] · evidence_refs[] · recorded_at`. `execution_status ∈ {EXECUTED, PARTIAL}`; FAILED / CANCELLED belong to the execution / operations layer and are not in M4 V1.

Rules: merchant, brand, Push, manifest and authorization refs match the originals; `activated_at` ∈ `[activation_window.start, activation_window.end)`, `≥ authorized_at`, `≤ authorization.expires_at`; `recorded_at ≥ activated_at`; evidence is mandatory ("no receipt without proof"); EXECUTED covers **every** manifest delivery, PARTIAL covers at least one (a subset). A receipt says *an activation was really executed*, never that it was a good idea.

## 5. MarketingRun

`run_id (mrn_…) · schema_version · merchant_id · brand_id · finding_ref · push_ref · activation_manifest_ref · execution_ref · execution_status · activated_at · measurement_plan_ref · observation_window · created_at · review_signals[]`. Built only from the original Push, the original ActivationManifest, the authorization, the receipt, the tenant and an explicit `asOf`; scope, execution status and activation time are derived. `observation_window` is **exactly** `push.measurement_plan.observation_window` (never a second window). A Run carries no result. Signals (sorted, unique, no free text): `PARTIAL_EXECUTION`, `INCREMENTALITY_NOT_ELIGIBLE`, `MEASUREMENT_WINDOW_NOT_COMPLETE`. M4 does **not** own the offline / online taxonomy of channels (M2 channels are extensible) and never infers an expected offline attribution from a channel name; a real offline measurement arrives as an `OfflineAttributionObservation` (`OFFLINE_ATTRIBUTED`, signal `OFFLINE_ATTRIBUTION_ONLY`). An "offline attribution expected" signal would need an explicit contract / configuration, not a channel list in M4.

## 6. OfflineAttributionObservation

`observation_id (moa_…) · method · result_ref · source_ref · evidence_refs[] · observed_at · limitations[] · causal_claim`. Methods: `QR`, `PROMO_CODE`, `SHORT_URL`, `POS_MARKER`, `COUPON`, `SELF_REPORTED`. Evidence is mandatory; **`causal_claim` is always `false`** (`true` is refused). A QR / promo code / POS marker / coupon / self-report **is attribution — not incrementality, not causality**. No connector is built.

## 7. RunEvidenceBundle

`assessment_ref (mre_…) · merchant_id · brand_id · run_ref · measurement_plan_ref · data_state · evidence_class · assessment_status · primary_metric_ref · observed_result_refs[] · attributed_result_refs[] · offline_attribution_observations[] · incremental_result_ref? · success_criterion · failure_criterion · stop_rule_assessments[] · guardrail_assessment_refs[] · evidence_refs[] · limitations[] · assessed_at`.

- `data_state`: `COMPLETE · PARTIAL · UNAVAILABLE · PENDING`. `evidence_class`: `OBSERVED · ATTRIBUTED · OFFLINE_ATTRIBUTED · INCREMENTAL` (no generic CAUSAL). `assessment_status`: `SUPPORTS · CHALLENGES · INCONCLUSIVE · NOT_MEASURABLE · UNKNOWN`, chosen by a deterministic / trusted adapter — never by a model.
- `primary_metric_ref`, `success_criterion.criterion_ref`, `failure_criterion.criterion_ref` equal the MeasurementPlan's; `stop_rule_assessments[].rule_ref` ⊆ `plan.stop_rule_refs` (each at most once); criteria and stop rules have status `MET · NOT_MET · UNKNOWN · NOT_MEASURABLE` and are only *observed* (M4 executes no stop rule). `guardrail_assessment_refs[]` are opaque refs: M4 has no guardrail engine.
- `merchant_id`, `brand_id`, `run_ref`, `measurement_plan_ref` and `assessment_ref` are derived from the Run; `assessed_at ≥ run.activated_at`. The evidence class must have a result of its own layer when data is present.

## 8. Incrementality gate

An `incremental_result_ref` (or the INCREMENTAL class) is allowed **only** when `control_method = HOLDOUT` AND `eligibility_status = ELIGIBLE` AND `incrementality_candidate = true` — otherwise `MKT_M4_INCREMENTAL_RESULT_NOT_ALLOWED`. The class needs the ref and the ref needs the class. Derived `incrementality_status`:

| Status | When |
|---|---|
| `MEASURABLE` | HOLDOUT + ELIGIBLE + class INCREMENTAL + `incremental_result_ref` + `data_state = COMPLETE` |
| `UNTESTABLE` | `control_method` NONE or TIME (the business-layer `INCREMENTALITY_UNTESTABLE`) |
| `NOT_MEASURABLE` | an eligible HOLDOUT whose execution / data quality prevents an incremental conclusion (PARTIAL / UNAVAILABLE data, assessment NOT_MEASURABLE, no incremental result) |
| `UNKNOWN` | the incremental data is expected but pending (`data_state = PENDING` or assessment UNKNOWN) |

## 9. MarketingRunResult

`result_id (mrr_…) · schema_version · merchant_id · brand_id · run_ref · finding_ref · push_ref · hypothesis_ref? · assessment_ref · evaluated_at · result_state · finalization_reason · evidence_class · outcome · direction · incrementality_status · observed_result_refs[] · attributed_result_refs[] · offline_attribution_refs[] · incremental_result_ref? · success_criterion · failure_criterion · stop_rule_assessments[] · evidence_refs[] · limitations[] · review_signals[]`.

**Result target:** if the Push has a `hypothesis_ref` the result evaluates that hypothesis, else the expected Push outcome (`hypothesis_ref` is null).

**Pending / final.** `result_state ∈ {PENDING, FINAL}`. Before `observation_window.end` the result is `PENDING` (`finalization_reason = null`) unless a stop rule is `MET`; at `asOf ≥ observation_window.end` it is `FINAL` (`OBSERVATION_WINDOW_COMPLETE`); an early FINAL has reason `STOP_RULE_MET`. M4 stops nothing.

**Outcome** (`CONFIRMED · SUGGESTIVE · REFUTED · NOT_MEASURABLE · UNKNOWN`) and **direction** (`SUPPORTS · CHALLENGES · INCONCLUSIVE`), strict:

| Condition (evaluated top to bottom) | Outcome | Direction |
|---|---|---|
| `result_state = PENDING` | UNKNOWN | INCONCLUSIVE |
| `assessment_status = NOT_MEASURABLE` | NOT_MEASURABLE | INCONCLUSIVE |
| `data_state = PENDING` or `assessment_status = UNKNOWN` | UNKNOWN | INCONCLUSIVE |
| `data_state` PARTIAL / UNAVAILABLE, or `assessment_status = INCONCLUSIVE` | NOT_MEASURABLE | INCONCLUSIVE |
| SUPPORTS / CHALLENGES, FINAL, class INCREMENTAL, `MEASURABLE`, **EXECUTED**, eligible HOLDOUT | CONFIRMED / REFUTED | SUPPORTS / CHALLENGES |
| SUPPORTS / CHALLENGES otherwise (OBSERVED, ATTRIBUTED, OFFLINE_ATTRIBUTED, NONE/TIME, PARTIAL execution) | SUGGESTIVE | SUPPORTS / CHALLENGES |

**Ceilings.** With `control_method` NONE or TIME, or a `PARTIAL` execution, CONFIRMED / REFUTED are impossible (ceiling SUGGESTIVE / NOT_MEASURABLE / UNKNOWN). `limitations` is the sorted union of the bundle's limitations and derived tokens (`ATTRIBUTION_IS_NOT_CAUSALITY`, `OFFLINE_ATTRIBUTION_IS_NOT_CAUSALITY`, `OBSERVATION_IS_NOT_ATTRIBUTION`, `NO_CONTROL_DESIGN`, `TIME_BASED_CONTROL_ONLY`, `PARTIAL_EXECUTION`, `DATA_*`, `INCREMENTALITY_NOT_ESTABLISHED`). `review_signals`: `PARTIAL_EXECUTION`, `OBSERVED_ONLY`, `ATTRIBUTION_ONLY`, `OFFLINE_ATTRIBUTION_ONLY`, `INCREMENTALITY_UNTESTABLE`, `MEASUREMENT_NOT_MEASURABLE`, `DATA_PENDING`, `STOP_RULE_MET`, `RESULT_CHALLENGES_HYPOTHESIS` (sorted union, no free text).

**Stored vs live.** `normalizeMarketingRunResult` re-validates a stored result by rebuilding it from the originals at its own `evaluated_at`. `evaluateMarketingRunResult(stored, { tenant, push, run, bundle, asOf })` is the **live** answer, recomputed from the original Run, Push, evidence bundle and explicit clock: it may *degrade* at any time (new evidence, an expiry) but a **FINAL stored result cannot become more conclusive unless the supplied bundle is strictly newer than the result** (`MKT_M4_RESULT_EVIDENCE_REGRESSION`): losing or replaying older evidence cannot silently improve a conclusion.

## 10. MarketingLearning — "do not learn the wrong lesson"

`learning_id (mlg_…) · merchant_id · brand_id · finding_ref · hypothesis_ref? · push_ref · run_ref · result_ref · conclusion · direction · evidence_class · evidence_refs[] · limitations[] · learned_at · valid_until · validity_basis_ref · reuse_status`.

- Created only from a **FINAL** result, re-evaluated live from its originals (the stored result must still say what the live evaluation says). Allowed conclusions reuse the outcome vocabulary: `CONFIRMED · SUGGESTIVE · REFUTED · NOT_MEASURABLE`. **UNKNOWN is never a learning.**
- CONFIRMED / REFUTED only from INCREMENTAL evidence (and never from a PARTIAL execution). SUGGESTIVE is never promoted to a fact. A NOT_MEASURABLE learning records the limits of the test; it neither confirms nor refutes the hypothesis.
- `valid_until > learned_at`; `validity_basis_ref` is mandatory; **no day count is hard-coded**. `reuse_status` is derived (`evaluateLearningReuse`): `REUSABLE`, then `STALE` from `asOf ≥ valid_until` (auditable, no longer injected as a current truth; signal `LEARNING_STALE`).
- A Learning never mutates `MarketingFinding`, `CandidateHypothesis` or `MarketSignal`; nothing is persisted. A future UNDERSTAND iteration may consume Learnings through an adapter.

## 11. MarketingFollowUpProposal

`follow_up_id (mfu_…) · merchant_id · brand_id · run_ref · result_ref · proposal_type · reason_codes[] · evidence_refs[] · change_refs[] · created_at · expires_at · readiness`. Types: `PROPOSE_CONTINUE · PROPOSE_STOP · PROPOSE_ADJUST · PROPOSE_SCALE · PROPOSE_TEST_AGAIN · DO_NOTHING`. Admissibility is derived from the LIVE result:

| Type | Admissible when |
|---|---|
| `PROPOSE_SCALE` | CONFIRMED + INCREMENTAL + MEASURABLE + run EXECUTED + FINAL, and no `PARTIAL_EXECUTION` / `STOP_RULE_MET` / `MEASUREMENT_NOT_MEASURABLE`. Never on attribution alone |
| `PROPOSE_CONTINUE` | CONFIRMED, or SUGGESTIVE + SUPPORTS |
| `PROPOSE_STOP` | REFUTED, or SUGGESTIVE + CHALLENGES, or any stop rule MET |
| `PROPOSE_ADJUST` | SUGGESTIVE, REFUTED or NOT_MEASURABLE, with `change_refs` (M4 defines no change) |
| `PROPOSE_TEST_AGAIN` | SUGGESTIVE or NOT_MEASURABLE (UNKNOWN is not enough: the data may simply be pending) |
| `DO_NOTHING` | always, with reason codes and evidence ("not now", never "abandon") |

For an UNKNOWN result, `DO_NOTHING` carries `WAITING_FOR_DATA` and no new test is proposed. Build refuses a type the result does not admit (`MKT_M4_FOLLOW_UP_NOT_ADMISSIBLE`); the **live** readiness (`evaluateFollowUpReadiness`) is `STALE` (expired) > `NOT_ELIGIBLE` (the live result no longer admits the type) > `NEEDS_EVIDENCE` (admissible, no evidence) > `READY_FOR_SOCLE`. There is no winner and nothing is executed.

## 12. MarketingSteerPackage

`steer_package_id (msp_…) · merchant_id · brand_id · run_ref · result_ref · created_at · expires_at · proposals[] · do_nothing · package_status · unresolved_requirement_refs[] · review_signals[]`. `do_nothing` (reason codes + evidence) is **always** present; at most **10** proposals (the list may be empty); no ranking, no `best_follow_up`, no score. Every proposal must be about the same merchant, brand, Run and result and be listed once. `package_status`: `STALE` (expired, or the stored result no longer says what the live evaluation says) > `READY_FOR_SOCLE` (at least one proposal READY) > `NEEDS_EVIDENCE` > `NO_ELIGIBLE_FOLLOW_UP` (a visible state, **not** a final decision). `evaluateSteerPackageStatus` recomputes it live from the original result, Run, proposals and `asOf`; no readiness array is stored in the package, and the stored status and a proposal's own stored `readiness` are snapshots that never serve as an authority.

## 13. Domain boundaries

M4 executes nothing, publishes nothing, schedules nothing, changes no budget, campaign, price or inventory, holds no customer profile, computes no finance figure, calls no model, no network, no database and no file, and has no power engine, A/B engine, geo-lift, MMM, multi-touch attribution, Decision Ledger, Policy engine or Socle Decision engine. The existing measurement modules (`build.js`, `provenance.js`, `traffic.js`, `paid.js`, `search.js`, `search-visibility.js`), the CLI, M1, M1.5, M2, M3, Branding and Creative Fidelity are not modified; the existing attribution semantics are reused through result refs.

## 14. Deviations and interpretations (documented, not hidden)

1. `delivery_execution_refs[]` is a list of `{ deliverable_ref, delivery_execution_ref }` pairs: the mandate asks that EXECUTED "cover every manifest delivery", which needs the deliverable each execution refers to.
2. The criterion assessment key is `criterion_ref` (mandate §26); §28's "success_criterion.ref" is read as that key.
3. Extra derived fields beyond the mandate's lists: `schema_version` on every object and `assessment_ref` on the result (provenance to the `RunEvidenceBundle`).
4. M4's inputs do not include the Finding or the Decision Package (mandate §17). The original Push and ActivationManifest are therefore bound to their own content-derived ids (`mpp_`, `mam_`) and to the tenant, and the Push's MeasurementPlan is trusted as built by M2.
5. A result that is still `PENDING` has the outcome `UNKNOWN` (nothing is concluded before the window ends or a stop rule is MET), so a PENDING result never feeds a Learning or a CONTINUE / TEST_AGAIN follow-up.
6. `PARTIAL` / `UNAVAILABLE` data and an `INCONCLUSIVE` assessment map to `NOT_MEASURABLE` (a known insufficiency), never to `UNKNOWN`.
7. The "evidence loss cannot silently improve" rule (§9) is implemented as a strictly-newer-evidence requirement for a FINAL result to become more conclusive.
8. A Learning and a follow-up take the *stored* result plus the originals; the result is re-evaluated live and `result_ref` is the stored `result_id`.
9. (Removed by the audit) M4 no longer derives `OFFLINE_ATTRIBUTION_EXPECTED` from a channel list.
10. `MEASUREMENT_WINDOW_NOT_COMPLETE` on a Run is a snapshot at `created_at`.

## 15. Open dependencies (not resolved here)

Socle execution authorization issuer · execution engine · execution receipt adapter · Decision Ledger · Evidence Registry · offline attribution connectors · online attribution connectors beyond the existing measurement · statistical / incrementality engine · holdout allocator · Learning persistence · Learning retrieval into UNDERSTAND · Policy engine · contact pressure · Finance / Inventory / Operations feedback · alerts · dashboards · specialized intelligences.

## 16. Test coverage — mandate cases 1–194

One row per numbered case of the M4 mandate (§85). Several cases share a test function when it asserts them together; `test/marketing-m4-steer.test.js` enforces that this table is contiguous, holds all 194 cases (195+ are the audit corrections) and that every named test exists. Cases marked **(CI)** are the Branding / Creative Fidelity suites, the Marketing focused suite and the full suite, executed by the `Marketing V1` workflow.

<!-- coverage-matrix:start -->
| # | Mandate case | Test |
|---|---|---|
| 1 | valid EXECUTE authorization | Execution authorization: a valid EXECUTE authorization is accepted, and its scope, status, refs and window are enforced |
| 2 | wrong scope refused | Execution authorization: a valid EXECUTE authorization is accepted, and its scope, status, refs and window are enforced |
| 3 | wrong status refused | Execution authorization: a valid EXECUTE authorization is accepted, and its scope, status, refs and window are enforced |
| 4 | manifest ref mismatch | Execution authorization: a valid EXECUTE authorization is accepted, and its scope, status, refs and window are enforced |
| 5 | push ref mismatch | Execution authorization: a valid EXECUTE authorization is accepted, and its scope, status, refs and window are enforced |
| 6 | invalid auth timestamps | Execution authorization: a valid EXECUTE authorization is accepted, and its scope, status, refs and window are enforced |
| 7 | execute after expiry refused | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 8 | EXECUTED receipt valid | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 9 | PARTIAL receipt valid | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 10 | merchant mismatch | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 11 | brand mismatch | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 12 | push mismatch | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 13 | manifest mismatch | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 14 | evidence required | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 15 | EXECUTED covers deliveries | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 16 | PARTIAL subset allowed | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 17 | PARTIAL empty refused | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 18 | execution outside window refused | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 19 | recorded_at before activated_at refused | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 20 | deep freeze | Execution receipt: EXECUTED and PARTIAL receipts, scope, evidence, deliveries, window and timestamps |
| 21 | valid run | Marketing Run: valid, deterministic, scope derived, the MeasurementPlan window reused, PARTIAL signalled, no result inside |
| 22 | deterministic id | Marketing Run: valid, deterministic, scope derived, the MeasurementPlan window reused, PARTIAL signalled, no result inside |
| 23 | same input same id | Marketing Run: valid, deterministic, scope derived, the MeasurementPlan window reused, PARTIAL signalled, no result inside |
| 24 | scope derived | Marketing Run: valid, deterministic, scope derived, the MeasurementPlan window reused, PARTIAL signalled, no result inside |
| 25 | observation window reused | Marketing Run: valid, deterministic, scope derived, the MeasurementPlan window reused, PARTIAL signalled, no result inside |
| 26 | no duplicate window | Marketing Run: valid, deterministic, scope derived, the MeasurementPlan window reused, PARTIAL signalled, no result inside |
| 27 | EXECUTED run | Marketing Run: valid, deterministic, scope derived, the MeasurementPlan window reused, PARTIAL signalled, no result inside |
| 28 | PARTIAL review signal | Marketing Run: valid, deterministic, scope derived, the MeasurementPlan window reused, PARTIAL signalled, no result inside |
| 29 | measurement ref match | Marketing Run: valid, deterministic, scope derived, the MeasurementPlan window reused, PARTIAL signalled, no result inside |
| 30 | no result in Run | Marketing Run: valid, deterministic, scope derived, the MeasurementPlan window reused, PARTIAL signalled, no result inside |
| 31 | no score | Marketing Run: valid, deterministic, scope derived, the MeasurementPlan window reused, PARTIAL signalled, no result inside |
| 32 | deep freeze | Marketing Run: valid, deterministic, scope derived, the MeasurementPlan window reused, PARTIAL signalled, no result inside |
| 33 | QR | Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic |
| 34 | PROMO_CODE | Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic |
| 35 | SHORT_URL | Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic |
| 36 | POS_MARKER | Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic |
| 37 | COUPON | Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic |
| 38 | SELF_REPORTED | Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic |
| 39 | unknown method refused | Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic |
| 40 | evidence required | Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic |
| 41 | causal_claim false | Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic |
| 42 | raw self-report text refused | Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic |
| 43 | PII refused | Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic |
| 44 | deterministic id | Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic |
| 45 | deep freeze | Offline attribution: the six methods, evidence required, causal_claim always false, no raw self-report, no PII, deterministic |
| 46 | observed bundle | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 47 | attributed bundle | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 48 | offline bundle | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 49 | incremental bundle | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 50 | metric match | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 51 | success criterion match | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 52 | failure criterion match | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 53 | stop rule refs validated | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 54 | run ref match | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 55 | merchant match | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 56 | brand match | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 57 | data_state valid | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 58 | assessment status valid | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 59 | evidence class valid | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 60 | evidence refs preserved | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 61 | no numbers invented | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 62 | deep freeze | Run evidence: each layer is its own class, the Plan metric and criteria are enforced, and nothing is invented |
| 63 | HOLDOUT eligible accepted | Incrementality gate: only an eligible HOLDOUT may carry an incremental result; the status is derived and never merged |
| 64 | NONE incremental refused | Incrementality gate: only an eligible HOLDOUT may carry an incremental result; the status is derived and never merged |
| 65 | TIME incremental refused | Incrementality gate: only an eligible HOLDOUT may carry an incremental result; the status is derived and never merged |
| 66 | invalid HOLDOUT state refused | Incrementality gate: only an eligible HOLDOUT may carry an incremental result; the status is derived and never merged |
| 67 | incremental class needs ref | Incrementality gate: only an eligible HOLDOUT may carry an incremental result; the status is derived and never merged |
| 68 | incremental ref needs class | Incrementality gate: only an eligible HOLDOUT may carry an incremental result; the status is derived and never merged |
| 69 | MEASURABLE derived | Incrementality gate: only an eligible HOLDOUT may carry an incremental result; the status is derived and never merged |
| 70 | NONE→UNTESTABLE | Incrementality gate: only an eligible HOLDOUT may carry an incremental result; the status is derived and never merged |
| 71 | TIME→UNTESTABLE | Incrementality gate: only an eligible HOLDOUT may carry an incremental result; the status is derived and never merged |
| 72 | design/data failure→NOT_MEASURABLE | Incrementality gate: only an eligible HOLDOUT may carry an incremental result; the status is derived and never merged |
| 73 | pending→UNKNOWN | Incrementality gate: only an eligible HOLDOUT may carry an incremental result; the status is derived and never merged |
| 74 | before window end PENDING | Finalization: PENDING until the window ends, FINAL after it or on an early MET stop rule, with its reason |
| 75 | after window end FINAL | Finalization: PENDING until the window ends, FINAL after it or on an early MET stop rule, with its reason |
| 76 | stop rule FINAL early | Finalization: PENDING until the window ends, FINAL after it or on an early MET stop rule, with its reason |
| 77 | no stop rule no early final | Finalization: PENDING until the window ends, FINAL after it or on an early MET stop rule, with its reason |
| 78 | completion reason | Finalization: PENDING until the window ends, FINAL after it or on an early MET stop rule, with its reason |
| 79 | stop reason | Finalization: PENDING until the window ends, FINAL after it or on an early MET stop rule, with its reason |
| 80 | pending reason null | Finalization: PENDING until the window ends, FINAL after it or on an early MET stop rule, with its reason |
| 81 | incremental SUPPORTS→CONFIRMED | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 82 | incremental CHALLENGES→REFUTED | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 83 | attributed SUPPORTS→SUGGESTIVE | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 84 | attributed CHALLENGES→SUGGESTIVE/CHALLENGES | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 85 | offline attribution max SUGGESTIVE | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 86 | observed max SUGGESTIVE | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 87 | NONE cannot confirm | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 88 | TIME cannot confirm | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 89 | NONE cannot refute | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 90 | TIME cannot refute | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 91 | NOT_MEASURABLE | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 92 | UNKNOWN | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 93 | PENDING→UNKNOWN | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 94 | PARTIAL cannot confirm | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 95 | PARTIAL cannot refute | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 96 | deterministic result id | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 97 | deep freeze | Outcome: CONFIRMED / REFUTED only from a FINAL, EXECUTED, INCREMENTAL, MEASURABLE result; everything else is capped |
| 98 | stored outcome ignored | Stored versus live: a stored outcome and direction are never an authority; forged results are refused; evidence cannot silently improve |
| 99 | stored direction ignored | Stored versus live: a stored outcome and direction are never an authority; forged results are refused; evidence cannot silently improve |
| 100 | live evidence required | Stored versus live: a stored outcome and direction are never an authority; forged results are refused; evidence cannot silently improve |
| 101 | explicit asOf required | Stored versus live: a stored outcome and direction are never an authority; forged results are refused; evidence cannot silently improve |
| 102 | forged result refused | Stored versus live: a stored outcome and direction are never an authority; forged results are refused; evidence cannot silently improve |
| 103 | new evidence can degrade | Stored versus live: a stored outcome and direction are never an authority; forged results are refused; evidence cannot silently improve |
| 104 | evidence loss cannot silently improve | Stored versus live: a stored outcome and direction are never an authority; forged results are refused; evidence cannot silently improve |
| 105 | CONFIRMED learning | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 106 | SUGGESTIVE learning | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 107 | REFUTED learning | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 108 | NOT_MEASURABLE learning | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 109 | UNKNOWN refused | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 110 | PENDING refused | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 111 | CONFIRMED needs INCREMENTAL | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 112 | REFUTED needs INCREMENTAL | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 113 | PARTIAL cannot confirmed learning | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 114 | valid_until | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 115 | validity basis | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 116 | REUSABLE | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 117 | STALE | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 118 | deterministic id | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 119 | no mutation M1 | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 120 | deep freeze | Learning: only a FINAL result teaches, with the proof level it really has; UNKNOWN never teaches; validity is explicit |
| 121 | CONTINUE confirmed | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 122 | CONTINUE suggestive supports | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 123 | CONTINUE challenges refused | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 124 | STOP refuted | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 125 | STOP suggestive challenges | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 126 | STOP stop-rule | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 127 | SCALE only confirmed incremental executed | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 128 | SCALE attributed refused | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 129 | SCALE partial refused | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 130 | SCALE not measurable refused | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 131 | ADJUST suggestive | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 132 | ADJUST refuted | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 133 | ADJUST not measurable | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 134 | ADJUST needs changes | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 135 | TEST_AGAIN suggestive | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 136 | TEST_AGAIN not measurable | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 137 | TEST_AGAIN unknown refused | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 138 | DO_NOTHING with proof | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 139 | DO_NOTHING no evidence refused | Follow-up admissibility: CONTINUE, STOP, SCALE, ADJUST, TEST_AGAIN and DO_NOTHING follow the live result |
| 140 | deterministic id | Follow-up: deterministic, frozen, no winner or auto-action, and its readiness is recomputed live |
| 141 | deep freeze | Follow-up: deterministic, frozen, no winner or auto-action, and its readiness is recomputed live |
| 142 | valid | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 143 | deterministic id | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 144 | do_nothing always present | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 145 | duplicate refused | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 146 | same run | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 147 | same result | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 148 | same merchant | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 149 | same brand | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 150 | READY | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 151 | NEEDS_EVIDENCE | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 152 | NO_ELIGIBLE | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 153 | STALE | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 154 | max 10 | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 155 | no winner | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 156 | no ranking | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 157 | no selected follow-up | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 158 | deep freeze | Steer package: valid, deterministic, do_nothing always present, same scope, bounded, no winner, no ranking |
| 159 | observed != incremental | Attribution is not incrementality is not causality: no class below INCREMENTAL can reach CONFIRMED or REFUTED |
| 160 | attributed != incremental | Attribution is not incrementality is not causality: no class below INCREMENTAL can reach CONFIRMED or REFUTED |
| 161 | offline != incremental | Attribution is not incrementality is not causality: no class below INCREMENTAL can reach CONFIRMED or REFUTED |
| 162 | online non-causal | Attribution is not incrementality is not causality: no class below INCREMENTAL can reach CONFIRMED or REFUTED |
| 163 | offline non-causal | Attribution is not incrementality is not causality: no class below INCREMENTAL can reach CONFIRMED or REFUTED |
| 164 | incremental only eligible holdout | Attribution is not incrementality is not causality: no class below INCREMENTAL can reach CONFIRMED or REFUTED |
| 165 | no generic causal_claim=true | Attribution is not incrementality is not causality: no class below INCREMENTAL can reach CONFIRMED or REFUTED |
| 166 | NOT_MEASURABLE allowed | Attribution is not incrementality is not causality: no class below INCREMENTAL can reach CONFIRMED or REFUTED |
| 167 | UNKNOWN distinct | Attribution is not incrementality is not causality: no class below INCREMENTAL can reach CONFIRMED or REFUTED |
| 168 | no execution | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 169 | no publish | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 170 | no scheduler | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 171 | no budget mutation | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 172 | no campaign mutation | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 173 | no price mutation | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 174 | no inventory mutation | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 175 | no customer profile | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 176 | no finance calculation | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 177 | no LLM/VLM | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 178 | no network | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 179 | no DB | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 180 | no filesystem | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 181 | no power engine | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 182 | no A/B engine | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 183 | no geo-lift | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 184 | no MMM | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 185 | no multi-touch rewrite | Domain boundaries: M4 executes, publishes, schedules and mutates nothing - the surface and the source prove it |
| 186 | M1 unchanged | Non-regression: M1, M1.5, M2, M3, Measurement, Branding and Creative Fidelity are untouched and do not depend on M4 |
| 187 | M1.5 unchanged | Non-regression: M1, M1.5, M2, M3, Measurement, Branding and Creative Fidelity are untouched and do not depend on M4 |
| 188 | M2 unchanged | Non-regression: M1, M1.5, M2, M3, Measurement, Branding and Creative Fidelity are untouched and do not depend on M4 |
| 189 | M3 unchanged | Non-regression: M1, M1.5, M2, M3, Measurement, Branding and Creative Fidelity are untouched and do not depend on M4 |
| 190 | Measurement unchanged | Non-regression: M1, M1.5, M2, M3, Measurement, Branding and Creative Fidelity are untouched and do not depend on M4 |
| 191 | Branding unchanged | (CI) the Branding suite, run by the `Marketing V1` / `Branding V1` workflows |
| 192 | Creative Fidelity unchanged | (CI) the Creative Fidelity suite, run by its workflow |
| 193 | Marketing focused green | (CI) `node --test test/marketing*.test.js`, run by the `Marketing V1` workflow |
| 194 | full suite green | (CI) the full suite (`npm test`), run by the `Marketing V1` workflow |
| 195 | STORE_FRONT does not automatically imply offline attribution expected | Offline expectation: M4 never infers it from a channel name, and real offline observations keep their semantics |
| 196 | IN_STORE does not automatically imply it | Offline expectation: M4 never infers it from a channel name, and real offline observations keep their semantics |
| 197 | PRINT does not automatically imply it | Offline expectation: M4 never infers it from a channel name, and real offline observations keep their semantics |
| 198 | a future arbitrary channel does not require changing M4 | Offline expectation: M4 never infers it from a channel name, and real offline observations keep their semantics |
| 199 | actual offline observations still produce OFFLINE_ATTRIBUTED semantics | Offline expectation: M4 never infers it from a channel name, and real offline observations keep their semantics |
| 200 | SteerPackage has no proposal_readiness field | Steer package readiness: no stored proposal_readiness exists, and the package status is derived live from the proposals |
| 201 | unknown proposal_readiness field is refused | Steer package readiness: no stored proposal_readiness exists, and the package status is derived live from the proposals |
| 202 | package status is derived live from proposals | Steer package readiness: no stored proposal_readiness exists, and the package status is derived live from the proposals |
| 203 | stored proposal readiness cannot improve package status | Steer package readiness: no stored proposal_readiness exists, and the package status is derived live from the proposals |
<!-- coverage-matrix:end -->

## 17. Invariants kept at closure

```text
OBSERVED ≠ ATTRIBUTED ≠ INCREMENTAL ≠ CAUSAL

NONE / TIME cannot CONFIRM or REFUTE
PARTIAL execution cannot CONFIRM / REFUTE / SCALE
UNKNOWN != NOT_MEASURABLE
Offline attribution is not causality
CONFIRMED / REFUTED require eligible incremental evidence
MarketingLearning never promotes SUGGESTIVE to FACT
Follow-up proposals return to the Socle
no auto-scale / auto-stop / auto-budget / auto-execution
```
