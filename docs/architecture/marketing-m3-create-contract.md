# Nordla — Marketing M3 · CREATE V1 (contract)

- **Status:** M3 — CREATE COMPLETE (audited, pushed, CI green)
- **Version:** `marketing-m3-create.v1`
- **Builds on:** [M1](./marketing-m1-understand-contract.md), [M1.5](./marketing-m1-5-signal-producers.md), [M2](./marketing-m2-build-contract.md) (all COMPLETE, unchanged), [Branding V1](./branding-v1-contract.md) and Creative Fidelity (reused, unchanged)
- **Parent architecture:** [`marketing-v1-architecture.md`](./marketing-v1-architecture.md)
- **Code:** `src/marketing/{m3-constants,m3-validation,create-authorization,create-gate,creative-brief,creative-handoff,creative-candidate,creative-validation,activation-manifest,m3}.js` — public surface `src/marketing/m3.js`
- **Tests:** `test/marketing-m3-create.test.js` · **CI:** `Marketing V1` (covers `src/marketing/**` and `test/marketing*.test.js`, no new workflow)

> **MARKETING OWNS THE BRIEF · CREATIVE INTELLIGENCE OWNS CREATIVE EXECUTION AND ARTISTIC QUALITY · CREATIVE FIDELITY OWNS PRODUCT FIDELITY · BRAND GUARDIAN OWNS BRAND COMPLIANCE · SOCLE / POLICY OWNS ACTIVATION AUTHORIZATION.**
>
> None of these boundaries is merged. `READY_FOR_POLICY` is **not** publication authorization, and a stored `status_snapshot` / `readiness` / `validation_status` is **never** a live authority: every live answer is recomputed from the originals and an explicit `asOf`.

M3 proves that Marketing can hand an approved intention to Creative Intelligence, then prepare a validated candidate for the activation step — **without** generating content, choosing a model, publishing or executing.

```text
MarketingPushProposal + SocleCreateAuthorization + READY Brand Context
        ↓
   CreativeBrief ─→ CreativeHandoffPackage ─→ Creative Intelligence      [EXTERNAL / DEFERRED]
                                                   ↓
                              SelectedCreativeCandidate                    [CONTRACT ONLY]
                                                   ↓
   trusted adapters: Creative Fidelity result (→ external gate) + Brand Candidate Manifest
                                                   ↓
                    Brand Guardian (EXISTING, unchanged) ─→ CreativeValidationReport
                                                   ↓
                              ActivationManifest ─→ Socle / policy / execution   [OUTSIDE M3]
```

M3 does **not** activate NDR-D02 (Creative Intelligence implementation stays deferred). It calls no model, no provider (no Qwen, Alibaba, OpenAI, Runway, local image/video/text model) and does not touch `src/marketing-creative/*`.

## 1. Rules common to every M3 contract

Same discipline as M1/M2: pure and deterministic (no network, filesystem, database, LLM/VLM, `Date.now()`, random id, environment); **closed schemas**; deep-frozen outputs; inputs never mutated or frozen; deterministic ids (`mcb_`, `mch_`, `mcv_`, `mam_`, `mdl_`); explicit ISO-8601 timestamps with an offset; opaque references only. M3 reuses the M1/M2 error class and codes for shape / scope / timestamp errors; M3-specific conditions have `MKT_M3_*` codes (`M3_ERROR`).

**References are never locations.** Beyond the opaque-token rule (no space, `@`, `?`, `&`), an M3 reference refuses any web / file / data location (`http(s):`, `ftp(s):`, `file:`, `data:`, `blob:`, `ws(s):`): no raw media, no URL, no signed or credentialed URL, no base64, no provider payload can be stored.

**One clock.** The explicit `asOf` is the creation time of every object built and the evaluation time of everything computed.

**Trust boundary.** Tenant, Brand Context, Finding, Package, Push, Authorization, candidates and their manifests come from trusted server-side adapters. M3 validates shape, scope and coherence; it authenticates nothing and verifies nothing cryptographically.

## 2. SocleCreateAuthorization

The representation of a decision **already taken elsewhere** (the future Socle). M3 builds **no mini-Socle**: no function creates, issues, grants or derives an authorization — the only authorization function, `normalizeSocleCreateAuthorization`, validates a **form** and its coherence with the original package and Push.

```text
authorization_ref  decision_ref  package_ref  push_ref  scope  status  authorized_at  expires_at
```

`scope` is exactly `CREATE` and `status` exactly `APPROVED` (nothing else in V1). `package_ref == package.package_id`; `push_ref == push.push_id`; `authorized_at ≤ expires_at ≤ push.expires_at` and `≤ package.expires_at`. **Staleness is live**: at `asOf ≥ expires_at` the authorization is expired (reported by the gate); an authorization whose `authorized_at` is after `asOf` is not yet valid (`NOT_AUTHORIZED`).

## 3. Live pre-create gate

`evaluateCreateGate({ tenant, finding, decisionPackage, push, authorization, brandContext, asOf })` returns `{ status, reason_codes }` and requires **the originals and an explicit clock**. It reuses the live M2 evaluators (`evaluatePackageStatus`, `evaluatePushReadiness`, which themselves re-validate the Finding through M1) — **a stored `readiness` / `package_status` is never read**.

Structural problems are **refused** with a stable code: a forged or foreign Package / Push / Finding (`MKT_M2_*`, `MKT_FINDING_*`), a Push that is not one of the package's proposals (`MKT_M3_PUSH_NOT_IN_PACKAGE`), a brandless Push (`MKT_M3_BRAND_REQUIRED`: M3 never chooses a brand), a READY Brand Context of **another** brand (`MKT_M3_BRAND_MISMATCH`). State- and time-dependent conclusions are **statuses**, with precedence **STALE > NOT_AUTHORIZED > PUSH_NOT_READY > BRAND_GATED > READY_FOR_CREATIVE**:

| Status | When (reason codes) |
|---|---|
| `STALE` | the Finding, Push, package or authorization has expired (`FINDING_EXPIRED`, `PUSH_EXPIRED`, `PACKAGE_EXPIRED`, `AUTHORIZATION_EXPIRED`) |
| `NOT_AUTHORIZED` | no authorization, or not yet valid (`AUTHORIZATION_MISSING`, `AUTHORIZATION_NOT_YET_VALID`) |
| `PUSH_NOT_READY` | the Push or the package is not live `READY_FOR_SOCLE` (`PUSH_NEEDS_EVIDENCE`, `PUSH_NOT_ELIGIBLE`, `PACKAGE_NEEDS_EVIDENCE`, …) |
| `BRAND_GATED` | the Brand Context is missing, not READY, or not rebuildable (`BRAND_CONTEXT_NOT_READY`, …). Like the Guardian, M3 **rebuilds** the context from its brand, Core, Memory and the tenant: a READY flag alone is not trusted |
| `READY_FOR_CREATIVE` | all of the above hold |

The builders (`buildCreativeBrief`, `buildCreativeHandoff`, `buildCreativeValidationReport`, `buildActivationManifest`) refuse anything but `READY_FOR_CREATIVE` (`MKT_M3_CREATE_NOT_READY`, `detail.status`).

## 4. CreativeBrief

A Brief answers **WHAT · WHY · FOR WHOM · WHERE · WHEN · WHAT MUST / MUST NOT BE COMMUNICATED · WHICH OUTPUTS**. It never answers HOW. **Refused anywhere in the input, at any depth, case-insensitively** (`MKT_M3_FORBIDDEN_CREATIVE_FIELD`): `prompt, negative_prompt, model, model_id, provider, style, visual_style, art_direction, composition, layout, camera, lens, lighting, font, typography, color_palette, hex, seed, sampler, steps, cfg, render_engine`. The Brief cannot become a hidden prompt.

**Derived, never re-entered** (copied from the validated Push / Authorization as a traceable snapshot; supplying any of them is refused, `MKT_M3_BRIEF_DERIVED_FIELD_SUPPLIED`, even with an equal value): `merchant_id, brand_id, finding_ref, push_ref, decision_ref, authorization_ref, objective, subject_refs, audience, channels, claim_refs, policy_requirement_refs, consent_requirement_refs, promotion_rule_refs, created_at`.

**Supplied** (closed): `message_intent` (an intention — **not** the final copy, never parsed), `cta_intent?` (an intention: no raw link, no tracking parameter, `MKT_M3_BRIEF_CTA_UNSAFE`), `deliverables[1..20]`, `source_asset_refs[]`, `mandatory_content_refs[]`, `prohibited_content_refs[]`, `locales[]`, `brief_limitations[]` (UPPER_SNAKE codes), `expires_at`. Claims stay opaque refs: no free-text claim is stored. `locales` are non-empty, unique after BCP 47 normalization and each in `brand.supported_locales`. `expires_at` is after `created_at` and **≤ the Finding, the Push, the package and the authorization** (`MKT_M3_BRIEF_OUTLIVES_GOVERNING`, `detail.bound`).

`normalizeCreativeBrief(stored, originals)` rebuilds the Brief from its own non-derived fields at its own `created_at` and compares (`MKT_M3_BRIEF_DERIVED_MISMATCH`). `evaluateBriefReadiness(brief, originals)` is the **live** answer, precedence `STALE > NOT_AUTHORIZED > PUSH_NOT_READY > BRAND_GATED > READY_FOR_CREATIVE`; while the gate is not READY the Brief is not inspected (it could only degrade the answer).

## 5. CreativeDeliverableSpec

`deliverable_id (mdl_…, deterministic)`, `content_kind`, `channel`, `placement`, `format_ref`, `locale`, `needed_by`, `source_asset_refs[]`, `mandatory_content_refs[]`, `requirement_refs[]`.

- `content_kind` is **exactly the Branding `CONTENT_KIND`** (`TEXT, IMAGE, VIDEO, DOCUMENT`), imported, never redefined.
- `channel` must be one of `push.channels` — no channel is introduced by M3.
- `placement` is an UPPER_SNAKE token (examples only: `FEED_POST, STORY, REEL, EMAIL_BODY, STORE_POSTER, WINDOW_POSTER, LANDING_HERO`); the core branches on no placement.
- `format_ref` is a **mandatory opaque ref** to a future format / production definition; M3 stores no dimensions, bleeds or codecs.
- `locale` ∈ the Brief locales. `needed_by` is **after the Brief's `created_at`**, **≤ the Push execution window end** and **≤ the authorization expiry** (`MKT_M3_DELIVERABLE_NEEDED_BY_INVALID`, `detail.limit`). There is no scheduler.
- Duplicates (same content) are refused; the order of deliverables carries no meaning (stored sorted by id).

## 6. CreativeHandoffPackage

`handoff_id (mch_…)`, `schema_version`, `creative_brief`, `brand_interface`, `created_at`, `expires_at`, `status_snapshot { status: READY_FOR_CREATIVE, as_of }`. `brand_interface` is **exactly** `creativeBrandInterface(brandContext)` — Brand Memory is neither imported nor rebuilt by M3. `expires_at ≤ brief.expires_at` (defaults to it). The `status_snapshot` records that the live gate was READY at `created_at`; it is a snapshot, never an authority. No model, provider or routing field can be expressed.

## 7. SelectedCreativeCandidate

`candidate_id` (given by Creative Intelligence), `merchant_id`, `brand_id`, `brief_ref`, `deliverable_ref`, `selection_ref`, `content_kind`, `channel`, `asset_refs[≥1]`, `provenance_ref`, `selected_at`, `candidate_expires_at`. `selection_ref` means Creative Intelligence made the selection; **M3 never re-judges it artistically.** Scope: same merchant and brand as the Brief, `brief_ref == brief.brief_id`, an existing deliverable, same `content_kind` and `channel` as that deliverable, `candidate_expires_at` after `selected_at` and `≤ brief.expires_at`. Refused anywhere (`MKT_M3_FORBIDDEN_CREATIVE_FIELD`): `prompt, negative_prompt, model, model_id, provider, cost, price, quality, quality_score, score, rating, winner, winner_score, rank, ranking_score`. Assets are opaque refs only.

## 8. Candidate manifest and Creative Fidelity

The candidate manifest is produced by **trusted adapters** and validated by Branding's `normalizeCandidateManifest`; its `content_kind` must equal the candidate's. Because Branding only requires its asset values to be whitespace-free tokens, M3 additionally refuses a raw location (URL, signed URL, data URI, blob, file) among the manifest's `assets` (`MKT_M3_CANDIDATE_MANIFEST_INVALID`): media never enters a manifest.

**M3 never computes product fidelity.** If Creative Fidelity ran, its result enters the manifest's `external_gates` through the existing adapter (`fidelityGateObservation`) and reaches the Guardian through the existing `product_fidelity` rule semantics — PASS passes, FAIL reaches the Guardian unchanged, NOT_MEASURABLE stays NOT_MEASURABLE. No M3 module imports Creative Fidelity.

## 9. Brand Guardian integration and CreativeValidationReport

M3 **really calls** the existing `evaluateBrandGuardian` (unchanged) with `tenant`, the READY `brandContext`, the candidate manifest, `targetRef = candidate.candidate_id`, `evaluatedAt = asOf` and an optional trusted `semanticAssessment` (advisory lane: it has no FAIL, `MKT_M3_SEMANTIC_ASSESSMENT_INVALID`). The report:

```text
validation_id (mcv_…)  schema_version  merchant_id  brand_id  brief_ref  candidate_ref  deliverable_ref
guardian_report  validation_status  evaluated_at  execution_decision (always null)
```

| Guardian outcome | `validation_status` |
|---|---|
| `PASS` | `READY_FOR_ACTIVATION_POLICY` |
| `REVIEW_REQUIRED` | `REVIEW_REQUIRED` |
| `FAIL` | `BLOCKED` |
| `NOT_MEASURABLE` | `NOT_MEASURABLE` |

`REVIEW_REQUIRED` is never turned into a pass; there is no override, force or publish-anyway. The Guardian report must be about this candidate, brand and merchant (`MKT_M3_GUARDIAN_SCOPE_MISMATCH`). The report is a **snapshot** at `evaluated_at`: it is recomputed at every live use.

## 10. ActivationManifest

```text
activation_manifest_id (mam_…)  schema_version  merchant_id  brand_id  finding_ref  push_ref  decision_ref  authorization_ref  brief_ref
created_at  expires_at  activation_window {start,end}  deliveries[]  measurement_plan_ref
claim_refs  policy_requirement_refs  consent_requirement_refs  promotion_rule_refs
unresolved_requirement_refs  review_signals  readiness  execution_decision (always null)
delivery = { deliverable_ref, candidate_ref, channel, placement, format_ref, locale, validation_ref, validation_status }
```

- **Every brief deliverable has exactly one delivery** (`MKT_M3_ACTIVATION_DELIVERABLE_MISSING`, `…_DUPLICATE_DELIVERABLE`); a candidate for a deliverable the Brief does not contain is refused (`MKT_M3_CANDIDATE_UNKNOWN_DELIVERABLE`; a stored delivery naming a candidate that was not supplied: `MKT_M3_ACTIVATION_UNKNOWN_CANDIDATE`). Channel, placement, format and locale are preserved from the deliverable.
- **Validations are computed by the Guardian inside the builder.** A `validation` supplied with a candidate is only cross-checked against the recomputed report (`MKT_M3_ACTIVATION_VALIDATION_MISMATCH`).
- `measurement_plan_ref = "<push_id>#measurement"` — a pointer to the M2 plan inside the Push, never a copy.
- Claims, policy, consent and promotion rules are **carried as opaque refs and validated by nobody here** (no compliance engine). `unresolved_requirement_refs` is derived from the Push (the Push-scoped counterpart of the M2 package derivation). `review_signals` is the deterministic, unique, sorted union of the Push signals, the Brand Context `review_signals` and every candidate's `guardian_report.brand_review_signals` and `guardian_report.guardian_review_signals`: no signal is lost along Brand Context -> Guardian -> CreativeValidationReport -> ActivationManifest, and a signal alone never changes readiness (it stays visible for the Socle / policy / human review).
- **Window.** `activation_window` is a **constraint, not a job**: `start` ≥ the Push window start; `end` ≤ the Push window end, the authorization expiry, the Brief expiry and every candidate expiry. A sub-window is accepted, a wider one refused (`MKT_M3_ACTIVATION_WINDOW_WIDER`, `detail.bound`). **Expiry:** `expires_at` after `created_at` and ≤ the Finding, Push, package, authorization, Brief and every candidate (`MKT_M3_ACTIVATION_OUTLIVES_GOVERNING`, `detail.bound`).
- No connector, no publication, no scheduler, no recipient, no send: such keys do not exist (refused as unknown keys).

## 11. Activation readiness

Exactly `READY_FOR_POLICY | REVIEW_REQUIRED | BLOCKED | NOT_MEASURABLE | STALE`, precedence **STALE > BLOCKED > REVIEW_REQUIRED > NOT_MEASURABLE > READY_FOR_POLICY**. Across the validations: any `BLOCKED` → `BLOCKED`; else any `REVIEW_REQUIRED` → `REVIEW_REQUIRED`; else any `NOT_MEASURABLE` → `NOT_MEASURABLE`; else `READY_FOR_POLICY`.

`evaluateActivationReadiness(manifest, { tenant, finding, decisionPackage, push, authorization, brandContext, asOf, brief, candidates })` is the **live** answer:

1. `STALE` if the Finding, Push, package or authorization (gate), the Brief, a candidate or the manifest has expired — read in the safe direction only (an expiry can degrade the answer, never improve it);
2. `BLOCKED` if the live gate is not READY (not authorized, Push not ready, Brand Context GATED — the reason codes are returned);
3. otherwise the stored manifest is re-validated against the originals (`normalizeActivationManifest`: rebuilt from its own non-derived fields at its own `created_at`, every derived field recomputed; a forged id, delivery, `validation_status` or `readiness` is refused, `MKT_M3_ACTIVATION_DERIVED_MISMATCH`) and the **Guardian is re-run** on every candidate manifest; the readiness comes from those live statuses.

A stored `readiness` / `validation_status` is a snapshot at `created_at` and is **never read as an authority**. A manifest built against inputs that have since changed (a new Brand Memory version, other candidate facts) no longer re-validates and must be rebuilt. **`READY_FOR_POLICY` ≠ execution approval ≠ publication authorized**; `execution_decision` is `null`, and M3 owns no `approveActivation`, `overrideGuardian`, `forcePublish` or `publishAnyway`.

## 12. Domain boundaries

| Concern | Owner | M3 behaviour |
|---|---|---|
| Brief | Marketing | built, bounded, copy-from-Push |
| Creative execution, artistic quality, model / provider choice | Creative Intelligence (deferred) | nothing called, nothing chosen, nothing evaluated |
| Product fidelity | Creative Fidelity | never recomputed or imported; its result is consumed through the Guardian external gate |
| Brand compliance | Brand Guardian | the existing engine is called, unchanged |
| Activation authorization | Socle / policy / human | `execution_decision = null`; the authorization is an input, never produced |
| Claims, consent, promotions, compliance | Compliance / policy | carried as opaque refs, validated by nobody here |
| Assets, formats | DAM / Format Registry (open) | opaque refs only |

## 13. Non-goals (not built)

Creative Intelligence engine, image / video / copy / prompt generation, provider selection, multi-model routing, Alibaba / OpenAI / Runway execution, Mini-Studio, print engine, Store Experience, publication, social posting, scheduler, execution worker, spend authorization, Socle Decision engine, policy engine, Decision Ledger, Creative Fidelity V1 rewrite, Brand Guardian rewrite, DAM, asset persistence, database migrations, M4 STEER.

## 14. Open dependencies (not resolved here)

Socle Decision engine · real Socle authorization issuer · Decision Ledger · Policy engine · Compliance engine · Activation / execution layer · DAM / Asset Registry · Format / Production Registry · Creative Intelligence implementation · Creative provider routing · Creative provider data-sharing policy · Creative candidate persistence · Human review workflow · publication · scheduler · M4 STEER.

## 15. Deviations and choices (documented)

1. **`schema_version` is an output field** of the Brief, handoff, validation report and manifest (as in M2).
2. **`brief_limitations` are UPPER_SNAKE codes**, not sentences, so that no prose or hidden instruction can ride along.
3. **Derived Brief fields are refused even with an equal value** (the mandate refuses a contradictory one): the simplest unambiguous rule.
4. **A cta_intent is checked for a raw link / tracking parameter** (`MKT_M3_BRIEF_CTA_UNSAFE`). This inspects the shape of the text for safety only; no business decision is taken from it. `message_intent` is never inspected.
5. **Raw locations are refused at the source** (audit correction): `normalizeCandidateManifest` now uses a manifest-specific `candidateRef` for `assets[].values[]` and every `evidence_refs[]` (refusing data:, blob:, file:, http(s):, ftp, ws, drive and absolute paths). The global `opaqueRef()` is unchanged. M3 keeps its own `isLocation` check as defense in depth.
6. **The activation builder takes the candidate entries and computes the validations itself**; a pre-built `validation` is only cross-checked. The stored manifest therefore cannot be live-evaluated without the candidate manifests.
7. **`BLOCKED` is the activation status for a gated live gate** (not authorized, Push not ready, Brand Context GATED), since the readiness vocabulary has no dedicated status; the reason codes carry the gate status.
8. **`unresolved_requirement_refs` of the manifest is re-derived from the Push, `review_signals` from the Push + Brand Context + Guardian reports** (M2 left its package-level helpers private; M2 was not modified).
9. **Not independently testable by construction (equivalent mutants):** the *finding* and *push* expiry bounds of a Brief or manifest are implied by the chain `authorization ≤ package ≤ push ≤ finding` that M2 already enforces; they are kept as defense in depth and are exercised through `detail.bound` where the chain makes them reachable.

## 16. Test coverage — mandate cases 1–192

One row per numbered case of the M3 mandate (§55). Several cases share a test function when it asserts them together; `test/marketing-m3-create.test.js` enforces that this table is contiguous, holds all 192 cases (193+ are the audit corrections) and that every named test exists. Cases marked **(CI)** are the Branding / Creative Fidelity suites and the full suite, executed by the `Marketing V1` workflow.

<!-- coverage-matrix:start -->
| Mandate case | Behaviour | Test (`test/marketing-m3-create.test.js` unless noted) |
|---:|---|---|
| 1 | valid CREATE authorization accepted | Authorization: a valid CREATE authorization is accepted; scope, status, refs, window and bounds are enforced |
| 2 | wrong scope refused | Authorization: a valid CREATE authorization is accepted; scope, status, refs, window and bounds are enforced |
| 3 | wrong status refused | Authorization: a valid CREATE authorization is accepted; scope, status, refs, window and bounds are enforced |
| 4 | package_ref mismatch | Authorization: a valid CREATE authorization is accepted; scope, status, refs, window and bounds are enforced |
| 5 | push_ref mismatch | Authorization: a valid CREATE authorization is accepted; scope, status, refs, window and bounds are enforced |
| 6 | authorized_at > expires_at | Authorization: a valid CREATE authorization is accepted; scope, status, refs, window and bounds are enforced |
| 7 | authorization outlives the Push | Authorization: a valid CREATE authorization is accepted; scope, status, refs, window and bounds are enforced |
| 8 | authorization outlives the package | Authorization: a valid CREATE authorization is accepted; scope, status, refs, window and bounds are enforced |
| 9 | stale authorization | Authorization: staleness is a live property, and Marketing never creates an authorization |
| 10 | unknown key refused | Authorization: a valid CREATE authorization is accepted; scope, status, refs, window and bounds are enforced |
| 11 | deep freeze | Authorization: a valid CREATE authorization is accepted; scope, status, refs, window and bounds are enforced |
| 12 | no automatic authorization creation | Authorization: staleness is a live property, and Marketing never creates an authorization |
| 13 | live package READY | Live gate: a live-ready package and Push, a valid authorization and a READY Brand Context give READY_FOR_CREATIVE |
| 14 | stale package refused | Live gate: a stale package, Push, authorization or Finding refuses CREATE |
| 15 | Push READY | Live gate: a live-ready package and Push, a valid authorization and a READY Brand Context give READY_FOR_CREATIVE |
| 16 | stale Push refused | Live gate: a stale package, Push, authorization or Finding refuses CREATE |
| 17 | NEEDS_EVIDENCE refused | Live gate: a Push that needs evidence or is not eligible refuses CREATE (PUSH_NOT_READY) |
| 18 | NOT_ELIGIBLE refused | Live gate: a Push that needs evidence or is not eligible refuses CREATE (PUSH_NOT_READY) |
| 19 | package missing the Push refused | Live gate scope: the Push must be in the package; tenant, brand and Finding must match; a brandless Push is refused |
| 20 | tenant mismatch | Live gate scope: the Push must be in the package; tenant, brand and Finding must match; a brandless Push is refused |
| 21 | brand mismatch | Live gate scope: the Push must be in the package; tenant, brand and Finding must match; a brandless Push is refused |
| 22 | Finding mismatch | Live gate scope: the Push must be in the package; tenant, brand and Finding must match; a brandless Push is refused |
| 23 | brandless Push refused | Live gate scope: the Push must be in the package; tenant, brand and Finding must match; a brandless Push is refused |
| 24 | Brand Context READY | Live gate: a live-ready package and Push, a valid authorization and a READY Brand Context give READY_FOR_CREATIVE |
| 25 | Brand Context GATED | Live gate: a Brand Context that is missing, GATED or not rebuildable is BRAND_GATED, and a flag alone is not trusted |
| 26 | stored Push readiness ignored | Live gate: a stored Push readiness and a stored package status are never read - the live evaluators decide |
| 27 | stored package status ignored | Live gate: a stored Push readiness and a stored package status are never read - the live evaluators decide |
| 28 | valid Brief | Brief: valid; merchant, brand, Finding, Push and decision are derived; objective, audience, channels and refs are copied |
| 29 | merchant derived | Brief: valid; merchant, brand, Finding, Push and decision are derived; objective, audience, channels and refs are copied |
| 30 | brand derived | Brief: valid; merchant, brand, Finding, Push and decision are derived; objective, audience, channels and refs are copied |
| 31 | finding_ref derived | Brief: valid; merchant, brand, Finding, Push and decision are derived; objective, audience, channels and refs are copied |
| 32 | push_ref derived | Brief: valid; merchant, brand, Finding, Push and decision are derived; objective, audience, channels and refs are copied |
| 33 | decision_ref derived | Brief: valid; merchant, brand, Finding, Push and decision are derived; objective, audience, channels and refs are copied |
| 34 | objective copied | Brief: valid; merchant, brand, Finding, Push and decision are derived; objective, audience, channels and refs are copied |
| 35 | audience copied | Brief: valid; merchant, brand, Finding, Push and decision are derived; objective, audience, channels and refs are copied |
| 36 | channels copied | Brief: valid; merchant, brand, Finding, Push and decision are derived; objective, audience, channels and refs are copied |
| 37 | claims / policy / consent / promotions copied | Brief: valid; merchant, brand, Finding, Push and decision are derived; objective, audience, channels and refs are copied |
| 38 | caller override refused | Brief: a caller cannot supply or override any derived value |
| 39 | message_intent required | Brief: message_intent is required and bounded; cta_intent is optional and is an intention (no raw link, no tracking) |
| 40 | cta_intent optional | Brief: message_intent is required and bounded; cta_intent is optional and is an intention (no raw link, no tracking) |
| 41 | locales non-empty | Brief locales: non-empty, unique, canonical BCP 47, and supported by the Brand |
| 42 | unsupported locale refused | Brief locales: non-empty, unique, canonical BCP 47, and supported by the Brand |
| 43 | duplicate locale refused | Brief locales: non-empty, unique, canonical BCP 47, and supported by the Brand |
| 44 | source asset refs opaque | Brief references are opaque: source assets, mandatory and prohibited content are refs, never content or locations |
| 45 | mandatory content refs opaque | Brief references are opaque: source assets, mandatory and prohibited content are refs, never content or locations |
| 46 | prohibited content refs opaque | Brief references are opaque: source assets, mandatory and prohibited content are refs, never content or locations |
| 47 | expiry <= Finding | Brief expiry is bounded by the Finding, the Push, the package and the authorization (each bound reported) |
| 48 | expiry <= Push | Brief expiry is bounded by the Finding, the Push, the package and the authorization (each bound reported) |
| 49 | expiry <= package | Brief expiry is bounded by the Finding, the Push, the package and the authorization (each bound reported) |
| 50 | expiry <= authorization | Brief expiry is bounded by the Finding, the Push, the package and the authorization (each bound reported) |
| 51 | no prompt | Brief: no prompt, model, provider, style, layout, composition, camera, lighting, font or color can be stored (anywhere in the input) |
| 52 | no model | Brief: no prompt, model, provider, style, layout, composition, camera, lighting, font or color can be stored (anywhere in the input) |
| 53 | no provider | Brief: no prompt, model, provider, style, layout, composition, camera, lighting, font or color can be stored (anywhere in the input) |
| 54 | no style | Brief: no prompt, model, provider, style, layout, composition, camera, lighting, font or color can be stored (anywhere in the input) |
| 55 | no layout / composition / camera / font / color | Brief: no prompt, model, provider, style, layout, composition, camera, lighting, font or color can be stored (anywhere in the input) |
| 56 | deep freeze | Brief: deep-frozen, deterministic id, same input same id, input never mutated |
| 57 | deterministic id | Brief: deep-frozen, deterministic id, same input same id, input never mutated |
| 58 | same input, same id | Brief: deep-frozen, deterministic id, same input same id, input never mutated |
| 59 | input unmutated | Brief: deep-frozen, deterministic id, same input same id, input never mutated |
| 60 | TEXT | Deliverable: content kinds are exactly the Branding CONTENT_KIND (TEXT, IMAGE, VIDEO, DOCUMENT) |
| 61 | IMAGE | Deliverable: content kinds are exactly the Branding CONTENT_KIND (TEXT, IMAGE, VIDEO, DOCUMENT) |
| 62 | VIDEO | Deliverable: content kinds are exactly the Branding CONTENT_KIND (TEXT, IMAGE, VIDEO, DOCUMENT) |
| 63 | DOCUMENT | Deliverable: content kinds are exactly the Branding CONTENT_KIND (TEXT, IMAGE, VIDEO, DOCUMENT) |
| 64 | unknown kind refused | Deliverable: content kinds are exactly the Branding CONTENT_KIND (TEXT, IMAGE, VIDEO, DOCUMENT) |
| 65 | channel taken from the Push | Deliverable: the channel comes from the Push, the placement is a token, the format is a mandatory ref |
| 66 | unknown channel refused | Deliverable: the channel comes from the Push, the placement is a token, the format is a mandatory ref |
| 67 | valid placement | Deliverable: the channel comes from the Push, the placement is a token, the format is a mandatory ref |
| 68 | invalid placement refused | Deliverable: the channel comes from the Push, the placement is a token, the format is a mandatory ref |
| 69 | format_ref required | Deliverable: the channel comes from the Push, the placement is a token, the format is a mandatory ref |
| 70 | locale supported | Deliverable: the locale must be a Brief locale; needed_by must be after the Brief and within the Push window and the authorization |
| 71 | needed_by after created_at | Deliverable: the locale must be a Brief locale; needed_by must be after the Brief and within the Push window and the authorization |
| 72 | needed_by <= Push window end | Deliverable: the locale must be a Brief locale; needed_by must be after the Brief and within the Push window and the authorization |
| 73 | needed_by <= authorization expiry | Deliverable: the locale must be a Brief locale; needed_by must be after the Brief and within the Push window and the authorization |
| 74 | deterministic deliverable id | Deliverable: deterministic id, duplicates refused, references only (no raw media, no credentialed URL) |
| 75 | duplicate refused | Deliverable: deterministic id, duplicates refused, references only (no raw media, no credentialed URL) |
| 76 | references only | Deliverable: deterministic id, duplicates refused, references only (no raw media, no credentialed URL) |
| 77 | no raw media / credentialed URL | Deliverable: deterministic id, duplicates refused, references only (no raw media, no credentialed URL) |
| 78 | valid handoff | Handoff: valid; the exact creativeBrandInterface is reused; Brand Memory is not rebuilt; scope, expiry and snapshot are correct |
| 79 | exact creativeBrandInterface reused | Handoff: valid; the exact creativeBrandInterface is reused; Brand Memory is not rebuilt; scope, expiry and snapshot are correct |
| 80 | Brand Memory not rebuilt | Handoff: valid; the exact creativeBrandInterface is reused; Brand Memory is not rebuilt; scope, expiry and snapshot are correct |
| 81 | merchant / brand match | Handoff: valid; the exact creativeBrandInterface is reused; Brand Memory is not rebuilt; scope, expiry and snapshot are correct |
| 82 | handoff expiry <= Brief | Handoff: valid; the exact creativeBrandInterface is reused; Brand Memory is not rebuilt; scope, expiry and snapshot are correct |
| 83 | status snapshot READY_FOR_CREATIVE | Handoff: valid; the exact creativeBrandInterface is reused; Brand Memory is not rebuilt; scope, expiry and snapshot are correct |
| 84 | live gate separate from the snapshot | Handoff: the live gate is separate from the snapshot; no model, provider or routing can be expressed |
| 85 | no model / provider routing | Handoff: the live gate is separate from the snapshot; no model, provider or routing can be expressed |
| 86 | deep freeze | Handoff: valid; the exact creativeBrandInterface is reused; Brand Memory is not rebuilt; scope, expiry and snapshot are correct |
| 87 | deterministic id | Handoff: valid; the exact creativeBrandInterface is reused; Brand Memory is not rebuilt; scope, expiry and snapshot are correct |
| 88 | valid candidate | Candidate: a valid candidate is accepted; merchant, brand, brief, deliverable, kind, channel and expiry are scoped to the Brief |
| 89 | merchant mismatch | Candidate: a valid candidate is accepted; merchant, brand, brief, deliverable, kind, channel and expiry are scoped to the Brief |
| 90 | brand mismatch | Candidate: a valid candidate is accepted; merchant, brand, brief, deliverable, kind, channel and expiry are scoped to the Brief |
| 91 | brief mismatch | Candidate: a valid candidate is accepted; merchant, brand, brief, deliverable, kind, channel and expiry are scoped to the Brief |
| 92 | unknown deliverable | Candidate: a valid candidate is accepted; merchant, brand, brief, deliverable, kind, channel and expiry are scoped to the Brief |
| 93 | content kind mismatch | Candidate: a valid candidate is accepted; merchant, brand, brief, deliverable, kind, channel and expiry are scoped to the Brief |
| 94 | channel mismatch | Candidate: a valid candidate is accepted; merchant, brand, brief, deliverable, kind, channel and expiry are scoped to the Brief |
| 95 | candidate expiry <= Brief | Candidate: a valid candidate is accepted; merchant, brand, brief, deliverable, kind, channel and expiry are scoped to the Brief |
| 96 | candidate id required | Candidate: id, selection, assets and provenance are required; no prompt, model, provider, cost or score; deep-frozen |
| 97 | selection_ref required | Candidate: id, selection, assets and provenance are required; no prompt, model, provider, cost or score; deep-frozen |
| 98 | asset_refs non-empty | Candidate: id, selection, assets and provenance are required; no prompt, model, provider, cost or score; deep-frozen |
| 99 | provenance_ref required | Candidate: id, selection, assets and provenance are required; no prompt, model, provider, cost or score; deep-frozen |
| 100 | prompt / model / provider refused | Candidate: id, selection, assets and provenance are required; no prompt, model, provider, cost or score; deep-frozen |
| 101 | quality score refused | Candidate: id, selection, assets and provenance are required; no prompt, model, provider, cost or score; deep-frozen |
| 102 | winner score refused | Candidate: id, selection, assets and provenance are required; no prompt, model, provider, cost or score; deep-frozen |
| 103 | deep freeze | Candidate: id, selection, assets and provenance are required; no prompt, model, provider, cost or score; deep-frozen |
| 104 | manifest normalized by Branding | Candidate manifest: normalized by Branding, and its content kind must match the candidate |
| 105 | content kind mismatch | Candidate manifest: normalized by Branding, and its content kind must match the candidate |
| 106 | fidelity PASS accepted | Creative Fidelity handoff: its result reaches the Guardian through the existing external gate, unchanged; M3 recomputes nothing |
| 107 | fidelity FAIL reaches the Guardian unchanged | Creative Fidelity handoff: its result reaches the Guardian through the existing external gate, unchanged; M3 recomputes nothing |
| 108 | fidelity NOT_MEASURABLE reaches the Guardian | Creative Fidelity handoff: its result reaches the Guardian through the existing external gate, unchanged; M3 recomputes nothing |
| 109 | no Creative Fidelity engine call | Creative Fidelity handoff: its result reaches the Guardian through the existing external gate, unchanged; M3 recomputes nothing |
| 110 | no fidelity recomputation | Creative Fidelity handoff: its result reaches the Guardian through the existing external gate, unchanged; M3 recomputes nothing |
| 111 | no raw media | Candidate manifest: normalized by Branding, and its content kind must match the candidate |
| 112 | PASS -> READY_FOR_ACTIVATION_POLICY | Guardian mapping is exact: PASS -> READY_FOR_ACTIVATION_POLICY, REVIEW_REQUIRED -> REVIEW_REQUIRED, FAIL -> BLOCKED, NOT_MEASURABLE -> NOT_MEASURABLE |
| 113 | REVIEW_REQUIRED -> REVIEW_REQUIRED | Guardian mapping is exact: PASS -> READY_FOR_ACTIVATION_POLICY, REVIEW_REQUIRED -> REVIEW_REQUIRED, FAIL -> BLOCKED, NOT_MEASURABLE -> NOT_MEASURABLE |
| 114 | FAIL -> BLOCKED | Guardian mapping is exact: PASS -> READY_FOR_ACTIVATION_POLICY, REVIEW_REQUIRED -> REVIEW_REQUIRED, FAIL -> BLOCKED, NOT_MEASURABLE -> NOT_MEASURABLE |
| 115 | NOT_MEASURABLE -> NOT_MEASURABLE | Guardian mapping is exact: PASS -> READY_FOR_ACTIVATION_POLICY, REVIEW_REQUIRED -> REVIEW_REQUIRED, FAIL -> BLOCKED, NOT_MEASURABLE -> NOT_MEASURABLE |
| 116 | targetRef = candidate id | Guardian integration: target and clock, no execution decision or override, optional advisory semantic lane, scope, determinism |
| 117 | evaluatedAt = asOf | Guardian integration: target and clock, no execution decision or override, optional advisory semantic lane, scope, determinism |
| 118 | execution_decision null | Guardian integration: target and clock, no execution decision or override, optional advisory semantic lane, scope, determinism |
| 119 | no override | Guardian integration: target and clock, no execution decision or override, optional advisory semantic lane, scope, determinism |
| 120 | semantic assessment optional | Guardian integration: target and clock, no execution decision or override, optional advisory semantic lane, scope, determinism |
| 121 | semantic FAIL impossible | Guardian integration: target and clock, no execution decision or override, optional advisory semantic lane, scope, determinism |
| 122 | brand scope preserved | Guardian integration: target and clock, no execution decision or override, optional advisory semantic lane, scope, determinism |
| 123 | deterministic validation report | Guardian integration: target and clock, no execution decision or override, optional advisory semantic lane, scope, determinism |
| 124 | deep freeze | Guardian integration: target and clock, no execution decision or override, optional advisory semantic lane, scope, determinism |
| 125 | valid manifest | Activation Manifest: valid, deterministic, every deliverable exactly once, channel / placement / format / locale preserved, frozen |
| 126 | deterministic id | Activation Manifest: valid, deterministic, every deliverable exactly once, channel / placement / format / locale preserved, frozen |
| 127 | all deliverables exactly once | Activation Manifest: valid, deterministic, every deliverable exactly once, channel / placement / format / locale preserved, frozen |
| 128 | missing deliverable refused | Activation Manifest: a deliverable cannot be forgotten, doubled, delivered by an unknown candidate or backed by a mismatching validation |
| 129 | duplicate deliverable refused | Activation Manifest: a deliverable cannot be forgotten, doubled, delivered by an unknown candidate or backed by a mismatching validation |
| 130 | unknown candidate refused | Activation Manifest: a deliverable cannot be forgotten, doubled, delivered by an unknown candidate or backed by a mismatching validation |
| 131 | validation mismatch refused | Activation Manifest: a deliverable cannot be forgotten, doubled, delivered by an unknown candidate or backed by a mismatching validation |
| 132 | channel preserved | Activation Manifest: valid, deterministic, every deliverable exactly once, channel / placement / format / locale preserved, frozen |
| 133 | placement preserved | Activation Manifest: valid, deterministic, every deliverable exactly once, channel / placement / format / locale preserved, frozen |
| 134 | format_ref preserved | Activation Manifest: valid, deterministic, every deliverable exactly once, channel / placement / format / locale preserved, frozen |
| 135 | locale preserved | Activation Manifest: valid, deterministic, every deliverable exactly once, channel / placement / format / locale preserved, frozen |
| 136 | measurement ref derived | Activation Manifest: measurement plan referenced not copied; claims, policy, consent and promotions carried as refs; no decision, connector or schedule |
| 137 | claims copied | Activation Manifest: measurement plan referenced not copied; claims, policy, consent and promotions carried as refs; no decision, connector or schedule |
| 138 | policy copied | Activation Manifest: measurement plan referenced not copied; claims, policy, consent and promotions carried as refs; no decision, connector or schedule |
| 139 | consent copied | Activation Manifest: measurement plan referenced not copied; claims, policy, consent and promotions carried as refs; no decision, connector or schedule |
| 140 | promotions copied | Activation Manifest: measurement plan referenced not copied; claims, policy, consent and promotions carried as refs; no decision, connector or schedule |
| 141 | execution_decision null | Activation Manifest: measurement plan referenced not copied; claims, policy, consent and promotions carried as refs; no decision, connector or schedule |
| 142 | no connector | Activation Manifest: measurement plan referenced not copied; claims, policy, consent and promotions carried as refs; no decision, connector or schedule |
| 143 | no publish | Activation Manifest: measurement plan referenced not copied; claims, policy, consent and promotions carried as refs; no decision, connector or schedule |
| 144 | no scheduled job | Activation Manifest: measurement plan referenced not copied; claims, policy, consent and promotions carried as refs; no decision, connector or schedule |
| 145 | expiry bounded | Activation Manifest: expiry and activation window are bounded by everything that governs them |
| 146 | activation window is a subset | Activation Manifest: expiry and activation window are bounded by everything that governs them |
| 147 | widened window refused | Activation Manifest: expiry and activation window are bounded by everything that governs them |
| 148 | deep freeze | Activation Manifest: valid, deterministic, every deliverable exactly once, channel / placement / format / locale preserved, frozen |
| 149 | all PASS -> READY_FOR_POLICY | Activation readiness: all PASS is READY_FOR_POLICY; BLOCKED > REVIEW_REQUIRED > NOT_MEASURABLE > READY |
| 150 | REVIEW_REQUIRED | Activation readiness: all PASS is READY_FOR_POLICY; BLOCKED > REVIEW_REQUIRED > NOT_MEASURABLE > READY |
| 151 | BLOCKED | Activation readiness: all PASS is READY_FOR_POLICY; BLOCKED > REVIEW_REQUIRED > NOT_MEASURABLE > READY |
| 152 | NOT_MEASURABLE | Activation readiness: all PASS is READY_FOR_POLICY; BLOCKED > REVIEW_REQUIRED > NOT_MEASURABLE > READY |
| 153 | BLOCKED dominates REVIEW_REQUIRED | Activation readiness: all PASS is READY_FOR_POLICY; BLOCKED > REVIEW_REQUIRED > NOT_MEASURABLE > READY |
| 154 | REVIEW_REQUIRED dominates NOT_MEASURABLE | Activation readiness: all PASS is READY_FOR_POLICY; BLOCKED > REVIEW_REQUIRED > NOT_MEASURABLE > READY |
| 155 | stale Finding | Activation readiness: STALE as soon as any governing object has expired (Finding, Push, package, authorization, Brief, candidate, manifest) |
| 156 | stale Push | Activation readiness: STALE as soon as any governing object has expired (Finding, Push, package, authorization, Brief, candidate, manifest) |
| 157 | stale package | Activation readiness: STALE as soon as any governing object has expired (Finding, Push, package, authorization, Brief, candidate, manifest) |
| 158 | stale authorization | Activation readiness: STALE as soon as any governing object has expired (Finding, Push, package, authorization, Brief, candidate, manifest) |
| 159 | stale Brief | Activation readiness: STALE as soon as any governing object has expired (Finding, Push, package, authorization, Brief, candidate, manifest) |
| 160 | stale candidate | Activation readiness: STALE as soon as any governing object has expired (Finding, Push, package, authorization, Brief, candidate, manifest) |
| 161 | Brand Context GATED | Activation readiness: a Brand Context that is GATED blocks (BLOCKED), whatever the manifest says |
| 162 | stored validation status is not a live authority | Activation readiness: stored validation status and stored readiness are never a live authority; READY_FOR_POLICY is not an execution approval |
| 163 | stored manifest readiness is not a live authority | Activation readiness: stored validation status and stored readiness are never a live authority; READY_FOR_POLICY is not an execution approval |
| 164 | READY_FOR_POLICY is not an execution approval | Activation readiness: stored validation status and stored readiness are never a live authority; READY_FOR_POLICY is not an execution approval |
| 165 | no image generation | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 166 | no video generation | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 167 | no text generation | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 168 | no prompt generation | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 169 | no provider selection | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 170 | no Alibaba | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 171 | no OpenAI | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 172 | no Runway | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 173 | no dynamic routing | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 174 | no artistic evaluation | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 175 | no fidelity recomputation | Creative Fidelity handoff: its result reaches the Guardian through the existing external gate, unchanged; M3 recomputes nothing |
| 176 | no Branding mutation | Static scope: no clock, randomness, network, database, filesystem, provider or model call, and no merchant-specific code in any M3 file |
| 177 | no Guardian mutation | Static scope: no clock, randomness, network, database, filesystem, provider or model call, and no merchant-specific code in any M3 file |
| 178 | no publish | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 179 | no send | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 180 | no scheduling | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 181 | no execution | Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function |
| 182 | no database | Static scope: no clock, randomness, network, database, filesystem, provider or model call, and no merchant-specific code in any M3 file |
| 183 | no network | Static scope: no clock, randomness, network, database, filesystem, provider or model call, and no merchant-specific code in any M3 file |
| 184 | no filesystem | Static scope: no clock, randomness, network, database, filesystem, provider or model call, and no merchant-specific code in any M3 file |
| 185 | no LLM / VLM | Static scope: no clock, randomness, network, database, filesystem, provider or model call, and no merchant-specific code in any M3 file |
| 186 | M1 unchanged | Non-regression: M1, M1.5, M2 and Measurement keep their public surface; the experimental providers are not activated |
| 187 | M1.5 unchanged | Non-regression: M1, M1.5, M2 and Measurement keep their public surface; the experimental providers are not activated |
| 188 | M2 unchanged | Non-regression: M1, M1.5, M2 and Measurement keep their public surface; the experimental providers are not activated |
| 189 | Branding tests unchanged | (CI) the Branding, Creative Fidelity and full suites, run by the `Marketing V1` workflow |
| 190 | Creative Fidelity tests unchanged | (CI) the Branding, Creative Fidelity and full suites, run by the `Marketing V1` workflow |
| 191 | Measurement unchanged | Non-regression: M1, M1.5, M2 and Measurement keep their public surface; the experimental providers are not activated |
| 192 | full suite green | (CI) the Branding, Creative Fidelity and full suites, run by the `Marketing V1` workflow |
| 193 | Brand Context signal survives to the manifest | Review signals: a Brand Context signal survives Brand Context -> Guardian -> validation -> Activation Manifest |
| 194 | Guardian semantic NOT_MEASURABLE signal visible | Review signals: a Guardian semantic NOT_MEASURABLE keeps readiness READY_FOR_POLICY but BRAND_SEMANTIC_NOT_MEASURABLE stays visible |
| 195 | signal union is unique, sorted, stable | Review signals: the union is unique, sorted and stable, and keeps the Push signals |
| 196 | semantic REVIEW_REQUIRED never silently improved | Semantic live revalidation: a REVIEW_REQUIRED never becomes PASS because the live entry omits the semanticAssessment |
| 197 | M3 refuses data / blob / file / URL asset refs | Candidate manifest refs: M3 refuses a data URI, blob, file or URL as an asset ref, through Branding itself |
| 198 | a signal changes no readiness and no decision | Review signals: no execution decision, override or readiness change comes with a signal |
| 199 | Branding refuses non-controlled manifest refs | (CI) `test/branding-candidate-manifest-refs.test.js`: asset:// and evidence:// accepted; data, blob, file, http(s), signed and credentialed URLs refused |
<!-- coverage-matrix:end -->

## 17. Semantic live revalidation rule (audit correction)

A live revalidation may degrade but never improves by losing evidence. When an entry carries its stored `validation` but no current `semanticAssessment`, the semantic assessment recorded in that validation snapshot stays in force (smallest variant). An explicit current assessment replaces it, and is then cross-checked against the supplied validation. Without either, the stored manifest no longer matches what the candidates produce and is refused (`MKT_M3_ACTIVATION_DERIVED_MISMATCH`), never silently read as READY.

## 18. Invariants kept at closure

```text
READY_FOR_POLICY
≠ approved for execution
≠ published

Creative Intelligence owns creative execution / artistic quality
Creative Fidelity owns product fidelity
Brand Guardian owns brand compliance
Socle / Policy / human owns activation authorization
```

Live revalidation can degrade, but cannot improve merely because a previous semantic assessment disappeared (see §17).
