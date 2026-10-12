# Creative planning — Phase 1: the Content Format Planner

Status: built on `feature/creative-phase-1-format-planner`, offline, no provider call. Decisions: NDR-P17 (order of the capability phases), NDR-P18 (copy modes), NDR-P19 (figures in contracts).

## Why

Creative could make one thing: one image, in a canvas that was already fixed, from a handful of approved texts. It could not decide *what* to make. A long text ended in `TEXT_DOES_NOT_FIT`; "a carousel", "five images" or "a video" had no home; a missing format was a question. Nordla now decides **what to create before it decides how to produce it**.

```
request ──► INPUT_UNDERSTANDING ──► CONTENT_ANALYSIS ──► FORMAT_PLAN ──► (per asset) the existing Creative Brain
 text, product image,                 inventory,              format, assets,        unchanged
 file, reference,                     measured density,       text on asset vs
 structured facts                     copy modes, facts       caption, canvas
```

The Creative Brain (`plan()`), the production runtime, the gates and the critics are **not modified**. The planner sits in front of them. A single-image brief goes through the planner and comes back identical (`briefForAsset`), so its plan ids, its ledger and the instructions the model sees do not change (test CL-5).

## The stages

| Stage | Kind | Output |
|---|---|---|
| INPUT_UNDERSTANDING | deterministic, optional ports | one normalized `InputObservation` per input |
| CONTENT_ANALYSIS | deterministic | `ContentInventory`: every text with its copy mode and measured size, every fact with its status |
| FORMAT_PLAN | deterministic (+ two optional copy ports) | `ContentPlan` |

### Input understanding (multimodal boundary)

The planner reads **observations**, never pixels, files or provider output. One closed contract covers text, a product image, an uploaded file, a reference image (with a role: product, style, layout, brand, content) and structured facts. A deterministic reading always exists. A connected *understanding port* (`understand({ source, bytes })`) can enrich it; nothing in the planner changes when one is connected, and a port that fails or answers badly leaves the observation `NOT_ANALYZED` with safe diagnostics. No provider is connected in this phase.

### Copy modes (NDR-P18)

| Mode | What Nordla may do |
|---|---|
| `COPY_LOCKED` | distribute across assets and caption; never rewrite. Checked: the placed pieces are slices of the text that hold exactly its words, in order (`verifyVerbatim`). |
| `COPY_ADAPTABLE` | condense when, and only when, it does not fit its role (or nothing else can hold it), and an adapter is connected. The result passes guards: figures, currency signs, links and handles unchanged; no new name; no claim word the source did not hold; no negation flipped. A refused adaptation leaves the text exactly as written. |
| `COPY_GENERATABLE` | write from `VERIFIED` or `APPROVED_CLAIM` facts only (an estimate or an unknown is never offered). The result must cite its facts and contain no figure, link, name, claim word or price that they do not hold. Without a connected writer the text stays `PENDING_GENERATION` and its asset is not executable. |

The guards are conservative heuristics, not a proof of meaning. Adapted and generated pieces stay marked as such in the plan, and owner approval stays pending.

### Format rules

Each decision names its rule (`FORMAT_RULE`):

1. `EXPLICIT_REQUEST_IS_HONOURED` — a requested format (or asset count) is used if it can hold the text; `FORMAT_IS_FIXED` turns an impossible request into a question, otherwise it gives way.
2. `VIDEO_IS_PLANNED_NOT_PRODUCED` — a video kind (requested, or the only kind of the channel) is selected; the plan is `PLANNED_NOT_EXECUTABLE` and carries a complete still alternative as a plan of its own.
3. `SEVERAL_CHANNELS_MAKE_A_CAMPAIGN` — members decided per channel; production is for later phases.
4. `TEXT_THAT_FITS_STAYS_ON_ONE_ASSET`, `NO_CHANNEL_MEANS_A_GENERIC_DIGITAL_FEED`.
5. `BODY_TEXT_GOES_TO_THE_CAPTION_WHEN_THE_ASSET_HAS_NO_BODY_SLOT` — a long text keeps its first whole sentence as the headline and the rest goes to the caption, verbatim.
6. `SECTIONED_LONG_TEXT_BECOMES_A_SEQUENCE` — three or more sections that fit entirely on the assets of a carousel / story sequence.
7. `ALL_TEXT_ON_ASSET_NEEDS_THE_SMALLEST_FORMAT_THAT_HOLDS_IT`.

A person is asked (`QUESTION_CODE`) only for a hard-constraint conflict, text that cannot be placed without altering it, nothing to say, no verified fact to generate from, or contradictory constraints. A missing format, channel, objective, audience or price is never a question.

### Canvas after format

The format kind is decided first. Each asset then gets its canvas from a deterministic **format resource** (`format-resources.js`: feed 4:5 and 1:1, story 9:16, poster, flyer) or from a canvas the caller supplied. Text capacity per role is stated in characters with its basis: the executable roles are `MEASURED_AGAINST_THE_LAYOUT_ENGINE` (re-measured by test CL-1 against the real layout); BODY, which has no layout recipe yet, is `MEASURED_AGAINST_THE_TEXT_LED_LAYOUT_SPEC` (Phase 2, test CL-8: the real typography engine in a text-led layout described as data), per density class, so an asset that uses it is planned, not executable, but its capacity is a measurement. The 360 / 280 character figures of the first version of this phase were provisional ceilings and are replaced by these measurements.

### Honest execution status

Each asset carries `EXECUTABLE_NOW` or `PLANNED_NOT_EXECUTABLE` with reasons (`MULTI_ASSET_PRODUCTION_NOT_AVAILABLE`, `ROLE_HAS_NO_LAYOUT_SLOT:BODY`, `COPY_NOT_YET_GENERATED`, `VIDEO_PRODUCTION_NOT_AVAILABLE`, `CANVAS_EXCEEDS_THE_CURRENT_PRODUCTION_LIMIT`, `ASSET_HAS_NO_TEXT`). Only a single-canvas asset whose roles all have a layout slot is executable today. Nothing is faked.

## Figures in contracts (NDR-P19)

A contract a model authors holds no number (`noNumbers` still refuses any JSON number in a model answer). A contract Nordla computes may hold measured, requested or declared figures: word and character counts, density, asset count, capacity, canvas dimensions. The wording in `src/creative-brain/validation.js` states this.

## Files

| New | `src/creative-planning/{constants,format-resources,text-units,request,understanding,inventory,copy-policy,format-planner,legacy-bridge,parity,index}.js`, `scripts/check-creative-planning-parity.mjs`, `docs/architecture/creative-planning-contract-matrix.md` (generated), tests `test/creative-planning-*.test.js` |
|---|---|
| Changed | `src/creative-runtime/ledger.js` (new components and decisions), `src/creative-brain/validation.js` (comment only), `NORDLA-DECISION-REGISTER.md` (NDR-P17..P21), the CI workflow paths |

## Blast radius and rollback

Additive. No existing module imports `creative-planning` (test CL-7). The ledger gained entries; `REQUIRED_DECISIONS` is unchanged. Rollback: revert the merge of the branch; nothing else depends on it.

## Not in this phase

Multi-asset production, layered scenes, REFINE / masked editing, general segmentation, video, upscale, multi-reference composition, any new provider. A carousel, a series, a story sequence, a poster beyond the current canvas limit and a campaign can be **planned**, not produced.
