# C2-C — Product-preserving creative runtime

**Status: IMPLEMENTED AND TESTED WITH FAKES. NO LIVE RUN HAS BEEN MADE with it.** Nothing here was sent to a provider. The first live run is a separate, explicit owner decision.

## 1. Why

The first real Qwen image edit (C2-B) failed the identity gate: the provider **redrew** the case (perspective rectified, camera module and printed text re-rendered). A generative edit re-renders every pixel, so it cannot guarantee identity; masked editing would not either (the output is re-encoded), and Alibaba documents no mask-based editing for the Qwen Image models in Frankfurt (the only mask inpainting listed is a Beijing-only legacy Wanx model). The HABB brand expression says the same: *"prefer cut-out and compositing over product regeneration"*, *"generate or compose the environment around the product"*, *"reserve text space before generating or composing the environment"*.

The recorded first result stays what it was: **`PROVIDER_OUTPUT_FIDELITY_FAIL`** (failed observations: `ARTWORK`, `ANISOTROPY`, `OUTLINE_EDGE`, `CAMERA_MODULE`, `PRINTED_TEXT_REGION`). The output is kept as evidence in the private store.

## 2. Architecture

```
Creative Brief (data: approved copy, claim roles, public facts)
 -> Product/Asset Analyst            decides the preservation mode              (COMPOSITE: real pixels, cut out)
 -> Creative Director (Qwen text)    decides the direction                      (concept, hierarchy, spatial intent, negative space, the look of the ENVIRONMENT)
 -> Approved-copy agent              selects approved texts for the hierarchy   (nothing is written)
 -> Visual Production Director       decides the strategy                       (segment the real product locally + generate an environment WITHOUT any product)
 -> Local product segmenter          cuts out the REAL product                  (deterministic mask, no provider, no model)
 -> Provider request builder         builds the environment request             (direction + brand photography principles; empty scene, no input asset, no text)
 -> Qwen environment lane            generates the empty environment            (text-only request, Frankfurt, PUBLIC data)
 -> Layout planner + layout engine   recipe, placement of the cut-out and of the text
 -> Typography rules                 text colour from the brand tokens against the actual environment pixels
 -> Preflight -> deterministic render (real fonts, soft contact shadow) -> IDENTITY fidelity gate on the delivered PNG
 -> candidate READY_FOR_REVIEW        (no Critic, no approval here)
```

**Segmentation is local**, not provider-based: a provider adds nothing guaranteed and would see the real photograph. The mask (`product-mask.js`) starts from the annotated inner outline, snaps to the real rim by edge detection (dynamic programming), then fits a **rounded quadrilateral** (four robustly fitted straight sides and circular corner arcs) to the measurements, so wood grain and a dark rim on a dark table cannot make the silhouette wobble. Its quality is evidence (`confident`, residual); a mask it cannot trust stops the run before any environment is generated.

**The provider never receives a product pixel.** The environment request is text only; the runtime refuses any provider request that carries an input asset; the C1 contract forces `NO_CRITICAL_TEXT`. Inside the product mask the delivered pixels are the source pixels, scaled uniformly by the renderer.

## 3. The decision ledger: who decided what

`creative-runtime/ledger.js` records every decision with the Nordla component that made it and the rule or brand statement it rests on; a decision with no Nordla component (a person, "manual", an unknown component) is refused. A run that lacks a required decision reports `NORDLA_CREATIVE_RUNTIME_INCOMPLETE`, never `NONE`.

| Decision | Nordla component | Rests on |
|---|---|---|
| Product preservation mode | `nordla:product-asset-analyst@1` | merchant-provided real pixels + an outline + printed content; the brand's "prefer cut-out and compositing over product regeneration" |
| Segmentation / mask | `nordla:local-product-segmenter@1` | the annotated outline; local deterministic mask |
| Creative direction | `nordla:creative-director@1` (Qwen text model behind the C1 agent boundary) | the brief and the brand expression |
| Background strategy | `nordla:visual-production-director@1` | the preservation mode; "generate or compose the environment around the product" |
| Provider request construction | `nordla:provider-request-builder@1` | the direction + the brand's photography / composition principles; brand-forbidden visuals are refused |
| Layout recipe | `nordla:layout-planner@1` | the direction's spatial intent and product role |
| Product placement, typography placement | `nordla:layout-constraint-engine@1` | recipe slots, uniform fit, text fitting |
| Text style (colours) | `nordla:typography-rules@1` | brand tokens against the worst contrast over the pixels behind each text |
| Shadow | `nordla:contact-shadow-rule@1` | darkest brand colour, scaled to the canvas |
| Fidelity | `nordla:identity-fidelity-gate@1` | IDENTITY measurements on the delivered PNG |

**What is data, not a decision:** the Brief (`benchmarks/creative-intelligence/habb-c2-brief.json`) carries the approved headline variant, the semantic role of each approved claim (price is the price, the visible speed claim is a supporting message) and public facts. It holds no composition, layout, colour, font size, background or provider instruction.

## 4. Capabilities added or extended

- `product-mask.js`, `product-cutout.js`, `png-encode.js`: the local mask and the transparent cut-out of the real pixels.
- `identity-preserve-measurements.js`: also measures `COMPOSITE` products; a composite may declare the environment images it draws (`expected.allowed_other_image_draws`); the registration optimizer now uses centre-preserving and anchored scale moves (a real fit of 0.99 where the old one stalled), and every mutation family is still detected.
- `preflight.js`: text over an **image** backdrop is judged on colours measured from its pixels (`measured_backdrops`, the worst of them); without them it stays NOT_MEASURABLE.
- `layout-recipes.js`: `PRODUCT_DOMINANT` (the product over half of the height) for a hero product; the other four recipes cap a tall product at about 30-48 % of the height.
- Alibaba lane: `qwen-environment.js` (text-only IMAGE_GENERATE of an empty scene, no input asset), `qwen-director-port.js` (one chat completion, PUBLIC data).
- `scripts/run-c2-habb-creative.mjs`: `--check` (no network, plus a LOCAL segmentation dry-run) and `--live` (exactly two billable calls, a lock refuses a second run).

## 5. Evidence before any live call

- Real photograph, local only: the mask is confident (rounded-quad residual ~1.3 px) and the identity gate passes through the real runtime with fixtures for the model and the environment (a technical verification: no candidate was saved or presented).
- CI holds no credential: every provider interaction is tested with fake responses.

## 6. Not in this runtime (next)

Creative Critic, Brand Guardian on the composite, owner approval, and multiple candidates. A mask on a photo whose rim and surface have almost the same tone is the known weak spot; its quality is reported, never hidden.

## 7. First autonomous attempt (2026-10-10): stopped by a provider refusal, and by a Nordla defect that hid it

The first `--live` run took its lock, assembled the brief, segmented the real product locally (ROUNDED_QUAD, residual 1.33 px) and then called the Creative Director's text model (`qwen3.8-max`, Frankfurt). Alibaba answered **403 `access_denied`** (no permission for the model; most likely the API key's Access Scope listed the image model only) with no request id. Only that call was sent: the environment image call never happened and no image was generated. The runtime stopped with a bare `CI_AGENT_FAILED` because the C1 agent wrapper discarded every diagnostic of the failure: a provider refusal was indistinguishable from a bug.

**Fix (Nordla, not the creative result):** a failing agent now keeps the SAFE diagnostics of its cause (name, code token, HTTP status, request id, transient) and never its message; the run script reports them. Nothing was decided in the Director's place: no direction, no composition, no fallback. The lock of that attempt stays until the Alibaba-side permission is fixed and the evidence is archived. Provisioning: the key's Access Scope must list `qwen3.8-max` and `qwen-image-3.0-pro`.

## 8. Second autonomous attempt (2026-10-10): both provider calls succeeded, the run stopped at PREFLIGHT_FAIL

Both calls succeeded (the Director text completion; one text-only environment image, 1080 x 1350, 8.7 s, about 0.082 EUR in total). The Director chose `PRODUCT_CENTER_TEXT_BELOW`, negative space `BOTTOM`, hierarchy PRODUCT / HEADLINE / SUBHEADLINE / PRICE, product role HERO. The runtime stopped at Preflight (`TEXT_OVERFLOW` on the subheadline, `INSUFFICIENT_CONTRAST` on the headline and the price), before any render or fidelity check.

| Failure | Classification | Responsible Nordla component | Fix |
|---|---|---|---|
| `TEXT_OVERFLOW` (subheadline: too many lines, too tall): the text was left at its default 400 x 100 box | `NORDLA_LAYOUT_LOGIC_DEFECT` | layout planner (chose `PRODUCT_AND_PRICE`, which had no SUBHEADLINE slot) and the runtime (ignored the layout engine's `unplaced`) | the planner picks only a recipe with a slot for every filled role (or stops: `NO_LAYOUT_RECIPE_COVERS_THE_HIERARCHY`); `PRODUCT_AND_PRICE` gets a SUBHEADLINE slot; an unplaced product or text stops the run |
| `INSUFFICIENT_CONTRAST` (headline 2.1:1, price 2.4:1; the best brand token read at 2.1:1 on the mid-grey stone environment) | `NORDLA_TYPOGRAPHY_LOGIC_DEFECT` (a valid Preflight rejection of a choice Nordla had no way out of); the grey tone is a provider contribution | typography rules | when no brand token reads on the environment behind a text, a solid plate in a brand token goes behind it and the text takes a token that reads on the plate; if no brand pair reads at all the run stops (`NO_BRAND_COLOUR_PAIR_READS`). Preflight is unchanged |
| Not a Preflight check: the "empty" environment contained a phone (three lenses, a different device) on a stone slab, despite a prompt that said no phone | `PROVIDER_OUTPUT_DEFECT` with a Nordla gap (nothing checked the environment) | provider request builder + a missing gate | the positive prompt names nothing it must not draw (forbidden objects and display furniture are in the negative prompt only; a direction asking for a pedestal / plinth / slab is refused); an environment suitability gate measures the product zone (strong-edge share, limit 2 %; the real environment measured 7 % where the phone stood, empty backdrop regions 0 %) and refuses `ENVIRONMENT_NOT_EMPTY` before composition |
| The stopped run's summary lacked the direction, the copy and the environment provenance | Nordla runtime defect | runtime | every stop carries the evidence gathered so far |

`MANUAL CREATIVE STEERING: NONE` was true for that run: every recorded decision had a Nordla component. The label `NORDLA_CREATIVE_RUNTIME_INCOMPLETE` it printed only meant the run had not reached the fidelity decision; the report now says `run_complete: false` and `decisions_not_reached` separately.

**CI note:** the first CI run of the fix commit (`b2408fd`) failed on the Node 24 job only, in the full-suite step; the Node 20 job passed. The failure did not reproduce locally on Node 24.21 (8 cores, 2 CPUs / 7 GB in Docker, 24-way test concurrency). The failing test's name could not be read (the job log needs authentication), so the cause is unknown until the re-run below or the log is read; it is not assumed to be a flake.
