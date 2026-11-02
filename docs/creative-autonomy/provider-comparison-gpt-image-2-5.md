# Image provider comparison — feasibility only (2026-11-02)

**No adapter was built and no call was made.** NDR-D02 and explicit owner approval govern any real call. This note says what is known, what is not, and how a fair comparison would run.

## Candidates

| | Alibaba `qwen-image-3.0-pro` (existing adapter) | OpenAI `gpt-image-2.5-flare` | OpenAI `gpt-image-2.5-sunburst` |
|---|---|---|---|
| Status in Nordla | Adapter exists (`marketing-creative/alibaba/qwen-image-edit.js`), offline-tested | None | None |
| Positioning (vendor) | Image edit around a reference | Faster, same quality/editing improvements | "precision for detailed creative work, with longer generation times"; recommended "where editing precision matters most" |
| Edit with a reference image | Yes (plate) | Edits endpoint and Responses API with image inputs | idem |
| Masks / exact preservation | No mask field documented | Not stated on the pages read | Not stated |
| Sizes | 512²–2048² pixels total (qwen-image 2.0 doc); n 1–6 | "arbitrary resolutions following constraints" (constraints not read) | idem |
| Negative prompt | ≤ 500 chars, truncated silently (2.0 doc) | n/a | n/a |
| Price | Nordla's estimate ≈ 0.106 € / call of 3 images (simulated pricing in this repo) | Not stated officially on the pages read (community: same token pricing as gpt-image-2) | idem |
| Region / residency | Frankfurt endpoint; image workspace scope GLOBAL (cross-border possible, declared in the tenant policy) | Not stated for these models | Not stated |
| Released | — | 2026-09-08 | 2026-09-08 |

Whatever the provider, Nordla **never keeps the provider's product pixels**: the real photo is restored and re-proven. A mask is never assumed to preserve pixels.

## Fair comparison protocol (for the authorised benchmark)
Same verified photo and SHA-256, same concept, art direction and stage, same 1080×1350 target, same scene checks and compositor, same critic. Measure per provider: scene variants passing `scene_check` (alignment, ghost, duplicate), product fidelity after restoration, concept-critic verdicts with evidence, a scene-only revision ("lumière plus chaude") — what changed and what did not, latency per call, **actual** invoiced cost, typography legibility over the produced scene.

## Before any OpenAI adapter
Organisation verification may be required (OpenAI guide). Owner decisions: data-processing terms and region for product photos (EU), retention, image rights for supplier photos, a spending ceiling, and an ADR extension of 0007 Part A (a new provider line in the tenant policy). The adapter would sit behind the existing provider port (`createSceneEngine` takes any edit function bound to the same authorisation, journal and SpendGuard).

Sources: [OpenAI community announcement](https://community.openai.com/t/introducing-gpt-images-2-5-in-the-api-and-chatgpt/1395897), [OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation), [Alibaba Model Studio — Qwen image edit](https://alibabacloud.com/help/en/model-studio/qwen-image-edit).
