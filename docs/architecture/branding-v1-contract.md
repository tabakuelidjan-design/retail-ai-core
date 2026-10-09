# Nordla Branding V1 — Generic contract

Status: BRANDING V1 CORE COMPLETE

Core scope complete:
Brand Identity → Brand Snapshot → Brand Core → Brand Memory → Brand Guardian.

Integration dependencies remain intentionally open:
persistence, Nordla Identity, Decision Ledger, Production Asset Registry,
Claims Registry, DAM, upstream extraction adapters and Branding UX.
These do not reopen the Branding V1 core architecture.

This document describes the generic contract implemented under `src/branding/`.
It does not contain any merchant-specific brand rule.

## Components

`Brand Identity` (which brand?) then `Brand Snapshot → Brand Core → Brand Memory → Brand Guardian`, all of it per brand.

### Brand Snapshot
Evidence-facing observation layer. Two separate vocabularies, never merged: a **claim** is FACT / INFERENCE / HYPOTHESIS (`claim_kind`, what Nordla asserts); a piece of **evidence** carries a `provenance` of observed / inferred / derived / unavailable (how the proof was obtained). A FACT must cite at least one `observed` or `derived` evidence. A Snapshot can become STALE after a material refresh trigger, but it cannot silently rewrite Brand Core.

### Brand Core
Small human-governed strategic core. An approved Core requires category, buying context, value proposition, positioning, core promise, reason to believe and at least one concrete exclusion. Priority distinctive assets are limited to three.

### Brand Memory
The approved, versioned, machine-readable operational brand. It is bound to ONE exact approved Core version and holds exactly five categories (see *Brand Memory V1* below). It stores references, never binaries and never the truth of a claim or product fact.

### Brand Guardian
A pure, deterministic compliance engine: it evaluates a candidate (described by a Candidate Manifest) against the approved Brand Memory behind a READY Brand Context and returns a traceable report. It is not an art director, a generator, a policy engine, a ledger or an override mechanism - see *Brand Guardian V1* below.

## Brand Identity V1 (`merchant_id` + `brand_id`)

Implemented in `src/branding/brand.js`.

A merchant (tenant) is not a brand. One company can own several brands (a house brand and a sub-brand, a webshop brand distinct from the legal entity, a brand launched later), so Branding never encodes "1 merchant = 1 brand".

- `merchant_id` answers *which company owns this data?* and always comes from the canonical tenant resolver.
- `brand_id` answers *which brand is this data about?* It is a stable UUID, distinct from `merchant_id`, issued server-side (a future `brands` registry). Like `resolvedActor`, a brand object must come from trusted server context and **never from an untrusted client payload**; Branding only checks shape, tenant ownership and status.

Brand Identity is a light referential, **not a fifth engine and not a governed document** (no draft/review/approval): `{ brand_id, merchant_id, name, status, created_at, parent_brand_id, default_locale, supported_locales }`.

- `name`: the commercial brand name (not necessarily the legal or tenant name).
- `status`: `ACTIVE` or `INACTIVE`. An INACTIVE brand cannot start governed work (`BRAND_INACTIVE`) and gates its Brand Context.
- `parent_brand_id`: `null` or another brand of the same merchant (`validateBrandHierarchy` checks existence, same merchant, no cycle on a list loaded from the registry). Nothing more: no endorsement, house-of-brands logic, portfolio scoring or equity.
  **Limit:** hierarchy validation, including cycle detection, is complete only over the brand graph the caller supplies. It cannot see brands it was not given, so a cycle or a foreign parent hidden in unloaded brands is invisible to it. Enforcing the hierarchy globally needs the persistent `brands` registry, which remains an **open dependency**.
- Locales: `default_locale` is mandatory and must be in `supported_locales`; the list is non-empty and duplicate-free. Only canonical BCP 47 locales are **stored**, restricted to `language[-Script][-REGION]` (e.g. `fr-BE`, `nl-BE`, `en-GB`, `zh-Hant-TW`; no variants or extensions in V1). A valid locale is **normalized on input** with the platform's `Intl.getCanonicalLocales` (`fr-be` -> `fr-BE`, legacy `iw` -> `he`) rather than refused for its casing, and duplicates are detected after normalization; an invalid one (`fr_BE`, `french`, `fr-BE-u-ca-gregory`) is refused. There is no home-made normalizer; where `Intl` is unavailable only an already-canonical value is accepted. This only prepares the model: no translations, fallback chain, per-locale Core/Memory or i18n.
- It holds no positioning, promise, voice, assets, hard rules or tokens: those stay in Brand Core and Brand Memory.
- The object is deeply frozen. `buildBrandIdentity({ tenant, ... })` takes `merchant_id` from the tenant; `resolveBrand(tenant, brand)` is the entry point of every governed operation (brand present, same tenant, ACTIVE).
- Persistence is not built; the contract maps one-to-one onto a future `brands` table (`brand_id`, `merchant_id`, `name`, `status`, `parent_brand_id`, `default_locale`, `supported_locales`, `created_at`).

### `brand_id` propagation

- **Snapshot, Core, Memory** each carry `merchant_id` and `brand_id`. Every operation takes the explicit `brand` next to `tenant` and checks `document.merchant_id == tenant.merchantId`, `document.brand_id == brand.brand_id` and `brand.merchant_id == tenant.merchantId`.
- Two brands of the same merchant have separate Snapshots, Cores and Memories. `Core.brand_id == Snapshot.brand_id` and `Memory.brand_id == Core.brand_id` (`CORE_SNAPSHOT_BRAND_MISMATCH`, `MEMORY_CORE_BRAND_MISMATCH`).
- **Active documents are unique per `merchant_id + brand_id`**: `selectActiveBrandCore(cores, tenant, brand)` and `selectActiveBrandMemory(memories, tenant, brand)` refuse two APPROVED documents for the same brand and allow one per other brand of the same merchant; a document of another brand can never be the one superseded (`CORE_ACTIVE_CORE_BRAND_MISMATCH`, `MEMORY_ACTIVE_MEMORY_BRAND_MISMATCH`).
- **Brand Context:** `buildBrandContext({ tenant, brand, snapshot, core, memory })`. GATED with explicit brand reasons: `BRAND_IDENTITY_MISSING`, `BRAND_TENANT_MISMATCH`, `BRAND_INACTIVE`, `BRAND_SNAPSHOT_BRAND_MISMATCH`, `BRAND_CORE_BRAND_MISMATCH`, `BRAND_MEMORY_BRAND_MISMATCH` (in addition to the existing document reasons). READY exposes `brand`; the Marketing and Creative views carry `brand { brand_id, name, default_locale, supported_locales }` and nothing from the registry internals.
- **Decision events:** `BRAND_CORE_APPROVED` and `BRAND_MEMORY_APPROVED` now include `brand_id` next to `merchant_id` and the subject (same single event model; the brand is part of the deterministic event id).
- **Guardian:** the brand reaches the Guardian only through the READY Brand Context (no `brand` / `brand_id` input). The report carries `merchant_id`, `brand_id`, `core_ref` and `memory_ref`; the Guardian re-verifies that the brand belongs to the tenant and that Core and Memory belong to that brand, and never infers the brand from the Candidate Manifest (which cannot carry a `brand_id`). See *Brand Guardian V1*.

## Brand Memory V1

Implemented in `src/branding/memory.js`, `hard-rules.js`, `candidate-manifest.js`; structural schema in `schemas/branding/brand-memory-v1.schema.json`.

### The five categories (nothing else may enter)

| Category | Content |
|---|---|
| `identity_references` | `primary_logo_ref`, `approved_logo_refs[]` - opaque refs, no binaries, no DAM. A logo is never mandatory. **Distinctive Brand Assets are not stored here**: `Brand Core.distinctive_assets` is the single authoritative source and is exposed to Creative through the Creative interface (`distinctive_assets`). Memory has no second list and refuses a `distinctive_asset_refs` key. |
| `design_tokens` | `colors` (`#RRGGBB`, normalized uppercase, unique values) and `typography` (`family`, integer `weights` 1-1000). No spacing/radius/shadow/grid/motion. |
| `hard_rules` | Verifiable rules only (below). |
| `semantic_context` | `voice_traits`, `do`, `dont`, `brand_style_summary`, `on_brand_examples`, `off_brand_examples`. Qualitative expectations live here, never in hard rules. |
| `external_references` | `production_asset_refs` (future Production Asset Registry), `claim_refs` (`claim://`, future Claims Registry), `policy_refs` (`external-policy://`). References only. |

Unknown keys are refused at every level, so budget, strategy, competitors, catalog, pricing, scores, etc. cannot be smuggled in.

### Hard rule contract

`{ id, rule_type, subject, operator, value, severity, scope, source_ref }` - every field validated, no extra field allowed.

- **rule_type** (exactly six): `ASSET_REF`, `COLOR`, `TYPOGRAPHY`, `TEXT`, `CLAIM_REF`, `EXTERNAL_GATE`.
- **operator** (exactly six): `EQUALS`, `ONE_OF`, `CONTAINS`, `NOT_CONTAINS`, `REQUIRED`, `STATUS_IN`. No `CUSTOM`, `EXECUTE_CODE`, `PROMPT` or `LLM_DECIDE`, and **no `MATCHES_PATTERN`**: pattern matching is out of V1 (no business need yet, no safe mechanism); it may be reintroduced later with a safe mechanism if a real case requires it.
- **Matrix** (`HARD_RULE_MATRIX`, any other pair is refused): `ASSET_REF`/`COLOR`/`TYPOGRAPHY`/`CLAIM_REF` -> `EQUALS`, `ONE_OF`, `REQUIRED`; `TEXT` -> `CONTAINS`, `NOT_CONTAINS`, `REQUIRED`; `EXTERNAL_GATE` -> `STATUS_IN`, `REQUIRED`.
- **value**: shaped by type and operator (hex color, `claim://` ref, opaque asset ref, text, list of known gate statuses; `REQUIRED` takes `true`).
- **severity**: `BLOCK` (failure -> Guardian `FAIL`) or `REVIEW` (failure -> `REVIEW_REQUIRED`). A required rule with no result is `NOT_MEASURABLE`; no `PASS` is possible with an uncovered rule.
- **scope**: `GLOBAL`, `TEXT`, `IMAGE`, `VIDEO`, `DOCUMENT` (no per-social-platform scope).
- **source_ref** (mandatory, "why does this rule exist?"): `brand-core://`, `decision://`, `approved-asset://`, `claim://` or `external-policy://`. A missing or non-standard one is refused (`HARD_RULE_SOURCE_REF_REQUIRED`).
- **EXTERNAL_GATE** consumes a canonical gate computed elsewhere; the subject must be a registered gate (`EXTERNAL_GATES`, V1: `product_fidelity` -> `creative-fidelity`). The registry separates what a gate can **report** (`observable_statuses`: for `product_fidelity`, `PASS`/`FAIL`/`NOT_MEASURABLE`, the vocabulary of a candidate manifest) from what a rule may declare **compliant** (`allowed_rule_statuses`: for `product_fidelity`, `[PASS]`). `STATUS_IN` may only list `allowed_rule_statuses`, so `FAIL` and `NOT_MEASURABLE` can never be configured as a conforming state. Branding never recomputes the gate.
- `CLAIM_REF` stores a `claim://` reference, never the claim's truth.

### Core <-> Memory binding

Memory references an exact `core_ref { id, version }`. It requires an APPROVED Core of the same tenant and the same brand. When the brand's active Core is not the Memory's `core_ref` (e.g. Core V2 approved while Memory is still on Core V1), validation reports `BRAND_MEMORY_CORE_MISMATCH` and the Brand Context is `GATED`. A new Memory version for the new Core supersedes the old Memory. A STALE Snapshot is NOT a mismatch: compatible Core + Memory stay `READY` with `BRAND_SNAPSHOT_STALE` in `review_signals`.

### Governed flow (no local lifecycle framework)

`buildBrandMemoryDraft` (DRAFT) -> `validateBrandMemory` -> `submitBrandMemoryForReview` (REVIEW_REQUIRED) -> `approveBrandMemory` (APPROVED) -> `proposeBrandMemoryRevision` (new version, REVIEW_REQUIRED) ; `selectActiveBrandMemory` refuses two APPROVED Memories for one tenant. Transitions are checked inside these functions.

`approveBrandMemory({ memory, core, tenant, resolvedActor, activeMemory, approvedAt })` has the same trust model as Core approval: `resolvedActor` comes from the trusted server / Socle context and **must never be built from an untrusted client payload**; Branding authenticates nobody and checks only presence, tenant and role (OWNER / AUTHORIZED_REVIEWER). It persists nothing and returns `{ approvedMemory, supersededMemory, decisionEvent }` (same shape as Core approval: `approvedX` / `supersededX` / `decisionEvent`; only the Core adds `reviewSignals`, which come from its reference Snapshot). The event reuses the Core decision-event model with type `BRAND_MEMORY_APPROVED`. An empty Memory cannot be submitted. An APPROVED version is deeply frozen; a revision never mutates it.

### Candidate manifest

Structured facts about a candidate, produced by upstream adapters (OCR, color extraction, font detection, asset resolver, creative-fidelity, document parser...). It holds **no raw media**: only refs, colors, family names, text fragments and statuses. See *Brand Guardian V1*.

### Schema

`schemas/branding/brand-memory-v1.schema.json` describes the normalized document structure. It is executed in tests by `validateSchemaSubset` (`schema-subset.js`), a **strict subset validator - not a general JSON Schema implementation**: it supports only the keywords the Branding schemas use (type, enum, const, properties, required, additionalProperties, items, min/max constraints, pattern, uniqueItems, local `#/$defs/` `$ref`) and refuses every other keyword, even in unreached branches, so a schema can never hold an unenforced constraint. `$schema`/`$id` are annotations only. It has no dependency (NDR-P10: build/own what is cheap). The type x operator matrix, value shapes, Core binding and token-name rules live in code only; a test fails if the schema enums drift from the code constants.

## Brand Memory V1.1 — `expression_system` (PRE-C2)

**Status: Brand Memory V1.1 mechanism COMPLETE** (pushed at `d182e86`). The canonical HABB brand package (Identity `4c487848-8d41-4e30-8f3f-66afd09b4be4`, Snapshot, Core V1 APPROVED, Memory V1.1 APPROVED with the owner-approved `expression_system`; current revision `habb-memory-v3@3`: v2 added the two approved typography families, v3 adds exactly three Guardian hard rules (declared-colour allowlist, two typography families, the `product_fidelity` gate must be PASS); earlier versions SUPERSEDED) is recorded in `benchmarks/creative-intelligence/habb-brand-canonical-v1.json` as benchmark-scoped trusted data, not the future persistent brands registry; a migration to that registry MUST preserve the brand_id. See `creative-pre-c2-foundation.md`.

V1.1 is **additive and backward compatible**: a sixth, optional Memory category. A V1 Memory stays valid, keeps exactly its V1 shape and is still a READY context;
it is simply not *C2 brand-ready* (`assessExpressionReadiness` answers `EXPRESSION_SYSTEM_ABSENT`). No default style is ever substituted.

- Domains: `photography`, `product_presentation`, `composition`, `layout_principles`, `illustration`, `iconography`, `motion`, `locale_overrides`.
- Each non-locale domain is `{principles, do, dont, reference_asset_refs}`: at most 20 items of at most 300 characters; no URL, prompt, model, seed, score, hex colour or claim/policy reference. Hard rules stay in `hard_rules` and are not duplicated here.
- `locale_overrides` is a partial map keyed by canonical locale; every key must be a locale the brand supports (checked at draft, submit and approve, where the brand is known).
- Governance is unchanged: DRAFT → REVIEW_REQUIRED → APPROVED → SUPERSEDED; an expression change is a revision; the exact Core binding is unchanged; there is no `core_version_range`.
- `creativeBrandInterface` exposes `expression_system` (`null` for a legacy Memory); `marketingBrandInterface` does **not**.
- Schema: `schemas/branding/brand-memory-v1.schema.json` (optional `expression_system`). Code: `src/branding/expression-system.js`. Tests: `test/branding-expression-system.test.js`.

## Brand Guardian V1

Implemented in `src/branding/guardian.js` and `src/branding/candidate-manifest.js`.

```text
Brand Context READY + Candidate Manifest -> evaluateBrandGuardian -> Guardian Report
                                                                    -> Socle Policy / human validation / execution
```

`evaluateBrandGuardian({ tenant, brandContext, candidateManifest, targetRef, evaluatedAt, semanticAssessment? })` - no other key is accepted (in particular no `contentKind`, no per-rule `checks`, and no `brand` / `brand_id`: the brand comes from the READY Brand Context, the single source of truth).

### Preconditions
The Brand Context must be `READY`; otherwise `GUARDIAN_REQUIRES_READY_BRAND_CONTEXT` (with the reasons). Guardian does not trust the flag: it rebuilds the gate from the brand, the approved Core and Memory and the tenant, so a tenant mismatch, a brand mismatch (`BRAND_CORE_BRAND_MISMATCH`, `BRAND_MEMORY_BRAND_MISMATCH`) or a Core/Memory mismatch (`BRAND_MEMORY_CORE_MISMATCH`) is refused even on a forged READY object. The report carries `merchant_id` and `brand_id` (taken from that context) next to `core_ref` and `memory_ref`; the brand is never inferred from the Candidate Manifest, which cannot carry a `brand_id`. A STALE Snapshot does not block: `BRAND_SNAPSHOT_STALE` is propagated in `brand_review_signals` and never changes the outcome.

### Trust of the inputs
The `candidateManifest` and the `semanticAssessment` must come from **trusted adapters or server context** (OCR, color extraction, the creative-fidelity adapter, a human review tool, a model run) and **must never be built directly from an untrusted client payload**. The Guardian is pure: it validates their shape (strict keys, enums, coverage rules) but **authenticates neither**, and cannot tell a truthful observation from a forged one. Whoever assembles these objects carries that trust, exactly as for `resolvedActor` and the brand object. This stays an open dependency until Nordla Identity / signed adapter outputs exist.

### Candidate manifest: subject-aware and coverage-aware
Candidate Manifest asset/evidence references are controlled opaque references. Raw transport locations are not valid candidate refs: `data:`, `blob:`, `file:`, `http(s):`, `ftp(s):`, `ws(s):` and local absolute filesystem paths.

`content_kind` (`TEXT`, `IMAGE`, `VIDEO`, `DOCUMENT`, the only source of truth) plus one channel per rule type:

| Channel | Rule type | Observation |
|---|---|---|
| `assets` | `ASSET_REF` | `{ subject, coverage, values: [asset ref], evidence_refs }` |
| `colors` | `COLOR` | values: `#RRGGBB` (normalized uppercase) |
| `typography` | `TYPOGRAPHY` | values: family names |
| `text` | `TEXT` | values: text fragments |
| `claims` | `CLAIM_REF` | values: `claim://` refs |
| `external_gates` | `EXTERNAL_GATE` | `{ subject (a registered gate), coverage, status, evidence_refs }` |

- **coverage** is the quality of the measurement, not a score: `COMPLETE` (exhaustive enough to conclude on an absence), `PARTIAL` (observations exist, exhaustiveness not guaranteed), `UNAVAILABLE` (no reliable measurement; it cannot carry values or a status). This is what separates *"no logo found after a complete measurement"* from *"the logo detector did not run"*.
- **subject** is the deterministic key: a rule reads the observation with `observation.subject === rule.subject` in its channel. No fuzzy or model matching. A subject appears once per channel; several values go in `values[]`. An adapter that cannot classify a subject must report `PARTIAL`/`UNAVAILABLE`, not guess.
- No observation at all for a rule's subject is `NOT_MEASURABLE` (`OBSERVATION_NOT_PROVIDED`), which is different from a COMPLETE observation with no value.
- `fidelityGateObservation({ gate })` turns a creative-fidelity `evaluateHardFidelityGate` result into the `product_fidelity` observation: PASS -> COMPLETE/PASS; FAIL without gaps -> COMPLETE/FAIL; FAIL with missing checks -> PARTIAL/FAIL (a violation is proven, compliance is not); NOT_MEASURABLE -> UNAVAILABLE.

### Hard-rule evaluation
A rule applies when `scope === GLOBAL` or `scope === content_kind`; others are listed in `not_applicable_rule_ids` and never count. For applicable rules (raw result before severity):

| Operator | COMPLETE | PARTIAL | UNAVAILABLE |
|---|---|---|---|
| `REQUIRED` | values -> PASS; none -> violation | values -> PASS; none -> NOT_MEASURABLE | NOT_MEASURABLE |
| `EQUALS` / `ONE_OF` (every observed value must be allowed) | >=1 value, all allowed -> PASS; none, or one not allowed -> violation | one not allowed -> violation; otherwise NOT_MEASURABLE | NOT_MEASURABLE |
| `CONTAINS` | found -> PASS; absent -> violation | found -> PASS; absent -> NOT_MEASURABLE | NOT_MEASURABLE |
| `NOT_CONTAINS` | found -> violation; absent -> PASS | found -> violation; absent -> NOT_MEASURABLE | NOT_MEASURABLE |
| `STATUS_IN` / `REQUIRED` on a gate | see below | | |

Principle: a partial observation can prove a violation, never compliance or the absence of something.

- **Text** matching joins only the fragments of the SAME subject and compares after one shared normalization (Unicode NFC, locale-independent lower-casing, whitespace collapsed). It is not fuzzy matching.
- **External gates:** a gate that is absent, UNAVAILABLE, status-less or reporting `NOT_MEASURABLE` is `NOT_MEASURABLE` (`EXTERNAL_GATE_NOT_MEASURED`), never a brand violation. `REQUIRED` passes on any usable result. `STATUS_IN`: status not allowed -> violation (even from a PARTIAL gate); allowed -> PASS only if COMPLETE, else NOT_MEASURABLE. Guardian never recomputes product fidelity.
- **Severity** is applied afterwards: violation + `BLOCK` -> `FAIL`, violation + `REVIEW` -> `REVIEW_REQUIRED`; `PASS` and `NOT_MEASURABLE` never change.
- **Aggregation:** `FAIL > REVIEW_REQUIRED > NOT_MEASURABLE > PASS` over applicable rules. No PASS if any applicable rule is NOT_MEASURABLE. Zero applicable rule -> `hard_outcome = NOT_MEASURABLE` with `NO_APPLICABLE_HARD_RULES` (nothing verified is not compliance).
- **Reason codes** (stable, `GUARDIAN_REASON`): `RULE_PASSED`, `REQUIRED_VALUE_MISSING`, `OBSERVED_VALUE_MISMATCH`, `OBSERVED_VALUE_NOT_ALLOWED`, `REQUIRED_TEXT_MISSING`, `FORBIDDEN_TEXT_FOUND`, `EXTERNAL_GATE_STATUS_NOT_ALLOWED`, `OBSERVATION_NOT_PROVIDED`, `MEASUREMENT_PARTIAL`, `MEASUREMENT_UNAVAILABLE`, `EXTERNAL_GATE_NOT_MEASURED`, `NO_APPLICABLE_HARD_RULES`.

### Semantic lane (advisory, separate)
`semantic_context` is not a hard rule. A `semanticAssessment` `{ outcome: PASS | REVIEW_REQUIRED | NOT_MEASURABLE, method: MODEL | HUMAN, evidence_refs, note }` may be passed in, already computed elsewhere; Guardian makes no model call. `FAIL` does not exist in this lane and the assessment cannot name a rule: a model never settles a hard rule.

`hard_outcome` and `semantic_outcome` are reported separately. Overall: hard FAIL / REVIEW_REQUIRED / NOT_MEASURABLE dominate; hard PASS + semantic REVIEW_REQUIRED -> `REVIEW_REQUIRED`; hard PASS + semantic PASS or absent -> `PASS`; hard PASS + semantic NOT_MEASURABLE -> `PASS` plus the Guardian signal `BRAND_SEMANTIC_NOT_MEASURABLE` in `guardian_review_signals`.

### Report
`id, merchant_id, core_ref, memory_ref, target_ref, content_kind, evaluated_at, rule_results[], not_applicable_rule_ids[], hard_outcome, hard_outcome_reason, semantic_outcome, semantic_assessment, brand_review_signals[], guardian_review_signals[], outcome, execution_decision (null), policy_note`. Each rule result: `rule_id, subject, rule_type, severity, scope, outcome, reason, evidence_refs, observed_summary`. `observed_summary` is a compact deterministic string (coverage, value count, at most three clipped offending values): no media and no full text is copied. Evidence refs are those of the observation actually used; nothing is invented. The report is deeply frozen.

### Authority, purity, boundaries
- `execution_decision` is always `null` and `policy_note` is `GUARDIAN_REPORT_IS_NOT_AN_EXECUTION_POLICY_DECISION`. Even `FAIL` is not an action. No `override`, `forcePass` or `publishAnyway` exists; a human observation enters through the manifest via a trusted adapter, it is not a policy override (override belongs to Socle Policy).
- The evaluation is pure: same Memory + Manifest + inputs give the same report. No network, filesystem, database, model, implicit clock or randomness; `evaluatedAt` is explicit and the report id is a hash of the explicit inputs. Nothing is persisted.
- Creative Intelligence owns composition, hierarchy, finishing, AI look, artifacts and aesthetics; creative-fidelity owns product fidelity. Neither is duplicated here.
- Not built (non-goals): OCR, vision, font detection, color extraction, any LLM/VLM call, publication, overrides, Decision Ledger persistence, dashboards, scoring, platform rules, auto-fix or regeneration.

## Generic interfaces

`buildBrandContext({ tenant, brand, core, memory, snapshot })` is the gate consumed by other domains. `tenant` is the result of the canonical resolver in `src/tenant` (ADR 0003); Branding never resolves or trusts a client-supplied merchant id, and every document stores a tenant UUID.

If the Core or Memory is missing, unapproved, mismatched or invalid, the context is `GATED` and no brand facts are invented.

`marketingBrandInterface(context)` exposes only what Marketing needs: Core fields, `semantic_context`, the TEXT and CLAIM_REF hard rules and `claim_refs`.

`creativeBrandInterface(context)` exposes identity references, distinctive assets, design tokens, hard rules, semantic context and external references (incl. production-asset refs).

A STALE or outdated Snapshot adds a non-blocking `review_signals` entry to a READY context; it never gates it.

Both views are deeply frozen copies that never contain approval internals. Marketing and Creative are readers. They do not rewrite Branding documents.

## Status model

Snapshot: `DRAFT → READY → STALE / SUPERSEDED`.
Core / Memory: `DRAFT → REVIEW_REQUIRED → APPROVED → SUPERSEDED`.

Statuses are plain validated fields; there is no local lifecycle engine. Transitions are enforced where they happen (`approveBrandCore`). An approved version never goes back to DRAFT; a change creates a new version.

Note: `REVIEW_REQUIRED` is both a document status and a Guardian outcome. They are different concepts and never interchangeable.

## Approval and decision events

`approveBrandCore({ proposal, snapshot, tenant, resolvedActor, activeCore, approvedAt })`:

- **Preparation vs approval.** A proposal may be prepared from a READY or STALE Snapshot (STALE adds a review signal). Approval is stricter: the reference Snapshot must be `READY`, otherwise `CORE_APPROVAL_REQUIRES_READY_SNAPSHOT`. An already APPROVED Core is unaffected when its Snapshot later becomes STALE: the brand context stays `READY` and carries `BRAND_SNAPSHOT_STALE` in `review_signals`.
- **`resolvedActor` - trust boundary.** It must come from the trusted server / Socle context and **must never be built from an untrusted client payload**. Branding performs **no authentication and no cryptographic verification**; it only checks that an actor is present, belongs to the same tenant and holds an authorized role (OWNER or AUTHORIZED_REVIEWER). Whoever constructs `resolved_actor` carries the trust. This stays an **open dependency on Nordla Identity**, which does not exist yet.
- Returns `{ approvedCore, supersededCore, decisionEvent, reviewSignals }` - the approved Core, the previous Core marked `SUPERSEDED` (a V2 must supersede the active V1 - two APPROVED Cores can never coexist), and a minimal **decision event** (`BRAND_CORE_APPROVED`, deterministic id, actor, subject, supersedes) shaped to map onto the future Socle Decision Ledger;
- persists nothing and creates no second approval system.

## Non-goals of this foundation

No web research, no LLM, no image generation, no budget decisions, no campaign calendar, no publication, no merchant-specific rules.

Those capabilities are layered later against this contract.


## Brand Snapshot V1 engine

Implemented in `src/branding/snapshot.js`.

The Snapshot engine is deliberately bounded:

- at most 3 direct competitors by default (`DEFAULT_MAX_DIRECT_COMPETITORS`, overridable per research plan);
- no continuous crawling;
- research is limited to four decision-relevant questions;
- every source is typed;
- competitor evidence must belong to the explicit research plan;
- FACT claims require observed/derived evidence;
- HYPOTHESIS never becomes FACT automatically;
- conflicting structured claims are surfaced as contradictions;
- missing answers become explicit evidence gaps rather than invented conclusions;
- material refresh events make the Snapshot STALE but never rewrite Brand Core.

The four V1 questions are:

1. who are the relevant direct competitors;
2. how do those competitors position themselves;
3. what do customers appear to value or reject;
4. what evidence materially challenges the current brand.

The research adapter layer is intentionally not implemented here. Search engines, review sources and connectors feed evidence into this contract later; they do not define Branding architecture.


## Brand Core V1 engine

Implemented in `src/branding/core.js`.

Brand Core is a governed human decision, not an automatic summary of Brand Snapshot.

Rules:
- a proposal can only be created from a READY or STALE Snapshot of the same tenant and brand (STALE adds a review signal; DRAFT/SUPERSEDED are refused);
- every cited evidence reference must exist in that Snapshot;
- a proposal is always `REVIEW_REQUIRED`;
- Nordla never auto-approves Brand Core;
- approval requires a READY reference Snapshot, a `resolved_actor` from trusted context (presence, tenant, role only), a timestamp, and produces a decision event;
- an approved Core is immutable;
- changes create a new version that supersedes the previous version;
- a stale Snapshot is surfaced as a review signal to the human reviewer, not as an automatic block;
- the decision packet shows the chosen Core fields and supporting evidence without introducing budget, calendar or marketing decisions.

This keeps Branding responsible for identity governance while Socle retains consequential decision control.
