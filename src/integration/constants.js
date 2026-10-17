// Nordla pre-China integration layer: the shared vocabulary every cross-module handoff uses. Additive: no existing module imports this, and this file imports no module.
// Governing decisions: NDR-002 (domains provide facts/levers, not final decisions), NDR-008 (deterministic numbers), NDR-009 (consequential actions need human approval),
// NDR-010 (provenance, tenant isolation, observability are Socle), NDR-014/15/16 (Branding, Creative, Sales Development separate from Marketing).

export const INTEGRATION_VERSION = 'nordla-integration-pre-china.v1';

export const MODULE = Object.freeze({
  CORE: 'CORE', IDENTITY: 'IDENTITY', SOCLE_DECISION: 'SOCLE_DECISION',
  BRANDING: 'BRANDING', MARKETING: 'MARKETING', CREATIVE: 'CREATIVE', ACTIVATION: 'ACTIVATION', GROWTH: 'GROWTH',
  CHINA_SOURCING: 'CHINA_SOURCING', BUYING: 'BUYING', FINANCE: 'FINANCE', STOCK_SALES: 'STOCK_SALES',
  ANALYTICS: 'ANALYTICS', PARLE_A_NORDLA: 'PARLE_A_NORDLA', SOCIAL_PUBLISHING: 'SOCIAL_PUBLISHING',
});

/** The real objects whose authority must live in exactly one module. */
export const ENTITY = Object.freeze({
  PRODUCT: 'PRODUCT', SUPPLIER: 'SUPPLIER', CUSTOMER: 'CUSTOMER', ORDER: 'ORDER', PURCHASE: 'PURCHASE', INVOICE: 'INVOICE', PAYMENT: 'PAYMENT',
  STOCK: 'STOCK', CAMPAIGN: 'CAMPAIGN', CREATIVE_ASSET: 'CREATIVE_ASSET', BRAND_PROFILE: 'BRAND_PROFILE', SOURCING_CASE: 'SOURCING_CASE',
  FINANCIAL_FACT: 'FINANCIAL_FACT', CLAIM_EVIDENCE: 'CLAIM_EVIDENCE', SOCIAL_POST: 'SOCIAL_POST',
});

/** Identity kinds used in cross-module references (tenant_id IS merchant_id: src/tenant/index.js has no separate tenant id). */
export const ID_KIND = Object.freeze({
  TENANT: 'tenant', MERCHANT: 'merchant', PRODUCT: 'product', VARIANT: 'variant', SUPPLIER: 'supplier', CUSTOMER: 'customer', ORDER: 'order',
  SOURCING_CASE: 'sourcing_case', PURCHASE: 'purchase', INVOICE: 'invoice', CAMPAIGN: 'campaign', ASSET: 'asset', RUN: 'run',
});

export const PROVENANCE = Object.freeze({
  USER_PROVIDED: 'USER_PROVIDED', SUPPLIER_CLAIM: 'SUPPLIER_CLAIM', DOCUMENT_OBSERVED: 'DOCUMENT_OBSERVED', IMAGE_OBSERVED: 'IMAGE_OBSERVED',
  SYSTEM_DERIVED: 'SYSTEM_DERIVED', VERIFIED: 'VERIFIED', ESTIMATED: 'ESTIMATED', UNKNOWN: 'UNKNOWN', CONFLICT: 'CONFLICT',
});

export const LEVEL = Object.freeze({
  READ_ONLY: 'READ_ONLY', AUTO_SAFE: 'AUTO_SAFE', OWNER_REVIEW: 'OWNER_REVIEW', OWNER_APPROVAL_REQUIRED: 'OWNER_APPROVAL_REQUIRED', BLOCKED: 'BLOCKED',
});

export const DEP = Object.freeze({ HARD: 'HARD', SOFT: 'SOFT', OPTIONAL: 'OPTIONAL', HISTORICAL_ONLY: 'HISTORICAL_ONLY' });

export const ERR = Object.freeze({
  MODULE_NOT_AVAILABLE: 'MODULE_NOT_AVAILABLE', COMMAND_NOT_AVAILABLE: 'COMMAND_NOT_AVAILABLE',
  IDENTITY_CONFLICT: 'IDENTITY_CONFLICT', IDENTITY_AMBIGUOUS: 'IDENTITY_AMBIGUOUS', IDENTITY_UNKNOWN: 'IDENTITY_UNKNOWN',
  OWNERSHIP_VIOLATION: 'OWNERSHIP_VIOLATION', PROVENANCE_PROMOTION_REFUSED: 'PROVENANCE_PROMOTION_REFUSED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED', APPROVER_NOT_HUMAN: 'APPROVER_NOT_HUMAN', ACTION_BLOCKED: 'ACTION_BLOCKED', ACTION_UNKNOWN: 'ACTION_UNKNOWN',
  CURRENCY_CONFLICT: 'CURRENCY_CONFLICT', STOCK_CLAIM_UNSUPPORTED: 'STOCK_CLAIM_UNSUPPORTED', CLAIM_NOT_APPROVED: 'CLAIM_NOT_APPROVED',
  NOT_A_BUY_CANDIDATE: 'NOT_A_BUY_CANDIDATE', TENANT_MISMATCH: 'TENANT_MISMATCH', HANDOFF_INVALID: 'HANDOFF_INVALID', PROVIDER_CALL_REFUSED: 'PROVIDER_CALL_REFUSED',
});

export class IntegrationError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'IntegrationError'; this.code = code; this.detail = detail; }
}
export const fail = (code, message, detail) => { throw new IntegrationError(code, message, detail); };
export const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
