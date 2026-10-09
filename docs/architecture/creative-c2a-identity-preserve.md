# C2-A — Identity-Preserve Fidelity and scoped external-media authorization

**Status: IMPLEMENTED, NOT YET CALIBRATED ON A REAL PROVIDER OUTPUT.** Nothing was sent to a provider, no credential was created or requested, no provider was called. C2 itself (the provider lane) has not started.

## 1. Why

HABB Benchmark 001 proved that the real product pixels can be placed untouched (`PIXEL_PRESERVE`) and measured. A premium creative needs more: a provider may replace the dark table, change the scale and the light. The existing measurements compare the delivered PNG with the original pixels at a fixed rectangle and therefore cannot judge an edited product (their result is, correctly, NOT_MEASURABLE). C2-A adds a **second explicit mode** that keeps the product's IDENTITY measurable when the surroundings change. It does not touch `PIXEL_PRESERVE`.

## 2. Preservation modes

| | Before | After |
|---|---|---|
| `PIXEL_PRESERVE` | pixels untouched, no crop / relight / rotation | **unchanged** |
| `COMPOSITE` | original cut-out pixels, no relight | unchanged |
| `CONTROLLED_EDIT`, `GENERATIVE_REFERENCE` | contract-only | unchanged |
| `IDENTITY_PRESERVE` | — | **new**: background, placement, scale, shadow and relighting may change; no crop, no rotation; needs a justification and protected regions; renderable (the already-edited asset is placed untouched) |

## 3. IDENTITY_PRESERVE observations

The five existing check codes are kept (`PRODUCT_IDENTITY`, `PRODUCT_GEOMETRY`, `PIECE_COUNT`, `PRODUCT_COLOR`, `TEXT`) so the existing hard gate aggregates them unchanged (FAIL dominates, then NOT_MEASURABLE, then PASS). Each is made of **separate sub-observations**, each PASS / FAIL / NOT_MEASURABLE with its own numbers. There is no similarity score.

| Check | Sub-observation | What it proves | Method |
|---|---|---|---|
| PRODUCT_IDENTITY | `DERIVATION_CHAIN` | the edited asset is derived from the pinned real asset, with provider provenance, consumed exactly once | hashes, refs, render log |
| | `REGISTRATION` | the real product is found in the delivered PNG | masked correlation under scale (x and y separately) + translation, no rotation |
| | `ARTWORK` | the printed artwork keeps its structure and contrast | local correlation + contrast ratio |
| PRODUCT_GEOMETRY | `ANISOTROPY` | no stretch (scale x / scale y within 3 %) | registration |
| | `SCALE_BOUNDS`, `INSIDE_CANVAS` | repositioning / scaling stays within allowed bounds | registration |
| | `OUTLINE_EDGE` | the case outline is still drawn where it must be (NOT_MEASURABLE on a background of the same tone) | edge strength along the annotated outline |
| | `CAMERA_MODULE` | the camera module is where and what it must be | local registration of the module |
| | `LENS_PLACEMENT` | the lens openings sit where they must | dark-blob centres in the module |
| PIECE_COUNT | `INSTANCE_COUNT` | one product, no duplicate | second correlation peak outside the first |
| | `LENS_COUNT` | no lens added, none removed | dark blobs in the module capsule |
| | `ASSET_DRAWN_ONCE` | the derived asset is drawn once | render log |
| PRODUCT_COLOR | `LUMINANCE_GAIN`, `CHANNEL_GAIN_SPREAD` | relighting within reasonable bounds | mean gains over the registered case |
| | `CHROMA_SHIFT`, `LOCAL_CHROMA_SHIFT` | no tint or hue change (global and local: a hue rotation barely moves the global mean) | chroma shares |
| TEXT | `PRINTED_TEXT_REGION:<id>` | the printed text keeps its structure AND contrast (a 90 % overlay keeps the correlation, not the contrast) | local correlation + contrast ratio |

A failed registration fails the identity and makes the dependent checks NOT_MEASURABLE (their evidence would be meaningless); it never lets them pass.

**VLM:** accepted only as `advisory_observations`: recorded, marked `counted: false`, never able to override a deterministic FAIL (nor to fail a deterministic PASS).

**Tolerances** (`IDENTITY_TOLERANCES`) are provisional technical ones. They have been exercised on a synthetic case and on the real HABB asset recomposed from its own pixels. They are **not calibrated on a real provider output**; the first live outputs must calibrate them openly, and a calibration must never loosen a tolerance silently.

**Annotations** (`asset_evidence.identity_annotations` of the benchmark configuration): coordinates only — case outline, camera module, three lens openings, artwork area, printed-text region. They are `PROVISIONAL_ANNOTATION_NOT_OWNER_CONFIRMED`: annotated from the real asset and to be confirmed by the owner.

## 4. Mutation proofs

Synthetic product (CI): background-only change (white, studio, dark), repositioning and scaling (0.7×–1.6×) and relighting (+8 %, −10 %) PASS all five checks. Altered camera geometry, a missing lens, an extra lens, a stretched case (moderate and extreme), substituted artwork, damaged and faded printed text, a hue rotation, a strong tint, a strong darkening, a duplicated product and a redrawn outline each FAIL the check that owns them. Real asset (local only, `creative-intelligence-identity-preserve-real.test.js`): the same families on the real photograph recomposed from its own pixels.

## 5. Scoped external-media authorization

`benchmarks/creative-intelligence/habb-c2-external-media-authorization.json` authorizes **one asset** (`asset://habb/benchmark-001/real-personalised-case-001`, SHA-256 pinned), **one provider** (Alibaba Cloud Model Studio), **one region** (`eu-central-1`, Frankfurt), **one purpose** (`C2_HABB_BENCHMARK_001`), operations `IMAGE_EDIT` and `VISION_CRITIQUE`, covering the source asset and images derived from it for that purpose only. It is checked by `assertScopedExternalMediaUse` (`src/marketing-creative/alibaba/scoped-media-authorization.js`), which refuses everything else with `EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED`.

- **Retention:** standard Alibaba Model Studio inference retention can be up to **30 days**. Zero Data Retention is **not confirmed and not claimed**; a ZDR claim without evidence is refused by the guard.
- **Global default unchanged:** `assertAlibabaExternalUse` still accepts PUBLIC data only (no personal data, no face), `policy.js` is untouched, and the lane stays pinned to Frankfurt. Holding a clearance for this asset makes no other private media acceptable.
- **State:** `NOT_TRANSMITTED`, credentials `NOT_PROVISIONED`. The owner authorization is captured in the working session and is not authenticated by Nordla Identity (an open dependency).

## 6. What is still needed before a live call

1. The owner confirms the identity annotations and the face / personal-data statement.
2. A dedicated Alibaba workspace credential (outside Git), and the existing activation prerequisites of the Alibaba lane (spend guard, public-asset smoke already done).
3. The first live output calibrates the identity tolerances.
4. A provider adapter for `IMAGE_EDIT` that consumes the scoped clearance (not part of C2-A).
