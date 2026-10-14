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
