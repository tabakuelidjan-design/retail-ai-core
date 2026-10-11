# Creative Brain benchmark 001 — the live runner

Status: wired and tested with fake ports. **Nothing has been run live.** `scripts/run-creative-brain-benchmark.mjs` is the only entry point; the logic is in `src/creative-brain-benchmark/` (provider-agnostic: every model, the image provider, the vision critic and the Brand Guardian are ports) and `src/marketing-creative/alibaba/qwen-brain-port.js` (the one place that names the provider).

## What it is
A fresh benchmark from the original brief and the real Samsung Galaxy A17 source asset, in a NEW private directory (`NORDLA_PRIVATE_DIR/creative-brain-benchmark-001`, default `~/nordla-private/creative-brain-benchmark-001`). It is not Candidate 4. It reads no earlier candidate, critique, direction or owner review (a test greps the sources), passes no reference image, and refuses an output directory that is the earlier run. Manual creative steering: none.

## Execution graph
```
OBSERVE → FRAME → IDEATE → SELECT CONCEPT → ART DIRECT → COMPOSE → SCENE → PRODUCTION STRATEGY      (Creative Brain, text port)
   → environment image (text-only scene request with the reserved integration zone)                    (image port)
   → deterministic product-preserving composite → Preflight → Fidelity → Brand Guardian                (runtime and gates)
   → execution critic (14 dimensions) + concept critic (6 dimensions)                                  (vision port, only if every gate passed)
   → recovery diagnosis → [RECONCEPT only: new concept → its single candidate → critics] → STOP for owner review
```
The relational composition is tried first; a preset is used only as a recorded `PRESET_FALLBACK` with its reason.

## Bounds
2 concept rounds in total (planning and recovery share them), 3 concepts per round, 1 production candidate per selected concept, 1 recovery action. Only a `RECONCEPT` is executed (it brings a new concept, which gets its own single candidate). A `REFINE` or `RECOMPOSE` decision is recorded as a recommendation and not executed: executing it would be a second candidate for the same concept.

## Cost and calls (worst case)
Text: 1 framing + 2 per concept round + 2 per planned candidate = 9. Images: 2. Vision: 2 critics × 2 candidates = 4. Total 15 calls. Each text call is bounded by construction (input refused above 12 000 estimated tokens before the network, output capped at 4 000 tokens, thinking off, no retry); the cost is computed from the lane's own price table (USD treated as EUR, which over-estimates). Worst case about EUR 0.57, spend guard at EUR 0.60, hard ceiling EUR 1.00 (the benchmark refuses to start above it).

## Modes
- `--check`: no network. Credentials (names only), output path new and writable, no earlier record or lock, asset hash, Brain contracts, capabilities, local segmentation dry-run, first instruction built from the brief only, worst-case cost.
- `--explain`: offline, read-only; the chain, the provider calls and the stop reason from the stored evidence.
- `--live --confirm-creative-brain-benchmark`: re-runs the checks, takes the exclusive lock (never released by code), then executes. No automatic retry.

## Result states
`BLOCKED`, `TECHNICAL_FAIL`, `TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT`, `READY_FOR_OWNER_REVIEW`. Never a plain PASS; `OWNER_APPROVAL` is always `PENDING`; an unjudged candidate is never ready.

## Known risks
- The Brain sees only the names of the brand expression sections; the brand's "don't" lists are enforced afterwards by the existing check on the scene request, which stops the run before the image call (after the Brain stages were paid for).
- The prompts have never met a real model; a non-conforming answer stops the run at that stage (BLOCKED, recorded, no retry).

## Final state and failures
The final state is the state of the last candidate that exists; a failure while preparing the single recovery is recorded (`error`, `final.stopped_early`) and does not hide a candidate the owner can review. With no candidate the final state is `BLOCKED`. A candidate stopped before the image call is `BLOCKED`; one stopped after the image was paid for (or by Preflight, Fidelity or the Brand Guardian) is `TECHNICAL_FAIL`, and no critic is paid for.

## Tests and mutation
`test/creative-brain-benchmark.test.js` (23 runner tests: no network in `--check`, no leakage of earlier candidates or the owner reference, stage order, relational composition before a recorded preset fallback, substitute product refused, product preservation, bounded recovery, RECONCEPT from the concept stage, live lock, cost cap, evidence, owner never auto-approved, no secret in the output) plus `BR-9` for the round budget. 28 mutations of the runner, the bounded Brain rounds, the Brain port and the store: all killed.

## Incident 1: NO_LAYOUT_RECIPE_FOR_THE_SPATIAL_INTENT (first live attempt, cost EUR 0.0369, no image)
The Brain produced a valid plan and synthesized a recipe (dominant product anchored to the end, text beside it). Solved against the real approved words in the real fonts, that first recipe failed (`TEXT_DOES_NOT_FIT`, supporting claim, `TOO_MANY_LINES`: a one-line claim needs a slot of at least 57.5% of the usable width, the first text column was 40%). The preset fallback then had nothing for an END-anchored intent, and the record kept only the preset's reason. Root cause: **RECIPE_SYNTHESIZER_CAPABILITY_LIMIT** (the synthesizer fixed one set of proportions without regard to the words), made opaque by a reporting defect. Fix: a plan now yields a deterministic LADDER of recipes (`synthesizeRecipeLadder`): every rung keeps every relation of the plan and flexes only the text proportion, bounded by a dominance-by-area rule (a dominant product keeps at least 2.5 times the area of the largest text slot). The runtime tries the rungs in order against the real texts before any preset; a failure records every rung with the solver's own reasons, then the preset attempt and its reason (`NO_EXECUTABLE_LAYOUT_FOR_THE_COMPOSITION`). The stored plan of the incident now lays out at rung 7 (product 36.6% of the width, full 80% height, text column 57.5%).

## Incident 2: ENVIRONMENT_NOT_EMPTY (second live attempt, cost EUR 0.1048, one image, no PNG)
Concept `cnc_38416aeef…` (two pairs of hands handing over the case across a shop counter). The scene request was correct: hands "in the foreground, at the edges of the frame", a worn wood counter, and a reserved zone "completely calm and empty... nothing stands on it, nothing crosses it". The provider drew the two hands at the CENTRE of the frame, inside the zone where the product is placed (about 20 % object structure in the zone), on a strongly grained wood counter, and a sign with lettering and a logo glyph at the right edge. Verdict: the REFUSAL WAS RIGHT (the integration zone was occupied: provider scene non-compliance), and the gate also had a legacy defect: it counted wood grain as failure (pure wood bands measured 9-27 % fine edges), so any realistic material under the product would have been refused.
Fix (generic): the decision is now taken at OBJECT scale (`zoneObjectStructure`: luma averaged over blocks of about 1.5 % of the canvas width; a step between neighbouring blocks above 16 levels is structure; limit 2.5 % of the zone). Grain averages out; objects, hands, lettering and logos survive. The pixel-scale edge share is still measured and reported, but no longer decides. Calibration on every real environment we hold: phone on a stone slab 10.9 %, first non-empty environment 15.2 %, stone block on a stone counter 4.9 %, this hands scene 20.3 % (all refused); accepted environments 0.0-2.0 %, a pure wood counter 1.9 % (accepted; it was refused by the old measure at 12.4 %). The same image with the product box moved onto the pure wood is accepted, with the hands in the zone it is still refused.
Known limits (unchanged, reported): the zone gate sees only the zone. Lettering, a logo or a competing object OUTSIDE the zone is not detected by a pixel gate (it needs an object or text detector); it is forbidden in the scene request and judged downstream by the critic. A large low-contrast object is detected through its contour, so a limit close to the accepted evidence was chosen on purpose (a false refusal costs one image; a false acceptance puts an object under the product).
