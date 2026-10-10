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
