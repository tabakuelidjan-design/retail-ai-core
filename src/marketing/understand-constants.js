// Marketing M1 - UNDERSTAND foundation: closed vocabularies and stable error codes.
// Nothing here is merchant-specific (NDR-020). Every governed contract is a CLOSED schema: an unknown key is refused.

export const UNDERSTAND_VERSION = 'marketing-m1-understand.v1';

// ---- MarketSignal ----
// INTERNAL_MEASUREMENT  a structured internal measurement. Never causal truth by itself.
// EXTERNAL_SIGNAL       something observed in the outside world. Never a fact about the merchant.
// MANUAL_OBSERVATION    a traced human observation. Qualitative evidence, never statistical proof.
export const SIGNAL_CLASS = Object.freeze({
  INTERNAL_MEASUREMENT: 'INTERNAL_MEASUREMENT',
  EXTERNAL_SIGNAL: 'EXTERNAL_SIGNAL',
  MANUAL_OBSERVATION: 'MANUAL_OBSERVATION',
});

// Always carried by the signal (and therefore by any Finding that cites it).
export const SIGNAL_CLASS_LIMITATION = Object.freeze({
  INTERNAL_MEASUREMENT: 'INTERNAL_MEASUREMENT_IS_NOT_CAUSAL_PROOF',
  EXTERNAL_SIGNAL: 'EXTERNAL_SIGNAL_IS_NOT_A_MERCHANT_FACT',
  MANUAL_OBSERVATION: 'MANUAL_OBSERVATION_IS_NOT_STATISTICAL_PROOF',
});

// Documentation-only examples. The core never branches on a signal_type (no per-radar logic in M1).
export const RESERVED_SIGNAL_TYPES = Object.freeze([
  'MARKETING_MEASUREMENT', 'SOCIAL_TREND', 'SEARCH_DEMAND', 'STORE_OBSERVATION', 'REPUTATION', 'LOCAL_EVENT', 'LOST_DEMAND',
]);

// Added by a Finding that cites a signal which had already expired when the Finding was created.
export const CITED_SIGNAL_EXPIRED = 'CITED_SIGNAL_EXPIRED';

export const FRESHNESS = Object.freeze({ FRESH: 'FRESH', STALE: 'STALE' });

// ---- Materiality ----
export const MATERIALITY_AXIS = Object.freeze({
  ECONOMIC: 'ECONOMIC',
  CUSTOMER: 'CUSTOMER',
  STRATEGIC: 'STRATEGIC',
  RISK: 'RISK',
  OPERATIONAL: 'OPERATIONAL',
});

export const MATERIALITY_STATUS = Object.freeze({
  MATERIAL: 'MATERIAL',
  NOT_MATERIAL: 'NOT_MATERIAL',
  UNKNOWN: 'UNKNOWN',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
});

export const MATERIALITY_OVERALL = Object.freeze({
  MATERIAL: 'MATERIAL',
  NOT_MATERIAL: 'NOT_MATERIAL',
  UNKNOWN: 'UNKNOWN',
});

// An axis the caller did not assess is UNKNOWN, never silently NOT_MATERIAL.
export const AXIS_NOT_ASSESSED = 'AXIS_NOT_ASSESSED';

// ---- Domain Fit ----
export const DOMAIN_FIT_STATUS = Object.freeze({
  MARKETING_RELEVANT: 'MARKETING_RELEVANT',
  REFER_TO_DOMAIN: 'REFER_TO_DOMAIN',
  NO_MATERIAL_SIGNAL: 'NO_MATERIAL_SIGNAL',
  NOT_MEASURABLE: 'NOT_MEASURABLE',
});

// Closed registry of the destinations Marketing may refer a problem to: exactly the approved Level-2 domain map of
// NORDLA-CANONICAL-ARCHITECTURE.md (there is no code-level registry, so none is duplicated), minus MARKETING itself - a
// problem is never referred back to the domain that is referring it. A new owner (e.g. customers, site/commerce,
// operations) would need a separate architecture decision; it is not added here.
export const TARGET_DOMAIN = Object.freeze({
  FINANCE: 'FINANCE',
  ANALYSES: 'ANALYSES',
  SALES: 'SALES',
  INVENTORY: 'INVENTORY',
  BUYING_SUPPLIERS: 'BUYING_SUPPLIERS',
  BRANDING: 'BRANDING',
  SALES_DEVELOPMENT: 'SALES_DEVELOPMENT',
  COMPLIANCE: 'COMPLIANCE',
  AFTER_SALES_SERVICE: 'AFTER_SALES_SERVICE',
});

// Categories of read-only input a MarketingContext may carry. These are INPUT categories, not domain identities:
// SALES, INVENTORY and FINANCE happen to share the name of the canonical Level-2 domain that owns the data, but
// OPERATIONAL_CAPACITY is only a kind of fact (work/machine/time capacity) and is NOT a Nordla domain. What a fact is
// about (a product, a segment...) belongs to its fact_key / subject_ref, never to the category name. The real owners stay
// external to M1; the context only consumes their trusted, owner-computed facts and refs.
export const CONTEXT_INPUT_CATEGORY = Object.freeze({
  SALES: 'SALES',
  INVENTORY: 'INVENTORY',
  FINANCE: 'FINANCE',
  OPERATIONAL_CAPACITY: 'OPERATIONAL_CAPACITY',
});

// ---- Finding / Hypothesis ----
export const FINDING_TYPE = Object.freeze({
  PROBLEM: 'PROBLEM',
  OPPORTUNITY: 'OPPORTUNITY',
  NO_MATERIAL_SIGNAL: 'NO_MATERIAL_SIGNAL',
  NOT_MEASURABLE: 'NOT_MEASURABLE',
});

export const TESTABILITY = Object.freeze({
  TESTABLE_NOW: 'TESTABLE_NOW',
  TESTABLE_LATER: 'TESTABLE_LATER',
  NOT_TESTABLE: 'NOT_TESTABLE',
  UNKNOWN: 'UNKNOWN',
});

export const READINESS = Object.freeze({
  READY_FOR_BUILD: 'READY_FOR_BUILD',
  REFER_TO_DOMAIN: 'REFER_TO_DOMAIN',
  NO_MATERIAL_SIGNAL: 'NO_MATERIAL_SIGNAL',
  NOT_MEASURABLE: 'NOT_MEASURABLE',
  STALE: 'STALE',
});

// ---- Stable error codes: one code per condition ----
export const MKT_ERROR = Object.freeze({
  UNKNOWN_KEY: 'MKT_UNKNOWN_KEY',
  INVALID_FIELD: 'MKT_INVALID_FIELD',
  INVALID_TIMESTAMP: 'MKT_INVALID_TIMESTAMP',
  TENANT_INVALID: 'MKT_TENANT_INVALID',
  DUPLICATE_ENTRY: 'MKT_DUPLICATE_ENTRY',
  CAUSAL_CLAIM_FORBIDDEN: 'MKT_CAUSAL_CLAIM_FORBIDDEN',
  BRAND_IDENTITY_INVALID: 'MKT_BRAND_IDENTITY_INVALID',
  BRAND_INACTIVE: 'MKT_BRAND_INACTIVE',

  SIGNAL_TENANT_MISMATCH: 'MKT_SIGNAL_TENANT_MISMATCH',
  SIGNAL_BRAND_MISMATCH: 'MKT_SIGNAL_BRAND_MISMATCH',
  SIGNAL_INVALID_CLASS: 'MKT_SIGNAL_INVALID_CLASS',
  SIGNAL_INVALID_TYPE: 'MKT_SIGNAL_INVALID_TYPE',
  SIGNAL_SOURCE_REQUIRED: 'MKT_SIGNAL_SOURCE_REQUIRED',
  SIGNAL_INVALID_EXPIRY: 'MKT_SIGNAL_INVALID_EXPIRY',
  SIGNAL_INVALID_OBSERVED_AT: 'MKT_SIGNAL_INVALID_OBSERVED_AT',
  SIGNAL_INVALID_EFFECTIVE_WINDOW: 'MKT_SIGNAL_INVALID_EFFECTIVE_WINDOW',

  CONTEXT_TENANT_MISMATCH: 'MKT_CONTEXT_TENANT_MISMATCH',
  CONTEXT_BRAND_NOT_READY: 'MKT_CONTEXT_BRAND_NOT_READY',
  CONTEXT_BRAND_MISMATCH: 'MKT_CONTEXT_BRAND_MISMATCH',
  CONTEXT_DUPLICATE_SIGNAL: 'MKT_CONTEXT_DUPLICATE_SIGNAL',

  MATERIALITY_INVALID_AXIS: 'MKT_MATERIALITY_INVALID_AXIS',
  MATERIALITY_INVALID_STATUS: 'MKT_MATERIALITY_INVALID_STATUS',
  MATERIALITY_REASON_REQUIRED: 'MKT_MATERIALITY_REASON_REQUIRED',
  MATERIALITY_EVIDENCE_REQUIRED: 'MKT_MATERIALITY_EVIDENCE_REQUIRED',
  MATERIALITY_OVERALL_MISMATCH: 'MKT_MATERIALITY_OVERALL_MISMATCH',

  DOMAIN_FIT_INVALID_STATUS: 'MKT_DOMAIN_FIT_INVALID_STATUS',
  DOMAIN_FIT_REASON_REQUIRED: 'MKT_DOMAIN_FIT_REASON_REQUIRED',
  DOMAIN_FIT_TARGET_REQUIRED: 'MKT_DOMAIN_FIT_TARGET_REQUIRED',
  DOMAIN_FIT_UNKNOWN_TARGET: 'MKT_DOMAIN_FIT_UNKNOWN_TARGET',
  DOMAIN_FIT_TARGET_NOT_ALLOWED: 'MKT_DOMAIN_FIT_TARGET_NOT_ALLOWED',
  DOMAIN_FIT_EVIDENCE_REQUIRED: 'MKT_DOMAIN_FIT_EVIDENCE_REQUIRED',

  FINDING_TENANT_MISMATCH: 'MKT_FINDING_TENANT_MISMATCH',
  FINDING_BRAND_MISMATCH: 'MKT_FINDING_BRAND_MISMATCH',
  FINDING_CONTEXT_INVALID: 'MKT_FINDING_CONTEXT_INVALID',
  FINDING_INVALID_TYPE: 'MKT_FINDING_INVALID_TYPE',
  FINDING_SUBJECT_REQUIRED: 'MKT_FINDING_SUBJECT_REQUIRED',
  FINDING_EVIDENCE_REQUIRED: 'MKT_FINDING_EVIDENCE_REQUIRED',
  FINDING_DATA_GAP_REQUIRED: 'MKT_FINDING_DATA_GAP_REQUIRED',
  FINDING_INVALID_EXPIRY: 'MKT_FINDING_INVALID_EXPIRY',
  FINDING_INVALID_WINDOW: 'MKT_FINDING_INVALID_WINDOW',
  FINDING_IS_IS_NOT_CONFLICT: 'MKT_FINDING_IS_IS_NOT_CONFLICT',
  FINDING_EVIDENCE_SIGNAL_EXPIRED: 'MKT_FINDING_EVIDENCE_SIGNAL_EXPIRED',
  FINDING_OUTLIVES_EVIDENCE: 'MKT_FINDING_OUTLIVES_EVIDENCE',

  HYPOTHESIS_INVALID_TESTABILITY: 'MKT_HYPOTHESIS_INVALID_TESTABILITY',
});

export class MarketingUnderstandError extends Error {
  /** @param {string} code one of MKT_ERROR @param {string} message never contains submitted values @param {object} [detail] non-secret context */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'MarketingUnderstandError';
    this.code = code;
    this.detail = detail;
  }
}
