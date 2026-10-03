// China Sourcing Intelligence - field mode V0. Vocabulary shared by every module. ISOMORPHIC (no Node API): the same files run in the server, the tests
// and the phone browser (offline). Nothing here is a legal conclusion: these are the labels that keep facts, claims and estimates apart.

/** What KIND of statement an output is. Never merged: a supplier claim stays a supplier claim, an estimate stays an estimate. */
export const FACT_CLASS = Object.freeze({
  VERIFIED_FACT: 'VERIFIED_FACT', // read from an official source / document we can point to (still: the existence of a document is not compliance)
  OBSERVED_MARKET_DATA: 'OBSERVED_MARKET_DATA', // a price/listing/review seen on a marketplace at a time
  SUPPLIER_CLAIM: 'SUPPLIER_CLAIM', // stated by the supplier (quote, datasheet, label, certificate they supply)
  CALCULATED_VALUE: 'CALCULATED_VALUE', // deterministic arithmetic over the inputs above
  ESTIMATE: 'ESTIMATE', // an explicit estimate (range, rule of thumb) supplied by the user or a documented heuristic
  ASSUMPTION: 'ASSUMPTION', // something Nordla or the user assumed so a calculation can run
  UNKNOWN: 'UNKNOWN',
  REQUIRES_AUTHORITY_CONFIRMATION: 'REQUIRES_AUTHORITY_CONFIRMATION', // only an authority / notified body / expert can settle it
});

/** How a product-identity attribute is known. Ordered by strength (see IDENTITY_RANK). */
export const IDENTITY_LEVEL = Object.freeze({
  PROBABLE: 'PROBABLE', // inferred from a category profile or keywords
  AI_SUGGESTED: 'AI_SUGGESTED', // suggested by an AI model from a photo or label: never a fact until the owner or a document confirms it
  SUPPLIER_CLAIMED: 'SUPPLIER_CLAIMED', // the supplier says so (verbally, in a listing, on a quote)
  USER_STATED: 'USER_STATED', // the owner typed it after looking at the product
  VERIFIED_BY_SUPPLIER_DOCUMENT: 'VERIFIED_BY_SUPPLIER_DOCUMENT', // stated consistently in a supplier document that was inspected
  VERIFIED_OFFICIAL: 'VERIFIED_OFFICIAL', // confirmed by an official source / authority record
});
export const IDENTITY_RANK = Object.freeze({ PROBABLE: 1, AI_SUGGESTED: 1.5, SUPPLIER_CLAIMED: 2, USER_STATED: 3, VERIFIED_BY_SUPPLIER_DOCUMENT: 4, VERIFIED_OFFICIAL: 5 });

/** Where a piece of external data came from, and how fresh it is. Cached data is never presented as live. */
export const DATA_MODE = Object.freeze({ LIVE_VERIFIED: 'LIVE_VERIFIED', CACHED: 'CACHED', OFFLINE_VERIFICATION_REQUIRED: 'OFFLINE_VERIFICATION_REQUIRED', MANUAL: 'MANUAL' });

export const RULE_STATUS = Object.freeze({
  APPLIES: 'APPLIES', // the identity facts established so far make the rule apply
  NOT_APPLICABLE: 'NOT_APPLICABLE', // the identity facts established so far exclude it
  UNRESOLVED: 'UNRESOLVED', // not enough identity evidence to decide: stays unresolved, never assumed
});

export const REQUIREMENT = Object.freeze({ REQUIRED: 'REQUIRED', CONDITIONAL: 'CONDITIONAL', RECOMMENDED: 'RECOMMENDED', NOT_APPLICABLE: 'NOT_APPLICABLE', UNKNOWN: 'UNKNOWN' });

export const TRAFFIC = Object.freeze({ GREEN: 'GREEN', AMBER: 'AMBER', RED: 'RED', UNKNOWN: 'UNKNOWN' });
export const VERDICT = Object.freeze({ GO: 'GO', CONDITIONAL_GO: 'CONDITIONAL_GO', NO_GO: 'NO_GO', INSUFFICIENT_INFORMATION: 'INSUFFICIENT_INFORMATION' });

export const BLOCKER = Object.freeze({
  LEGAL_REQUIREMENT_UNRESOLVED: 'LEGAL_REQUIREMENT_UNRESOLVED',
  REQUIRED_DOCUMENT_MISSING: 'REQUIRED_DOCUMENT_MISSING',
  PRODUCT_IDENTITY_UNRESOLVED: 'PRODUCT_IDENTITY_UNRESOLVED',
  SAFETY_ALERT_EXACT_MATCH: 'SAFETY_ALERT_EXACT_MATCH',
  AMAZON_CATEGORY_RESTRICTION: 'AMAZON_CATEGORY_RESTRICTION',
  NEGATIVE_UNIT_ECONOMICS: 'NEGATIVE_UNIT_ECONOMICS',
  CRITICAL_COST_UNKNOWN: 'CRITICAL_COST_UNKNOWN',
  DOCUMENT_CONTRADICTS_CASE: 'DOCUMENT_CONTRADICTS_CASE',
  OWN_BRAND_MANUFACTURER_DUTIES: 'OWN_BRAND_MANUFACTURER_DUTIES',
});

/** Document findings. Wording is deliberate: nothing here says "fake" - only what the evidence shows. */
export const DOC_FINDING = Object.freeze({
  MODEL_MISMATCH: 'MODEL_MISMATCH', MANUFACTURER_MISMATCH: 'MANUFACTURER_MISMATCH', PRODUCT_MISMATCH: 'PRODUCT_MISMATCH', MISSING_PAGES: 'MISSING_PAGES',
  EXPIRED_OR_DATE_CONCERN: 'EXPIRED_OR_DATE_CONCERN', UNRELATED_STANDARD: 'UNRELATED_STANDARD', INCOMPLETE_DECLARATION: 'INCOMPLETE_DECLARATION', UNKNOWN_LAB: 'UNKNOWN_LAB',
  DOCUMENT_TYPE_MISREPRESENTED: 'DOCUMENT_TYPE_MISREPRESENTED', INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE', OCR_UNCONFIRMED: 'OCR_UNCONFIRMED',
});
export const DOC_CONSISTENCY = Object.freeze({ NO_ISSUE_FOUND: 'NO_ISSUE_FOUND', INCONSISTENT: 'INCONSISTENT', SUSPICIOUS: 'SUSPICIOUS', UNVERIFIED: 'UNVERIFIED', INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE' });
