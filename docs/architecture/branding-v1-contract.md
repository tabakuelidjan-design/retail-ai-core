# Nordla Branding V1 — Generic contract

Status: IMPLEMENTING

This document describes the generic contract implemented under `src/branding/`.
It does not contain any merchant-specific brand rule.

## Components

`Brand Snapshot → Brand Core → Brand Memory → Brand Guardian`

### Brand Snapshot
Evidence-facing observation layer. Two separate vocabularies, never merged: a **claim** is FACT / INFERENCE / HYPOTHESIS (`claim_kind`, what Nordla asserts); a piece of **evidence** carries a `provenance` of observed / inferred / derived / unavailable (how the proof was obtained). A FACT must cite at least one `observed` or `derived` evidence. A Snapshot can become STALE after a material refresh trigger, but it cannot silently rewrite Brand Core.

### Brand Core
Small human-governed strategic core. An approved Core requires category, buying context, value proposition, positioning, core promise, reason to believe and at least one concrete exclusion. Priority distinctive assets are limited to three.

### Brand Memory
The approved, versioned, machine-readable operational brand. It is bound to ONE exact approved Core version and holds exactly five categories (see *Brand Memory V1* below). It stores references, never binaries and never the truth of a claim or product fact.

### Brand Guardian
Compliance reporter only. Deterministic checks are planned first; qualitative checks follow when required. Outcomes are PASS / FAIL / REVIEW_REQUIRED / NOT_MEASURABLE.

- **PASS requires full coverage:** every rule of the approved Memory must be controlled. A rule with no usable check is `NOT_MEASURABLE`; an empty rule set is `NOT_MEASURABLE`.
- **Severity is honoured:** a failed `REVIEW` rule yields `REVIEW_REQUIRED`; a failed `BLOCK` rule yields `FAIL`.
- **Method limits:** hard rules are deterministic by construction, so a `MODEL` judgment can never settle one (it is ignored and the rule stays `NOT_MEASURABLE`). Allowed methods: `DETERMINISTIC`, `OCR`, `HUMAN` for ordinary rules; `FIDELITY_GATE`, `HUMAN` for external gates.
- **Scope:** a rule scoped to `TEXT`/`IMAGE`/`VIDEO`/`DOCUMENT` is owed only by a candidate of that `contentKind`; `GLOBAL` is always owed. Skipped rules are listed in `not_applicable_rule_ids`; without a `contentKind` every rule is owed.
- **Product fidelity is not duplicated:** an `EXTERNAL_GATE` rule (first gate: `product_fidelity`) is settled only by the `creative-fidelity` hard gate via `guardianCheckFromFidelityGate`, or by a human.
- Visual composition/layout and AI-look quality stay with Creative Intelligence; there is no `VISUAL`/`LAYOUT`/`TONE` rule type and no `CUSTOM` operator.

The Guardian never decides publication or execution. `execution_decision` is deliberately null in the report. Socle policy owns the action decision.

## Brand Memory V1

Implemented in `src/branding/memory.js`, `hard-rules.js`, `candidate-manifest.js`; structural schema in `schemas/branding/brand-memory-v1.schema.json`.

### The five categories (nothing else may enter)

| Category | Content |
|---|---|
| `identity_references` | `primary_logo_ref`, `approved_logo_refs[]`, `distinctive_asset_refs[]` - opaque refs, no binaries, no DAM. A logo is never mandatory. `distinctive_asset_refs` must come from the Core's `distinctive_assets[].asset_ref` (referenced, not re-declared). |
| `design_tokens` | `colors` (`#RRGGBB`, normalized uppercase, unique values) and `typography` (`family`, integer `weights` 1-1000). No spacing/radius/shadow/grid/motion. |
| `hard_rules` | Verifiable rules only (below). |
| `semantic_context` | `voice_traits`, `do`, `dont`, `brand_style_summary`, `on_brand_examples`, `off_brand_examples`. Qualitative expectations live here, never in hard rules. |
| `external_references` | `production_asset_refs` (future Production Asset Registry), `claim_refs` (`claim://`, future Claims Registry), `policy_refs` (`external-policy://`). References only. |

Unknown keys are refused at every level, so budget, strategy, competitors, catalog, pricing, scores, etc. cannot be smuggled in.

### Hard rule contract

`{ id, rule_type, subject, operator, value, severity, scope, source_ref }` - every field validated, no extra field allowed.

- **rule_type** (exactly six): `ASSET_REF`, `COLOR`, `TYPOGRAPHY`, `TEXT`, `CLAIM_REF`, `EXTERNAL_GATE`.
- **operator** (exactly seven): `EQUALS`, `ONE_OF`, `CONTAINS`, `NOT_CONTAINS`, `MATCHES_PATTERN`, `REQUIRED`, `STATUS_IN`. No `CUSTOM`, `EXECUTE_CODE`, `PROMPT` or `LLM_DECIDE`.
- **Matrix** (`HARD_RULE_MATRIX`, any other pair is refused): `ASSET_REF`/`COLOR`/`TYPOGRAPHY`/`CLAIM_REF` -> `EQUALS`, `ONE_OF`, `REQUIRED`; `TEXT` -> `CONTAINS`, `NOT_CONTAINS`, `MATCHES_PATTERN`, `REQUIRED`; `EXTERNAL_GATE` -> `STATUS_IN`, `REQUIRED`.
- **value**: shaped by type and operator (hex color, `claim://` ref, opaque asset ref, text, pattern, list of known gate statuses; `REQUIRED` takes `true`). `MATCHES_PATTERN` is length-capped, must compile, and a nested-quantifier heuristic rejects obvious catastrophic-backtracking patterns.
- **severity**: `BLOCK` (failure -> Guardian `FAIL`) or `REVIEW` (failure -> `REVIEW_REQUIRED`). A required rule with no result is `NOT_MEASURABLE`; no `PASS` is possible with an uncovered rule.
- **scope**: `GLOBAL`, `TEXT`, `IMAGE`, `VIDEO`, `DOCUMENT` (no per-social-platform scope).
- **source_ref** (mandatory, "why does this rule exist?"): `brand-core://`, `decision://`, `approved-asset://`, `claim://` or `external-policy://`. A missing or non-standard one is refused (`HARD_RULE_SOURCE_REF_REQUIRED`).
- **EXTERNAL_GATE** consumes a canonical gate computed elsewhere; the subject must be a registered gate (`EXTERNAL_GATES`, V1: `product_fidelity` -> `creative-fidelity`) and `STATUS_IN` values must be statuses of that gate. Branding never recomputes it.
- `CLAIM_REF` stores a `claim://` reference, never the claim's truth.

### Core <-> Memory binding

Memory references an exact `core_ref { id, version }`. It requires an APPROVED Core of the same tenant. When the tenant's active Core is not the Memory's `core_ref` (e.g. Core V2 approved while Memory is still on Core V1), validation reports `BRAND_MEMORY_CORE_MISMATCH` and the Brand Context is `GATED`. A new Memory version for the new Core supersedes the old Memory. A STALE Snapshot is NOT a mismatch: compatible Core + Memory stay `READY` with `BRAND_SNAPSHOT_STALE` in `review_signals`.

### Governed flow (no local lifecycle framework)

`buildBrandMemoryDraft` (DRAFT) -> `validateBrandMemory` -> `submitBrandMemoryForReview` (REVIEW_REQUIRED) -> `approveBrandMemory` (APPROVED) -> `proposeBrandMemoryRevision` (new version, REVIEW_REQUIRED) ; `selectActiveBrandMemory` refuses two APPROVED Memories for one tenant. Transitions are checked inside these functions.

`approveBrandMemory({ memory, core, tenant, resolvedActor, activeMemory, approvedAt })` has the same trust model as Core approval: `resolvedActor` comes from the trusted server / Socle context and **must never be built from an untrusted client payload**; Branding authenticates nobody and checks only presence, tenant and role (OWNER / AUTHORIZED_REVIEWER). It persists nothing and returns `{ approvedMemory, supersededMemory, decisionEvent }`. The event reuses the Core decision-event model with type `BRAND_MEMORY_APPROVED`. An empty Memory cannot be submitted. An APPROVED version is deeply frozen; a revision never mutates it.

### Candidate manifest (contract only)

`normalizeCandidateManifest` fixes the input the Guardian evaluates rules against: `content_kind`, `asset_refs[]`, `detected_colors[]`, `typography[]`, `text_content`, `claim_refs[]`, `external_gate_results[]`. Future adapters (OCR, color extraction, font detection, creative-fidelity) fill it. Evaluating rules against the manifest is **deferred to Guardian V1**; only the shape is validated here.

### Schema

`schemas/branding/brand-memory-v1.schema.json` describes the normalized document structure. It is executed in tests by `validateJsonSchemaLite` (`json-schema-lite.js`, no dependency: NDR-P10 build-own-when-cheap), which refuses any schema keyword it does not enforce. The type x operator matrix, value shapes, Core binding and token-name rules live in code only; a test fails if the schema enums drift from the code constants.

## Generic interfaces

`buildBrandContext({ tenant, core, memory, snapshot })` is the gate consumed by other domains. `tenant` is the result of the canonical resolver in `src/tenant` (ADR 0003); Branding never resolves or trusts a client-supplied merchant id, and every document stores a tenant UUID.

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
- Returns the approved Core, the previous Core marked `SUPERSEDED` (a V2 must supersede the active V1 - two APPROVED Cores can never coexist), and a minimal **decision event** (`BRAND_CORE_APPROVED`, deterministic id, actor, subject, supersedes) shaped to map onto the future Socle Decision Ledger;
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
- a proposal can only be created from a READY or STALE Snapshot of the same tenant (STALE adds a review signal; DRAFT/SUPERSEDED are refused);
- every cited evidence reference must exist in that Snapshot;
- a proposal is always `REVIEW_REQUIRED`;
- Nordla never auto-approves Brand Core;
- approval requires a READY reference Snapshot, a `resolved_actor` from trusted context (presence, tenant, role only), a timestamp, and produces a decision event;
- an approved Core is immutable;
- changes create a new version that supersedes the previous version;
- a stale Snapshot is surfaced as a review signal to the human reviewer, not as an automatic block;
- the decision packet shows the chosen Core fields and supporting evidence without introducing budget, calendar or marketing decisions.

This keeps Branding responsible for identity governance while Socle retains consequential decision control.
