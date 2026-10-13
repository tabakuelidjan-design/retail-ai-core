# Creative performance snapshot (2026-10-14)

Existing tests and fixtures only, provider-free, no optimisation. Windows 11, Node 24.19, one file group at a time, wall clock including process start and fixture building. Memory is only available for the Phase 5 matrix runner (the others are `node --test` runs).

| Stage (test group) | Tests | Wall time | What dominates |
|---|---|---|---|
| Planning (`creative-planning*`) | 71 | 16 s | text units / layout solving |
| Campaign (`creative-campaign*`) | 53 | 10 s | planning loops, no pixels |
| Brain (`creative-brain*`) | 197 | 225 s | protocol validation + parity/contract probes repeated per test; no pixels |
| Critic + fidelity | 64 | 1 s | |
| Production (`creative-production*`) | 69 | 22 s | |
| Creative intelligence (C1/C2/C3 foundation) | 108 (107 pass, 1 skipped) | 191 s | rasterisation and mask building |
| **Layered runtime** (composition, gates) | 20 | **455 s** | SVG rasterisation of every layer, gates and compositor run per scenario; ≈ 23 s per scenario |
| Single-image runtime | 19 (18 pass, 1 skipped) | 26 s | |
| **Refine** | 62 | **278 s** | each repair re-runs the layered runtime on a copy (by design: every gate stays in force) |
| **Integration (Phase 5)** | 39 | 32 s | segmentation + matte checks |
| Readiness | 7 | 1 s (+13 s for the real gate: all audits) | |

Phase 5, measured by `scripts/creative-integration-matrix.mjs` (end to end, one product into a 900×700 scene):

| Case | Time | Heap delta |
|---|---|---|
| drawn products ≈ 300×440 | 0.6–1.3 s | −11…+7 MB |
| real 497×1000 photograph (MILA, analysed at ≤ 1000 px) | ≈ 5.0 s (analysis 1.3 s, selection + matte 0.8 s, grading / identity / shadow / artifacts the rest) | +71 MB |
| real 968×1000 (remax, stops at the matte gate) | ≈ 3.8 s | +47 MB |
| two products from one photograph | 2.1 s, source analysed once (cache hit on the second) | — |
Peak RSS of the matrix process ≈ 262 MB. A reused mask makes the second integration's segmentation < 20 % of the first.

## Expensive steps and repeated work (observations, nothing changed)
1. **Layered runtime ≈ 23 s per scenario** in tests: rasterisation (resvg) of plate, props, product and the composite at each stage, repeated by every REFINE attempt although only one layer changed. Opportunity: cache the rasterised kept layers keyed by their hash (the layer hashes already exist).
2. **REFINE = layered runtime again** (278 s for 62 tests): same cache would apply.
3. **Brain tests 225 s with no pixels**: contract/parity probes rebuilt per test; a shared memoised probe would cut most of it.
4. **Phase 5**: the colour-distance plane is computed twice (segmentation and matte check); the matte check recomputes connected components several times; the splitting step uses one distance transform now (it was iterated erosion: 4.6 s → 1.3 s). Analysis is cached per source; a source analysed for one selection is free for the next.
5. Fixture building (drawn products, grain, plates) is repeated in several test files; `segmented()` memoises within one process only.

## Not measured
Memory of the layered runtime and refine; any real provider latency (none exists); the cost of a full campaign (planning → production → refine) because no entry point chains them.
