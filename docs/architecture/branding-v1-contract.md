# Nordla Branding V1 — Generic contract

Status: IMPLEMENTING

This document describes the generic contract implemented under `src/branding/`.
It does not contain any merchant-specific brand rule.

## Components

`Brand Snapshot → Brand Core → Brand Memory → Brand Guardian`

### Brand Snapshot
Evidence-facing observation layer. Findings are explicitly FACT, INFERENCE or HYPOTHESIS and reference provenance. A Snapshot can become STALE after a material refresh trigger, but it cannot silently rewrite Brand Core.

### Brand Core
Small human-governed strategic core. An approved Core requires category, buying context, value proposition, positioning, core promise, reason to believe and at least one concrete exclusion. Priority distinctive assets are limited to three.

### Brand Memory
Machine-readable source of truth. It binds an approved Core to deterministic/qualitative rules, design tokens, semantic context and references to approved assets. Physical production details remain external and are referenced through `production_asset_refs`.

### Brand Guardian
Compliance reporter only. Deterministic checks are planned first; qualitative checks follow when required. Guardian outcomes are PASS / FAIL / REVIEW_REQUIRED / NOT_MEASURABLE.

The Guardian never decides publication or execution. `execution_decision` is deliberately null in the report. Socle policy owns the action decision.

## Generic interfaces

`buildBrandContext({ core, memory })` is the gate consumed by other domains.

If the Core or Memory is missing, unapproved, mismatched or invalid, the context is `GATED` and no brand facts are invented.

`marketingBrandInterface(context)` exposes only what Marketing needs.

`creativeBrandInterface(context)` exposes visual rules, distinctive assets and production-asset references needed by Creative Intelligence.

Marketing and Creative are readers. They do not rewrite Branding documents.

## Lifecycle

Snapshot:
`DRAFT → READY → STALE/SUPERSEDED`

Core / Memory:
`DRAFT → REVIEW_REQUIRED → APPROVED → SUPERSEDED`

An approved version never goes back to DRAFT. A change creates a new version.

## Non-goals of this foundation

No web research, no LLM, no image generation, no budget decisions, no campaign calendar, no publication, no merchant-specific rules.

Those capabilities are layered later against this contract.


## Brand Snapshot V1 engine

Implemented in `src/branding/snapshot.js`.

The Snapshot engine is deliberately bounded:

- maximum 3 direct competitors in the V1 research plan;
- no continuous crawling;
- research is limited to four decision-relevant questions;
- every source is typed;
- competitor evidence must belong to the explicit research plan;
- FACT claims require concrete evidence references;
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
