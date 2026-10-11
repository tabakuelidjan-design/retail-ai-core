# Creative Brain — art direction intelligence

Status: foundations implemented and tested with fake model ports. **No provider call has been made with it and no new HABB image exists.** The Creative module is not claimed to be successful.

## Why it exists (the plateau of Candidates 1–3)

The three benchmark candidates were technically valid (real providers, product preserved, Preflight / Fidelity / Brand Guardian PASS, critic, autonomous revision, manual creative steering NONE) and all were rejected by the owner. The causes are architectural:

1. **The concept lived only in three text fields of at most 300 characters.** Nothing stored a central idea, a visual metaphor, a story, an emotional intent or a memory hook. Nothing could compare, reject or refine an idea.
2. **There was one idea per run.** The Director returned one direction; the first plausible idea always won. No ideation, no selection, no way to say "this idea is generic, try another".
3. **The environment contract forbade the scene.** The request builder asks for "quiet and empty: a single seamless surface", names forbidden objects, and purifies scene wording. A scene with materials, depth or narrative elements could not be expressed, so every candidate was `background + product + text + price`.
4. **Five fixed layout recipes.** Layout was a choice among presets; relations (who leads, where the product anchors, how the words stand to it) could not be stated, and the last cycles stopped at the layout capability limit.
5. **The critic judged execution only.** Its 14 dimensions cannot say "clean but conceptually weak"; a green outcome read as quality.
6. **Recovery had no semantics.** A failure led to a new direction written from hints, never to a diagnosis of whether to polish, recompose or re-conceive. A weak concept could only be polished.
7. **The Director's latency tail** (thinking mode) consumed revision cycles.

## Architecture

`src/creative-brain/` — a sequence of decision stages. Each has a closed canonical contract, a responsibility, concise recorded evidence (a one-sentence rationale, never a reasoning log) and a deterministic guard. Language models sit behind ports `complete({system,user}) -> {text, model?, request_id?}`; their JSON is untrusted and normalized by the closed contracts (no unknown key, no number, closed vocabularies, content-derived ids). Nothing requests, stores or depends on a provider's private reasoning.

| Stage | Module | Decided by |
|---|---|---|
| OBSERVE | `problem-frame.js` `observeBrief` | deterministic |
| FRAME | `problem-frame.js` | model fields, `fixed` / `may_change` deterministic |
| IDEATE | `concept.js` | model; layout-variant and distinctness guards deterministic |
| SELECT CONCEPT | `concept-selection.js` | model gives per-criterion words; **outcome derived by Nordla** |
| ART DIRECT | `art-direction.js` | model; reasons, substitutes, numbers guarded |
| COMPOSE | `composition.js` | model states relations; **synthesizer is deterministic** |
| SCENE | `scene-composer.js` | deterministic |
| PRODUCTION STRATEGY | `production-strategist.js`, `tool-registry.js` | deterministic |
| CRITIQUE | `concept-critic.js` (+ the unchanged 14-dimension critic) | VLM opinion; state deterministic |
| DIAGNOSE / RECOVER | `recovery.js` | deterministic from critic words and history |
| Orchestration | `brain.js` | sequence, coherence checks, ledger |

### Creative knowledge (`knowledge.js`)
36 principles in 8 domains (ATTENTION, HIERARCHY, COMPOSITION, STORYTELLING, PREMIUM_CRAFT, COMMERCIAL_COMMUNICATION, DISTINCTIVENESS, OCCASION_INTELLIGENCE). Each has a purpose, when it applies, **failure modes**, tensions with other principles and the stages it serves. Dominance is contextual (`HIE-CONTEXTUAL`). Occasion intelligence teaches how to reason (register, giver/receiver relationship, moment) and refuses the motif shortcut (`OCC-NO-SHORTCUT`); a test proves no motif, brand, figure or provider appears in the knowledge. Principles are projected by stage into instructions.

### CreativeProblemFrame
What we show, who cares, what must be understood immediately / felt / remembered, the commercial objective, the occasion context, what is fixed (product pixels, approved texts, claims, format — derived from the brief, never by a model), what may change, what would be generic, what would be distinctive.

### Concept Director
3–5 concepts per round: `concept_id, central_idea, visual_metaphor, story, emotional_intent, product_role, message_role, memory_hook, distinctiveness_reason, risks`. A concept whose idea and metaphor share too few conceptual words is refused as a layout variant (`CONCEPT_IS_A_LAYOUT_VARIANT`); concepts overlapping each other or an already-rejected concept are refused (`CONCEPTS_NOT_DISTINCT`).

### Concept selection
Ten criteria (concept strength, relevance, emotional resonance, product relationship, distinctiveness, feasibility, brand compatibility, commercial clarity, narrative cohesion, generic risk) judged `MEETS / PARTIAL / FAILS / NOT_ASSESSED` with evidence. No score. Nordla derives per concept `SELECT / REFINE_CONCEPT / REJECT_CONCEPT` and per round `SELECT / REFINE_CONCEPT / REJECT_CONCEPT / NO_CLEAR_WINNER` (selection only if one concept is not dominated; dominance is per criterion, no weights, no sum). A model that names a winner or a score is refused.

### Art direction
Atmosphere, depth model, material language, lighting intent, visual rhythm, product and text relationships, realism, emotional temperature, tension, negative-space strategy, narrative elements (each with a **reason argued in the concept**), permitted secondary elements, forbidden noise (a mandatory list is always appended). No digit, coordinate, size, colour code or unit.

### Scene Composer
A scene can be rich, but the **protected product** (`COMPOSITE_REAL_PIXELS`, merchant authority) is never described to or redrawn by a generator, and the scene always **reserves a product integration zone** (`reservation: REQUIRED`) lit consistently with the scene. No element may be, or stand in for, the product, a phone/case/device, a competing hero, a logo or text. The provider request is an adapter projection of the scene; prohibitions go in the negative prompt only; the zone is described in words (`START/CENTER/END × UPPER/MIDDLE/LOWER × SMALL/MEDIUM/LARGE`).

### Composition intelligence
The five presets remain, as safe fallbacks. A `CompositionPlan` states relations only: hero relationship, product anchor, text adjacency, alignment family, visual weight per role, grouping, overlap permission, negative-space reservation, reading flow. Contradictory relations are refused. A deterministic synthesizer turns a plan into a layout recipe that must pass `assertValidLayoutRecipe` (the same invariants as presets: in bounds, one slot per role, no overlap, media alignment); a relation the solver cannot guarantee (overlap) is refused, not ignored. The real solver (`solveLayout({recipe})`) still resolves geometry, text fitting, collisions and readability.

### Production Strategist
Chooses capabilities, not providers: local segmentation, cut-out, environment or rich-scene generation, deterministic composite and text, shadow/contact, local refinement (and, never needed here, multi-reference and selective editing, each with a reason). `tool-registry.js` is the only module that names a tool; unsupported capabilities (local refinement, selective editing, multi-reference) are reported with an explicit degradation or block the plan. Qwen is kept; no second provider.

### Creative recovery
`diagnoseRecovery` from critic words and history: **REFINE** (execution flaws: redo scene and production, keep frame, concept, art direction, composition), **RECOMPOSE** (structure flagged: redo composition, keep concept and art direction), **RECONCEPT** (a decisive concept failure, three concept flags, or a concept already polished twice: keep only the frame, exclude the failed concepts). A weak concept is never endlessly polished.

### Critic expansion
The 14 dimensions are untouched. Six concept-level dimensions are judged separately by the same VLM port (`CONCEPT_STRENGTH, NARRATIVE_COHESION, EMOTIONAL_RESONANCE, EDITORIAL_SOPHISTICATION, DISTINCTIVENESS, WOW_FACTOR`), four outcomes, visual evidence, semantic hints, no score. `creativeQualityState` says `NOT_TECHNICALLY_VALID`, `NOT_MEASURABLE`, `TECHNICALLY_VALID_BUT_CREATIVELY_INSUFFICIENT` (Candidate 3 is the canonical case: clean execution, weak concept) or `CREATIVELY_SUFFICIENT_AWAITING_OWNER`; `premium_quality_implied` is always false and `owner_approval` always `PENDING`.

## Runtime integration (`runProductPreservingCreative({ creativePlan })`)
Optional; without it nothing changes. With a plan: the canonical direction is built by the C1 contract (`directionFromPlan` → `normalizeCreativeDirection`) and replaces the Director's; the scene request is `projectSceneRequest` with the zone where the layout placed the product; the synthesized recipe is solved for the real approved texts and, if it has no slot for a text or does not solve, the named preset of the direction takes over with the reason recorded (`source: PRESET_FALLBACK`), never silently. Brand-forbidden visuals stop the run before any provider call.

## Gates that stay authoritative
Segmentation confidence, the layout solver, the environment suitability gate (now applied to the integration zone), typography contrast rules, Preflight, Identity Fidelity, Brand Guardian, scoped external-media authorization, the live-call lock, the 14-dimension critic's deterministic precedence. The Brain proposes; none of these is weakened or bypassed. The critic never approves publication; only the owner does.

## Known limits
- Never run against a real model: the instructions are untested for quality, and the guards are calibrated on synthetic fixtures.
- No live runner script wires the Brain to credentialed ports yet.
- `LOCAL_REFINEMENT`, `SELECTIVE_EDITING`, `MULTI_REFERENCE_COMPOSITION` are not implemented (reported as unsupported).
- Lexical guards (layout-variant, distinctness, substitute stems) are heuristics for EN/FR; a stronger semantic check is possible later.
- The Node 24 product-mask determinism issue recorded in `creative-c3-critic.md` remains parked.

## Mutation testing
62 mutations of the critical decisions (concept decision rules and dominance, distinctness and layout-variant guards, art-direction reasons and substitutes, scene protection and zone reservation, composition consistency and synthesis, strategist capability rules, tool registry confinement, recovery diagnosis and polish limit, creative-quality state, runtime fallbacks and brand check, recipe invariants): 60 killed. The two survivors are defensive guards that the current constants make unreachable (`NO_ROOM_FOR_THE_TEXT_BLOCK` and the final `assertValidLayoutRecipe` of the synthesizer, whose slots are valid by construction); they stay so that a later change of the constants cannot produce an invalid recipe silently. Writing the sweep also removed two redundant rules (a three-failure concept rejection that was always implied by a blocking or decisive failure, and a duplicate product check in the grouping rule).
