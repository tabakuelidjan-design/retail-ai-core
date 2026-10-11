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
