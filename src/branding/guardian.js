import {
  GUARDIAN_METHOD,
  GUARDIAN_OUTCOME,
  RULE_ENFORCEMENT,
} from './constants.js';
import {
  assertObject,
  enumValue,
  isoDate,
  objectList,
  optionalString,
  requiredString,
  stringList,
  uniqueIds,
} from './validation.js';

export function normalizeGuardianCheck(input, field = 'check') {
  assertObject(input, field);
  return Object.freeze({
    id: requiredString(input.id, `${field}.id`),
    rule_id: requiredString(input.rule_id, `${field}.rule_id`),
    outcome: enumValue(input.outcome, GUARDIAN_OUTCOME, `${field}.outcome`),
    method: enumValue(input.method, GUARDIAN_METHOD, `${field}.method`),
    evidence_refs: stringList(input.evidence_refs, `${field}.evidence_refs`),
    note: optionalString(input.note, `${field}.note`),
  });
}

export function aggregateGuardianOutcome(checks = []) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return GUARDIAN_OUTCOME.NOT_MEASURABLE;
  }
  if (checks.some((check) => check.outcome === GUARDIAN_OUTCOME.FAIL)) {
    return GUARDIAN_OUTCOME.FAIL;
  }
  if (checks.some((check) => check.outcome === GUARDIAN_OUTCOME.REVIEW_REQUIRED)) {
    return GUARDIAN_OUTCOME.REVIEW_REQUIRED;
  }
  if (checks.some((check) => check.outcome === GUARDIAN_OUTCOME.NOT_MEASURABLE)) {
    return GUARDIAN_OUTCOME.NOT_MEASURABLE;
  }
  return GUARDIAN_OUTCOME.PASS;
}

export function buildGuardianPlan(memory) {
  const phase1 = [];
  const phase2 = [];

  for (const rule of memory?.hard_rules ?? []) {
    const target = rule.enforcement === RULE_ENFORCEMENT.QUALITATIVE ? phase2 : phase1;
    target.push(Object.freeze({
      rule_id: rule.id,
      enforcement: rule.enforcement,
      severity: rule.severity,
      rule_type: rule.rule_type,
    }));
    if (rule.enforcement === RULE_ENFORCEMENT.HYBRID) {
      phase2.push(Object.freeze({
        rule_id: rule.id,
        enforcement: RULE_ENFORCEMENT.QUALITATIVE,
        severity: rule.severity,
        rule_type: rule.rule_type,
        fallback_only: true,
      }));
    }
  }

  return Object.freeze({
    deterministic_first: Object.freeze(phase1),
    qualitative_second: Object.freeze(phase2),
  });
}

export function buildGuardianReport(input) {
  assertObject(input, 'guardian_report');
  assertObject(input.memory_ref, 'guardian_report.memory_ref');

  const checks = objectList(input.checks, 'guardian_report.checks', normalizeGuardianCheck);
  uniqueIds(checks, 'guardian_report.checks');

  return Object.freeze({
    id: requiredString(input.id, 'guardian_report.id'),
    merchant_id: requiredString(input.merchant_id, 'guardian_report.merchant_id'),
    memory_ref: Object.freeze({
      id: requiredString(input.memory_ref.id, 'guardian_report.memory_ref.id'),
      version: input.memory_ref.version,
    }),
    target_ref: requiredString(input.target_ref, 'guardian_report.target_ref'),
    created_at: isoDate(input.created_at, 'guardian_report.created_at'),
    checks,
    outcome: aggregateGuardianOutcome(checks),
    execution_decision: null,
    policy_note: 'GUARDIAN_REPORT_IS_NOT_AN_EXECUTION_POLICY_DECISION',
  });
}
