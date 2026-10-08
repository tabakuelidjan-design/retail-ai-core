# Nordla Branding V1 — Scope final après revue équipe

- **Status:** APPROVED WITH CHANGES — READY FOR BUILD
- **Date:** 2026-10-08
- **Scope:** Branding domain only
- **Canonical chain:** Brand Snapshot → Brand Core → Brand Memory → Brand Guardian

## 1. Purpose

Nordla Branding is not a standalone branding application, agency toolkit, DAM or brand-consulting suite.

Its purpose is narrower:

> provide Marketing and Creative Intelligence with a reliable, current and enforceable description of the brand, then verify brand/product compliance before execution.

Branding does not decide campaign budget, channel, timing, offer or commercial priority.

## 2. Final V1 scope

### 2.1 Brand Snapshot

Purpose: understand the current brand reality with enough evidence to support Brand Core.

Inputs may include:
- merchant-provided brand documents and assets;
- current website/storefront;
- actual products/offers/prices;
- real customer reviews available to Nordla;
- a small set of relevant direct competitors;
- existing public brand presence;
- internal sales/customer/product facts when relevant.

Outputs:
- current positioning as observed;
- current promise/messages;
- category and immediate competitors;
- recurring customer expectations/pain points supported by evidence;
- visible brand assets and repeated cues;
- contradictions/inconsistencies;
- evidence gaps;
- FACT / INFERENCE / HYPOTHESIS labels;
- provenance and freshness.

V1 anti-scope:
- no mass social listening;
- no broad market-intelligence crawler;
- no large-scale opinion study;
- no automatic global competitor universe.

Default competitor scope should stay small and decision-relevant.

Brand Snapshot is not onboarding-only. It can be refreshed when a material trigger occurs.

Initial refresh triggers:
1. a new relevant competitor is detected or manually added;
2. a meaningful customer-review signal changes;
3. the merchant materially changes or pivots the offer/product portfolio.

A refresh emits a review signal. It does not silently rewrite Brand Core.

### 2.2 Brand Core

Purpose: store the small set of human-approved strategic brand decisions that Marketing and Creative must respect.

V1 fields:
- category / market frame;
- primary audience or buying context;
- value proposition;
- positioning;
- core promise;
- reasons to believe;
- personality / voice;
- concrete exclusions: what the brand refuses to do/say/look like;
- 2–3 priority Distinctive Brand Assets where known;
- validation state;
- version and provenance.

Avoid abstract value lists that cannot be operationalized.

Brand Core is human-approved. Nordla may propose changes but cannot silently rewrite it.

### 2.3 Brand Memory

Purpose: machine-readable source of truth consumed by Marketing and Creative Intelligence.

Hard structured rules:
- approved logo assets and variants;
- colors;
- typography;
- spacing/sizing rules where relevant;
- mandatory/forbidden wording;
- approved claims;
- price/offer presentation rules where brand-specific;
- image/video style constraints;
- priority distinctive assets;
- prohibited visual cues;
- approved asset references;
- version/provenance.

Semantic context:
- tone;
- personality;
- examples of on-brand / off-brand communication;
- explanation of non-deterministic style rules.

Implementation direction:
- strict JSON Schema for hard rules;
- design-token-compatible representation for visual tokens;
- semantic context stored separately from deterministic rules;
- Marketing and Creative read Brand Memory but do not directly rewrite it;
- changes require the Branding path and human approval.

If Brand Memory is absent, invalid or not approved:
- no brand facts may be invented;
- dependent capabilities return GATED / NOT_MEASURABLE where brand compliance is required.

### 2.4 Physical assets / substrate boundary

Brand Memory must NOT become the production database.

Physical production facts such as:
- exact printable dimensions;
- substrate material;
- machine-safe zones;
- bleed;
- fixture/template geometry;
- raw product source photos;
- packaging dimensions;

belong to a shared Asset / Production Registry.

Brand Memory may reference those records when they are relevant to brand or product fidelity.

This keeps Branding small while allowing Creative Intelligence to produce physically executable work.

### 2.5 Brand Guardian

Purpose: assess compliance with Brand Memory and real-product invariants.

Guardian responsibilities:
- logo compliance;
- approved colors;
- typography rules where deterministically testable;
- mandatory/forbidden text;
- price/offer correctness when supplied as canonical facts;
- product identity/fidelity checks;
- prohibited brand cues;
- tone compliance when a qualitative model is necessary.

Deterministic checks run first wherever possible:
- schema/rule validation;
- exact text and regex checks;
- structured-layout checks;
- color/contrast checks when technically reliable;
- asset identity/hash/reference checks;
- OCR/text comparison when needed;
- product-fidelity checks using declared invariants.

AI/VLM checks are reserved for qualitative or visually ambiguous cases.

Guardian outcomes:
- PASS
- FAIL
- REVIEW_REQUIRED
- NOT_MEASURABLE

The Guardian itself does not publish, block publication or override the owner.

A separate Socle policy decides whether a Guardian outcome:
- allows execution;
- requires human approval;
- blocks execution until an explicit authorized override.

Overrides, where policy permits them, are logged with actor, reason, time and provenance.

## 3. Boundary with Creative Intelligence

Brand Guardian:
- brand compliance;
- product-realism/invariant compliance;
- mandatory/forbidden brand rules.

Creative Intelligence:
- composition quality;
- artistic quality;
- finishing;
- visual hierarchy;
- readability as creative execution;
- AI-look/artifact quality;
- channel-specific creative adaptation.

Creative Intelligence may expose quality results to Guardian/Socle, but Guardian does not become the creative art director.

## 4. Boundary with Marketing

Branding answers:
- who/what is the brand;
- what must remain coherent;
- what is allowed/forbidden;
- what evidence says the current brand reality is.

Marketing answers:
- what to push;
- why;
- for whom;
- with what offer/message;
- on which channel;
- when;
- with what budget;
- what success/failure means.

Branding never makes budget or calendar decisions.

## 5. Merchant-specific configuration rule

Nordla Branding remains fully merchant-generic.

Any company-specific:
- colors;
- typography;
- logos;
- visual prohibitions;
- wording rules;
- product/price presentation rules;
- approved claims;
- distinctive assets;
- visual preferences;

must live in that merchant's Brand Memory/configuration and must never be hard-coded into the generic Branding domain.

## 6. Research boundary

Brand Snapshot research is intentionally narrow.

V1 asks only:
1. who are the relevant direct competitors;
2. how do they position themselves;
3. what do real customers appear to value/reject;
4. what evidence materially challenges the current Brand Core.

External research is triggered by a decision need or refresh trigger, not performed continuously without purpose.

## 7. Operating loop

The flow is circular, not one-time:

Brand Snapshot
  → proposes evidence / contradictions
  → Brand Core review
  → Brand Memory update after approval
  → Marketing / Creative consume
  → Brand Guardian checks execution
  → execution / measurement
  → new evidence may trigger Brand Snapshot refresh

No block silently rewrites another block.

## 8. V1 non-goals

Do not build now:
- complete naming laboratory;
- trademark-management suite;
- enterprise DAM;
- financial brand valuation;
- mass social listening;
- autonomous logo generator product;
- large-scale consumer research platform;
- full competitor-intelligence platform;
- full channel-guideline library;
- autonomous brand evolution.

## 9. Build order

1. Brand Snapshot V1 schema + evidence/provenance contract
2. Brand Core V1 schema + approval/versioning
3. Brand Memory V1 schema + hard/semantic split
4. shared Asset/Production Registry references
5. Brand Guardian deterministic checks
6. qualitative Guardian checks only where deterministic checks cannot decide
7. Socle policy integration for PASS / FAIL / REVIEW_REQUIRED / NOT_MEASURABLE
8. merchant configuration fixtures for testing, never generic logic

## 10. Acceptance criterion

Branding V1 is complete enough when:

- Marketing can consume a validated Brand Memory without inventing brand facts;
- Creative Intelligence can obtain the exact brand constraints and product/asset references it needs;
- Brand Guardian can deterministically catch material brand-rule violations where the rule is machine-testable;
- uncertain qualitative cases remain REVIEW_REQUIRED / NOT_MEASURABLE rather than fabricated;
- a material change in market/customer/offer evidence can trigger a Brand Core review without silently changing the brand;
- merchant-specific rules remain configuration only.
