# Nordla Creative Production V1 — implementation contract

Created 2026-11-01. **Purpose:** give HABB three independently conceived, premium 4:5 advertising visuals while preserving the actual product photograph and verified commercial facts.

## Preserve; do not rebuild

Base: Creative Autonomy commit 7b4742e1306c32cf2fab12ced42fdaa01ed9b377. Keep its FRAME, IDEATE, SELECT, ART_DIRECT, STAGE, HABB policy, repair limits, Alibaba EU text lane, attempt locks, spend controls and owner review. Do not merge into main without review.

Known evidence: three real concepts from Alibaba; first run stopped on an overlong rationale followed by a broken plinth repair. Windows offline tests passed; a local low-resolution Blender/test-double composition exists but does not meet the premium TYESO visual benchmark. No end-to-end *real visual* Nordla campaign has been demonstrated.

## Single modular visual pipeline

1. **Nordla Creative Brain:** three genuinely different stories, artistic directions and retail objectives from verified Shopify facts. No invented prices, capabilities, colors, stock or personalization.
2. **Versioned background contract:** create a product-free, logo-free, text-free scene brief with reserved placement for the real product. The initial implementation lives in src/creative-autonomy/visual-production-contract.js. This is only a pure contract, not a production image engine.
3. **Image-generator adapter:** runtime-selectable OpenAI or approved Alibaba image backend. The first integration candidate is Alibaba Qwen Image 3.0 Pro through Nordla's EXISTING Model Studio account because the owner has no active OpenAI API billing. Reuse the existing src/marketing-creative/alibaba/qwen-image.js code where appropriate, but confirm its endpoint, model entitlement, actual account billing, handling of provider URLs, retention and security; no live image calls are authorized yet. Alibaba lists this model in Frankfurt under GLOBAL deployment scope (not EU-only): the owner must separately approve that handling before a live test. OpenAI remains an OPTIONAL interchangeable provider to consider only if the owner later chooses to fund and authorize it. Backends share the same image/metadata interface and can be replaced without changing the Brain.
4. **Real product compositing:** use the owner's licensed product image, with unchanged cap, shape, logo and colors. Produce physical-looking contact shadow, scaling and reflections without generating a second product. Reject uncertain cutouts. Portable fonts on Windows (fix hard-coded Linux paths); render headlines, verified pricing and address independently of the image model.
5. **Quality gates:** automatic pixel-fidelity checks plus close-up review of product contour, logo, typography, spacing, realistic scene integration and HABB forbidden elements (hearts, foliage, beige, artificial gold and bokeh). A human approves the best images; never auto-publish.
6. **Reports:** per-concept story, stages, provider, response SHA, image sizes, real product source SHA, quality findings, actual token/use statements and billing caveats. No secrets or private source photos in GitHub.

## Financial and privacy constraints

- Zero paid calls during implementation. Mocked provider transports for initial tests.
- The first real paid visual call needs a NEW explicit per-plan, per-provider, per-model authorization, separate from the consumed Alibaba text trial.
- Maximum calls must be enforced by a durable user-machine lock; existing 1.50 EUR text-trial cap does NOT automatically authorize image calls. Do not invent a provable monetary ceiling for a provider that bills by variable tokens. Obtain a bounded estimate and owner approval before each real experiment.
- The public/owner-approved content classification and supplier-photo rights must be checked separately. Do not send any product photo in a background-only generation request. An image may be used in advertising only if HABB has the required rights.
- Alibaba Frankfurt Qwen Image 3.0 Pro is currently listed with GLOBAL deployment scope, not guaranteed EU-only; verify and explicitly approve data handling before use. The official list price checked on 2026-11-01 is USD $0.034380 per 1K image output (USD $0.068761 for 2K), excluding possible input charges and the rest of the pipeline; access, pricing, and billable scope still require a fresh provider-console check. Do not assume a free image quota in Frankfurt. Never send the product photo to the background generator.
- OpenAI is an optional future provider, not a prerequisite. If later considered, confirm account billing, model support and EU processing eligibility and obtain new per-plan authorization. Do not silently fall back to global processing.

## Fixed delivery gates

**A — Implemented in this draft PR:** vendor-neutral background brief; opt-in Alibaba adapter using the pre-existing generateMarketingImage client and MemoryOutputStore; existing FULL route forwards actual concepts and art directions to the adapter; Python-generated image-to-compositor geometry bridge; portable compositor fonts; one-shot durable plan locks; HABB restrictions; global image-scope opt-in; secret-free CI and mocked unit/integration tests. No paid API call. The Blender default path remains intact.

**B — Next:** wire a separate CLI with auditable plan fingerprint, source-photo SHA, approved spending ceiling and provider-account eligibility check; inspect an offline real-photo composition on Windows and review realistic product grounding, fidelity/typography at 100% scale. The current renderer remains OPT-IN by code and is NOT a production CLI.

**C — After explicit consent:** ONE true Nordla-directed paid visual proof with TYESO, real-image output, QA, billing reconciliation. Authorisation must separately cover supplier-photo advertising rights, image model GLOBAL deployment scope, approved billing ceiling and a fresh source-image/code-bound one-use trial. Do not claim success before viewing the artifact.

**D — Final:** THREE distinct finished premium images, each independently staged, verified and presented for owner approval. The first one-call trial must NOT be silently reused to create all three; a separately approved three-image plan is required. Benchmark visually against the HABB TYESO reference; one bounded improvement only when a demonstrated defect requires it.

## Retail urgency

HABB marketing must continue today using clearly labeled, approved existing creative tools. Nordla development must not become a dependency for the shop's actual campaigns.

## Current official references checked 2026-11-01

- https://www.alibabacloud.com/help/en/model-studio/model-pricing
- https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
- https://developers.openai.com/api/reference/resources/images/methods/generate
- https://developers.openai.com/api/docs/guides/your-data

### Verification limitations

- The current Alibaba adapter is opt-in for `runAutonomous({ engines: createAlibabaBackgroundEngine(...) })`; the existing `scripts/creative-autonomy-trial.mjs` is unchanged and still uses Blender. Never imply a real production image was made by this branch.
- CI only verifies unit contracts, mocked provider responses, and the FULL route with fake Brain / photo engines, plus Python source syntax. A mock-generated first background followed by a deliberate second-call refusal yields `STOPPED_ERROR`; this is expected for the one-call permission, NOT a three-image production success.
- The background prompt is product-free, but text-only generation cannot technically guarantee the remote model won't hallucinate a product or text. Owner visual review and dedicated QA are required before use.
- The background geometry bridge positions the product deterministically; realistic contact lighting and reflections must be validated with a real photo at full resolution.
- Pricing: Alibaba Frankfurt Global Qwen Image 3.0 Pro outputs are $0.034380 for 1K tier (up to 2,250,000 output pixels) and $0.068761 above that threshold as verified 2026-11-01. All existing 1080x1350, 1080x1920 and 1920x1080 formats are in the first tier. Nordla's image SpendGuard now uses the actual pixel-area rule; this image-only cost does NOT include Brain text or vision. Verify invoices after any explicitly authorized experiment.
