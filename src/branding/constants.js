export const BRANDING_VERSION = '1.0';

export const SNAPSHOT_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  READY: 'READY',
  STALE: 'STALE',
  SUPERSEDED: 'SUPERSEDED',
});

export const GOVERNED_DOCUMENT_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  APPROVED: 'APPROVED',
  SUPERSEDED: 'SUPERSEDED',
});

// Status of a CLAIM (what Nordla asserts). Never a property of the proof itself.
export const CLAIM_KIND = Object.freeze({
  FACT: 'FACT',
  INFERENCE: 'INFERENCE',
  HYPOTHESIS: 'HYPOTHESIS',
});

// Status of the EVIDENCE (how the proof was obtained). Vocabulary aligned with
// the Marketing provenance words, but deliberately NOT imported from Marketing
// (Branding stays separate, NDR-014) and NOT merged with CLAIM_KIND.
export const EVIDENCE_PROVENANCE = Object.freeze({
  OBSERVED: 'observed',
  INFERRED: 'inferred',
  DERIVED: 'derived',
  UNAVAILABLE: 'unavailable',
});

// Only these provenances can support a FACT claim.
export const FACT_SUPPORTING_PROVENANCE = Object.freeze([
  EVIDENCE_PROVENANCE.OBSERVED,
  EVIDENCE_PROVENANCE.DERIVED,
]);

export const DECISION_EVENT_TYPE = Object.freeze({
  BRAND_CORE_APPROVED: 'BRAND_CORE_APPROVED',
  BRAND_MEMORY_APPROVED: 'BRAND_MEMORY_APPROVED',
});

export const APPROVER_ROLE = Object.freeze({
  OWNER: 'OWNER',
  AUTHORIZED_REVIEWER: 'AUTHORIZED_REVIEWER',
});

export const EVIDENCE_COMPLETENESS = Object.freeze({
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  UNAVAILABLE: 'UNAVAILABLE',
});

export const SNAPSHOT_SOURCE_KIND = Object.freeze({
  MERCHANT_PROVIDED: 'MERCHANT_PROVIDED',
  OWNED_SURFACE: 'OWNED_SURFACE',
  INTERNAL_FACT: 'INTERNAL_FACT',
  CUSTOMER_REVIEW: 'CUSTOMER_REVIEW',
  DIRECT_COMPETITOR: 'DIRECT_COMPETITOR',
  PUBLIC_REFERENCE: 'PUBLIC_REFERENCE',
});

export const SNAPSHOT_TOPIC = Object.freeze({
  CATEGORY: 'CATEGORY',
  POSITIONING: 'POSITIONING',
  MESSAGE: 'MESSAGE',
  COMPETITOR: 'COMPETITOR',
  COMPETITOR_POSITIONING: 'COMPETITOR_POSITIONING',
  CUSTOMER_EXPECTATION: 'CUSTOMER_EXPECTATION',
  VISIBLE_ASSET: 'VISIBLE_ASSET',
  CORE_CHALLENGE: 'CORE_CHALLENGE',
});

export const SNAPSHOT_RESEARCH_QUESTION = Object.freeze({
  WHO_COMPETES: 'WHO_COMPETES',
  HOW_COMPETITORS_POSITION: 'HOW_COMPETITORS_POSITION',
  WHAT_CUSTOMERS_VALUE_OR_REJECT: 'WHAT_CUSTOMERS_VALUE_OR_REJECT',
  WHAT_CHALLENGES_CURRENT_BRAND: 'WHAT_CHALLENGES_CURRENT_BRAND',
});

export const SNAPSHOT_COVERAGE_STATUS = Object.freeze({
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  UNAVAILABLE: 'UNAVAILABLE',
});

export const SNAPSHOT_REFRESH_TRIGGER = Object.freeze({
  NEW_RELEVANT_COMPETITOR: 'NEW_RELEVANT_COMPETITOR',
  CUSTOMER_REVIEW_SIGNAL_CHANGED: 'CUSTOMER_REVIEW_SIGNAL_CHANGED',
  OFFER_PORTFOLIO_CHANGED: 'OFFER_PORTFOLIO_CHANGED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
});

export const DISTINCTIVE_ASSET_TYPE = Object.freeze({
  LOGO: 'LOGO',
  SYMBOL: 'SYMBOL',
  COLOR: 'COLOR',
  TYPOGRAPHY: 'TYPOGRAPHY',
  SHAPE: 'SHAPE',
  PATTERN: 'PATTERN',
  PACKAGING: 'PACKAGING',
  PHOTOGRAPHY_STYLE: 'PHOTOGRAPHY_STYLE',
  VERBAL_CUE: 'VERBAL_CUE',
  OTHER: 'OTHER',
});

// Hard rules are verifiable by construction: exactly these six types in V1.
export const BRAND_RULE_TYPE = Object.freeze({
  ASSET_REF: 'ASSET_REF',
  COLOR: 'COLOR',
  TYPOGRAPHY: 'TYPOGRAPHY',
  TEXT: 'TEXT',
  CLAIM_REF: 'CLAIM_REF',
  EXTERNAL_GATE: 'EXTERNAL_GATE',
});

// What a candidate asset is (candidate manifest) ...
export const CONTENT_KIND = Object.freeze({
  TEXT: 'TEXT',
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
  DOCUMENT: 'DOCUMENT',
});

// ... and which candidates a rule applies to. No per-social-platform scope in V1.
export const RULE_SCOPE = Object.freeze({
  GLOBAL: 'GLOBAL',
  ...CONTENT_KIND,
});

export const RULE_SEVERITY = Object.freeze({
  BLOCK: 'BLOCK',
  REVIEW: 'REVIEW',
});

// No CUSTOM / EXECUTE_CODE / PROMPT / LLM_DECIDE: no non-deterministic escape hatch.
export const RULE_OPERATOR = Object.freeze({
  EQUALS: 'EQUALS',
  ONE_OF: 'ONE_OF',
  CONTAINS: 'CONTAINS',
  NOT_CONTAINS: 'NOT_CONTAINS',
  REQUIRED: 'REQUIRED',
  STATUS_IN: 'STATUS_IN',
});

export const GUARDIAN_OUTCOME = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  NOT_MEASURABLE: 'NOT_MEASURABLE',
});

export const GUARDIAN_METHOD = Object.freeze({
  DETERMINISTIC: 'DETERMINISTIC',
  OCR: 'OCR',
  // Result of the existing creative-fidelity hard gate (consumed, never re-implemented).
  FIDELITY_GATE: 'FIDELITY_GATE',
  // Advisory AI/VLM judgment (e.g. against semantic_context). It can never settle a hard rule.
  MODEL: 'MODEL',
  HUMAN: 'HUMAN',
});

export const BRAND_CONTEXT_STATUS = Object.freeze({
  READY: 'READY',
  GATED: 'GATED',
});

// Non-blocking signals attached to a READY brand context.
export const BRAND_REVIEW_SIGNAL = Object.freeze({
  SNAPSHOT_STALE: 'BRAND_SNAPSHOT_STALE',
  SNAPSHOT_SUPERSEDED_BY_NEWER: 'BRAND_SNAPSHOT_REFERENCE_OUTDATED',
});

// Brand Identity is a light referential, not a governed document: it is either in use or retired.
export const BRAND_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
});
