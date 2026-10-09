# Creative Intelligence C1 — Foundation, DesignDocument, deterministic composer & preflight

- **Status:** C1 FOUNDATION — COMPLETE (audited, pushed, CI green). Creative Intelligence as a whole is NOT complete: C2 is NOT READY and deferred.
- **HABB CANONICAL BRAND = COMPLETE** (Identity, Snapshot, Core V1 APPROVED, Memory V1.1 APPROVED, expression_system BOUND) · **HABB BENCHMARK 001 PREPARATION = COMPLETE** · **HABB BENCHMARK 001 = NOT_RUN / BLOCKED** (HABB BENCHMARK FONT BINDINGS = COMPLETE: Playfair Display and Montserrat BOUND, HABB Brand Memory v2 APPROVED; PRODUCT and ASSET still MISSING) · **C2 = NOT READY**
- **PRE-C2 TECHNICAL FOUNDATION = COMPLETE** (pushed at `d182e86`, remote CI green on Node 20 and 24) · **C2 = NOT READY** — HABB CREATIVE BENCHMARK 001 is NOT_RUN / BLOCKED on real HABB data. See `creative-pre-c2-foundation.md`.
- **Branch:** `feature/branding-marketing-creative-v1` (C1 pushed as `055708e` on top of `a0162e9`)
- **Code:** `src/creative-intelligence/` · **Tests:** `test/creative-intelligence-*.test.js` · **CI:** `.github/workflows/creative-intelligence-v1.yml`

```text
MARKETING PREPARES (why, to whom, what must / must not be said)  →  CreativeBrief
CREATIVE INTELLIGENCE EXPRESSES (how)                           →  DesignDocument + CreativeCandidate + provenance + reports
CREATIVE FIDELITY guards the product · BRAND GUARDIAN guards the brand · ACTIVATION publishes
```

The durable output of Creative Intelligence is **not an image**. It is a structured **DesignDocument** (a scene graph), plus a
**CreativeCandidate** that points at it, plus provenance and a preflight report. A PNG / SVG is a **projection** of that state.

## Closure

### What COMPLETE means (C1 FOUNDATION)

```text
Creative Intake contract                        COMPLETE
M3 -> C1 handoff                                COMPLETE
Product / Asset readiness contract              COMPLETE
DesignDocument / Scene Graph V1                 COMPLETE
Layout Constraint Engine V1                     COMPLETE
Typography contract                             COMPLETE
deterministic SVG renderer                      COMPLETE
structural / resolved render boundary           COMPLETE
deterministic preflight                         COMPLETE
CreativeCandidate / selection                   COMPLETE
Provider Capability Registry                    COMPLETE
agent interfaces / trust boundary               COMPLETE
Resource Resolver interface                     COMPLETE
```

COMPLETE means the contracts, deterministic engines and their tests are finished and tested against synthetic fixtures. It does **not**
mean Creative Intelligence can produce a production creative.

### Status after PRE-C2

```text
PRE-C2 technical mechanisms = COMPLETE
  (common Resource Resolver, FORMAT and FONT resolution, Brand Memory V1.1 expression_system mechanism, real font metrics,
   real shaping, Arabic / Bidi / RTL verification, deterministic rasterizer, real PNG path, sRGB PNG semantics)

HABB operational bindings / data = NOT COMPLETE
```

### What is explicitly NOT complete

```text
populated / approved HABB expression_system
HABB product binding
real approved HABB product asset
approved HABB claims
HABB font bindings
HABB Benchmark 001 execution
C2 providers (product segmentation / compositing, image generation / edit)
VLM Creative Critic
video
Creative Learning
```

### C2 - NOT READY

C2 provider bake-off and real provider execution are **DEFERRED until HABB CREATIVE BENCHMARK 001 is runnable and used**
(`NORDLA-DECISION-REGISTER.md` NDR-D02 clarification, `NORDLA-DEFERRED.md` L3-002 clarification). Blockers (`assessCreativeC2Readiness()`):

```text
1. production Socle Resource Resolver with FORMAT capability
2. Brand Memory V1.1 expression_system
3. real font metrics from real font files
4. real font shaping
5. Arabic / bidi / RTL verification
6. deterministic rasterizer
7. real PNG path
8. HABB CREATIVE BENCHMARK 001 runnable with real evidence / assets
```

CJK line breaking remains deferred and is not a C2 blocker. HABB CREATIVE BENCHMARK 001 stays configuration / benchmark data only
(status `NOT_RUN`). Next target: the PRE-C2 foundation patch.

## 0. Canonical documents audit (final architect audit)

All nine canonical documents were re-read in full against C1: `NORDLA-CANONICAL-ARCHITECTURE.md`, `NORDLA-DECISION-REGISTER.md`,
`NORDLA-DEFERRED.md`, `docs/principles/decision-principles.md`, `branding-v1-contract.md`, `marketing-v1-architecture.md`,
`marketing-m3-create-contract.md`, `activation-channel-execution-v1.md`, `provider-provisioning-live-connections-v1.md`.

| Decision | C1 |
|---|---|
| NDR-015 / NDR-014 / NDR-013 (Creative Intelligence separate from Marketing and Branding) | respected: Creative consumes a Marketing handoff by reference and writes nothing back |
| NDR-006 (no opaque universal score) | respected: no score anywhere; per-check and per-dimension statuses (a test refuses any score key) |
| NDR-007 (`NOT_MEASURABLE` is first-class) | respected: every gate has it; an unknown is never a pass |
| NDR-008 / NDR-011 / NDR-009 (deterministic numbers, bounded agents, policy outside the model) | respected: agents are untrusted until normalized; they cannot publish, schedule, price or decide |
| NDR-020 (HABB is configuration, not architecture) | respected: no merchant logic in the source (tested); fixtures are generic |
| NDR-D01 (no dynamic routing yet) / NDR-P16 (no private media sent externally without a gate) | respected: the provider registry is data and a filter, never a router; `cloud_provider_allowed` is false for personal / unclassified / unreleased media |
| NDR-P13 / NDR-P08 (routine compositing is Nordla-owned, least-cost engine) | respected: composition, layout, typography and render are deterministic Nordla code; no provider is integrated |
| Branding: hard rules, reference conventions (`asset://`, `claim://`...), Guardian owns brand compliance | respected after a fix (below); Creative does not evaluate brand compliance and does not touch Brand Memory |
| Marketing M3: the Brief carries no HOW; the handoff is `creative_brief` + creative brand interface | respected: the adapter reads references only |
| Activation / Provisioning (`READY_FOR_POLICY` is not publication; media transport is ephemeral) | respected: Creative publishes nothing and a resolved payload is never persisted |

**Finding recorded (not a design conflict).** `NORDLA-DEFERRED.md` L3-002 / NDR-D02 say Creative Intelligence is built "when the Marketing
brief contract is stable **and a real HABB campaign is used as benchmark**", and rule 3 asks for an explicit implementation decision when the
prerequisites are met. The Marketing brief contract is stable, `marketing-v1-architecture.md` names Creative Intelligence the next build
target, and the C1 mandate is the architect's explicit decision to start; but C1 is validated on **synthetic** fixtures only, so the
"real campaign benchmark" condition is **not met by C1**. It is carried forward as the entry condition of C2 provider work (the first real HABB campaign
is the benchmark), and the architect has since recorded the per-stage clarification in `NORDLA-DECISION-REGISTER.md` (NDR-D02) and `NORDLA-DEFERRED.md`
(L3-002), keeping the original condition.

**Two defects found by the audit and fixed** (neither is a redesign): (1) the reference validator refused every `scheme://` reference,
whereas Marketing and Branding identify resources as `asset://...`, `claim://...`, `category://...`, `format://...`; it now refuses only
transport schemes (`http(s)`, `ftp(s)`, `sftp`, `ssh`, `file`, `data`, `blob`, `ws(s)`, `javascript`, `mailto`, `tel`, `s3`, `gs`, `gcs`,
`drive`) and bare host paths; (2) the intake carried `product_refs`, but a real Marketing subject is `category://phone-cases`: the intake now
carries untyped `subject_refs`.

## 0.1 Real Marketing M3 to C1 intake

`buildIntakeFromHandoff({ handoff, deliverable_ref, resolved_format, created_at })` (`m3-intake.js`) is a tiny pure adapter over plain data; it
imports nothing from Marketing. It **copies references and pins**, reads no prose (`message_intent`, `cta_intent`, `brief_limitations` are
never touched - a test makes reading them throw), copies no business truth (no objective, audience, channels or statement), invents no
product identity, and preserves: `merchant_id`, `brand_id`, `brief_ref`, `deliverable_ref`, `subject_refs`, `source_asset_refs` (Brief and
deliverable), `claim_refs`, mandatory refs (Brief and deliverable), prohibited refs, `requirement_refs`, policy / consent / promotion refs,
`needed_by`, channel, placement, locale, `format_ref` and `content_kind`. The brand interface travels inside the handoff, so
`brand_context_ref` is the `handoff_id`. The canvas (width, height, unit `px`), medium, zones and production constraints come from the **resolved FORMAT** (the
common resolver's answer), never from the reference text; the aspect ratio is **derived** from the canvas; `channel` and `placement` stay
Marketing deliverable facts and cannot be stated by a format. A `TEXT` / `VIDEO` deliverable is refused (`CONTENT_KIND_UNSUPPORTED`), not converted. The integration
test (rows 256-278) builds the chain with the real Marketing and Branding builders (Finding, Push, Package, Authorization, Brand Context,
CreativeBrief, CreativeHandoffPackage) and compares field by field; Marketing M3 is not modified. Not enforced yet (recommended, not built):
a preflight check that a document uses no prohibited content and carries every mandatory content reference.

## 0.2 Resource resolution boundary

```text
resolve(ref, tenant)  ->  { ref, kind, merchant_id, version?, status, metadata? }
```

`resource-resolver.js` defines only the **boundary and its checks** - no registry, no database, no network. Creative never infers what a
reference names by reading the string (a test scans the source). The resolver's `kind` (`PRODUCT`, `COLLECTION`, `CATEGORY`,
`SUBJECT_OTHER`, `ASSET`, `CLAIM`, `FONT`, `FORMAT`) is authoritative; a reference the resolver does not know is `UNRESOLVED` (no kind),
never "probably a product"; a resource of another merchant is refused; only a font or a format may be platform-level; a URL / payload is not an
identity (refused before the resolver is asked) and metadata cannot carry a location. `resolveIntakeResources` reports `RESOLVED` only if every
reference is `ACTIVE` and of an expected kind; asset readiness is `NOT_MEASURABLE` without a resolution and `NOT_READY` for an unresolved,
revoked, expired, restricted or wrongly-typed asset. **The common Socle Resource Resolver that implements this boundary is an explicit PRE-C2 dependency.**

**FORMAT is a resource kind, not a second resolver.** It is resolved through that same resolver (there is no separate architectural Format
Resolver or Format Registry dependency). Its metadata is exactly:

```text
{ canvas: { width, height, unit }, medium, safe_zones, forbidden_zones, production_constraints }
```

C1 renders in `px` (another unit is refused, not converted). `aspect_ratio` is derived from the canvas by `CreativeOutputContext` (omitted it
is computed, supplied it must agree) and is never an independent source of truth.

## 0.3 Canonical reference vs resolved payload; structural vs resolved render

A `DesignDocument` stores canonical references (`asset://...`) and never `data:`, `blob:`, `http(s):` or `file:` (refused in every reference
position). A **trusted resolver** may hand the renderer an **ephemeral payload** (an inline image data URI) for one render; it appears in the
SVG projection only, never in the document, the structure, the text runs, the candidate or any reference. With no resolver an image points at
the symbolic `ref:<canonical ref>`.

**STRUCTURAL / UNRESOLVED render != RESOLVED render.** `renderDesignDocument` reports `render_mode`. It is `RESOLVED` only when every media
reference the render needs (a background image, a product, an image, a logo) was resolved by the trusted resolver into an ephemeral payload;
a missing, partial or merely symbolic (`ref:…`) answer leaves it `STRUCTURAL`, lists the `unresolved_asset_refs`, and labels the SVG itself
(`data-render-mode`). A structural SVG is for deterministic inspection and tests; it can never back a render-ready candidate
(`renderedAssetRefOf` and `normalizeCreativeCandidate` refuse it with `CI_RENDER_NOT_RESOLVED`; the candidate must state `render_mode:
RESOLVED`) and `renderPng` never rasterizes it. A document with no media to resolve has nothing unresolved. The payload never enters the
DesignDocument. Limit: the candidate's `render_mode` is stated by the trusted pipeline that rendered it; selection does not re-render.

## 0.4 Brand expression system - PRE-C2 dependency

C1 invents **no** brand expression: no colour literal, font family, style vocabulary, default canvas colour, default image fit, default
font family or default recipe exists in the source (tests scan for them; the canvas colour, image fit and font generic family are
required inputs; a layout recipe must be named by the caller). The recipes are neutral geometry primitives selected explicitly, not a
house style. **Brand Memory V1.1 `expression_system`** (photography, product_presentation, composition, layout_principles, illustration,
iconography, motion, locale_overrides) is a PRE-C2 dependency; Branding is **not** modified by this audit. There is no
fallback "AI style", no generic "premium" style, no hidden template default.

## 0.5 Typography / rasterization - C2 is blocked until

`assessCreativeC2Readiness()` lists them and answers `c2_allowed: false` until each has **issued evidence** (an object produced by this package's own
verifications; a string, a hand-made object or evidence of another dependency is refused): **the common resource resolver (with
FORMAT capability), brand expression system, real font metrics from real font files, real shaping for complex scripts, Arabic / bidi / RTL
verification, a deterministic rasterizer, a real PNG render path, a real campaign benchmark**. CJK line breaking is documented as DEFERRED (not claimed, not blocking).
The PRE-C2 patch implements the capabilities (`socle-resource-resolver-v1.md`, `creative-pre-c2-foundation.md`): production typography exists
(`production.js`, real fonts, shaping, bidi, glyph-path SVG, resvg PNG) and `typography_production_ready` is derived from the three typography
verifications. The declared-metrics typography stays an inspection mode (`typography_mode: DECLARED_METRICS`) and can never produce a PNG.
`BRAND_EXPRESSION_SYSTEM` and `REAL_CAMPAIGN_BENCHMARK` need real HABB data (an approved expression system, the product binding and photo, approved claims, font bindings, and the benchmark run) and stay open: `c2_allowed` is `false`.

## 0.6 L3-002 / NDR-D02 and HABB CREATIVE BENCHMARK 001

C1 foundation may close.
C2 provider work remains blocked until a real HABB campaign benchmark exists.

The canonical register and deferred list carry the explicit clarification (a test guards it and guards that the original condition is kept). The architect-selected benchmark is **HABB CREATIVE BENCHMARK 001**:
a personalized phone case, price 25 €, promise "5 minutes", primary channel Instagram Feed, primary canvas 1080 x 1350. It lives as
**configuration data only** in `benchmarks/creative-intelligence/habb-creative-benchmark-001.json` (status `NOT_RUN`) and no generic Creative
source contains any of it (tested). Its requirements: real product asset, exact product preservation, exact approved price (25 €), exact
approved claim (5 minutes), exact critical text, brand expression compliance, no generic style fallback, deterministic typography, preflight
PASS, Fidelity gate, Guardian gate. The file lists what is still missing to run it (the real product asset and its resolution, the approved claim
references, the Brand Memory V1.1 `expression_system`, the resolved FORMAT).

## 1. What C1 builds (and what it does not)

Built: creative intake contract (and the real M3 handoff adapter), resource resolution boundary, pre-C2 readiness, · `CreativeOutputContext` · Asset Readiness · `ProductUnderstandingPackage` · `CreativeDirection` ·
`DesignDocument` V1 (+ layers, revisions, locks) · Layout Recipes V1 · Layout Constraint Engine V1 · Typography engine (measure, line
break, fit) · deterministic SVG renderer · Preflight V1 (18 deterministic checks) · Creative Quality **contract** · `CreativeCandidate` V1
· hard-gate selection V1 · Provider Capability Registry **contract** · six agent **interfaces** with fakes and a trust boundary.

Not built (by mandate): any real image-model, Photoroom-class, LLM or video call · a WYSIWYG editor · Creative Learning · publishing ·
print pre-press / PDF-X · a trained layout model · C2–C5 below.

## 2. Final tree (the mandate's tree; C1 covers C0, C1, C3, C5, C6-contract, C7, C10-contract and the agent interfaces of C2 / C4)

```text
NORDLA CREATIVE INTELLIGENCE
├── C0  Creative intake & trust boundary          BUILT  intake.js, output-context.js
├── C1  Creative understanding                    BUILT  asset-readiness.js, product-understanding.js (metadata only)
├── C2  Creative direction                        CONTRACT + agent interface  creative-direction.js, agents.js
├── C3  DesignDocument / scene graph              BUILT  design-document.js, layers.js
├── C4  Production lanes                          INTERFACES ONLY (copy, visual production) — no live lane
├── C5  Deterministic composition                 BUILT  layout-recipes.js, layout-engine.js, typography.js, renderer.js
├── C6  Quality / efficiency hub                  PREFLIGHT BUILT, VLM critique = CONTRACT  preflight.js, creative-quality.js
├── C7  Candidate selection                       BUILT (hard gates)  candidate.js, selection.js
├── C8  ADAPT / REFINE / REUSE                    PARTIAL: derivation + revision chain in DesignDocument; reuse lookup = contract
├── C9  Human editing                             DEFERRED (the DesignDocument is the editable representation)
├── C10 Provider capability registry              CONTRACT  provider-registry.js
└── C11 Creative learning                         NOT BUILT
THEN: Creative Fidelity → Brand Guardian → Activation   (none of them is touched here)
```

## 3. Agents vs deterministic engines

Six agents (interfaces + normalizers + fakes in `agents.js`; **no live model call exists**): Creative Orchestrator · Product & Asset Analyst ·
Creative Director · Copy & Claims Agent · Visual Production Director · Creative Critic.

Never agents (deterministic code): DesignDocument validator · Layout Constraint Engine · Typography engine · Renderer · Product
compositor (placement of existing pixels) · Preflight gates · Provider registry · hard-gate selector. Creative Fidelity, Brand Guardian
and Activation stay what they are.

**Trust boundary:** `model output → adapter → plain-JSON check → normalize → validate → immutable domain object`. An output carrying a
function, a class instance, an unknown key, a provider prompt / model / seed, an unapproved claim, or a verdict that belongs to another
module is refused, and the error never echoes the value. An agent cannot publish, schedule, choose a channel / audience / budget / price,
or recompute a Marketing decision (those keys are refused).

## 4. DesignDocument V1

Top level (closed): `document_id · version · merchant_id · brand_id · brief_ref · direction_ref · output_context · canvas · layers ·
constraints · asset_refs · claim_refs · provenance · created_at`. `document_id` is derived from the content (any edit → new id); `version`
and `provenance.parent_document_ref` chain the revisions (`CREATE / ADAPT / REFINE / REUSE`). Locked layers cannot be modified or removed
by a revision. No provider secret, raw media byte or URL can be canonical truth: every asset / font / claim is an **opaque reference**
(a URL, host path, `data:` / `blob:` / `file:` location is refused).

Layers (closed, deep-frozen): `BACKGROUND · PRODUCT · IMAGE · TEXT · SHAPE · LOGO · GROUP`, each with `id · type · z_index · geometry ·
visibility · locked · source_ref? · constraints · effects · provenance`.

**Text layer** — `content · font_ref · font_size · min_font_size · line_height · tracking · alignment (START/CENTER/END, logical) ·
max_lines · color · box · overflow_policy (FAIL / REWRITE_REQUIRED / RELAYOUT_REQUIRED) · locale · direction`, plus the claim basis:
`text_kind` is `CLAIM_BEARING` (needs an approved `claim_ref` **and** the digest of the approved wording) or `NON_CLAIM_CREATIVE_TEXT`
(no number, price, currency or percentage). `PRICE` and `LEGAL` roles are always claim-bearing. A price changed after approval fails the
digest. There is no free factual path.

**Product layer** — `product_ref · asset_ref · preservation_mode · protected_regions · allow_crop / relight / shadow / rotation`. The C1
renderer **places existing pixels**: it never redraws, relights, recolours or stretches a product (`preserveAspectRatio="meet"`; the only
filter a product can receive is its cast shadow). `PIXEL_PRESERVE` and `COMPOSITE` are renderable; `CONTROLLED_EDIT` and
`GENERATIVE_REFERENCE` are contract modes for later lanes (they need a justification reference and are refused by the renderer).

## 5. Layout, typography, renderer

- **Recipes** (`PRODUCT_HERO`, `EDITORIAL_SPLIT`, `TEXT_LED`, `PRODUCT_AND_PRICE`) are declarative: slots as fractions of the usable area.
  Slots of a recipe never overlap (tested), so the product and the text cannot collide by construction. `EDITORIAL_SPLIT` mirrors for RTL.
- **Layout Constraint Engine** — usable rectangle = canvas − margin − negative space, inside the largest safe zone, minus forbidden
  zones (largest remaining rectangle); products / logos are fitted by their **real aspect ratio**; text is fitted by shrinking one pixel
  at a time, **never below `min_font_size`**; constraints (`MIN_MARGIN`, `NO_OVERLAP`, `ABOVE`, `BELOW`, `ALIGN_CENTER_X`,
  `WITHIN_SAFE_ZONE`) are verified; whatever does not fit is **reported** (`TEXT_DOES_NOT_FIT` + the layer's overflow policy), never hidden.
  The result is a **new revision** of the document. Locked / hidden layers are not moved.
- **Typography** — exact measurement from declared font metrics (advance widths), greedy word-boundary line breaking (a word is never
  broken), explicit baselines, logical alignment resolved against the text direction.
- **Renderer** — pure function: same document + fonts + asset resolver → same bytes. Text is real SVG `<text>` from the document;
  XML-escaped; the rendered characters are asserted equal to the approved characters. `<image>` locations are restricted to inline
  raster `data:` URIs and symbolic `asset:` references.

## 6. Preflight V1

Outcome per check and overall: `PASS / REVIEW_REQUIRED / FAIL / NOT_MEASURABLE`; precedence `FAIL > REVIEW_REQUIRED > NOT_MEASURABLE > PASS`.
**No aesthetic numeric score.** The report is a pure function of `(document, explicit context)`; the selector recomputes it and refuses a
stored report that differs. The thirteen mandate checks come first, in a fixed order: `TEXT_OVERFLOW · TEXT_BELOW_MIN_SIZE ·
LAYER_OUT_OF_BOUNDS · SAFE_ZONE_VIOLATION · FORBIDDEN_ZONE_OVERLAP · PRODUCT_TEXT_COLLISION · MISSING_ASSET_REF · MISSING_FONT_REF ·
MISSING_CLAIM_REF · DUPLICATE_LAYER_ID · INVALID_Z_ORDER · INSUFFICIENT_CONTRAST · OUTPUT_DIMENSION_MISMATCH`. Additional integrity
checks: `TEXT_CONTENT_CHANGED · FONT_SCRIPT_UNSUPPORTED · PRODUCT_ASPECT_MISMATCH · GROUP_MEMBER_MISSING · CONSTRAINT_VIOLATION ·
TEXT_LAYER_OVERLAP`.

Whatever the context does not provide stays `NOT_MEASURABLE`: no font registry → overflow cannot be measured; no approved-claim list →
claims cannot be confirmed; a text over an image or a translucent layer → contrast is not measurable; a complex script (Arabic) with an
advance-table-only font → overflow is not measurable (an `EXACT`-shaping font is required to claim a fit).

Quality contract (`creative-quality.js`): ten dimensions (`composition · hierarchy · balance · spacing · readability · product_prominence ·
visual_clutter · artifact_risk · premium_credibility · channel_fit`), each `PASS / REVIEW_REQUIRED / NOT_MEASURABLE` with reason codes and
evidence references; an unassessed dimension is `NOT_MEASURABLE`; any score / rank / rating key is refused. No VLM is integrated.

## 7. Candidate and selection

A `CreativeCandidate` holds the document, the reference of its render (`render:<sha256>`), its preflight report, an optional quality
report and provenance. It **cannot claim** a Brand Guardian / Creative Fidelity / publishing verdict (those keys are refused) and it is
**not** Marketing's `SelectedCreativeCandidate` (that is built after a selection and an approval, outside C1). Selection is **hard gates
only**: recompute the preflight → remove every `FAIL` → expose the rest in `candidate_id` order (a stable order, stated as *not a ranking*).
A `REVIEW_REQUIRED` / `NOT_MEASURABLE` candidate stays that way (`needs_review`); several eligible candidates set `human_choice_required`.

## 8. Provider neutrality

`provider-registry.js` is a **contract**: capabilities (`IMAGE_GENERATE · IMAGE_EDIT · IMAGE_BACKGROUND · IMAGE_VECTOR · PRODUCT_SEGMENT ·
PRODUCT_RELIGHT · VIDEO_GENERATE · VIDEO_EDIT · VOICE · STT`), regions, the most sensitive input class the provider may receive,
commercial-rights / cost-model / benchmark **references**, latency class, health. Rank, score, priority, default, preferred, winner and
weight are **refused**; selecting = filtering by capability / privacy / region / health, returned in `provider_id` order. No vendor or
model name appears anywhere in the source (tested). Later stages (C2) benchmark current Western and Asian systems and fill the registry
with evidence.

## 9. Honest limitations (stated, not hidden)

- **Font metrics are declared, not read from font files.** Measurement is exact *with respect to the registry*; the metrics must be
  generated from the real font. Fixtures use synthetic metrics. A later step must prove parity with a real font renderer.
- **SVG names fonts, it does not embed them.** The family must exist where the SVG is viewed or rasterized.
- **PNG is not produced in this runtime** (no rasterizer ships). `renderPng` takes an injected rasterizer and otherwise answers
  `{ supported: false }`; it never fabricates an image.
- **Arabic / complex scripts:** direction, logical alignment and the RTL mirrored recipe are supported; exact measurement of joined
  scripts is not (NOT_MEASURABLE unless the font declares `EXACT` shaping). CJK line breaking (no spaces) is not implemented.
- **Contrast** is measured only against solid, opaque backdrops (canvas colour, solid background / shape).
- **Rotation** is handled through the rotated bounding box (an approximation for collision tests).
- **Shapes** are rendered but not placed by recipes (a CTA button behind a text is positioned by the caller).
- **Asset readiness is metadata-only**: no pixel is read, nothing is segmented, nothing is sent to a provider.
- **Print** (bleed, CMYK, PDF/X) is out of scope: `CreativeOutputContext` carries no ICC / pre-press fields.

## 10. Dependencies and coupling

Imports from outside `src/creative-intelligence/` are limited to three pure shared helpers (the M3 adapter imports nothing from Marketing): `marketing/understand-validation.js`
(`deepFreeze`, `deriveId`, `localeValue`), `marketing/m2-validation.js` (`canonical`) and the `CONTENT_KIND` constant of `branding/constants.js`
(tested). No new npm dependency. No Marketing M1–M4, Branding, Creative Fidelity, Activation, Provider Connections or Finance file is modified.

## 11. After C1 (do not build yet)

C2: provider benchmark harness, product segmentation / compositing, background generation, image editing, real adapters, cost / latency /
quality evidence. C3: VLM Creative Critic, pairwise review, ADAPT / REFINE / REUSE. C4: video, real-world content / highlights.
C5: Creative Learning from M4 evidence (OBSERVED / ATTRIBUTED / INCREMENTAL).

## 12. Coverage matrix

Every row is a behaviour the mandate (rows 1-255) or the final architect audit (rows 256 and up) asks to prove; each carries a `// N` marker in the named test, and the test
`Coverage matrix: ...` verifies that all rows exist, are contiguous and point at a real test.

<!-- coverage-matrix:start -->
| # | Behaviour | Test |
|---|---|---|
| 1 | a valid intake is normalized and deep-frozen | creative-intelligence-contracts.test.js › Creative intake: references only, closed schema, explicit clock, deep-frozen and deterministic |
| 2 | the intake id is derived from the content and deterministic | creative-intelligence-contracts.test.js › Creative intake: references only, closed schema, explicit clock, deep-frozen and deterministic |
| 3 | an unknown key is refused | creative-intelligence-contracts.test.js › Creative intake: references only, closed schema, explicit clock, deep-frozen and deterministic |
| 4 | a provider prompt / model key is refused | creative-intelligence-contracts.test.js › Creative intake: references only, closed schema, explicit clock, deep-frozen and deterministic |
| 5 | a URL can never be an asset reference | creative-intelligence-contracts.test.js › Creative intake: references only, closed schema, explicit clock, deep-frozen and deterministic |
| 6 | identifiers are validated (merchant UUID, brief reference) | creative-intelligence-contracts.test.js › Creative intake: references only, closed schema, explicit clock, deep-frozen and deterministic |
| 7 | an intake may carry no source asset (the readiness report then says NO_ASSETS) | creative-intelligence-contracts.test.js › Creative intake: references only, closed schema, explicit clock, deep-frozen and deterministic |
| 8 | a free-text claim is not a claim reference | creative-intelligence-contracts.test.js › Creative intake: references only, closed schema, explicit clock, deep-frozen and deterministic |
| 9 | the clock is explicit and carries an offset | creative-intelligence-contracts.test.js › Creative intake: references only, closed schema, explicit clock, deep-frozen and deterministic |
| 10 | an intake needs a subject reference or an approved claim reference, and no content can be both mandatory and prohibited | creative-intelligence-contracts.test.js › Creative intake: references only, closed schema, explicit clock, deep-frozen and deterministic |
| 11 | a valid output context is normalized | creative-intelligence-contracts.test.js › Output context: canvas, aspect ratio, zones, locale / direction and unsupported kinds |
| 12 | the aspect ratio must follow from the canvas | creative-intelligence-contracts.test.js › Output context: canvas, aspect ratio, zones, locale / direction and unsupported kinds |
| 13 | VIDEO and TEXT are not expressible by C1 | creative-intelligence-contracts.test.js › Output context: canvas, aspect ratio, zones, locale / direction and unsupported kinds |
| 14 | canvas bounds are enforced | creative-intelligence-contracts.test.js › Output context: canvas, aspect ratio, zones, locale / direction and unsupported kinds |
| 15 | a zone must lie inside the canvas | creative-intelligence-contracts.test.js › Output context: canvas, aspect ratio, zones, locale / direction and unsupported kinds |
| 16 | zones are validated and their ids are unique across safe and forbidden zones | creative-intelligence-contracts.test.js › Output context: canvas, aspect ratio, zones, locale / direction and unsupported kinds |
| 17 | the direction must agree with the locale | creative-intelligence-contracts.test.js › Output context: canvas, aspect ratio, zones, locale / direction and unsupported kinds |
| 18 | a viewing distance only exists for a PHYSICAL output | creative-intelligence-contracts.test.js › Output context: canvas, aspect ratio, zones, locale / direction and unsupported kinds |
| 19 | an unknown key is refused and production constraints are tokens | creative-intelligence-contracts.test.js › Output context: canvas, aspect ratio, zones, locale / direction and unsupported kinds |
| 20 | the context is deep-frozen and its zones are in a stable order | creative-intelligence-contracts.test.js › Output context: canvas, aspect ratio, zones, locale / direction and unsupported kinds |
| 21 | a sufficient, owned, classified product with a cut-out is READY | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 22 | an asset that needs an upscale is PARTIAL | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 23 | an asset far below the target is NOT_READY | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 24 | restricted rights are NOT_READY | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 25 | unknown rights are PARTIAL, never READY | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 26 | unknown dimensions are NOT_MEASURABLE | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 27 | an unclassified privacy class is NOT_MEASURABLE | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 28 | a product with no cut-out information is NOT_MEASURABLE | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 29 | a product that needs a cut-out is PARTIAL | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 30 | no assets at all is NOT_READY (NO_ASSETS) | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 31 | aggregation precedence: NOT_READY > NOT_MEASURABLE > PARTIAL > READY | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 32 | personal, restricted, unclassified or unreleased media is not allowed to reach a cloud provider by default | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 33 | the same asset reference twice is refused | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 34 | the reuse lookup is a contract: references and provenance only, and it answers its own request | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 35 | the report id is derived, the report is deep-frozen and an unknown key is refused | creative-intelligence-contracts.test.js › Asset readiness: metadata-only verdicts, honest unknowns, stated aggregation |
| 36 | a valid package is normalized | creative-intelligence-contracts.test.js › Product understanding: preservation modes, protected regions and the commerce default |
| 37 | PIXEL_PRESERVE forbids crop, relight and rotation | creative-intelligence-contracts.test.js › Product understanding: preservation modes, protected regions and the commerce default |
| 38 | COMPOSITE places the original pixels: no relight | creative-intelligence-contracts.test.js › Product understanding: preservation modes, protected regions and the commerce default |
| 39 | CONTROLLED_EDIT needs a justification and protected regions | creative-intelligence-contracts.test.js › Product understanding: preservation modes, protected regions and the commerce default |
| 40 | GENERATIVE_REFERENCE needs a justification as well | creative-intelligence-contracts.test.js › Product understanding: preservation modes, protected regions and the commerce default |
| 41 | a logo / packaging-text region must be covered by a protected region | creative-intelligence-contracts.test.js › Product understanding: preservation modes, protected regions and the commerce default |
| 42 | regions are fractions that stay inside the asset | creative-intelligence-contracts.test.js › Product understanding: preservation modes, protected regions and the commerce default |
| 43 | the same region id twice is refused | creative-intelligence-contracts.test.js › Product understanding: preservation modes, protected regions and the commerce default |
| 44 | the orientation defaults to UNKNOWN and is a closed set | creative-intelligence-contracts.test.js › Product understanding: preservation modes, protected regions and the commerce default |
| 45 | the package id is derived, the package is deep-frozen and an unknown key is refused | creative-intelligence-contracts.test.js › Product understanding: preservation modes, protected regions and the commerce default |
| 46 | a valid direction is normalized and deep-frozen | creative-intelligence-contracts.test.js › Creative direction: intent as enums, never a provider prompt; distinct directions |
| 47 | a provider prompt, model or seed is refused anywhere in the input | creative-intelligence-contracts.test.js › Creative direction: intent as enums, never a provider prompt; distinct directions |
| 48 | an unknown key is refused | creative-intelligence-contracts.test.js › Creative direction: intent as enums, never a provider prompt; distinct directions |
| 49 | hierarchy rules: no repeated role, a HERO needs the product in it, an absent product cannot be ranked | creative-intelligence-contracts.test.js › Creative direction: intent as enums, never a provider prompt; distinct directions |
| 50 | a forged direction id is refused | creative-intelligence-contracts.test.js › Creative direction: intent as enums, never a provider prompt; distinct directions |
| 51 | the spatial intent is a closed set | creative-intelligence-contracts.test.js › Creative direction: intent as enums, never a provider prompt; distinct directions |
| 52 | the negative-space intent is a closed set | creative-intelligence-contracts.test.js › Creative direction: intent as enums, never a provider prompt; distinct directions |
| 53 | the same direction twice is not a second candidate | creative-intelligence-contracts.test.js › Creative direction: intent as enums, never a provider prompt; distinct directions |
| 54 | two directions with the same concept and spatial intent are not distinct | creative-intelligence-contracts.test.js › Creative direction: intent as enums, never a provider prompt; distinct directions |
| 55 | references are opaque: a URL is refused | creative-intelligence-contracts.test.js › Creative direction: intent as enums, never a provider prompt; distinct directions |
| 56 | a valid document is built and deep-frozen | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 57 | document_id is derived from the content | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 58 | a forged document_id is refused | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 59 | an unknown top-level key is refused | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 60 | an unknown layer key is refused | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 61 | layers are stored in canonical order (z_index, then id) | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 62 | a URL cannot be a layer source | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 63 | a URL cannot be a document reference | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 64 | raw media (a data URI) cannot be canonical truth | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 65 | a provider secret or a provider parameter has no place in the document | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 66 | version is a positive integer | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 67 | a revision bumps the version and chains to its parent | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 68 | an ADAPT / REFINE / REUSE document names its parent | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 69 | a locked layer cannot be modified by a revision | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 70 | a locked layer cannot be removed by a revision | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 71 | a duplicate layer id is structurally accepted and reported by the preflight (not thrown mid-iteration) | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 72 | the layer count is bounded | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 73 | the canvas is validated and its colour is normalized to #RRGGBB | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 74 | a document-level constraint names its subject | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 75 | constraint kinds are closed and their parameters are checked | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 76 | effects are closed and bounded | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 77 | geometry is finite and has a positive size | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 78 | a group lists its members | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 79 | the provenance names this contract version | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 80 | normalizing a normalized document returns the same document | creative-intelligence-document.test.js › DesignDocument: a closed, content-addressed, versioned scene graph |
| 81 | the content is preserved exactly (NFC-normalized, nothing trimmed or altered) | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 82 | claim-bearing text needs a claim reference | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 83 | claim-bearing text needs the digest of the approved wording | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 84 | a price that changed after approval is refused | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 85 | non-claim text cannot carry a claim reference or a digest | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 86 | non-claim text cannot contain a number | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 87 | non-claim text cannot contain a currency sign or a percentage | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 88 | a PRICE text must be claim-bearing | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 89 | a LEGAL text must be claim-bearing | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 90 | decorative text cannot carry a claim | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 91 | decorative, non-factual text is allowed without any claim | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 92 | a text layer must say what it is: there is no free factual path | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 93 | whitespace that could not survive rendering is refused (tab, double space, padding, empty) | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 94 | font sizes are bounded | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 95 | max_lines is a bounded integer | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 96 | the overflow policy is one of FAIL / REWRITE_REQUIRED / RELAYOUT_REQUIRED | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 97 | alignment is logical (START / CENTER / END), never LEFT / RIGHT | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 98 | the locale is normalized | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 99 | the direction is LTR or RTL | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 100 | a text layer has no source reference and no unknown key | creative-intelligence-document.test.js › Text layers: the characters are the approved characters; fact-bearing text always has a claim basis |
| 101 | a valid product layer is normalized | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 102 | PIXEL_PRESERVE forbids relighting | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 103 | PIXEL_PRESERVE forbids rotation and cropping | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 104 | COMPOSITE forbids relighting | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 105 | a rotated product needs allow_rotation | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 106 | a shadow needs allow_shadow | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 107 | an opacity change on a product is refused (it would alter how its pixels read) | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 108 | a product is sourced through asset_ref, not source_ref | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 109 | protected regions are fractions inside the asset | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 110 | the renderer scales the product uniformly ("meet") and never stretches it | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 111 | CONTROLLED_EDIT and GENERATIVE_REFERENCE layers cannot be rendered by C1 | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 112 | the product pixels are untouched: the only filter ever applied to a product is its cast shadow | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 113 | a product asset that the document does not declare is reported by the preflight | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 114 | a box whose proportions differ from the real asset is flagged for review (the renderer letterboxes, it never stretches) | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 115 | an asset whose size is unknown cannot be checked: NOT_MEASURABLE, never PASS | creative-intelligence-document.test.js › Product layers: the real product pixels are placed, never mutated |
| 116 | with no zone the usable area is the canvas minus the margin | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 117 | a safe zone restricts the usable area (the largest safe zone, intersected with the margins) | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 118 | a forbidden zone is carved out of the usable area (the biggest remaining rectangle) | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 119 | forbidden zones that leave nothing make the layout unsatisfiable | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 120 | margins that push the usable area out of the only safe zone make it unsatisfiable | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 121 | negative space TOP is reserved at the top | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 122 | negative space START / END follow the reading direction (START is the right edge in RTL) | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 123 | SURROUNDING negative space shrinks every side | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 124 | a MIN_MARGIN constraint raises the margin the solver uses | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 125 | NO_OVERLAP is evaluated | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 126 | ABOVE / BELOW are evaluated | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 127 | ALIGN_CENTER_X is evaluated | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 128 | WITHIN_SAFE_ZONE is evaluated against the output context | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 129 | a constraint whose target does not exist is reported, not ignored | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 130 | a hidden layer is not constrained | creative-intelligence-layout.test.js › Usable area: margins, safe zones, forbidden zones and negative space - all deterministic |
| 131 | four generic recipes exist (closed set) | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 132 | every slot is a fraction of the usable area (0..1) and carries no merchant, font or colour | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 133 | the slots of a recipe never overlap (collisions are excluded by construction) | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 134 | same input -> same output (document id included) | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 135 | the demo layout is solved with no violation | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 136 | the product keeps its real aspect ratio (800 x 1000 -> 0.8) | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 137 | the logo keeps its aspect ratio (600 x 200 -> 3) and sits on the start edge | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 138 | every text is inside its slot and never below its minimum size | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 139 | a text that is too big is shrunk to fit - and only down to its minimum | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 140 | a text that cannot fit even at its minimum is reported with its overflow policy and stays at the minimum | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 141 | a locked layer is never moved | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 142 | a hidden layer is skipped | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 143 | a second layer for the same role is not placed (reported, not silently stacked) | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 144 | an unknown recipe is refused | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 145 | a missing font is reported as a violation | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 146 | EDITORIAL_SPLIT is mirrored for a right-to-left output | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 147 | the solver returns a NEW revision (version + 1, chained, produced by the engine) | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 148 | the input document is not mutated | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 149 | EDITORIAL_SPLIT puts the product and the text in opposite halves with no collision | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 150 | an asset whose size is unknown is placed in its box with an ASPECT_UNKNOWN note | creative-intelligence-layout.test.js › Layout recipes are declarative; the solver places layers deterministically and honestly |
| 151 | the same document renders to the same bytes | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 152 | critical text is rendered exactly as written (the price included) | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 153 | XML special characters in a text are escaped, never interpreted | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 154 | the output has no script, no foreignObject and no event handler | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 155 | an asset resolver cannot point an image at a remote or script location | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 156 | by default an image points at the symbolic canonical reference (the renderer never parses it) | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 157 | a hidden layer - and the members of a hidden group - are not rendered | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 158 | layers are drawn in z order | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 159 | numbers are formatted stably (no -0, at most three decimals) | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 160 | right-to-left text carries its direction and a logical anchor | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 161 | a text whose font is not registered cannot be rendered | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 162 | without a rasterizer a PNG is honestly unsupported - never a fake image | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 163 | an injected rasterizer's output must really be a PNG | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 164 | the render reports its structure and its text runs | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 165 | a background image fills the canvas (slice) and an image can contain or cover its box | creative-intelligence-layout.test.js › Renderer: a pure, deterministic projection of the document |
| 166 | a text that does not fit fails, and the remediation is the layer's own overflow policy | creative-intelligence-preflight.test.js › Preflight text gates: overflow, minimum size |
| 167 | an overflow cannot silently pass, whatever its policy | creative-intelligence-preflight.test.js › Preflight text gates: overflow, minimum size |
| 168 | a text rendered below its minimum size fails | creative-intelligence-preflight.test.js › Preflight text gates: overflow, minimum size |
| 169 | a layer outside the canvas fails - a background may bleed | creative-intelligence-preflight.test.js › Preflight geometry gates: bounds, safe zones, forbidden zones, collisions |
| 170 | content outside every safe zone fails | creative-intelligence-preflight.test.js › Preflight geometry gates: bounds, safe zones, forbidden zones, collisions |
| 171 | critical content over a forbidden zone fails | creative-intelligence-preflight.test.js › Preflight geometry gates: bounds, safe zones, forbidden zones, collisions |
| 172 | a product overlapping a text fails | creative-intelligence-preflight.test.js › Preflight geometry gates: bounds, safe zones, forbidden zones, collisions |
| 173 | an asset the document does not declare - or the catalogue does not hold - fails | creative-intelligence-preflight.test.js › Preflight reference gates: assets, fonts, claims, ids, z-order |
| 174 | an unregistered font fails; no registry at all cannot be measured | creative-intelligence-preflight.test.js › Preflight reference gates: assets, fonts, claims, ids, z-order |
| 175 | a claim the document does not declare, or the Brief did not approve, fails; without the approved list it is NOT_MEASURABLE | creative-intelligence-preflight.test.js › Preflight reference gates: assets, fonts, claims, ids, z-order |
| 176 | a repeated layer id fails | creative-intelligence-preflight.test.js › Preflight reference gates: assets, fonts, claims, ids, z-order |
| 177 | two visible layers on the same z_index, or a background above the content, fail | creative-intelligence-preflight.test.js › Preflight reference gates: assets, fonts, claims, ids, z-order |
| 178 | low contrast fails (WCAG: 4.5 for small text, 3 for large text) | creative-intelligence-preflight.test.js › Preflight contrast and output gates |
| 179 | over an image the backdrop is unknown: NOT_MEASURABLE, never PASS; over a solid shape it is measured | creative-intelligence-preflight.test.js › Preflight contrast and output gates |
| 180 | a canvas that differs from the output context fails | creative-intelligence-preflight.test.js › Preflight contrast and output gates |
| 181 | the thirteen mandate checks are always present, in a fixed order | creative-intelligence-preflight.test.js › Preflight report: complete, ordered, never an optimistic default, no score |
| 182 | overall precedence: FAIL > REVIEW_REQUIRED > NOT_MEASURABLE > PASS | creative-intelligence-preflight.test.js › Preflight report: complete, ordered, never an optimistic default, no score |
| 183 | with no context at all nothing is reported as a pass: unknowns stay NOT_MEASURABLE | creative-intelligence-preflight.test.js › Preflight report: complete, ordered, never an optimistic default, no score |
| 184 | the report is a pure function of its inputs, derived-id and deep-frozen | creative-intelligence-preflight.test.js › Preflight report: complete, ordered, never an optimistic default, no score |
| 185 | a complex script is NOT_MEASURABLE with an advance-table font and measured with an exact-shaping font | creative-intelligence-preflight.test.js › Preflight report: complete, ordered, never an optimistic default, no score |
| 186 | a script the font does not cover fails | creative-intelligence-preflight.test.js › Preflight report: complete, ordered, never an optimistic default, no score |
| 187 | a claim-bearing text that differs from the approved wording fails | creative-intelligence-preflight.test.js › Preflight report: complete, ordered, never an optimistic default, no score |
| 188 | a violated constraint fails | creative-intelligence-preflight.test.js › Preflight report: complete, ordered, never an optimistic default, no score |
| 189 | two texts (or a logo and a text) that overlap fail | creative-intelligence-preflight.test.js › Preflight report: complete, ordered, never an optimistic default, no score |
| 190 | the report carries no numeric aesthetic score of any kind | creative-intelligence-preflight.test.js › Preflight report: complete, ordered, never an optimistic default, no score |
| 191 | a candidate holds the document, the reference of its render and its preflight report | creative-intelligence-preflight.test.js › Creative candidate: facts about the pipeline, never another module\'s verdict |
| 192 | the candidate id is derived; a forged one is refused | creative-intelligence-preflight.test.js › Creative candidate: facts about the pipeline, never another module\'s verdict |
| 193 | a candidate cannot claim a Brand Guardian / Creative Fidelity verdict, nor be marked published | creative-intelligence-preflight.test.js › Creative candidate: facts about the pipeline, never another module\'s verdict |
| 194 | a candidate cannot carry a score, a rank or a winner flag | creative-intelligence-preflight.test.js › Creative candidate: facts about the pipeline, never another module\'s verdict |
| 195 | the candidate and its document must belong together (merchant, brand, brief, direction) | creative-intelligence-preflight.test.js › Creative candidate: facts about the pipeline, never another module\'s verdict |
| 196 | a report (preflight or quality) of another document is refused | creative-intelligence-preflight.test.js › Creative candidate: facts about the pipeline, never another module\'s verdict |
| 197 | a preflight report whose id does not follow from its content is refused | creative-intelligence-preflight.test.js › Creative candidate: facts about the pipeline, never another module\'s verdict |
| 198 | a candidate whose preflight FAILS cannot be selected | creative-intelligence-preflight.test.js › Selection: hard gates only - no winner, no score, nothing promoted |
| 199 | a PASS candidate is exposed | creative-intelligence-preflight.test.js › Selection: hard gates only - no winner, no score, nothing promoted |
| 200 | a REVIEW_REQUIRED candidate stays REVIEW_REQUIRED and is flagged for review - it is never promoted to PASS | creative-intelligence-preflight.test.js › Selection: hard gates only - no winner, no score, nothing promoted |
| 201 | a stored report that differs from the one recomputed now is refused (a stored report is never an authority) | creative-intelligence-preflight.test.js › Selection: hard gates only - no winner, no score, nothing promoted |
| 202 | there is no winner, no score and no ranking in the answer | creative-intelligence-preflight.test.js › Selection: hard gates only - no winner, no score, nothing promoted |
| 203 | several eligible candidates require a human choice; a single one does not | creative-intelligence-preflight.test.js › Selection: hard gates only - no winner, no score, nothing promoted |
| 204 | when nothing is eligible the answer says so | creative-intelligence-preflight.test.js › Selection: hard gates only - no winner, no score, nothing promoted |
| 205 | candidates of different merchants / briefs, duplicates and an empty list are refused | creative-intelligence-preflight.test.js › Selection: hard gates only - no winner, no score, nothing promoted |
| 206 | a valid entry is normalized and deep-frozen | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 207 | capabilities are a closed set (video and voice exist as contract values, anything else is refused) | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 208 | a rank, priority, default, preference or winner is refused | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 209 | no default and no winner: every qualifying provider is returned, in provider_id order | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 210 | an input more sensitive than the provider's class is filtered out | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 211 | the region filter applies when asked | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 212 | an UNAVAILABLE provider is excluded, a DEGRADED one only when allowed | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 213 | the same provider id twice is refused | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 214 | commercial rights and cost model are required opaque references | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 215 | benchmarks are references to evidence, not numbers | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 216 | the registry performs no network access (the source has no network primitive) | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 217 | the registry and its entries are immutable | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 218 | an unknown key is refused | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 219 | an empty registry is valid and qualifies nobody | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 220 | no provider or model name is hardcoded anywhere in the Creative Intelligence source | creative-intelligence-contracts.test.js › Provider registry: capabilities and conditions as data - never a ranking, a default or a vendor |
| 221 | the six C1 roles exist and nothing else | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 222 | a handler's output becomes an immutable domain object | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 223 | a function inside the output is refused | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 224 | a class instance (not plain data) is refused | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 225 | an unknown role is refused | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 226 | a failing handler becomes AGENT_FAILED and its message is not echoed | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 227 | a director output carrying a provider prompt is refused | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 228 | the copy agent cannot use a claim reference that is not approved | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 229 | an approved claim gets the digest of its wording; a number in non-claim text is refused | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 230 | one text per role | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 231 | a visual request must state that no critical text is generated into pixels | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 232 | video capabilities and provider parameters are refused at this stage | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 233 | the orchestrator cannot publish, schedule or decide strategy; it must keep RENDER and PREFLIGHT, in order | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 234 | the critic returns dimension statuses: no score, no unknown dimension, only its own document | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 235 | the analyst returns a product package and a readiness report, for the right merchant only | creative-intelligence-contracts.test.js › Agents: six roles, one trust boundary - model output is untrusted until it is normalized |
| 236 | the public surface has no publish / schedule / activate / approve function | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 237 | no network, clock, randomness or environment access in the source | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 238 | the only modules imported from outside the directory are shared pure validators and the Branding content-kind constant | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 239 | no merchant-specific logic in the generic domain | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 240 | no platform is hardcoded in the generic domain (channel facts come from explicit contracts) | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 241 | a candidate carries no publishing state | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 242 | Creative Intelligence cannot mutate Brand Memory: it neither imports it nor lets an agent write to it | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 243 | an agent cannot recompute a Marketing decision (objective, margin, stock, strategy) | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 244 | an agent cannot choose a channel, an audience, a budget or a price | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 245 | a raw URL can never become a canonical asset reference, in any contract | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 246 | normalizers never mutate their input | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 247 | every produced object is deep-frozen | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 248 | no dependency was added: the package manifest still holds only what existed before Creative Intelligence | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 249 | error codes are stable, unique and namespaced | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 250 | the public surface exposes the documented entry points | creative-intelligence-preflight.test.js › Boundaries: Creative Intelligence expresses an approved brief - it never publishes, approves, decides or mutates others |
| 251 | the demo yields a DesignDocument, an SVG, a preflight report and a CreativeCandidate for a 1080 x 1350 PRODUCT_HERO still | creative-intelligence-preflight.test.js › Demo: one synthetic still, end to end, with no network and no model |
| 252 | the PNG projection is honest: unsupported in this runtime, never faked | creative-intelligence-preflight.test.js › Demo: one synthetic still, end to end, with no network and no model |
| 253 | the selection exposes the candidate without ranking it | creative-intelligence-preflight.test.js › Demo: one synthetic still, end to end, with no network and no model |
| 254 | the price in the SVG and in the document is exactly the approved wording | creative-intelligence-preflight.test.js › Demo: one synthetic still, end to end, with no network and no model |
| 255 | two complete runs produce the same bytes and the same ids | creative-intelligence-preflight.test.js › Demo: one synthetic still, end to end, with no network and no model |
| 256 | a real CreativeHandoffPackage (real Marketing and Branding builders) becomes a valid, deep-frozen C1 intake | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 257 | merchant and brand are preserved | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 258 | the Brief, the deliverable and the brand interface (through the handoff) are pinned by reference | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 259 | subject_refs are preserved exactly and stay untyped: a category is not turned into a product | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 260 | source assets: the Brief's and the deliverable's, preserved | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 261 | claims are preserved | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 262 | the channel is the deliverable's | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 263 | the placement is the deliverable's | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 264 | the locale is the deliverable's (the direction is the platform rule for that language, not a choice) | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 265 | the format reference is preserved; the canvas comes from the RESOLVED format, never from the reference text | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 266 | mandatory content: the Brief's and the deliverable's | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 267 | prohibited content is preserved | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 268 | the deliverable's requirement refs are preserved | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 269 | policy, consent and promotion refs are preserved | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 270 | the deadline is preserved | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 271 | no business truth of Marketing is copied into Creative | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 272 | the prose of the Brief is never read (accessing it would throw) | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 273 | the Marketing objects are not modified | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 274 | a TEXT deliverable is refused, never converted into an image | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 275 | a resolved format of another reference, kind, status or merchant is refused | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 276 | a handoff of another scope, an expired one or an unknown deliverable is refused | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 277 | the same inputs give the same intake | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 278 | the adapter imports nothing from Marketing: it receives plain data | creative-intelligence-m3-resolver.test.js › Real Marketing M3 handoff -> C1 intake: every fact is preserved, nothing is copied, invented or parsed |
| 279 | a resolution has exactly: ref, kind, merchant_id, version, status, metadata | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 280 | an unknown reference cannot become a PRODUCT by inference - however product-like it looks | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 281 | the resolver's kind is authoritative: a product-looking reference that is an ASSET is an ASSET, and vice versa | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 282 | a resource of another merchant is refused; a merchant-less resource is only allowed for platform-level kinds | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 283 | a raw URL is not a resource identity: refused before the resolver is even asked; metadata cannot carry a location either | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 284 | an unresolved resource can never silently become READY | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 285 | a failing resolver is a stable refusal and its message is not echoed | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 286 | a resolver that answers for another reference is refused | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 287 | closed vocabularies: kind and status are enums | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 288 | the resolver receives only the merchant (frozen) and the boundary never touches the network | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 289 | no Creative Intelligence module reads a reference to decide what it names (only the location deny-list of the validator does) | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 290 | a subject, an asset and a claim always belong to a merchant; only a font and a format may be platform-level | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 291 | an intake whose every reference resolves ACTIVE and of an expected kind is RESOLVED | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 292 | a reference resolved as the wrong kind, or not at all, leaves the intake UNRESOLVED (reported, never assumed) | creative-intelligence-m3-resolver.test.js › Resource resolver boundary: the resolver\'s kind is authoritative, nothing is inferred from a string |
| 293 | a DesignDocument stores canonical references in the platform convention | creative-intelligence-m3-resolver.test.js › Canonical ref is not a resolved payload: a trusted resolver may feed one render, never the document |
| 294 | a payload or a location is refused in every canonical position | creative-intelligence-m3-resolver.test.js › Canonical ref is not a resolved payload: a trusted resolver may feed one render, never the document |
| 295 | the ephemeral payload lives in the SVG projection only: the document, the structure and the text runs never hold it | creative-intelligence-m3-resolver.test.js › Canonical ref is not a resolved payload: a trusted resolver may feed one render, never the document |
| 296 | the candidate carries a digest reference of the render, never the payload; that reference is itself a valid opaque ref | creative-intelligence-m3-resolver.test.js › Canonical ref is not a resolved payload: a trusted resolver may feed one render, never the document |
| 297 | a resolver cannot point an image at a remote location instead of a payload | creative-intelligence-m3-resolver.test.js › Canonical ref is not a resolved payload: a trusted resolver may feed one render, never the document |
| 298 | the same document renders deterministically with the same payload, and the document id never depends on it | creative-intelligence-m3-resolver.test.js › Canonical ref is not a resolved payload: a trusted resolver may feed one render, never the document |
| 299 | no colour literal anywhere in the C1 source (no default palette, no "premium" colour) | creative-intelligence-m3-resolver.test.js › No invented style: with no brand expression system, Creative Intelligence carries no style default |
| 300 | no font family and no style vocabulary table anywhere in the C1 source | creative-intelligence-m3-resolver.test.js › No invented style: with no brand expression system, Creative Intelligence carries no style default |
| 301 | the canvas colour is required, never defaulted | creative-intelligence-m3-resolver.test.js › No invented style: with no brand expression system, Creative Intelligence carries no style default |
| 302 | an image fit and a font's generic family are required, never defaulted | creative-intelligence-m3-resolver.test.js › No invented style: with no brand expression system, Creative Intelligence carries no style default |
| 303 | no recipe is chosen by default: the caller (the creative direction) names it | creative-intelligence-m3-resolver.test.js › No invented style: with no brand expression system, Creative Intelligence carries no style default |
| 304 | the expression system is a declared PRE-C2 dependency covering every domain the architect listed | creative-intelligence-m3-resolver.test.js › No invented style: with no brand expression system, Creative Intelligence carries no style default |
| 305 | with no fact, C2 is not allowed and every blocking dependency is open | creative-intelligence-m3-resolver.test.js › Pre-C2 readiness: C2 stays blocked until every blocking dependency has explicit evidence |
| 306 | the typography / rasterization blockers the architect named are all present and blocking | creative-intelligence-m3-resolver.test.js › Pre-C2 readiness: C2 stays blocked until every blocking dependency has explicit evidence |
| 307 | one closed dependency does not unblock C2 | creative-intelligence-m3-resolver.test.js › Pre-C2 readiness: C2 stays blocked until every blocking dependency has explicit evidence |
| 308 | C2 is allowed only when every blocking dependency has evidence - and typography is never declared production-ready by C1 | creative-intelligence-m3-resolver.test.js › Pre-C2 readiness: C2 stays blocked until every blocking dependency has explicit evidence |
| 309 | evidence is an opaque reference (never a URL) and an unknown dependency is refused | creative-intelligence-m3-resolver.test.js › Pre-C2 readiness: C2 stays blocked until every blocking dependency has explicit evidence |
| 310 | CJK line breaking is DEFERRED: documented, never claimed, and it does not block C2 | creative-intelligence-m3-resolver.test.js › Pre-C2 readiness: C2 stays blocked until every blocking dependency has explicit evidence |
| 311 | no PNG is faked meanwhile: without an injected rasterizer the answer is "unsupported" | creative-intelligence-m3-resolver.test.js › Pre-C2 readiness: C2 stays blocked until every blocking dependency has explicit evidence |
| 312 | ONE resource resolver (with FORMAT capability) is the pre-C2 dependency - there is no separate format resolver | creative-intelligence-m3-resolver.test.js › Pre-C2 readiness: C2 stays blocked until every blocking dependency has explicit evidence |
| 313 | an unresolved asset may produce a structural representation (labelled, deterministic, for inspection and tests) | creative-intelligence-m3-resolver.test.js › Structural render is not a production render: only resolved media may back a render-ready candidate |
| 314 | a partial resolution, a symbolic answer or no answer all stay structural | creative-intelligence-m3-resolver.test.js › Structural render is not a production render: only resolved media may back a render-ready candidate |
| 315 | an unresolved render can never become a render-ready candidate, nor a production image | creative-intelligence-m3-resolver.test.js › Structural render is not a production render: only resolved media may back a render-ready candidate |
| 316 | a resolved ephemeral payload can render: every needed media reference resolved, a RESOLVED render and candidate | creative-intelligence-m3-resolver.test.js › Structural render is not a production render: only resolved media may back a render-ready candidate |
| 317 | the resolved payload never enters the DesignDocument, nor the candidate | creative-intelligence-m3-resolver.test.js › Structural render is not a production render: only resolved media may back a render-ready candidate |
| 318 | the same resolved inputs produce the same bytes; another payload changes the bytes, never the document | creative-intelligence-m3-resolver.test.js › Structural render is not a production render: only resolved media may back a render-ready candidate |
| 319 | a document with no media to resolve has nothing unresolved (text and shapes only) | creative-intelligence-m3-resolver.test.js › Structural render is not a production render: only resolved media may back a render-ready candidate |
| 320 | the architect-selected benchmark exists as DATA with exactly the facts and requirements given | creative-intelligence-m3-resolver.test.js › C1 may close, C2 provider work stays blocked on a real campaign benchmark kept as configuration data |
| 321 | none of it lives in the generic Creative source: no campaign, price, promise or channel | creative-intelligence-m3-resolver.test.js › C1 may close, C2 provider work stays blocked on a real campaign benchmark kept as configuration data |
| 322 | with everything else closed, the missing real benchmark alone keeps C2 blocked | creative-intelligence-m3-resolver.test.js › C1 may close, C2 provider work stays blocked on a real campaign benchmark kept as configuration data |
| 323 | the benchmark says honestly what is still missing before it can run | creative-intelligence-m3-resolver.test.js › C1 may close, C2 provider work stays blocked on a real campaign benchmark kept as configuration data |
| 324 | the architecture document states the decision: C1 may close, C2 provider work is blocked on that benchmark | creative-intelligence-m3-resolver.test.js › C1 may close, C2 provider work stays blocked on a real campaign benchmark kept as configuration data |
| 325 | NDR-D02 / L3-002 carry the explicit clarification (C1 foundation COMPLETE, C2 DEFERRED on the benchmark) and keep the original condition | creative-intelligence-m3-resolver.test.js › C1 may close, C2 provider work stays blocked on a real campaign benchmark kept as configuration data |
<!-- coverage-matrix:end -->
