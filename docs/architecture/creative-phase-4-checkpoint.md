# Creative — Phase 4 checkpoint (2026-10-13)

Purpose: a durable, self-contained statement of where Creative stands after Phase 4, so that work can resume without the conversation. Facts only; every number below was measured or read from a committed file on the date above. This file is documentation: it is outside the code hash (`src`, `test`, `scripts`, `package*.json`), so it does not invalidate the readiness attestation.

## 1. Where things are

| Item | Value |
|---|---|
| Repository / worktree | `retail-ai-core`, worktree `C:\Users\etaba\Desktop\retail-ai-core-creative-phase4-wt` |
| Branch | `feature/creative-phase-4-refine-layer-repair` (pushed, worktree clean) |
| Built from | `9f30628` (Phase 3 closure, branch `feature/creative-phase-3-layered-scene-production`, untouched) |
| Phase 4 tip at checkpoint | `f9fa326` (this file is committed after it) |
| Code commit that was verified | `2c4fa34476351a2cda8af2b61acf09ea78c0cdb5` |
| Code hash in the attestation | `44bded3f87508cb8809ca9a96c27711af2ac8ee9` |
| Not merged anywhere | no merge to `main`, no rebase of shared history, no force push |

## 2. Phase status (owner order NDR-P17)

| Phase | Status |
|---|---|
| 1 Content Format Planner | complete, attested |
| 2 Multi-asset / carousel planner | complete, attested |
| 3 Layered scene production (architecture + executable runtime) | complete, attested (`9f30628`, CI success run 38307717076 recorded by the Phase 3 session) |
| **4 Executable REFINE + layer repair + masked-edit interface** | **complete in code and tests; combined readiness NOT_READY only because the CI run is unread (see §7)** |
| 5 General segmentation + realistic integration | NOT STARTED (owner stop condition: do not start without an explicit order) |
| Video, upscale, multi-reference, new image providers, live HABB benchmarks | out of scope until after Phase 5 |

## 3. What Phase 4 built

`src/creative-refine/` (new, additive): `constants.js`, `defects.js`, `dependency-map.js`, `planner.js`, `refine.js`, `memory.js`, `masked-edit.js`, `parity.js`, `index.js`. Design and rules: `docs/architecture/creative-refine.md`; decision `NDR-P25`; generated matrix `docs/architecture/creative-refine-contract-matrix.md`; parity script `scripts/check-creative-refine-parity.mjs`.

* Concepts: DefectRegion, RepairEvidence, RepairScope, RepairReason (block codes), RepairPlan, LayerDependencyMap, RepairResult, RefineMemory.
* Executable scopes: `PROP_REPAIR`, `PLATE_REPAIR`, `TYPOGRAPHY_REPAIR`, `COMPOSITE_REPAIR`, `LAYER_REMOVE_OR_REPOSITION`. **No scope regenerates the creative, the concept, the art direction or the product.**
* A repair re-runs `runLayeredCreative` on a **copy** of the shared layers with only the plan's overrides; kept layers come from the store (same bytes, same hashes); only the replaced layer is paid for (allowance 2 candidates per regenerated layer, reserved before the call). The result is checked node by node against its own plan; a change outside the plan, to the product, to locked text, more calls than the allowance, or a tool switch → rejected, original kept.
* Dependency-aware invalidation: bad prop → prop + composites + text style + render; bad foreground prop does not touch the base under the product; typography → text style + render; plate → plate + composites + text style + render. Upstream (concept, art direction, asset plan, product identity), the product node and the locked text nodes are never invalidated by a layer defect; an upstream defect is `REPLAN_REQUIRED`.
* Working memory: reposition (anchor 1, then 2 / foreground inset 0.15, then 0.05) → remove → replan; a failed repair is not repeated; max 3 attempts per scene; plain JSON, resumable.
* Critique → action: the critic's `REVISION_INTENT` vocabulary and the gate findings of a delivered candidate map to defects (`defectsFromRevisionIntents`, `defectsFromCandidate`); nothing maps to "regenerate everything"; an owner that cannot be named is refused, never guessed.
* Masked editing: provider-independent **interface only** — `CAPABILITY_INTERFACE_READY`, `PROVIDER_NOT_CONNECTED`. Request contract, validation (a mask touching a protected region is refused before any provider), output check (protected pixels intact). Not an executable scope; a repair that needs it → `NEEDS_A_MASKED_EDIT_PROVIDER`.
* Executor is testable: `refineCreative({ …, runtime })` takes the layered runtime as an injectable dependency (default: the real one).

Additive changes to existing files: `src/creative-runtime/layered-runtime.js` (shared layer store: `reject / count / allowance / fork / export`, resumable from JSON; policy hooks `drop_layers`, `anchors`, `typography.plate_behind_text`; the **layered artifact** — the hash of every layer — on the result), `src/creative-runtime/ledger.js` (refine components and decisions), `src/creative-production/constants.js` (one block code), `src/creative-readiness/index.js` + `test/creative-readiness.test.js` (component `REFINE`), `.github/workflows/creative-intelligence-v1.yml` (paths), `NORDLA-DECISION-REGISTER.md` (NDR-P25). The single-image `runtime.js` is byte-for-byte unchanged (a test pins its hash).

## 4. Commits of the phase (oldest first)

`b20f4e7` executable REFINE + store/policy/artifact hooks + RF tests · `0cbae0d` REFINE in the readiness verdict, parity audit, doc, NDR-P25, CI paths · `f0e23d1` fast planner suite; two planner defects fixed · `893264c` edge guards, policy as a parameter · `c8ac3e2` last guards, selective scenarios (`RF_SCENARIOS`) · `0b5508f` post-run check simplified · `fad2fc5` injectable runtime + executor suite · `6564cc7` store suite · `0c10c72` mergePolicy / unchanged filter simplified · `fc4f386` RF-27/RF-28 (runtime prop-tool check, allowance of one) · `2c4fa34` unchanged-node guard · `f9fa326` attestation + verification section.

## 5. Tests and measurements

| Check | Result |
|---|---|
| Focused: `creative-refine.test.js` (RF-1…RF-28, real layered runtime behind a fake layer port) | green |
| Fast suites: `-planner` (PL), `-planner-edges` (PE), `-executor` (EX, fake runtime), `-store` (ST), `-parity` (RP) | green |
| Full suite, clean clone, **Node 24.21** (Docker, concurrency 4) at `2c4fa34` | 2346 tests, 2343 pass, 2 skipped, 1 failure = `CR-6` (expected until the attestation names REFINE; passes on the attestation commit) |
| Full suite, clean clone, **Node 20.20** | identical |
| Phase 1–3 tests | green (whole suite) |
| Provider calls / live images | 0 / 0 |
| Mutation (in-house operator harness, outside the repo) | REFINE 510 mutants, 459 killed, 51 documented; layered-runtime additions: 17 run (timeboxed), 16 killed, 1 documented unreachable; **remaining runtime hooks NOT swept** (asserted by RF-2/5/10/17/21/27/28, which is not a mutation result) |
| CI | workflow `creative-intelligence-v1.yml` runs on the push; **result unread** (no GitHub CLI, private repo) |

Documented survivors (51 in REFINE): 19 nullish defaults (`??`→`||`, left operand is only null/undefined/object), 28 conjunctions inside the parity audit's own probes (each conjunct asserted by PL/PE/RF), 3 equivalent PNG-mask-reader shapes, 1 equivalent policy-key merge.

## 6. Architecture decisions taken in Phase 4 (and why)

1. Repair by **re-running the layered runtime on a copy** rather than patching pixels: keeps every gate (identity fidelity, Guardian, compositor) in force and makes "unchanged layer = same hash" provable.
2. The check against the plan is the safety net, not the planner: a bug in planning cannot silently change the product or the text.
3. Masked editing is an **interface**, never a simulated capability, until a real tool is approved (NDR-D01 style explicit tool candidates).
4. A named-but-unknown layer is never re-targeted to "the only prop" (found by the planner tests); a defect that names nothing may default only where there is a single candidate.
5. The repair policy is a parameter (`policy` of `planRepair`), and two dead checks were removed — found by mutation analysis, not by review.
6. Readiness: `REFINE` is a sixth active component; CI is recorded as `unknown`, **not** success, so the verdict stays honest.

## 7. Known issues / open items (nothing hidden)

* **CI unread.** `creative-readiness.json` has `ci.status: unknown`; the combined verdict is `NOT_READY` with the single reason `CI_NOT_SUCCESS_YET` (the Brain gate repeats it). Reading the run and recording it as success (with the run id) is the only step left to reach `CREATIVE_PIPELINE_READY` for this code. Do not mark it success without reading the run.
* Mutation coverage of the runtime hooks is partial (see §5).
* A repair regenerates at most 2 layers and strictly fewer than the scene has; a foreground prop has one declared anchor family; repositioning follows the fixed ladder; relight / contact shadow / grading are Phase 5.
* Harness lesson (for anyone repeating a sweep): run fast pure suites per mutant; end-to-end scenarios cost ~15–75 s per mutant. `RF_SCENARIOS=<list>` builds only the scenarios a run needs.
* Windows checkouts are CRLF; scripts that edit sources must normalise line endings.

## 8. Exact next steps

1. Read the GitHub Actions run for `feature/creative-phase-4-refine-layer-repair` (workflow *Creative Intelligence V1*). If green: set `ci: { status: "success", run: <id> }` in `docs/architecture/creative-readiness.json` and `creative-brain-readiness.json` (documents only; the code hash is unaffected), run `node scripts/check-creative-readiness.mjs` and expect `CREATIVE_PIPELINE_READY`.
2. Owner decision: merge order for Phase 3 → Phase 4 (nothing is merged).
3. Only on an explicit owner order: Phase 5 (generic segmentation port + deterministic fixtures; contact shadow as a separate recomputable layer; bounded grading and relight under declared fidelity tolerances; fail closed outside tolerance; no new paid provider; no weakening of identity protection). Then focused tests → mutation → full suite → clean clones Node 20 + 24 → CI → attestation, one heavy job at a time.
4. If a masked-edit provider is ever approved: connect it behind `ports.maskedEdit` (needs `edit()` and a non-empty `tool_id`), through an OPEN provider gate, with the protected-pixel output check already in place; add it as a new scope only with its own plan rules and tests.

Rules in force: no live provider calls, no live images, no Shopify/HABB changes, no changes to Core/Finance/Buying/China Sourcing from this branch, one heavy local task at a time.
