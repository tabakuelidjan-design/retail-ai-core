# Nordla Creative Production V1 — implementation contract

Created 2026-11-01. **Purpose:** give HABB three independently conceived, premium 4:5 advertising visuals while preserving the actual product photograph and verified commercial facts.

## Preserve; do not rebuild

Base: Creative Autonomy commit 7b4742e1306c32cf2fab12ced42fdaa01ed9b377. Keep its FRAME, IDEATE, SELECT, ART_DIRECT, STAGE, HABB policy, repair limits, Alibaba EU text lane, attempt locks, spend controls and owner review. Do not merge into main without review.

Known evidence: three real concepts from Alibaba; first run stopped on an overlong rationale followed by a broken plinth repair. Windows offline tests passed; a local low-resolution Blender/test-double composition exists but does not meet the premium TYESO visual benchmark. No end-to-end *real visual* Nordla campaign has been demonstrated.

## Single modular visual pipeline

1. **Nordla Creative Brain:** three genuinely different stories, artistic directions and retail objectives from verified Shopify facts. No invented prices, capabilities, colors, stock or personalization.
2. **Versioned background contract:** create a product-free, logo-free, text-free scene brief with reserved placement for the real product. The initial implementation lives in src/creative-autonomy/visual-production-contract.js. This is only a pure contract, not a production image engine.
3. **Image-generator adapter:** runtime-selectable OpenAI or approved Alibaba image backend. The first candidate is OpenAI gpt-image-2.5-sunburst. Require explicit account access and processing-region verification; do not infer EU processing from ChatGPT Plus or from an EU text-model workspace. Backends share the same image/metadata interface and can be replaced without changing the Brain.
4. **Real product compositing:** use the owner's licensed product image, with unchanged cap, shape, logo and colors. Produce physical-looking contact shadow, scaling and reflections without generating a second product. Reject uncertain cutouts. Portable fonts on Windows (fix hard-coded Linux paths); render headlines, verified pricing and address independently of the image model.
5. **Quality gates:** automatic pixel-fidelity checks plus close-up review of product contour, logo, typography, spacing, realistic scene integration and HABB forbidden elements (hearts, foliage, beige, artificial gold and bokeh). A human approves the best images; never auto-publish.
6. **Reports:** per-concept story, stages, provider, response SHA, image sizes, real product source SHA, quality findings, actual token/use statements and billing caveats. No secrets or private source photos in GitHub.

## Financial and privacy constraints

- Zero paid calls during implementation. Mocked provider transports for initial tests.
- The first real paid visual call needs a NEW explicit per-plan, per-provider, per-model authorization, separate from the consumed Alibaba text trial.
- Maximum calls must be enforced by a durable user-machine lock; existing 1.50 EUR text-trial cap does NOT automatically authorize image calls. Do not invent a provable monetary ceiling for a provider that bills by variable tokens. Obtain a bounded estimate and owner approval before each real experiment.
- The public/owner-approved content classification and supplier-photo rights must be checked separately. Do not send any product photo in a background-only generation request. An image may be used in advertising only if HABB has the required rights.
- For OpenAI EU processing, verify that the account has the necessary residency/retention controls and that the selected image endpoint is supported; use an authorized region endpoint. Do not silently fall back to global processing.

## Fixed delivery gates

**A — Completed here:** vendor-neutral background contract, fail-closed one-shot approval and six local unit tests. No API call or change to the existing full path.

**B — Next:** image-provider interface and mocked image response, safe output storage and ledger; Windows font portability, real-photo local composition and independent fidelity/typography checks.

**C — After explicit consent:** ONE true Nordla-directed paid visual proof with TYESO, real-image output, QA, billing reconciliation. Do not claim success before viewing the artifact.

**D — Final:** THREE distinct finished premium images, each independently staged, verified and presented for owner approval. Benchmark visually against the HABB TYESO reference; one bounded improvement only when a demonstrated defect requires it.

## Retail urgency

HABB marketing must continue today using clearly labeled, approved existing creative tools. Nordla development must not become a dependency for the shop's actual campaigns.

## Current official references checked 2026-11-01

- https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
- https://developers.openai.com/api/reference/resources/images/methods/generate
- https://developers.openai.com/api/docs/guides/your-data
