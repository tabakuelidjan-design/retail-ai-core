# Nordla Creative Production V1 — scene around the real product

Updated 2026-11-02 (branch `feature/creative-production-v1-scene`, based on PR #35 head `de403d3`). **Purpose:** one authentic, premium Nordla advertisement for HABB first, then the three concepts.

## Product image selection — owner decision, 2026-11-02

**No pre-generation client confirmation of the product photograph.** This rule applies to Nordla's customer-facing workflow, not just the HABB TYESO trial.

- The client selects a product and requests creation. Nordla's media integration chooses an image matching the exact product/variant from the verified catalog and validates image suitability internally. **Never ask the client to approve or confirm that source image before generating.**
- If the chosen image is missing, unusable or inconsistent with the selected product, try another verified image **of the same variant**, if available; otherwise stop with an internal media diagnostic. Do not substitute another color, size or product; do not publish unsupported claims.
- The existing `runAutonomous` engine accepts a `photoPath`; the present trial CLI also needs `--photo`. These are **internal integration inputs**, not a customer approval workflow. Automatic Shopify media selection exists as an internal adapter (`src/creative-autonomy/product-media.js`, see the last section); it is **not yet wired to the customer-facing app nor to the `--scene` trial CLI**.
- **After creation**, show the actual finished output for the client's acceptance, revision or rejection. No automatic publication.
- External provider data clearance and approved financial caps are background **operator/security controls**, not customer-facing prompts. For customer-uploaded/personal images, do not bypass actual consent/privacy requirements.
- HABB confirms a direct commercial relationship with TYESO and does not want a supplier-permission message as a prerequisite to this trial. This does not grant a blanket license to other companies' assets.

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

## Automatic product-image selection — client rule implemented in internal adapter (2026-11-02)

`src/creative-autonomy/product-media.js` implements an internal read-only Shopify catalog media selector and the `runAutonomousWithShopifyMedia` entrypoint. It receives an already **tenant-verified** Shopify connector (it never reads credentials or bypasses `src/connectors/shopify.js`), obtains product media, matches the exact variant and product size from catalog metadata, fetches only CDN-hosted images over HTTPS, validates actual PNG/JPEG/WebP bytes/dimensions and stages the source privately. The creative engine is called with the selected media automatically. There is **no customer prompt for confirming the photo before creation**. Owner/customer review remains after rendering.

**Safety:** incomplete gallery or conflicting/ambiguous metadata ⇒ `NO_VERIFIED_SOURCE_IMAGE`, with no image download or generation. For TYESO **750 ml**, the HABB Shopify file `Black_20oz.webp` conflicts with the product size even if its alt claims 750 ml: reject instead of quietly creating an advertisement with the smaller bottle. A correctly labeled `Black_25oz` / `750ml` media may be selected. This is a strong metadata gate, **not a computer-vision proof** of the physical product: visual recognition and suitable cut-out still require the downstream checks.

**Integration scope:** the standalone `creative-autonomy-trial.mjs --scene` still requires an **internal** `--photo` path so its authorized plan is bound to exact bytes, and the customer-facing app has not yet been wired to call this adapter. This module is reusable by the verified Shopify connector integration; do not claim that any live storefront workflow has already been deployed. No Shopify mutation, Alibaba call, client prompt, budget authorization, merge or publication is done here.

## Audit corrections (Claude, 2026-11-02, on PR #37 head `2bcd3f5`; branch `fix/creative-production-v1-audit-20261102`)

**Media selection** (`src/creative-autonomy/product-media.js`)
- One read-only query by **immutable product + variant IDs**: product facts, variant list, product gallery (50), the variant (options, own media, 10). Requested cost **183** by Shopify's published rules (single-query limit 1000; the previous shape cost about 4500 and would have been refused). Every connection's `pageInfo.hasNextPage` must be `false`; an absent flag is incomplete.
- Evidence order: (1) the variant's own media in Shopify; (2) a product **without options** (`hasOnlyDefaultVariant`) — a single variant WITH an option (e.g. `XL`) no longer inherits every product image; (3) otherwise every option value (colour, capacity) proven by the metadata. Unknown values are refused. Contradictions exclude even a linked image.
- Identity: the variant must belong to the product and be in its variant list; a renamed title is recorded (`variant_title_changed`), another ID is refused. Fallback only across images of the same variant.
- Bytes: full Pillow decode (≤ 36 MP) and dimensions equal to Shopify's. Tenant: connector of `src/connectors/shopify.js`, `merchantId` equal to the request, state `CONFIGURED` now.

**Production entrypoint** (`runAutonomousWithShopifyMedia`)
- Order: select → SHA-256 → the tenant's **accepted** policy read from the durable Creative ledger → per-operation authorization → atomic reservation of the whole run ceiling (`creative_spend_reserve`) → `AUTHORIZED`/`RESERVED` events → build the critic, then the scene engine, **from the selected bytes**, journaling into the run's transmission recorder → verify both declare a binding to that SHA and recorder, and share the reserved SpendGuard → run → settle (or release + `CANCELLED` if nothing was attempted). Preconstructed `ports` / `engines` are refused; a non-durable ledger is refused outside tests. Price, stock and description come from the same read. `published: false`.
- Reached from the integration hub as `CREATIVE.produce_product_visual` (OWNER_REVIEW: the customer reviews the finished result). Non-simulated providers are refused there under NDR-D02.
- The real critic (`connectProviders`) and scene engine (`createSceneEngine`) now expose `binding`; local engines declare they transmit nothing.

**Authorization and spending**: `src/creative-autonomy/media-processing-policy.js` and the Creative ledger (`docs/creative-autonomy/creative-ledger.md`), see ADR 0007 (PROPOSED). The per-photo files of the `--scene` trial remain an operator control for the trial only.

**Brief**: a missing product photo is `BLOCKED_INTERNAL_MEDIA` (kind `INTERNAL`, no question), never a customer question.

**Evidence**: `test/creative-product-media.test.js` (17 tests, adversarial), `test/creative-shopify-e2e.test.js` (3 tests: the whole customer chain through the real Python engines, the real critic port and the real scene engine, against a fetch double). Simulated success is not production readiness: no real image model, Shopify call or visual judgement ran.

**Still open**: TYESO 750 ml source photo (see `tyeso-750ml-media-remediation.md`); NDR-D02 exception (ADR 0007 Part B); the customer-facing UI that calls `CREATIVE.produce_product_visual`; the admin screen presenting the tenant policy for acceptance (storage and acceptance function exist, not applied to any shared database).
