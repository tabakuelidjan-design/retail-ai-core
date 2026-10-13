# Creative refine — Phase 4: executable REFINE and layer repair

Status: built on `feature/creative-phase-4-refine-layer-repair`, offline, **no provider call and no image generated outside the test fixtures**. Decisions: NDR-P17 (order), NDR-P24 (layered runtime), NDR-P25 (this phase).

Principle: **a local defect must not force Nordla to regenerate the whole creative.** The smallest valid repair is chosen, executed, and checked against its own plan; a repair that cannot be proved to stay inside its scope is rejected and the original candidate is kept.

## 1. What exists

```
delivered layered candidate  (runLayeredCreative -> status, png, ARTIFACT: the hash of every layer)
        │   defects: from a gate, a critique (REVISION_INTENT), a measurement, or a region the owner points at
        ▼
DefectRegion ──► attribution to the layer that owns the pixels (topmost layer at the region; explicit node / layer first)
        ▼
PLANNER  ──►  RepairPlan { scope, steps, invalidated, reused, protected, cost, overrides }   or   BLOCKED (with a code and the replan)   or   REPLAN_REQUIRED (upstream)
        ▼
EXECUTOR ──►  a COPY of the shared layers + the overrides of the plan  ──►  the layered runtime again (every gate)  ──►  CHECK node by node against the plan
        ▼
RepairResult { REPAIRED | NOT_REPAIRED | BLOCKED | REPLAN_REQUIRED, before, after, layer_diff, product_identical, locked_copy_identical, cost }   (original kept unless REPAIRED)
```

| Concept | Where |
|---|---|
| DefectRegion, RepairEvidence, attribution, critique → action | `src/creative-refine/defects.js` |
| LayerDependencyMap | `src/creative-refine/dependency-map.js` |
| RepairScope, RepairReason (the block codes), RepairPlan | `src/creative-refine/constants.js`, `planner.js` |
| RepairResult, the executor, the node-by-node check | `src/creative-refine/refine.js` |
| Working memory (RefineMemory) | `src/creative-refine/memory.js` |
| Masked-edit capability interface | `src/creative-refine/masked-edit.js` |
| Parity audit and contract matrix | `src/creative-refine/parity.js`, `docs/architecture/creative-refine-contract-matrix.md` |

## 2. Executable scopes (and what is deliberately not one)

| Scope | What it does | Provider calls |
|---|---|---|
| `PROP_REPAIR` | replaces ONE generated prop with a new candidate of that layer | at most 2, only for that prop |
| `PLATE_REPAIR` | rebuilds ONLY the generated background plate | at most 2, only for the plate |
| `TYPOGRAPHY_REPAIR` | redraws the deterministic text STYLE (a brand plate behind the text, chosen from the brand tokens); the text itself is locked | 0 |
| `COMPOSITE_REPAIR` | recomputes the compositing from valid layers | 0 |
| `LAYER_REMOVE_OR_REPOSITION` | moves one prop to another declared anchor (or a foreground prop less over the product), or removes it | 0 |

There is **no** scope that regenerates the whole creative, the concept, the art direction, all assets, or the product. A plan that regenerates every generated layer of the scene (or more than 2) is refused as `REPAIR_SCOPE_TOO_BROAD`. A scope that does not exist, or is not allowed by the caller, is `REPAIR_SCOPE_INVALID`.

## 3. Dependency-aware invalidation

```
PLATE ───────────────┐
PROP (each) ─────────┼──► COMPOSITE_BASE (plate + background / midground props) ─┐
PRODUCT (protected) ─┴──► COMPOSITE_STACK (every raster layer) ──► TEXT_STYLE (colour read on the stack) ──► RENDER
TEXT (locked content) ───────────────────────────────────────────────────────────► (drawn by the deterministic typography)
upstream, never invalidated by a layer defect: CONCEPT, ART_DIRECTION, ASSET_PLAN, PRODUCT_IDENTITY
```

A bad prop invalidates that prop, the composites made from it, the text style read on them, and the render; it does not touch the plate, the other props, the product or the locked text. A bad foreground prop does not touch the base under the product. A typography defect touches the text style and the render only. A defect that truly originates upstream (concept, brand expression, composition intent) is answered with `REPLAN_REQUIRED` naming the upstream node; no layer is repaired in its place.

## 4. Product, copy and tool protection

* The real product pixels are authoritative. A defect that lies on the product (by region, node, or kind) is refused with `REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS`; the product node and the locked text nodes are never in an invalidated set, and the executor verifies after the run that the product node (cut-out, placement) and every text node (digest, geometry) are identical.
* Locked copy is exact: a copy change, or a defect on a text node other than a legibility one, is `REPAIR_WOULD_CHANGE_LOCKED_COPY`; the text is never an input of the repair.
* No silent tool or provider switch: the repair runs only with the tool the scene specification selected (the runtime already stops on any other); the executor additionally compares the tools executed by the port now with those recorded in the artifact and refuses a difference (`TOOL_SWITCH_REFUSED`) before any call.
* The repair never reaches the single-image runtime (`runtime.js` is byte for byte unchanged; a test pins its hash).

## 5. Cost and budget

A repair reserves and spends only for the layer it regenerates (the plan prices exactly those lines; a deterministic repair costs 0). The new candidates of a regenerated layer are bounded by the repair allowance (2), reserved before the call, and refused past the ceiling like any layered run. Every other layer is served from the shared layers, judged again for free by its own gate.

## 6. Working memory and recovery

* The shared layers keep every candidate ever paid for (a rejected candidate stays, so numbering and bounds never reuse an index); `reject`, `count`, `allowance`, `fork` and `export` make the working state a plain value that can be saved and resumed in another process. A repair works on a **copy**: the original store is replaced only when the repair is accepted.
* `RefineMemory` (plain data) records each attempt (plan, fingerprint, scope, outcome, cost). The planner escalates a placement defect reposition → reposition → remove → replan, refuses a repair identical to one that failed, and stops after 3 attempts per scene.
* A failed repair keeps the original candidate, the original artifact and the original store; nothing valid is lost.
* **Resume equals a clean build**: replaying the saved state from scratch with no provider gives the same delivered image (RF-10).

## 7. Masked editing: interface only

`describeMaskedEditCapability` reports `CAPABILITY_INTERFACE_READY` and **`PROVIDER_NOT_CONNECTED`**. A request carries: source image (hash, size), mask (rectangles or a PNG), instruction, protected regions, expected output class, provenance, cost estimate. It is validated before anything (a mask that touches a protected region is refused), reaches a provider only through an open provider gate, and its output is accepted only if every protected region is pixel-identical. A defect that needs a masked edit is refused with `NEEDS_A_MASKED_EDIT_PROVIDER`; it is not an executable scope and nothing is simulated.

## 8. Critique → action

`defectsFromRevisionIntents` maps the critic's `REVISION_INTENT` vocabulary: cleaner environment → plate repair; text hierarchy, typographic composition, claim and price presentation → typography repair; composition / whitespace / visual hierarchy → reposition or remove a prop; product dominance → upstream layout (replan); concept, brand expression, retail quality, template feel → upstream concept (replan); product integration (relight, shadow) → not available before Phase 5. An unknown intent is refused. `defectsFromCandidate` maps the findings of the gates of a delivered candidate (preflight contrast, identity fidelity, Brand Guardian); a finding that cannot be attributed to a layer is refused, never guessed.

## 9. Files, blast radius, rollback

| New | `src/creative-refine/{constants,defects,dependency-map,planner,refine,memory,masked-edit,parity,index}.js`, `scripts/check-creative-refine-parity.mjs`, `docs/architecture/creative-refine-contract-matrix.md` (generated), tests `test/creative-refine{,-parity}.test.js`, `test/creative-refine-world.js` |
|---|---|
| Changed (additive) | `src/creative-runtime/layered-runtime.js` (the shared layer store, policy hooks `drop_layers`, `anchors`, `typography`, the layered artifact on the result), `src/creative-runtime/ledger.js` (components and decisions of the refine), `src/creative-production/constants.js` (one block code), `src/creative-readiness/index.js` + its test (component REFINE), the CI workflow paths, `NORDLA-DECISION-REGISTER.md` (NDR-P25) |

The refine imports the layered runtime; nothing outside the readiness gate imports the refine. The single-image path is untouched. Rollback: revert the merge of the branch.

## 10. Not in this phase

A connected masked-edit provider; general segmentation, contact shadow, relight and grading (Phase 5); any live provider call; video, upscale, multi-reference composition.

## 11. Verification (recorded in `creative-readiness.json`)

| Check | Result |
|---|---|
| Focused suites | `creative-refine.test.js` RF-1 to RF-28 (real layered runtime, real gates, compositor and typography, fake layer port), `creative-refine-planner.test.js` + `-edges` (PL, PE), `-executor` (EX, fake runtime), `-store` (ST), `-parity` (RP), `creative-readiness.test.js` |
| Full suite, clean clone, Node 24 (docker, concurrency 4) | 2346 tests, 2343 passed, 2 skipped; the one failure was CR-6, which can only pass once the attestation names REFINE (passes on the attestation commit) |
| Full suite, clean clone, Node 20 | identical |
| Mutation (in-house harness) | REFINE: 510 mutants, 459 killed, 51 documented; layered-runtime additions: 17 run (timeboxed), 16 killed, 1 documented as unreachable; the rest of the runtime hooks were not swept and are covered by RF-2, RF-5, RF-10, RF-17, RF-21, RF-27, RF-28 |
| CI | Creative Intelligence V1 run 38398261230 (Node 20 and Node 24 success) on `9d919d2`, then run 38400493168 on the closure (Node 24 failed once on an unrelated intermittent test, then passed; Node 20 passed): recorded in `creative-phase-4-checkpoint.md` §5 and `creative-readiness.json`. (Earlier text of this row said UNKNOWN; superseded.) |
| Provider calls / live images | 0 / 0 (every image is drawn by a test; the layer port is a fake) |

Known limits (not worked around): the masked-edit capability has no provider; a repair regenerates at most two layers and strictly fewer than the scene has; a foreground prop has one declared anchor family; repositioning follows a fixed ladder (anchor 1, anchor 2 or inset 0.15, 0.05, then removal); relight, contact shadow and grading are Phase 5.
