# Creative end to end — one entry point, one run, one result

Status: built on `feature/creative-e2e-wiring` (from `8def488`, the Phase 5 consolidation). Decision NDR-P27. **Provider-free: no live provider was called, no live image was made.** Not Phase 6; no merge to `main`.

The overnight consolidation found the gap: the five phases were separately tested libraries that no code chained. This phase closes it with ONE opt-in entry point, `runCreativeEndToEnd` (`src/creative-e2e/`), and says plainly what is still missing (real providers, live validation).

## 1. The call graph BEFORE this work (read from the code, then confirmed by the wiring audit)

```
tests / scripts only ──► createContentFormatPlanner ─► createCampaignPlanner(brain, contentPlanner, assetDirector) ─► createProductionPlanner.plan
                                                                                             │
                                                           runLayeredCreative(production, scene_id, ports{segmenter, layers}, agents, guardian, store, budget, policy)
                                                             segmenter = createLocalProductSegmenter  (needs an annotated OUTLINE: buildProductMask + makeProductCutout)
                                                             product placed by containFit + resizePng; text by solveLayout; gates: preflight, hard fidelity (phone-case annotations), Guardian
                                                                                             │
                                                           refineCreative({candidate, defects, run, store, budget, runtime}) ─► reruns runLayeredCreative on a COPY of the store
creative-integration (Phase 5): called by tests, one script, the readiness gate. NOT called by anything above.
single-image runtime (runProductPreservingCreative): called by benchmark scripts. Separate path, unchanged.
```
Duplicated state: three budgets (campaign planner, production plan, layer budget), no operation id outside the benchmark, one ledger per component. Missing bridges: segmentation → layered runtime; planners → layered runtime; layered → refine (only by hand); a result contract. Mock-only: every provider port (Brain, asset director, layer generator).

## 2. The flow now

```
REQUEST ─► ASSET (decoded WITH its alpha; one recorded downscale to ≤ 1000 px) ─► SEGMENTATION (native alpha if the image is pre-cut, else the photograph path; BEFORE any paid call)
  ─► FORMAT_PLAN + BRAIN_PLAN (campaign planner: content planning, framing, ideation, selection, art direction, asset directing; every text call is an operation of the run)
  ─► PRODUCTION_PLAN ─► INTEGRATION (runLayeredCreative on ONE scene; the product IS the cut-out of the segmentation stage; optional contact shadow layer)
  ─► REFINE (only for a named, repairable defect) ─► FINAL_GATES ─► ONE RESULT
```
Segmentation moved ahead of the planning on purpose: a product that cannot be cut out stops the run before any billable call (tested: zero Brain calls, zero spend).

| What | Where |
|---|---|
| Entry point, result contract, routing | `e2e.js` |
| One run context: id, ledger, budget, operation ids, checkpoints, resume | `run-context.js` |
| Asset decode / downscale / derived annotations | `asset.js` |
| Segmentation stage (native alpha, photograph path, provider port) | `segmentation-stage.js` (+ `src/creative-integration/native-alpha.js`) |
| Placement, contact-shadow hook, delivered identity, artifacts | `integration-stage.js` |
| Parity audit (readiness component END_TO_END) | `parity.js` |
| Real-asset runner | `scripts/creative-e2e-real-assets.mjs` |

Additive changes to existing files (each inert by default, proven by a golden hash): `layered-runtime.js` gained two opt-in policy hooks (`contact_shadow`: a separate midground-band layer under the product; `product_shadow_effect: false`: drops the renderer's default offset shadow when the separate layer replaces it) and one guard in its artifact; `ledger.js` gained one component and one decision (`E2E_RUN_EVENT`); `creative-readiness` gained the END_TO_END component and the four levels. The single-image runtime is byte for byte unchanged (RF-12 pin) and a direct layered call produces the same PNG as on the commit before this work (EP-11, golden `ffd299a4…`).

## 3. One run context (task 3, 4, 5)
`createRunContext({ run_id, ceiling_eur, ledger, at, resume })`: ONE ledger (the stages' own decisions and the run events share it), ONE budget, ONE chain of operation ids, the provider-call list, the checkpoints, the failure.
* **Operation ids** `<run_id>:<KIND>:<NNNN>`, a counter per kind; a failed operation keeps its id, the next never reuses it; a paid operation without an estimate, or of an unknown kind, is refused; every paid kind of the vocabulary is covered (Brain text, asset-director text, image generation, segmentation provider, masked edit, vision critic, upscale). Local steps are traced too (`LOCAL`).
* **Budget** reserve BEFORE the work, settle after, release on failure; a reservation beyond the ceiling is refused before any operation exists (`RunBudgetError`); the campaign planner receives the run ceiling and its pre-flight estimate above it is `BUDGET_EXCEEDED` before a single call. Text ports and the layer port are WRAPPED by the context, so no module-local budget can ignore downstream cost. The unit price of an image comes from the production plan.
* **Reuse**: a settled request (a hash of its instruction or `request_key#candidate`) returns its settled answer; an image request asked again after settlement is an invariant error, never a second charge.

## 4. Native-alpha path (task 7)
A pre-cut image (alpha: transparent border AND opaque product) is not flattened and re-segmented. `segmentNativeAlpha` validates it and keeps it: transparent border, near-opaque alpha (≥ 245) snapped to 255 (a supplier alpha of 253 is opaque; the count is reported), soft pixels hug the opaque core (a baked **semi-transparent** glow fails), one object (several need an explicit group), no enclosed pinholes, no stray dust, not cut by the border, a monotonic soft edge. Failure is closed with the reason (`ALPHA_INVALID` + the failing codes). **Limit, unfixable from the alpha alone:** a glow baked into OPAQUE pixels (the supplier alpha marks the glow as product) passes — see §10.

## 5. Multi-product (task 8)
`options.selection` (`IDS`, `POINT`, `BOX`, `GROUP`) goes to the segmentation; an unselected photograph with several objects is `SEGMENTATION_FAILED / AMBIGUOUS_SELECTION` before any spend; the result carries `selection.product_ids`; only the selected components enter the cut-out; one failing selected product fails the asset. (A campaign of several assets still produces one scene per run: `options.scene_index`.)

## 6. Refine (task 9)
Invoked only when the layered candidate failed a gate with a named defect, or the caller names defects (`options.refine.defects`), AND `options.refine.enabled`. It runs the real `refineCreative` on the shared layer store and budget (its image calls are operations of the run), at most `max_attempts` (default 1). Outcomes: `REPAIRED` (the repaired candidate goes through every final gate; a REFINE checkpoint is saved), `BLOCKED`/`NOT_REPAIRED`/`REPLAN_REQUIRED` → BLOCKED `REFINE_REJECTED` with the refine's own code and replan, a defect that only a masked edit could fix → **`PROVIDER_NOT_CONNECTED`** (never a silent restart of the concept), disabled with named defects → a warning, and a failed candidate is BLOCKED (never READY).

## 7. Final gates (task 10) and the final states (task 11)
| Gate | Status today | Mandatory |
|---|---|---|
| PLACEMENT (scale, visibility, size, no rotation, no deformation) | EXECUTABLE_NOW | yes |
| PRODUCT_DELIVERED_IDENTITY (the delivered pixels of the product against the cut-out drawn by the same renderer: mean and tail of the difference, chromaticity, hue, alpha) | EXECUTABLE_NOW | yes |
| PRODUCT_PIXELS_IN_THE_COMPOSITOR (changed = 0, checked > 0) | EXECUTABLE_NOW | yes |
| COPY_INTEGRITY (every planned text exact) | EXECUTABLE_NOW | yes |
| LAYOUT_TEXT_PREFLIGHT | EXECUTABLE_NOW | yes |
| INTEGRATION_ARTIFACTS (halo, cropping, deformation, alpha noise; with a shadow: floating, detached, double, direction) | EXECUTABLE_NOW | yes |
| BRAND_GUARDIAN | EXECUTABLE_NOW (needs the port) | yes: not configured ⇒ BLOCKED |
| PRODUCT_IDENTITY_CASE_GATE (phone-case annotations: camera module, lenses, artwork) | EXECUTABLE_NOW for printed cases only | no (NOT_APPLICABLE is a warning) |
| VISION_CRITIC | PROVIDER_REQUIRED | only if `require_critic` |
| relight / grade | NOT_APPLIED in the layered flow (its identity gate demands the exact colours) | — |

Final states: `READY` (every mandatory gate ran and passed, no warning), `NEEDS_OWNER_REVIEW` (produced, with named warnings), `BLOCKED` (a named stop: stage, code, reason, replan), `TECHNICAL_FAIL`, `PROVIDER_NOT_CONNECTED`, `BUDGET_EXCEEDED`. `owner_approval` is always `PENDING`. The integration states of Phase 5 (`SEGMENTATION_FAILED`, `SEGMENTATION_LOW_CONFIDENCE`, `MATTE_INVALID`, `PRODUCT_IDENTITY_RISK`, `PLACEMENT_INVALID`, `SHADOW_INVALID`, `INTEGRATION_ARTIFACT`) appear as `block.code`; `RELIGHT_OUT_OF_BOUNDS` cannot occur here because no relight is applied in the layered flow. There is no fallback to a generated or redrawn product.

The contract: `state, run_id, asset_id, campaign_id, format, final{png_bytes, sha256, size}, source_provenance, product_identity, copy_integrity, integration, layers, selection, refine, gates, budget, provider_calls, operation_ids, ledger_reference, timings_ms, memory_mb, stages, checkpoints, warnings, block, failure, owner_approval, fallback_to_generated_product:false, resume_state`.

## 8. Checkpoints, resume, failure propagation (tasks 12, 13)
Checkpoints are saved after REQUEST, ASSET, SEGMENTATION, FORMAT_PLAN, BRAIN_PLAN, PRODUCTION_PLAN, INTEGRATION, REFINE (when a repair is accepted) and FINAL_GATES. `resume_state` (plain JSON) carries the run state (operations, settled results, reservations, checkpoints), the campaign checkpoint store, the layer store and the refine memory. On resume: a settled text request is answered from the cache, a generated layer comes from the layer store, a valid segmentation checkpoint with the same input is reused (`stages.SEGMENTATION = REUSED`), the planners re-run deterministically over their store, the ledger and operation ids continue. Tested: a finished run resumed with dead ports gives the same PNG and no new operation; a run broken at the second image resumes and the total number of image calls equals an uninterrupted run; a failed shadow request keeps the plans, the segmentation and the generated layers valid.

Invalidation (`INVALIDATES`): ASSET → segmentation, production plan, integration, refine, gates · SEGMENTATION → production plan, integration, refine, gates · FORMAT_PLAN → BRAIN_PLAN and everything after it that depends on it · PRODUCTION_PLAN → integration, refine, gates · INTEGRATION → refine, gates · REFINE → gates only. Invalidation only goes forward; a refine failure never touches the product, the cut-out or the layers.

## 9. Readiness (task 17)
`CREATIVE_MODULES_READY` (each component proven) · `CREATIVE_END_TO_END_READY` (the entry point is wired and a provider-free fixture ran end to end, recorded) · `CREATIVE_PROVIDER_READY` (a connection recorded for each required provider: layer generator, Brain model) · `CREATIVE_LIVE_VALIDATED` (a recorded successful live run). None implies the next; `CREATIVE_PIPELINE_READY` is now the first two together and never implies a provider.

## 10. Limits (not worked around)
* No real provider is connected to the layered path: the Brain model, the asset director and the layer generator are fakes in every test. `providers_connected` is empty in the attestation.
* One scene per run; no campaign loop yet.
* The relight / grade of Phase 5 is not applied in this flow (the legacy hard identity gate demands exact colours); the contact shadow is opt-in and assumes the product stands on a surface the request declares.
* The local photograph segmentation depends on the analysis size: the real MILA case passes at ≤ 1000 px and stopped at `EDGE_RECONSTRUCTION_RUN` at ≤ 1200 px (one 13-pixel run just over its limit); the size is fixed at 1000, the sensitivity is recorded, no threshold was changed.
* The native-alpha validation cannot see a glow baked into opaque pixels (see the real-asset table).
* The case-specific identity gate only exists for printed phone cases; other products are judged by the delivered-identity gate.
* Real HABB assets, provider-free run (`scripts/creative-e2e-real-assets.mjs`): see the final report.

## 11. Close-out proofs

### 11.1 Resolution sensitivity: why 1000 px, and why it is a contract and not a workaround
* The segmentation limits of Phase 5 (edge-reconstruction run length, halo width, hole size…) are measured **in pixels**, and were calibrated and attested on the matrix at the working size of that phase (a real 497×1000 photograph and drawn products of ≈ 300×440). They are therefore only meaningful at a stated analysis size: the same photograph analysed at 1.2× the size is a different measurement of the same edge, not a stricter or looser judge.
* `ANALYSIS_MAX_PX = 1000` is a **constant of the module** (`src/creative-e2e/constants.js`), not an option of the entry point, not chosen per image and not adapted after a failure. `prepareAsset` is a pure function of the file's bytes: a file at or below 1000 px is untouched (derivation `NONE`); above it there is ONE downscale to exactly 1000 px on the longest edge, and the result records `original_sha256`, `scale`, `width_px`, `height_px`. The downscaled file is the product identity of the run; the owner's original stays named. Same bytes → same size → same hash (guard test EG-11…13).
* How it was found, said plainly: the first real-asset run used 1200 px and MILA stopped at `EDGE_RECONSTRUCTION_RUN` by one 13-pixel run just over the limit; at 1000 px (the calibrated scale) it passes. No limit was edited, no limit differs between assets, and the remax photograph is `MATTE_INVALID` at both sizes. The sensitivity is itself a finding: the local photograph segmentation is **resolution-dependent**, which is recorded in §10 and is one reason the provider segmentation port exists. Making the limits scale-invariant would be a change to the Phase 5 calibration and needs its own approval.

### 11.2 Native alpha is not assumed clean (`test/creative-e2e-native-defects.test.js`)
| Defect | Where it is stopped | Test |
|---|---|---|
| a glow baked into the alpha as a semi-transparent ring | native-alpha validation (`ALPHA_BAKED_HALO` / `ALPHA_OPAQUE_CORE`): BLOCKED at SEGMENTATION, 0 Brain calls, 0 provider calls, 0 € | ND-1, NA-8 |
| a pinhole (2×2) inside the product | native-alpha validation (`ALPHA_PINHOLES`); a larger enclosed opening is a legitimate product aperture | ND-3, NA-10 |
| a ragged/zigzag edge, dust, a second object, a product cut by the border | native-alpha validation | NA-9…14 |
| a halo that appears in the delivered composition of a clean native alpha | final gate INTEGRATION_ARTIFACTS: BLOCKED `INTEGRATION_ARTIFACT` even though the source is NATIVE_ALPHA | ND-2 |
| product pixels altered in the compositor | PRODUCT_DELIVERED_IDENTITY / PRODUCT_PIXELS_IN_THE_COMPOSITOR | RT-8, RT-27 |
| **a glow painted into OPAQUE pixels and marked opaque by the supplier** | **not detectable from the alpha**; no gate rejects it. The run is NOT stopped. It ends NEEDS_OWNER_REVIEW only because of the warnings every provider-free run carries (critic skipped, owner approval PENDING) — that is not a detection of the glow. Stated as a limit, not claimed as caught; the owner's visual review is the only control until a vision critic is connected | ND-4 |

### 11.3 The mutation survivors, classified (targeted sweep of the new code: run context, native alpha, final-gate routing)
356 mutants · 155 killed · 201 survivors, none left unexplained. (The earlier count of 224 was before the guard tests; two rounds of guards — EG-1…13, RT-27…30 — killed 23 more and an unreachable `FAILED_BEFORE_CALL` state was deleted rather than tested.)

| Concern named by the owner | Mutants that touch it | Status |
|---|---|---|
| **Routing** (stage order, entry/refusal routing, state mapping) | e2e.js request completeness (3 branches), gate→state priority, ceiling gate | all killed except: gate priority "placement ranks above artifacts when BOTH fail" (`.some`→`.every`, 1 survivor): both gates are listed in `block.reason` and the run is BLOCKED either way; only the headline code differs. `ceiling > 0`→`>=` (1): ceiling 0 is refused by the parity probe EP-2 and by the budget at the first reservation; same state, one step later. |
| **Fail-closed decisions** | final gates, request validation, budget refusal: killed. Native-alpha quality validation (`native-alpha.js`): 185 survivors | 107 are ±1 on a calibrated numeric limit (a boundary, not a decision); 78 are loop-bound `<`→`<=` (a no-op one cell past the array), `false`→`true` in a finding that is immediately followed by `return fail(...)` (changes the findings list, never the decision), and branches duplicated by an independent check (e.g. `touches border` is also judged by ALPHA_BORDER_TRANSPARENT). **Honest limit:** the ±1 boundaries of these calibrated limits are not pinned by tests; that is RECOMMANDÉ for later and no decision depends on them being exact, since INTEGRATION_ARTIFACTS and the delivered-identity gate are an independent second line (ND-2). |
| **Budget enforcement** | `>=`/`>` on reserve/settle, negative/NaN amounts, ceiling, unknown/closed reservations | killed (EG-1, EG-6…10). The 4 survivors (`>`→`>=` and `12`→`13` at lines 56 and 62) are equivalent: both comparisons carry a `+ 1e-12` tolerance, so `>=` and `1e-13` give the same result on every representable euro amount. |
| **Operation-id uniqueness** | counters per kind, never reused after a failure, restored on resume | killed (counter increment, `Math.max` on resume, id format). Survivors on these lines: `seq` (a trace-order counter, not part of an id) and `0`→`1` in `Math.max(x ?? 0, n)` (equivalent: n ≥ 1). |
| **Checkpoint invalidation** | `INVALIDATES` filter | killed (EG-2). |
| **Provenance / product identity** | native alpha never sets identity; delivered identity, product pixels and the asset hash are checked by gates | killed (RT-8, RT-27, E2-*); no survivor on those lines. |
| Cosmetic | reuse note payload (`calls_saved: 1`), failure reason `slice(0,160)`, default candidate index, critic cost estimate constant | not decisions: ledger text, truncation of a message, a key suffix, an estimate (the reservation is still enforced). |

## 12. Closure of the defects found by the assembled-system validation (NDR-P28)
Nothing here adds a provider or a tool. Each row is a defect observed on the real MILA / REMAX runs and what now happens.

| Defect | Cause | Now |
|---|---|---|
| A `SINGLE_IMAGE` request stopped with `NOT_A_MULTI_ASSET_PLAN` | the campaign planner only accepted multi-asset formats; the sequence planner already knew the `SINGLE` asset role | `options.single_asset` (set by the end-to-end run) lets the planner plan ONE asset; the default planner contract is unchanged (its test still expects NOT_A_MULTI_ASSET_PLAN). One asset, one run, the same budget / ledger / identity contracts, no second planner path. |
| Low ceilings gave `TECHNICAL_FAIL BRAIN_PORT_FAILED` | the run context refused the reservation correctly (the port was never called), but the Brain wraps every port error into its own, and the asset director degrades silently | the run context remembers the first refusal; the run maps it to `BUDGET_EXCEEDED` at the end of planning, of production, of refine and in the catch-all. A real provider failure stays `TECHNICAL_FAIL`. |
| Refine of the real MILA: `a BLOCKED run has no artifact to repair` | the real product has no case annotations, so the hard fidelity gate is NOT_MEASURABLE (`IDENTITY_ANNOTATIONS_MISSING`) and the layered status is `BLOCKED` although an image exists; refine knew only the delivered statuses | `classifyCandidate` says four things apart: `DELIVERED`, `UNMEASURABLE_DELIVERED`, `NO_ARTIFACT`, `INVALID` (codes `NO_ARTIFACT_TO_REPAIR`, `FIDELITY_NOT_MEASURABLE`, `ARTIFACT_INVALID`). An unmeasured candidate is repaired only if the caller says it judges the product pixels itself (`allowUnmeasurableIdentity`, set by the end-to-end run, which does: delivered-identity gate, product pixels unchanged). The fidelity gate itself is untouched; the repaired candidate is accepted on the same footing and only after the diff proves the product and the locked copy unchanged. |
| An approved price vanished | the brief claims reached the image only through request copy, silently | every approved claim and approved copy ends with a stated disposition (`VISUAL_COPY` / `CAPTION` / `METADATA_ONLY` / `NOT_USED`, with the reason and where it is placed); `options.claim_policy` declares the intent; a declared placement the plan does not hold is `CLAIM_NOT_PLACED`, an amount written in another form is `CLAIM_ALTERED`, an undeclared absent claim is `NOT_USED` with a warning (the state is then never READY). Nothing is forced onto the visual. To put the price on the image the request carries a locked unit with `role: 'PRICE'` and the exact approved wording (the layered runtime already refuses a price that is not an approved claim of the same wording). |
| Phone-case copy accepted on a power bank | no gate | `PRODUCT_COPY_CONSISTENCY`, before anything is spent: the declared product category against the attributes the copy asserts (table in `consistency.js`). `PRODUCT_COPY_CONFLICT` blocks (never rewrites). Limits: the category comes from the declared product only; a product that is not declared is `CATEGORY_NOT_DECLARED` (a warning); a cross-sell mention is not a contradiction; it is a guard against the obvious. |
| `final.status_of_layered_run = BLOCKED` beside `NEEDS_OWNER_REVIEW`; `PLANNED_NOT_EXECUTABLE` beside a produced asset | raw sub-statuses exposed without a model | `final.layered_run = { raw_status, delivery, case_gate }` (delivery: `COMPLETE`, `IDENTITY_NOT_MEASURED_BY_THE_CASE_GATE`, `A_GATE_OF_THE_LAYERED_RUN_FAILED`, `NO_IMAGE`) and `execution = { planned, specified, produced, deliverable, layered_delivery }`. The planner's `execution` flag inside a stored plan means "the planner does not produce" and is superseded by `execution`. Invariant (tested): `produced` iff an image exists; `deliverable` implies a delivered final state. |
| Three manual invocations for a carousel | the entry point makes one scene per call | `runCreativeCampaign` over the same entry point: one campaign id, one campaign budget above the asset budgets (each asset runs with the remainder of the campaign as its ceiling; the planner estimate is judged against the campaign ceiling), one ledger, one shared planner store (the Brain is asked once), one shared layer store, the product segmented once, one run id and operation chain per asset, one `resume_state`. A cause shared by every asset (budget, a provider not connected) stops the rest once; an asset that fails alone does not stop the others. |
| No text-layer raster | not a defect | no downstream path needs one: the compositor draws the text from its geometry, style node and text hash (`TEXT:` / `TEXT_STYLE:` nodes), and a typography repair re-renders from the style node (a `TYPOGRAPHY_REPAIR` changed only `RENDER` and `TEXT_STYLE`). A second raster would be a redundant copy that could drift from the geometry; geometry + hash stays authoritative. |

Limits, stated: the campaign runs its assets one after the other (no parallelism); a campaign of N assets pays the planning once; the claim and consistency checks are deterministic text rules, not a reading of meaning; the Brain, the asset director and the layer generator are still scripted fakes in every test.
