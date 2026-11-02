# Nordla Créateur V1 — quality, performance, revisions (2026-11-02)

Branch `fix/creative-production-v1-stabilization-20261102` (PR #39). Everything here was measured or tested with **simulated providers**. Nothing here proves that a real provider produces a premium image: that needs the benchmark in `first-premium-benchmark-plan.md`.

## 1. Capability matrix (audit of the existing modules, then what changed)

| Capability | Before | Now | Where |
|---|---|---|---|
| 3 distinct concepts, distinctness guard | EXISTS | EXISTS (unchanged) | `creative-brain/concept.js` |
| Selection on 10 criteria, decided by code | EXISTS | EXISTS (unchanged) | `creative-brain/concept-selection.js` |
| Art direction: narrative elements by plane, depth, negative space | EXISTS, **NOT WIRED** to the image model | **WIRED**: planes, depth, space strategy and the stage's unexpressible needs reach the image request (requested, never claimed as drawn) | `scene-engine.js#buildSceneRequest` |
| Concept text contradicting the negative prompt (a device named in the idea) | MISSING (contradiction sent) | Withheld and recorded (`concept_text_withheld_for`) | `scene-engine.js` |
| Report a concept that cannot be executed | PARTIAL (`grammar_gap` stored, not used) | PARTIAL+: gaps are sent to the scene model and listed; selection rejects infeasible concepts (product edit, people). No `NOT_EXECUTABLE` status yet | `run.js`, `concept-selection.js` |
| Tenant brand rules (forbidden decor, palette, merchant name, requirements) | HARDCODED HABB in 7 shared modules, applied to every tenant | **Tenant configuration** (`config/merchants/habb/creative-brand.json`), resolved per tenant; HABB enforcement unchanged; other tenants get none of it | `brand-profile.js`, `brand-guard.js` |
| "HABB, Namur" on every tenant's image | YES (defaults in run.js, brief.js, compose) | Removed: the active tenant's name or none | — |
| Placeholder headline ("Titre de test") | Passed | Refused for every tenant | `stage-contract.js` |
| Negative prompt length | 864 chars, **silently truncated** by the provider at 500, product protections LAST | Protections first, deduplicated, ≤ 500, dropped terms reported | `qwen-image-edit.js` |
| Concept critic (WOW_FACTOR) | EXISTS, gates nothing | Feeds a 7-axis judge with its visual evidence | `run.js#judgeProposal` |
| `creativeQualityState` | NOT WIRED | Attached (`canonical`); NOT_MEASURABLE because the 14-dimension execution critic is not connected in this route | `run.js` |
| Partly measured critique | Reported "sufficient" | NOT_MEASURED | `run.js#creativeQuality` |
| Typography gates | Contrast (headline only), overlap, margins | + missing glyphs, word overflow, info-line contrast on its own background, info width and margins, fonts/sizes/resolution reported | `compose_stage.py` |
| Targeted revisions | Re-run with the note appended | Planned, priced, verified (§3) | `revision-planner.js`, Créateur |

## 2. Performance (same simulated fixtures, same machine, `node scripts/creator-benchmark.mjs 5`)

| | Before (`ce036d7`) | After | Change |
|---|---|---|---|
| First creation, wall clock | 10.4 s | 7.0 s | −33 % |
| Re-creation / revision of the same photo (median of 4) | 10.2 s | 6.1 s | **−40 %** |
| Nordla's own time (simulated provider excluded) | 8.9 s | 4.8 s | **−46 %** |
| RENDER step (scene: plate + provider + checks) | 8.6 s | 5.3 s | −38 % |
| EXAMINE (same photo again) | 0.81 s | 0.001 s | reused |
| Estimated provider cost of a run | 0.128 € | 0.128 € | unchanged (no request removed) |

Three largest bottlenecks measured: (1) `scene_check.py` run 3× sequentially, each loading numpy/scipy (≈7.5 s, 70 % of the run); (2) the simulated provider (≈1.3 s — the stand-in for network latency, not Nordla's work, not optimised); (3) `examine_product.py` (≈0.8 s per run, mostly imports).
Changes: one Python process checks all variants (reports, images and metadata **byte-identical** to the old per-variant runs; faulty variants still rejected for the same reasons); the deterministic examination (verified byte-identical across runs) is reused by photo SHA-256. Not done (measured but not justified without risk): FFT reuse inside `masked_ncc` (≈1.7 s of the check) would change floating-point results; parallel checks bring nothing on 2 CPUs.
With real providers the run is dominated by provider latency (seconds to tens of seconds per call); these gains then matter mostly for revisions and retries.

## 3. Revisions: what is actually implemented

| Request | Method | Cost | Verified |
|---|---|---|---|
| Exact headline ("Remplace le titre par « … »"), price shown/hidden | LOCAL_RECOMPOSE on the same scene | 0 € | changed share and box, scene identical, product re-proven |
| Exact text side ("en haut à droite") | LOCAL_RECOMPOSE | 0 € | idem; text-over-product refused **before** running |
| Vague text ("le titre est banal") | NEEDS_EXACT_INSTRUCTION | 0 € | nothing runs |
| Background, light, surface, framing | NEW_SCENE_GENERATION, confirmed first | estimated (≈0.11 € simulated pricing), worst case 0.50 € | scene layer compared separately; identical scene → **UNCHANGED**; unrequested changes listed |
| New idea | NEW_CREATIVE_RUN, confirmed first | ≈ last run, worst case 0.50 € | idem |

**Known gap (P1):** NEW_SCENE_GENERATION currently re-runs the whole pipeline: it does not keep the approved headline (the verification reports it as an unrequested change) and it does not yet pass the revision note into the image request as a scene edit. A scene-only regeneration (same concept, art direction and stage, the note as an edit instruction) is the next step. With the simulated provider the scene never changes, and the Creator says so.

## 4. What still requires a real image provider
Whether the narrative scene is drawn as requested; photorealistic integration (light continuity, shadow and reflection under the real product); concept critic verdicts on a real image (originality, storytelling, premium execution); revision consistency of a real scene edit; typography over a real, busy scene. None of this is claimed.

## 5. Remaining defects and limits (ordered)
- P1: scene-only regeneration for revisions (above).
- P1: the substitute lexicon (born from the phone-case pilot) refuses words like `box` even when they name the product itself (gift box): the concept sentence is then withheld from the image prompt. It needs a product-aware exception.
- P1: no `NOT_EXECUTABLE_AS_CONCEIVED` status; gaps are listed but the proposal is still PROPOSED.
- P1: brand relevance and commercial effectiveness are NOT_MEASURABLE (no image-level judge for them); the judge has not been validated against human-reviewed reference outputs (no labelled HABB set exists yet).
- P2: `BRAND_NAVY` / `BRAND_TERRACOTTA` are still the names of the palette enums (now tenant-gated: refused for a tenant that does not define them).
- P2: FFT reuse in `scene_check.py`; typography has no tracking/kerning control or optical alignment beyond the current layout.
