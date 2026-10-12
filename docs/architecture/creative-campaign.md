# Creative campaign — Phase 2: the multi-asset / carousel planner

Status: built on `feature/creative-phase-2-campaign-planner`, offline, no provider call. Decisions: NDR-P17 (order of the capability phases), NDR-P21 (campaign budget), NDR-P22 (one readiness verdict for the whole Creative pipeline).

## What it adds

A request for several assets (a carousel, a series, a story sequence, a multi-channel campaign) used to have nowhere to go. It is now planned like this:

```
one objective ─► ContentPlan(s) ─► ONE Frame ─► ONE Concept ─► ONE ArtDirection ─► CampaignPlan ─► N AssetPlans
                  (Phase 1)        (Brain)       (Brain)         (Brain)            sequence, continuity,   each with its role,
                                                                                     diversity, budget       copy, density, looks, imagery brief
```

Nothing is produced: every asset stays `PLANNED_NOT_EXECUTABLE` (multi-asset production is a later phase). The Creative Brain's `plan()`, the production runtime and the gates are unchanged; the Brain gained three methods that expose the shared stages one by one (`planFrame`, `selectConcept`, `directArt`), used only by the campaign planner.

## A carousel is not one template repeated

| Mechanism | What it does |
|---|---|
| **Narrative role per asset** | `HOOK`, `CONTEXT`, `PROBLEM`, `PROGRESSION`, `PROOF`, `DETAIL`, `OFFER`, `CTA`. The cover is the hook; a closing asset is the offer (with a price) or the call to action; the body follows the pattern of the objective (`EDUCATE`, `SELL`, `AWARENESS`, `ANNOUNCE`). No role is compulsory: a role the content does not need is not invented, and `PROOF` needs three body assets and a verified product-claim fact. A person can name an asset's role. |
| **Density classes** | `LOW` (headline-level), `MEDIUM`, `HIGH`, `TEXT_LED`. A class describes the text of an asset; it is decided by measurement against the format's slide capacities, never by a bare character count. A hook is deliberately `LOW`. A body role that should say little is replaced by a progression when its locked copy is long. Copy is **distributed, never cut**: the planner tries the lightest class that holds all the text on the slides, then a heavier one. |
| **Composition and imagery intents** | Closed vocabularies. The k-th occurrence of a role takes the k-th option of that role, an asset never repeats the look of its predecessor, and an asset that carries much text is offered the text-led variants. |
| **Imagery brief per asset** | One model completion per asset behind the asset director port, given only the shared concept and art direction plus the asset's own role, intents and copy. It holds no figure and never names a substitute for the product. Without the port, or if it fails, the asset keeps its intents and says so (`INTENT_ONLY`, with the safe failure code). |
| **Continuity contract** | `MUST_STAY_CONSISTENT` (concept, art direction, brand constraints, product identity, approved facts, visual language) and `SHOULD_VARY` (role, composition, imagery, crop scale, text hierarchy, rhythm), and the forbidden pattern `SAME_SLIDE_REPEATED_WITH_DIFFERENT_TEXT`. |
| **Diversity report** | Measured rules: no two neighbours share a look, not one template repeated, roles are varied, no copy repeated on two assets. A lane that fails them says so (`CAMPAIGN_LOOKS_REPEATED`). |

## Slide text capacity (calibrated)

The 360 / 280 character ceilings of Phase 1 were provisional. Phase 2 replaces them with measurements. `text-led-spec.js` describes a text-led slide as data (margins, a text region sized by density class, the BODY size of the type scale) and measures the capacity with the **real typography engine**. A format resource now carries `slide_capacity` per class and canvas, each stated with a 20% safety factor below the measured maximum and re-measured by a test on every run (`CL-8`). BODY still has no layout recipe, so an asset that uses it is planned, not executable, but its capacity is a measurement. A single canvas that shares its space with an image holds a `HIGH` slide.

## Working state, checkpoints, invalidation

Every stage result is a node of a plain, serializable state, stored with the hash of the inputs it was made from. A node is reused iff that hash is unchanged. The ids of what a node used are part of the inputs of what follows, so a change travels down the dependency graph by itself, and a node whose inputs did not change is never recomputed.

| Change | Recomputed |
|---|---|
| nothing | nothing (no model call) |
| a hint on one asset | that asset only |
| the audience or the objective | content plan, frame, concept, art direction and every asset |
| a failure after the frame | the next run starts at the next stage |
| a failed imagery brief | the asset is `DEGRADED`; the next run redoes that asset only |

The state is stored through a port (`load`, `save`); an in-memory store ships, and a durable one (the Core's state layer) implements the same two methods later. Core Resilience is not merged or imported here.

## Campaign budget (NDR-P21)

A campaign has its own configurable ceiling, **EUR 2.00** for development and benchmark campaigns. The planner estimates the worst case of producing what it planned from unit costs by capability class (never by provider), under a stated bounded shape: each asset may use up to 3, then 2, then 1 environment images, and the richest shape that fits the ceiling is written into the plan. Every line is reserved before any cost and a reservation that would pass the ceiling is refused; if even the cheapest shape does not fit, the plan carries the blocking question `CAMPAIGN_BUDGET_EXCEEDED` instead of exceeding it. The unit costs are the worst-case reservations observed on the benchmark and are to be recalibrated from measured production costs.

## One readiness verdict for the whole pipeline (NDR-P22)

`src/creative-readiness/` is the combined gate. For the exact code hash it requires the contract / prompt parity of the **planning**, **Brain** and **campaign** stages, the Brain's own gate (unchanged), and an attestation that names the components it covers: the full suite, a mutation sweep of each component, the Node 20 and 24 clean clones and CI. A component added to the pipeline joins `ACTIVE_COMPONENTS` and the gate refuses until its parity and attestation exist, so a new stage cannot become a blind spot. The live benchmark is wired to this gate (`CREATIVE_PIPELINE_READY`).

## Files

| New | `src/creative-campaign/{constants,density,sequence,continuity,budget,state,asset-director,campaign-planner,parity,index}.js`, `src/creative-planning/text-led-spec.js`, `src/creative-readiness/index.js`, `scripts/check-creative-campaign-parity.mjs`, `scripts/check-creative-readiness.mjs`, `docs/architecture/creative-campaign-contract-matrix.md` (generated), `docs/architecture/creative-readiness.json` (the attestation), tests `test/creative-campaign*.test.js`, `test/creative-readiness.test.js` |
|---|---|
| Changed | `src/creative-brain/brain.js` (three additive methods), `src/creative-planning/{format-planner,format-resources,request,text-units,constants,index}.js` (measured slide capacities, balanced distribution on sentences, prepare / plan-from-preparation, `slide_density`), `src/creative-runtime/ledger.js`, `src/creative-brain-benchmark/runner.js` and `scripts/run-creative-brain-benchmark.mjs` (the combined gate), `NORDLA-DECISION-REGISTER.md`, the CI workflow paths |

## Blast radius and rollback

The campaign planner is additive. The Brain's `plan()` is unchanged (the single-image golden test still passes). The planning changes are behind the new `slide_density` input and the measured capacities; a single-image request is decided exactly as before. Rollback: revert the merge of the branch.

## Not in this phase

Producing any asset, layered scenes, REFINE / masked editing, general segmentation, video (a video lane is planned and has no assets), upscale, multi-reference composition, advanced provider routing, merging Core Resilience.
