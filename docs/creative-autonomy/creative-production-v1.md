# Nordla Creative Production V1 — scene around the real product

Updated 2026-11-02 (branch `feature/creative-production-v1-scene`, based on PR #35 head `de403d3`). **Purpose:** one authentic, premium Nordla advertisement for HABB first, then the three concepts.

## Decision (owner, 2026-11-01)

The PR #35 path (a background generated WITHOUT the product, then the photo pasted on it) was replaced. A background that never saw the product cannot give it a contact shadow, a reflection, a shared perspective or a coherent light. The retained architecture:

1. **Brain, unchanged:** FRAME, IDEATE (3 concepts), SELECT. Then ART_DIRECT and STAGE **of the concept SELECT chose only** (`runAutonomous({ produce: 'SELECTED' })`). If SELECT finds no concept to produce (`NO_CLEAR_WINNER`, `REJECT_CONCEPT`), the run stops **before any image call** (`STOPPED_NO_CONCEPT_SELECTED`). A `REFINE_CONCEPT` outcome (Nordla's best, judged promising but not yet strong) is produced and labelled as such in the trace.
2. **Plate (local):** the real cut-out (`examine_product.py`) is placed on a neutral grey canvas at the final format, exactly where the compositor will restore it (`scene_plate.py`, the same formula and resampling as `compose_stage.py`: a test checks it pixel for pixel).
3. **One image edit, n variants:** `qwen-image-edit.js` (existing lane, now `n` = 1 to 6) sends the plate as the reference with the scene described from Nordla's concept, art direction and stage. Positive prompt = Nordla's decisions; HABB's exclusions **only** in `negative_prompt` (lesson of the 2026-10-10 live run). `prompt_extend: false`. The plate is an image derived from the authorised photo: its clearance is the owner's record via `deriveCandidateAuthorization`, bound to the plate's bytes.
4. **Per-variant checks (local, `scene_check.py`):**
   - BLOCKING: where the model really drew the product (shift and scale searched on the contours; the authentic pixels are restored **there**, so the model's shadow and reflection stay under the restored product); a ghost edge around it; a second product in the scene (shape AND detail correlation).
   - WARNINGS, shown to the critic and the owner: contact shadow, reflection (expected on a MIRROR floor), light side of the redrawn product versus the photo, busy integration zone (`environment-suitability.js` structure measure).
   - The best passing variant becomes the scene; if none passes, an honest stop with the evidence for each variant.
5. **Restoration and text (local, `compose_stage.py`):** the photo's pixels at the measured place, at a level measured on the model's rendering (a bounded layer, removed by the fidelity proof). No synthetic shadow when the scene has its own. Headline from Nordla, price and name from the verified Shopify snapshot.
6. **Refinement:** the paid scene is never regenerated. Only the text may move (deterministic). A framing change or the critic's hints are **reported to the owner, not applied**.

Restoring authentic pixels is not proof of realism. The measured shadow, reflection and light are indicators; the owner judges at full size.

## Removed from PR #35 (duplicates)

`alibaba-background-engine.js`, `visual-production-contract.js`, `prepare_generated_background.py` and their tests: a third text-only background path beside `qwen-environment.js` and `creative-runtime` C2-C, with the weaknesses found in the review (old OpenAI-compatible client with `prompt_extend` on by default, forbidden objects named in the positive prompt, blind placement, no check of the generated image, an untested real path). Kept from PR #35: the area-tier image pricing (verified against the Alibaba API reference), portable compositor fonts.

## Single execution point

`scripts/creative-autonomy-trial.mjs --scene` (plan, then execute). The plan id binds the code fingerprint, the photo SHA-256, the text model and scope (EU), the image model and scope (GLOBAL), the workspace layout, variants, size, call caps and the **0.50 EUR** ceiling. Execution additionally requires the image-workspace key, the owner's scene media record (written by `--plan` as a REVOKED template), and two FREE model-list checks before the one-attempt lock.

## Money (TYESO photo, computed by `--plan --scene`)

- Image call: 3 × 0.03438 USD (1K, 1080×1350 ≤ 2.25 Mpx) + 1 reference image × 0.00275 USD = **0.10589 USD**.
- Text and one critique at the qwen3-vl-plus list price: expected ≈ 0.012 €, worst ≈ 0.050 €.
- Estimate ≈ 0.11 €, worst ≈ 0.15 €. Safety ledger (text at the qwen3.8-max rate, USD = EUR) provable maximum ≈ 0.47 €, under the 0.50 € ceiling.

## Not proven

- No real image has been generated: the provider is simulated in every test. Whether Qwen keeps the product in place well enough is the open question the first paid run answers.
- The thresholds (contour correlation 0.30, ghost 20 %, duplicate 0.75 / 0.45, search radius 28 px) are calibrated on simulated scenes only.
- Nothing has run on Windows on this branch.
