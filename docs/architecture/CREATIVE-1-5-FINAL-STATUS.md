# Creative phases 1–5 — final status (2026-10-14)

Authoritative, deliberately unoptimistic. Written from tests, readiness records, git history and a static trace of the runtime wiring; nothing here was inferred from file existence alone. Companion documents are in `docs/architecture/creative-final/`.

**One-sentence truth:** Creative 1–5 is a set of **separately tested, attested, offline libraries** (planning, brain, campaign, layered production, refine, integration) that have **never been run as one chain**, with **no real provider connected to the layered path**, **no production entry point**, and the Phase 5 module **not yet called by the layered runtime**. Everything that exists fails closed and is documented; very little has met reality.

## 1. Phases, tips, hashes, evidence
| Phase | Branch | Tip | Code verified / hash | CI evidence | Closed |
|---|---|---|---|---|---|
| 1 Content Format Planner | `feature/creative-phase-1-format-planner` | `6f7a4e8` | per its attestation (not re-verified tonight) | per branch record (not re-read tonight) | yes |
| 2 Multi-asset / carousel / campaign planner | `feature/creative-phase-2-campaign-planner` | `860d8a6` | per its attestation | per branch record | yes |
| 3 Layered scene production | `feature/creative-phase-3-layered-scene-production` | `9f30628` | per its attestation | run 38307717076 (recorded by the Phase 3 session) | yes |
| 4 REFINE / layer repair | `feature/creative-phase-4-refine-layer-repair` | `3f858f5` | `2c4fa34`, hash `44bded3f…` | run 38398261230 (Node 20 + 24 success); closure run 38400493168 (Node 24 failed once on an unrelated intermittent test, passed on re-run; Node 20 success) | yes |
| 5 Segmentation + integration | `feature/creative-phase-5-integration` | `f9c8afd` (+ this documentation commit) | `08b683c`, hash `bf5ea85e03856959dcd15b3b05496c5041222ea2` | Creative Intelligence V1 run 38477140859 (Node 20 **and** Node 24 success, first attempt); Marketing V1 run 38477140804 success | yes (as a module) |

`node scripts/check-creative-readiness.mjs` → `CREATIVE_PIPELINE_READY`. Clean-clone full suite (Docker, concurrency 4) on the Phase 5 code commit: **2385 tests, 2382 pass, 2 skipped, 1 fail on Node 24.21 and on Node 20.20**; the one failure (CR-6) is the committed-attestation test that can only pass once the attestation exists, and passes on the attestation commit. Live provider calls in Phase 5: **0**; nothing merged to `main`.

**What "READY" means here:** seven components (PLANNING, BRAIN, CAMPAIGN, PRODUCTION, LAYERED_RUNTIME, REFINE, INTEGRATION) each passed a parity audit, a mutation sweep and a clean clone. It is **not** an end-to-end run, and it does not cover the Critic, the Fidelity module, the single-image runtime or the benchmark module.

## 2. Capability inventory
Classes: READY_NOW (implemented + tested + attested, as a library on fixtures/fakes) · ARCHITECTURE_ONLY · PROVIDER_REQUIRED · REAL_WORLD_VALIDATION_REQUIRED · DEFERRED · NOT_IMPLEMENTED. "also" = a second class that applies. **"READY_NOW" never means wired or validated on real data.**

### Planning
| Capability | Class | also | Evidence / limit |
|---|---|---|---|
| Content format planning, single-image planning, channel/canvas planning | READY_NOW | REAL_WORLD_VALIDATION_REQUIRED | `src/creative-planning`; 71 tests; never run on real HABB copy with a real model |
| Long-copy decomposition, copy distribution, locked / adaptable / generatable copy | READY_NOW | REAL_WORLD_VALIDATION_REQUIRED | same; copy integrity enforced in production |
| Carousel planning, campaign planning (density, sequence, continuity, diversity, budget) | READY_NOW | REAL_WORLD_VALIDATION_REQUIRED | `src/creative-campaign`; 53 tests |
| Ingestion of raw briefs / documents / images (`understand` port) | PROVIDER_REQUIRED | NOT_IMPLEMENTED | port exists, no real implementation |

### Creative Brain
| Capability | Class | also | Evidence / limit |
|---|---|---|---|
| Framing, ideation, concept selection, art direction, composition planning, production strategy | READY_NOW (protocol, with fake model ports) | REAL_WORLD_VALIDATION_REQUIRED | 197 tests; a real Qwen brain port exists and ran in benchmark scripts only; the live attempts were stopped by the owner (attempt 12 archived) |
| Substitute detection, unknown handling, protocol repair (bounded) | READY_NOW | — | tested; repair limits per call |

### Production
| Capability | Class | also | Evidence / limit |
|---|---|---|---|
| Layered scene planning, scene specification, capability routing, production budget | READY_NOW | — | 69 tests |
| Plate generation boundary, props generation boundary | ARCHITECTURE_ONLY | PROVIDER_REQUIRED | the layer port is faked in every test; **no real implementation anywhere** |
| Real product insertion (annotated-outline cut-out, `containFit`) | READY_NOW | REAL_WORLD_VALIDATION_REQUIRED | the only product path the layered runtime uses; needs a human outline annotation |
| Deterministic typography, deterministic composition (compositor) | READY_NOW | — | pixel-exact product check in the compositor |
| Product identity preservation (hard fidelity gate) | READY_NOW | — | gate + compositor check |

### Refine
| Capability | Class | also | Evidence / limit |
|---|---|---|---|
| Defect localization, dependency map, invalidation, repair planning, working memory, store/checkpoint, local repair execution | READY_NOW | — | 28 end-to-end + 5 fast suites; real layered runtime behind a **fake** layer port; **no caller outside tests and the readiness gate** |
| Selective / masked edit | ARCHITECTURE_ONLY | PROVIDER_REQUIRED | interface + validation + protected-pixel check; `PROVIDER_NOT_CONNECTED` |

### Integration (Phase 5)
| Capability | Class | also | Evidence / limit |
|---|---|---|---|
| General segmentation (plain-ground photographs), multi-object selection, matte quality (14 checks), identity decision, bounded relight/grade, placement rules, contact shadow (separate layer), artifact detection, nine fail-closed states | READY_NOW | REAL_WORLD_VALIDATION_REQUIRED | drawn fixtures + 1 real asset (see §5); **not wired into the layered runtime** |
| Segmentation provider (port) | ARCHITECTURE_ONLY | PROVIDER_REQUIRED | port validated by the same contract; nothing connected |
| Native-alpha (pre-cut PNG) path | NOT_IMPLEMENTED | — | 4 of 9 real assets are pre-cut |
| Rotation / perspective warp of the product; light estimation from the scene | NOT_IMPLEMENTED | DEFERRED | the light is declared, not estimated |

### Runtime
| Capability | Class | also | Evidence / limit |
|---|---|---|---|
| Persistence / resumability (layer store export/fork/resume), evidence ledger, classified failure states, readiness gate | READY_NOW | — | tested; resume equals clean build (RF-10) |
| Cost control, provider gate | READY_NOW (layered) | — | single-image runtime has no reservation or operation id (P1 in the safety review) |
| Production entry point (CLI/service/route chaining the stages) | NOT_IMPLEMENTED | — | none: only tests/scripts compose the stages |
| Real provider execution in the layered path | PROVIDER_REQUIRED | — | none connected |
| Video, upscale, multi-reference | DEFERRED | — | after Phase 5 per NDR-P17 |

## 3. End-to-end reality check (static trace)
| Transition | Status | Note |
|---|---|---|
| BRIEF → CONTENT ANALYSIS | PARTIALLY_WIRED (library) | `understandInputs` takes a port; no real understander |
| ANALYSIS → FORMAT PLAN | WIRED inside the campaign planner | callers: tests, parity |
| FORMAT PLAN → CAMPAIGN / ASSET PLAN | WIRED (library) | no runtime caller |
| FRAME → IDEATE → SELECT → ART DIRECT → COMPOSE | WIRED inside `createCreativeBrain` | real caller: the brain benchmark script (real Qwen port) |
| BRAIN PLAN → LAYERED PRODUCTION | PARTIALLY_WIRED | the benchmark feeds the **older single-image runtime**, not the layered one |
| SEGMENT REAL PRODUCT | WIRED to the **old** annotated-outline segmenter | |
| INTEGRATE PRODUCT (Phase 5) | **NOT_WIRED** | no import from runtime/production/refine; tests, one script, readiness only |
| TEXT | WIRED | typography inside `runLayeredCreative` |
| REFINE | PARTIALLY_WIRED | executor works on the real layered runtime; no caller |
| GATES: preflight, identity fidelity | WIRED | |
| GATE: Brand Guardian | PARTIALLY_WIRED | blocks (`BRAND_GUARDIAN_NOT_CONFIGURED`) until configured |
| GATE: critic | NOT_WIRED to the layered runtime | run by benchmark/scripts after the single-image runtime |
| FINAL ASSET | PARTIALLY_WIRED | a PNG artifact with status `READY_FOR_REVIEW`; nothing stores or publishes it |

Documentation that suggests more than the runtime has: the readiness note ("the whole active Creative pipeline"), NDR-P22 ("one verdict for the whole pipeline"), NDR-P26 and `creative-integration.md` §1 (arrows drawn as a flow, though the module is a library), `creative-brain-benchmark.md` ("wired into the product-preserving runtime" = the single-image one). The wording has been left; this document is the correction.

## 4. Provider gaps (summary; detail in `provider-gap-matrix.md`)
No real provider is connected to: plate/prop generation in the layered path, segmentation, masked editing, understanding of raw inputs, upscale, video, multi-reference. Real Qwen ports (brain, director, vision critic, environment, product edit) exist and ran only from scripts, never from a service.

## 5. Real-product limitations (detail in `real-habb-product-matrix.md`)
9 real HABB images: **1 integrates (MILA case), 4 stopped by the matte gate (remax FC-02 chrome connector, black bag, pink tumbler with baked glow, gold magnet with baked shadow), 4 refused before segmentation** (ambiguous plaque, checkerboard-baked PNG, lifestyle scene, the real benchmark photograph on a non-plain ground). All stops were judged correct; none was forced. The local segmenter is a **plain-ground, opaque-photograph tool**. Seven drawn product classes pass.

## 6. Known flaky tests
`test/creative-intelligence-product-mask.test.js:57` (PM-6): failed once on Node 24 in run 38400493168, passed on re-run, not reproducible, not caused by Phase 4/5 (code unchanged since Phase 3). **Unexplained.** The Phase 5 CI run passed first time.

## 7. Mutation coverage reality
| Component | Mutants | Killed | Documented survivors | Note |
|---|---|---|---|---|
| PLANNING | 82 | 81 | 1 | |
| BRAIN | 154 | 152 | 2 | |
| CAMPAIGN | 68 | 68 | 0 | |
| PRODUCTION | 112 | 112 | 0 | |
| LAYERED_RUNTIME | 154 | 146 | 8 | Phase 4 hooks only partly swept |
| REFINE | 510 | 459 | 51 | end-to-end asserted by tests, not mutation |
| INTEGRATION | 484 | 275 | 209 | **targeted** (identity, thresholds, routing); 188 survivors are numeric/boundary changes in pixel arithmetic; kill rate 57 %; segmentation internals, matte internals, shadow geometry not mutation-covered |

The harness is in-house. A survivor classed "documented" is not a proof of equivalence in every case.

## 8. Runtime wiring, cost and safety
See `safety-cost-review.md` and `code-health-findings.md`. Highlights: no P0; P1 = single-image runtime has no budget/operation id, layered calls carry no operation id, a thrown provider error leaves the spent report wrong, REFINE allowance cap to be verified; two different ceilings (2.0 € / 1.0 €); no per-run image cap in the layered runtime; benchmark store does not enforce the outside-repo guard. No credential logging found. No fallback to a generated product exists.

## 9. Performance
See `performance-snapshot.md` (tests and fixtures only; no live call; no optimisation done).

## 10. Before-trip / after-trip
See `roadmap-before-after-trip.md`. **No Creative item blocks the trip.** Recommended before: park the work (tags), decide the merge route in principle, shoot the real benchmark assets. Everything else (wiring, providers, native-alpha path, benchmark, merge) after return.

## 11. Merge status and rollback
**Nothing merged; `main` untouched.** `origin/main` = `a9d0e2f` is an ancestor of every phase tip (fast-forwardable). The branch carries 345 commits / 851 files, of which 197 commits are non-Creative (Finance, Core/sync/tenant with 18 Supabase migrations, Analytics, Marketing, Branding, Activation, Provider-connections, Socle). "Creative only" is not extractable without Branding, Marketing M1–M4, Socle and tenant (HARD dependencies) and the repo-wide privacy test. Recommendation and rollback tags in `merge-dependency-report.md`. Rollback points: `a9d0e2f` (pre-merge), then `3d4f850`, `8105a82`, `6f7a4e8`, `860d8a6`, `9f30628`, `3f858f5`, `f9c8afd`; tag `creative-brain-baseline-2d5e885` exists; no other tag was created.

## 12. Master roadmap keys
PHASE_1…PHASE_5 = CLOSED · MAIN_MERGE = NOT_DONE · LIVE_PROVIDER_VALIDATION = NOT_DONE · REAL_PRODUCT_MATRIX = PARTIAL · PRODUCTION_DEPLOYMENT = NOT_DONE.
