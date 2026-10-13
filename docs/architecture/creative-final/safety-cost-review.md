# Creative security / cost safety review (read-only, 2026-10-14)

No credentials, secrets or configuration were touched.

| # | Area | Finding | Severity |
|---|---|---|---|
| S1 | Budget ceilings | Layered runtime: reservation before each call, ceiling refusal, REFINE allowance reserved first (good). **Single-image runtime: no reservation, spend or operation id** — relies on the port or the benchmark runner (`runtime.js:188-210`). Two different ceilings exist (2.0 € campaign dev ceiling, 1.0 € benchmark hard ceiling). | P1 |
| S2 | Operation ids | Generated only by the benchmark (`environmentOperationId`, `-c<n>` suffix). The layered runtime passes only `candidate_index = store.count + 1` and **no operation id**: uniqueness and "never reuse a reservation" are delegated to the port. | P1 |
| S3 | Spend booking | Layered spend is booked after the call; a thrown provider error leaves `spent` at 0 while the reservation stays held (safe for the ceiling, wrong for the spent report). In `runtime.js:210` a thrown error in the multi-candidate loop is not caught or recorded: earlier candidates' provenance is lost. | P1 |
| S4 | REFINE allowance | `room = allowance > 0 ? allowance : candidates − cached.length`: the allowance **replaces** the bound instead of being capped by it, and `store.allowance` is not decremented. Enforcement relies on the planner's pricing (at most 2 candidates per regenerated layer) and the reservation, not on a maximum constant — to be confirmed. | P1 (verify) |
| S5 | Evidence retention / location | The benchmark store writes `0o600` into a caller-given directory; "outside the repository" is documented but not enforced (substring test only). `creative-fidelity/provenance.js:85-92` enforces an absolute outside-repo path for its ledger and the same guard is missing from `createFileStore`; `mkdir` uses default permissions; nothing rotates or deletes; `buildRunRecord` copies free-form `metadata` / `output_ref` / `source_refs` unfiltered (could contain paths). `.gitignore` covers `.env`, `data/private/`, `benchmarks/creative-fidelity/private/`, `artifacts/private/`, `.nordla-private/`, `config/marketing-creative.alibaba.env`. | P2 |
| S6 | Generated image caps | Layered: only per-request `candidates` and the ceiling, **no per-run image cap**; benchmark: `environment_images_per_run: 3` via SpendGuard; campaign estimate ≤ 3 per asset, bounded by 2.0 €. | P2 |
| S7 | Retry / repair limits | Brain: one protocol repair per call, `MAX_CONCEPT_ROUNDS = 2` (per-life bound only when `bounds` is passed); critic loop capped at 3 and not raisable by the caller; benchmark `protocol_repairs_per_run: 4`, `recovery_actions: 1`; REFINE max 3 attempts per scene; **Phase 5: no provider call, no retry**. | P2 |
| S8 | Credentials / logging | No logging of API keys or headers in Creative `src`; `api_key` appears only in forbidden-key lists; credentials live in `marketing-creative/alibaba` (out of scope) and the config file is gitignored. | OK |
| S9 | Product asset leakage | Guarded in the layered path: environment requests carry `input_asset_refs: []` and record `carries_input_asset`; the ledger stores `prompt_sha256`, not prompts; real product pixels never go to a provider; the benchmark writes the delivered image (it contains the product) to the private store only. **The Phase 5 segmentation port receives the full source photograph by contract**: connecting a real segmentation provider would send product pixels out — a deliberate decision to take at connection time (the opposite of the plate/prop rule). | note |
| S10 | Uncontrolled fallback | None found: no fallback to a single-image generator, no tool switch, no generative replacement of the product (Phase 4 asserts it; Phase 5 has no way to). | OK |
| S11 | Repeated paid calls | `runtime.js` reuses one request for up to 3 environment candidates (the same request paid up to 3×; cap from the caller; a non-integer falls back to 1). Phase 5 segmentation results are cached by source + selection + segmenter id (a port is called once per unchanged input). | P2 |

## Gaps to close before any live use (proposals only)
1. One wrapper giving every provider call (single-image and layered) a unique operation id, a pre-call reservation and a post-call ledger entry even on error.
2. A hard per-run image cap in the layered runtime.
3. The outside-repo guard of `provenance.js` applied to the benchmark `createFileStore`, `0700` directories, and a retention rule.
4. A decision on whether a segmentation provider may see the full product photograph.
