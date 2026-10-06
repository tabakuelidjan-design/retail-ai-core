// Socle Decision V0 - shared vocabulary. Pure data, no behaviour.

export const SUBJECT_STATUS = Object.freeze({
  TO_VERIFY: 'TO_VERIFY',
  TO_DECIDE: 'TO_DECIDE',
  IN_PROGRESS: 'IN_PROGRESS',
  RESULT: 'RESULT',
  DISMISSED: 'DISMISSED',
});

// Internal property of a Subject, not separate public objects.
export const SUBJECT_KIND = Object.freeze({ ANOMALY: 'anomaly', GAP: 'gap', RISK: 'risk', OPPORTUNITY: 'opportunity' });

// Subject types used to validate the engine (the engine itself is type-agnostic).
export const SUBJECT_TYPE = Object.freeze({
  DORMANT_INVENTORY: 'DORMANT_INVENTORY',
  CASH_FLOOR_RISK: 'CASH_FLOOR_RISK',
  FOOTFALL_DECLINE: 'FOOTFALL_DECLINE',
});

export const FACT_QUALITY = Object.freeze({ OK: 'OK', SUSPECT: 'SUSPECT' });

export const CONFIDENCE = Object.freeze({ LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' });
export const RISK = Object.freeze({ LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' });
export const REVERSIBILITY = Object.freeze({
  REVERSIBLE: 'REVERSIBLE',
  PARTIALLY_REVERSIBLE: 'PARTIALLY_REVERSIBLE',
  IRREVERSIBLE: 'IRREVERSIBLE',
});

export const LEVER_TYPE = Object.freeze({ ACTION: 'ACTION', DO_NOTHING: 'DO_NOTHING', TEST_SMALL: 'TEST_SMALL' });
export const REQUIRED_APPROVAL = Object.freeze({ NONE: 'NONE', MANAGER: 'MANAGER', OWNER: 'OWNER' });

export const RULE_RESULT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', NEEDS_HUMAN: 'NEEDS_HUMAN' });
export const RULE_TYPE = Object.freeze({
  MIN_CASH: 'MIN_CASH',
  MIN_MARGIN: 'MIN_MARGIN',
  MAX_DISCOUNT: 'MAX_DISCOUNT',
  MAX_BUDGET: 'MAX_BUDGET',
  MAX_CAPACITY: 'MAX_CAPACITY',
  MAX_RISK: 'MAX_RISK',
});

// Common comparison axes. Units stay separate - there is no combined score.
export const AXES = Object.freeze([
  'cash_impact', // currency, + is better
  'margin_impact', // currency, + is better
  'time_to_cash_days', // days, lower is better
  'capacity_impact', // capacity units consumed, lower is better
  'inventory_impact', // units, direction set by the decision profile
  'risk', // LOW > MEDIUM > HIGH
  'reversibility', // REVERSIBLE > PARTIALLY_REVERSIBLE > IRREVERSIBLE
  'confidence', // HIGH > MEDIUM > LOW
]);

export const DECISION_OUTCOME = Object.freeze({ RECOMMENDED: 'RECOMMENDED', TO_VERIFY: 'TO_VERIFY' });
export const RECOMMENDATION_KIND = Object.freeze({
  ACTION: 'ACTION',
  COMBINED: 'COMBINED',
  TEST_SMALL: 'TEST_SMALL',
  DO_NOTHING: 'DO_NOTHING',
});

export const APPROVAL_STATUS = Object.freeze({
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  AWAITING_HUMAN_DECISION: 'AWAITING_HUMAN_DECISION',
  NEEDS_HUMAN_INPUT: 'NEEDS_HUMAN_INPUT',
});

export const HUMAN_DECISION = Object.freeze({
  APPROVED: 'APPROVED',
  APPROVED_ALTERNATIVE: 'APPROVED_ALTERNATIVE',
  REJECTED: 'REJECTED',
  DEFERRED: 'DEFERRED',
});

export const OUTCOME_RESULT = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  SUGGESTIVE: 'SUGGESTIVE',
  REFUTED: 'REFUTED',
  NOT_MEASURABLE: 'NOT_MEASURABLE',
  UNKNOWN: 'UNKNOWN',
});
export const EVIDENCE_LEVEL = Object.freeze({ NONE: 'NONE', WEAK: 'WEAK', MODERATE: 'MODERATE', STRONG: 'STRONG' });
