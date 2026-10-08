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
Machine-readable source of truth. It binds an approved Core to deterministic/qualitative rules, design tokens, semantic context and references to approved assets. Physical production details remain external and are referenced through `production_asset_refs`.

### Brand Guardian
Compliance reporter only. Deterministic checks are planned first; qualitative checks follow when required. Outcomes are PASS / FAIL / REVIEW_REQUIRED / NOT_MEASURABLE.

- **PASS requires full coverage:** every rule of the approved Memory must be controlled. A rule with no usable check is `NOT_MEASURABLE`; an empty rule set is `NOT_MEASURABLE`.
- **Severity is honoured:** a failed `REVIEW` rule yields `REVIEW_REQUIRED`; a failed `BLOCK` rule yields `FAIL`.
- **Method limits:** a model (`MODEL`) can never settle a deterministic rule and can never produce a hard `FAIL` (it is capped to `REVIEW_REQUIRED`). A HYBRID rule needs its non-model part measured.
- **Product fidelity is not duplicated:** `PRODUCT_FIDELITY` rules are settled only by the `creative-fidelity` hard gate (`guardianCheckFromFidelityGate`) or a human.
- Visual composition/layout and AI-look quality stay with Creative Intelligence; the Guardian has no `VISUAL`/`LAYOUT` rule type and no `CUSTOM` operator.

The Guardian never decides publication or execution. `execution_decision` is deliberately null in the report. Socle policy owns the action decision.

## Generic interfaces

`buildBrandContext({ tenant, core, memory, snapshot })` is the gate consumed by other domains. `tenant` is the result of the canonical resolver in `src/tenant` (ADR 0003); Branding never resolves or trusts a client-supplied merchant id, and every document stores a tenant UUID.

If the Core or Memory is missing, unapproved, mismatched or invalid, the context is `GATED` and no brand facts are invented.

`marketingBrandInterface(context)` exposes only what Marketing needs.

`creativeBrandInterface(context)` exposes visual rules, distinctive assets and production-asset references needed by Creative Intelligence.

A STALE or outdated Snapshot adds a non-blocking `review_signals` entry to a READY context; it never gates it.

Marketing and Creative are readers. They do not rewrite Branding documents.

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
