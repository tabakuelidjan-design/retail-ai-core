# Creative integration — Phase 5: general segmentation and realistic product integration

Status: built on `feature/creative-phase-5-integration` (from the Phase 4 closure `3f858f5`), offline, **no provider call and no image generated outside the test fixtures**. Decisions: NDR-P17 (order), NDR-P24 (layered runtime), NDR-P25 (refine), NDR-P26 (this phase).

Principle: **the real product pixels are authoritative.** The integration may cut them out, place them, and change their light and colour within declared bounds; it may add a shadow as a separate layer; it may never repaint, redraw or replace them. Every doubt is a named stop, not a silent pass.

## 1. What exists (`src/creative-integration/`)

```
photograph ──► SEGMENTATION (contract) ──► MATTE QUALITY ──► CUT-OUT ──► PLACEMENT RULES ──► RELIGHT / GRADE ──► IDENTITY ──► CONTACT SHADOW (layer) ──► COMPOSITE ──► ARTIFACTS ──► READY_FOR_COMPOSITE
                │ low conf./ambiguous      │ MATTE_INVALID        │            │ PLACEMENT_INVALID   │ RELIGHT_OUT_OF_BOUNDS │ PRODUCT_IDENTITY_RISK │ SHADOW_INVALID           │  INTEGRATION_ARTIFACT
                ▼ SEGMENTATION_FAILED / SEGMENTATION_LOW_CONFIDENCE
```

| Concern | File |
|---|---|
| States, reasons and every threshold (one reviewable place) | `constants.js` |
| Segmentation contract, local plain-ground segmenter, port validation, mask cache | `segmentation.js` |
| Matte quality checks (against the SOURCE pixels) | `matte-quality.js` |
| Cut-out (source pixels in the matte; only the soft boundary is decontaminated, and counted) | `cutout.js` |
| Product identity decision | `identity.js` |
| Bounded relight, colour match and bounded grade proposal | `relight.js` |
| Placement rules | `placement.js` (geometry: `compose.js`) |
| Contact shadow layer | `shadow.js` |
| Artifact detection | `artifacts.js` |
| Pipeline and multi-product scene | `integrate.js` |
| Visual acceptance output (seven views + sheet) | `visual.js` |
| Parity audit (readiness component) | `parity.js` |
| Matrix runner | `scripts/creative-integration-matrix.mjs` |

Nothing in `src/creative-runtime`, `src/creative-production` or `src/creative-refine` was changed. `toCompositorLayers` expresses the integrated layers (plate < contact shadow < product) for the Phase 3 compositor, which then measures that the product pixels are unchanged (test PI-6).

## 2. Segmentation contract (task 1, 2)

A segmentation is a value `{ status: OK | LOW_CONFIDENCE | FAILED, accepted, alpha, bounds, confidence 0..1, edge_quality, components, holes, failure_reason, source: LOCAL | PORT }`. It comes from the local segmenter or from an injected port (`{ id, segment({ rgba, selection }) }`); a port's answer is validated by the same rules (`validateSegmentation`), a violation is `PORT_CONTRACT_VIOLATION`, a throwing port is `PORT_FAILED`, and a result under the minimum confidence (0.6) is never `accepted`. Confidence is the weakest of its factors (ground plainness, edge contrast, edge definition, dropped-speck area, not cropped by the border), never an average.

The local segmenter (no model, no network, no randomness) learns the plain ground from the image border, scores each pixel by colour distance (a darker pixel of the ground's chroma is a ground shadow, not product), bridges long thin slivers (a mirror line crossing the ground colour), keeps real holes (the ground shows through, and the hole is not small) and fills specks, splits touching objects by a seeded split on eroded cores, and unmixes the boundary (alpha = coverage from the product colour at the nearest interior pixel). Selection is explicit: `AUTO` (refused if several significant objects), `IDS`, `POINT`, `BOX` (clips; refused if it cuts through foreground unless `allow_cut`), `GROUP`. A selected matte never contains a non-selected object (the seam is trimmed `seam_px`).

Reuse: the analysis of a source is cached once and shared by every selection; a cache entry is keyed by the source bytes, the selection and the segmenter, so an unchanged source and selection costs no second provider call (SG-32..35).

## 3. Matte quality (task 3) and its limits

`checkMatte` returns `{ valid, findings }`; each finding is `{ code, ok, value, limit, where? }`; a check that cannot be measured (ground not plain) is NOT ok. Codes: `EDGE_SUPPORT`, `FRINGE`, `FRINGE_RUN`, `PINHOLES`, `ACCIDENTAL_HOLES`, `GROUND_LEAK`, `FRAGMENTS`, `MISSING_THIN_PARTS` (the whole dropped structure counts), `BOUNDARY_OFFSET` (erosion < 0 / dilation > 0), `STRAY_ALPHA`, `INTERIOR_ALPHA`, `EDGE_RECONSTRUCTION` (+`_RUN`: the boundary pixel must equal alpha·product + (1−alpha)·ground), `ALPHA_NOISE` (local-extrema share of the alpha ramp).

Lesson recorded: a share-only limit hid a visible defect (a white wedge at a handle joint and a transparent chrome band on a connector tip passed every share). The `_RUN` checks fail on the length of a contiguous bad stretch, relative to the product (`max(5, 0.02·√area)` px).

## 4. Identity, relight and grading (tasks 4, 7, 8)

* Identity (`checkIdentity`): alpha byte for byte, no duplicated object, illumination-free detail correlation (global and the worst 8×8 tile with real detail, so a moved button cannot hide in a good global number), chromaticity and hue shift; `strict` mode (nothing requested) demands identical interior bytes.
* Relight (`relightProduct`): a gain field only (exposure, a light gradient along the light axis, temperature, tint, saturation). A request beyond the bounds, an unknown field or a non-number is REFUSED (`RELIGHT_OUT_OF_BOUNDS`), never clamped; then the largest interior luma change and the share of pixels that lost information to clipping are MEASURED against their bounds. The recipe and its hash are returned; the source cut-out is never overwritten and the relit layer is re-derivable from (source, recipe).
* Colour integration (`measureColorMatch`, `proposeGrade`): compares the illumination, not the product's own colour (white point for exposure, the cast of the neutral pixels for temperature, fine texture for sharpness, saturation loosely); a quantity that cannot be measured is skipped and says so. The proposal is bounded; an automatic grade is applied at the largest of 1 / 0.7 / 0.5 / 0.3 / 0 of itself that keeps relight bounds AND identity. A scene the product cannot be brought within bounds of is `INTEGRATION_ARTIFACT` (`COLOR_*`), not silently graded away.

## 5. Placement (task 5), shadow (task 6), artifacts (task 9)

* Placement: no rotation of product pixels in this phase (`ROTATION_UNSUPPORTED_IN_THIS_PHASE`, `TILT_TOO_LARGE`), uniform scale only (`ASPECT_DEFORMED`), visible share, size plausibility, contact below the horizon, on the support surface/line, scale consistent with depth (perspective: px/cm grows linearly below the horizon), occlusion order by depth, no covering of a protected region.
* Contact shadow: kinds `SOFT`, `HARD`, `DIFFUSE`, `DIRECTIONAL`; the silhouette projected on the support plane along the light (shear, depth squash, exp falloff from the contact), blurred, plus a tight contact core; capped at 0.65 opacity; composited under the product; a vertical plane gets a short offset silhouette. Invalid kind or light → `SHADOW_INVALID`.
* Artifacts: `HALO`, `CROPPED_BY_THE_CANVAS`, `CLIPPING`, `DEFORMATION`, `FLOATING_OBJECT`, `DETACHED_SHADOW`, `DOUBLE_SHADOW_LOBES`, `PLATE_SHADOW_AT_CONTACT`, `SHADOW_DIRECTION`, `ALPHA_NOISE`. No shadow layer means the contact cannot be judged, which fails.

## 6. Visual acceptance (task 11)

`renderAcceptance` writes SOURCE, MASK, COMPOSITE (the cut-out on a split dark/light backdrop, where a halo shows), EDGE CLOSE-UP (the hardest piece of the boundary, magnified), CONTACT SHADOW CLOSE-UP, PRODUCT FIDELITY DIFF (|source − graded|, ×8), FINAL SCENE, plus the shadow layer, as separate PNGs and one labelled sheet (built-in bitmap font: identical everywhere). **A number is not an acceptance**: the representative sheets were opened and looked at; looking found four real defects the numbers had passed (a ground-coloured wedge kept at a handle joint, an apex sliver closing a round hole, a tick of the neighbour's colour at a touching seam, a transparent mirror band on a connector tip), which are now gates.

## 7. Performance (task 12)

Measured by `scripts/creative-integration-matrix.mjs` (Windows, Node 24): drawn products (≈300×440) 0.6–1.3 s end to end; a real 497×1000 photograph 5.0 s (segmentation 1.3 s analysis + 0.8 s selection, the rest matte checks, grading, identity); heap delta ≤ 71 MB, peak RSS ≈ 262 MB; a reused mask makes the second integration's segmentation < 20 % of the first (PI-28); two products from one photograph analyse the source once. The iterated erosion was replaced by one distance transform (analysis 4.6 s → 1.3 s, same results).

## 8. Known limits (not worked around)

* The local segmenter needs a **plain ground** (border homogeneity ≥ 85 %). A cluttered or gradient ground → `BACKGROUND_NOT_PLAIN`; the answer is a port.
* A product colour that equals the ground (white on white, a mirror highlight the colour of the ground) cannot be separated by colour: the result is low confidence, ambiguous or `MATTE_INVALID`, by design. A diagonal mirror highlight wider than the bridge (a USB-C connector tip on a white ground) is the real case that stops `remax_FC-02.png`.
* A hand or table **flush against** the product with no border contact and no colour break is not detectable by the local segmenter; only an explicit `BOX` (refused if it cuts foreground) or a port can protect.
* Flush-touching objects (no neck) are not separable; touching objects with a neck are.
* No rotation or perspective warp of the product pixels; no real light estimation from the plate (the light is declared, the grade is a bounded two-number correction).
* An enclosed ground-coloured gap smaller than 0.3 % of the product is filled (a glossy highlight looks like the ground); a genuine tiny opening would show the source ground colour.
* No live provider, no live image, no Shopify/HABB change. The segmentation port is an interface; nothing is connected to it.

## 9. Tests and rollback

Focused suites (`// SG-`, `MQ-`, `ID-`, `RL-`, `CG-`, `SH-`, `PL-`, `AR-`, `PI-` markers): `creative-integration-segmentation`, `-matte`, `-identity`, `-shadow`, `-pipeline`; the readiness suite gained the INTEGRATION component. Drawn fixtures only (`test/creative-integration-world.js`). Rollback: revert the merge of the branch (the module is imported by nothing but the readiness gate).
