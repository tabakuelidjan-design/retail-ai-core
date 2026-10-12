# Creative production — Phase 3: layered scene production

Status: built on `feature/creative-phase-3-layered-scene-production`, offline, **no provider call and no image generated**. Decisions: NDR-P17 (order), NDR-P20 (explicit ranked tool candidates), NDR-P21 (campaign ceiling), NDR-P22 (one readiness verdict), NDR-P23 (this phase).

Priority principle: **a blocked, explicit, auditable result is preferable to a visually plausible but unverified creative result.**

## 1. The Attempt 12 issue, fixed first

Attempt 12 asked for "a bare polymer shell resting on a worn wooden counter, half its surface still untouched". The shell was an unfinished version of the product; the generator drew it as a large white hero object three times; the lexicon of the time did not know the word. Three layers of defence now exist:

| Layer | What it does |
|---|---|
| **Brain lexicon** | A fourth group, `product_look_alikes` (shell, housing, casing, sleeve, bumper, blank, polymer, silicone, protector, étui, boîtier, hoesje, unprinted, unfinished, half finished), is refused in every narrative element and is printed in the ART_DIRECT instruction (parity unchanged: the instruction prints exactly what the validator refuses). |
| **Detection relative to the product** | `detectSubstitutes({ text, identity })` also refuses the objects of the product's **family** (a neutral vertical table opted into by the words of the description: protective case, drinkware, framed print, gift box) and the words that **name the product**. It is applied to everything that would feed a generator, against *this* product. |
| **Explicit product identity** | `resolveProductIdentity` returns VERIFIED only for a pinned, traceable asset. Missing (no reference, no asset), ambiguous (not described, not pinned, bytes that do not match the pinned hash, several product families, a campaign naming another product) or unsupported (no outline for local segmentation) products give `INTENT_ONLY` scenes: no layer, no request, no cost, **no replacement**. |

The exact scene of Attempt 12 is a regression fixture (SD-1).

## 2. Architecture

```
CampaignPlan + AssetPlans (Phase 2)
        │   content plans (the exact pieces of copy), shared concept and art direction
        ▼
PRODUCT_IDENTITY ──► SCENE_PLATE:<key>  (shared: a plate per crop scale)
                 ──► SCENE_PROP:<key>   (shared: a prop per element)
                 ──► SCENE:<lane>:<i>   (one scene specification per asset)
                              │
                              ▼
        PROVIDER GATE (fails closed)   ──►   (later) provider requests, produced assets
```

A **scene specification** is the stack: `PLATE (z 0) < PROP_BACKGROUND (10) < PROP_MIDGROUND (20) < PRODUCT (30) < PROP_FOREGROUND (40) < TEXT (50+)`.

* The **plate** is a text-only request. It no longer asks the generator to keep a zone empty with words; the real product is placed afterwards and the **unchanged environment suitability gate** decides.
* A **prop** is one object, alone on a plain ground (to be cut out); no generator solves a whole scene. A foreground prop may overlap the real product only within `EDGE_ONLY` (declared 8% of the product) and never a protected region.
* The **product** layer is always the real asset: reference, asset, hash, exact pixels, `allow_crop / relight / rotation = false`. No generated layer can be a product (a validated rule).
* **Text** layers hold the exact planned text, its digest and its pieces.
* Generated layers are **shared**: a plate per crop scale (at most 3) and a prop per element, whatever the number of assets. They are produced once.
* Each capability's **tool** is selected from declared, ranked candidates under constraints (data class, region, size, wired or not), written into the scene with the candidates passed over and why. Execution uses only the selected tool; there is no fallback.

## 3. Text integrity

The visual layer never truncates, rewrites, compresses or rearranges copy. `checkTextFeasibility` judges whether the composition can carry the planned text: the measured capacity of its density class and, when a real font is given, the **real typography engine on the real text** in the text region. When it cannot, the scene is `BLOCKED` with `LOCKED_COPY_DOES_NOT_FIT_THE_COMPOSITION` and a replanning request; the scene keeps the exact text. `recoverLockedCopy` proves, from the layers and the caption alone, that every locked piece is the exact slice of its source and rebuilds each source identically (`reassemble`, whitespace included).

## 4. Provenance

`request → content plan → campaign → asset plan → scene → layers → provider request → produced asset`. Every scene carries the ids of the chain and the pinned product (`identity_id`, `product_ref`, `asset_ref`, `sha256`); every generated request carries its prompt digest and `produced_asset: NOT_PRODUCED` (tied back when something is produced). A generated layer cannot carry a product reference, a claim word nobody approved, or a figure. A `validateSceneSpec` rule names each way the chain can break.

## 5. Budget (hard ceiling)

`estimateProduction` lists every line (shared planning stages, per-asset planning stages, each generated layer at `candidates × unit cost`, critic calls) and `reserveProduction` reserves them in order against the campaign ceiling (EUR 2.00 by default). **Reuse before anything else**: if the layers do not fit, plates are shared more (crop scales merged, then one plate); no size, candidate count or prop is reduced. If even the most reuse does not fit, the production is `BLOCKED` by `PRODUCTION_BLOCKED_BY_BUDGET`, with the failing line.

## 6. State, checkpoints, invalidation

Every node is stored with the hash of its inputs (asset plan id, shared layer keys, identity id, copy digests, feasibility, blocks). A resumed production is identical to a clean one; one slide-level input recomputes only its scene; a changed art direction recomputes the shared layers and every scene; a changed product identity recomputes the identity, the layers and every scene. No model is asked in this phase.

## 7. Raster compositor

`composeLayers` composes the raster layers in the explicit z-order, pixel-exact, and **measures** the overlap of every foreground layer and the integrity of the product pixels; it refuses (and returns no image) when an overlap exceeds its policy, a protected region is covered, the structure is not a scene or the product pixels changed. Text is not drawn there. It is a tested library, not yet wired to the runtime, and the gate says so.

## 8. Provider gate and readiness

`evaluateProviderGate` fails closed: product identity VERIFIED, every scene SPECIFIED, budget within ceiling, **`CREATIVE_PIPELINE_READY`**, the compositor wired, and the owner's go. It never calls a provider. The combined readiness gate now has a fourth component, **PRODUCTION**: its parity is a mechanical probe of every production rule, and the attestation must name it and carry its mutation sweep for the exact code hash.

## 9. Files

| New | `src/creative-production/{constants,product-identity,capability-router,copy-integrity,scene-spec,production-cost,production-planner,compositor,gate,parity,index}.js`, `scripts/check-creative-production-parity.mjs`, `docs/architecture/creative-production-contract-matrix.md` (generated), tests `test/creative-production*.test.js` |
|---|---|
| Changed | `src/creative-brain/substitutes.js` (lexicon), `src/creative-brain/art-direction.js` (the instruction prints the new group), `src/creative-planning/copy-policy.js` (one export), `src/creative-runtime/ledger.js`, `src/creative-readiness/index.js` (PRODUCTION), the Brain contract matrix (regenerated), `NORDLA-DECISION-REGISTER.md` (NDR-P23), the CI workflow paths |

## 10. Blast radius, rollback, what is not here

The production module is additive: nothing in the existing source imports it except the readiness gate; it imports no runtime and no provider (tests LG-2). The single-image path is untouched (the Phase 1 golden test and LG-1). The Brain lexicon change is the only behaviour change outside the module, and it only refuses more. Rollback: revert the merge of the branch.

Not in this phase: any provider call, any generated image, wiring the compositor and the typography to the runtime, REFINE / masked editing (Phase 4), general segmentation and realistic integration (Phase 5), video, upscale, multi-reference.
