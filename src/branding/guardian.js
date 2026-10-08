import {
  BRAND_RULE_TYPE,
  GOVERNED_DOCUMENT_STATUS,
  GUARDIAN_METHOD,
  GUARDIAN_OUTCOME,
  RULE_ENFORCEMENT,
  RULE_SEVERITY,
} from './constants.js';
import {
  assertObject,
  assertSameTenant,
  enumValue,
  isoDate,
  objectList,
  optionalString,
  requiredString,
  stringList,
  uniqueIds,
} from './validation.js';
// Guardian CONSUMES the creative-fidelity hard gate; it never re-implements product fidelity.
import { FIDELITY_GATE_OUTCOME } from '../creative-fidelity/constants.js';

const M = GUARDIAN_METHOD;

// Which methods may settle a rule. A deterministic rule can never be settled by a model;
// product fidelity is owned by creative-fidelity (or a human), never by an ad-hoc check.
function allowedMethods(rule) {
  if (rule.rule_type === BRAND_RULE_TYPE.PRODUCT_FIDELITY) return [M.FIDELITY_GATE, M.HUMAN];
  switch (rule.enforcement) {
    case RULE_ENFORCEMENT.DETERMINISTIC: return [M.DETERMINISTIC, M.OCR, M.FIDELITY_GATE, M.HUMAN];
    case RULE_ENFORCEMENT.QUALITATIVE: return [M.MODEL, M.HUMAN];
    default: return [M.DETERMINISTIC, M.OCR, M.FIDELITY_GATE, M.MODEL, M.HUMAN];
  }
}

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

// Adapter: turn the result of creative-fidelity's evaluateHardFidelityGate into a Guardian check.
export function guardianCheckFromFidelityGate({ id, ruleId, gate }) {
  assertObject(gate, 'gate');
  const outcome = {
    [FIDELITY_GATE_OUTCOME.PASS]: GUARDIAN_OUTCOME.PASS,
    [FIDELITY_GATE_OUTCOME.FAIL]: GUARDIAN_OUTCOME.FAIL,
    [FIDELITY_GATE_OUTCOME.NOT_MEASURABLE]: GUARDIAN_OUTCOME.NOT_MEASURABLE,
  }[gate.outcome];
  if (!outcome) throw new TypeError(`unsupported fidelity gate outcome: ${gate.outcome}`);
  const codes = [
    ...(gate.failures ?? []).map((item) => `failed:${item.code}`),
    ...(gate.missing ?? []).map((code) => `missing:${code}`),
  ];
  return normalizeGuardianCheck({
    id,
    rule_id: ruleId,
    outcome,
    method: M.FIDELITY_GATE,
    evidence_refs: [],
    note: codes.length ? codes.join(',') : null,
  });
}

const RANK = Object.freeze({
  [GUARDIAN_OUTCOME.FAIL]: 4,
  [GUARDIAN_OUTCOME.REVIEW_REQUIRED]: 3,
  [GUARDIAN_OUTCOME.NOT_MEASURABLE]: 2,
  [GUARDIAN_OUTCOME.PASS]: 1,
});

const worst = (outcomes) => outcomes.reduce(
  (acc, outcome) => (RANK[outcome] > RANK[acc] ? outcome : acc),
  GUARDIAN_OUTCOME.PASS,
);

// PASS is only possible when at least one outcome exists and every one of them passes.
export function aggregateGuardianOutcome(items = []) {
  if (!Array.isArray(items) || items.length === 0) return GUARDIAN_OUTCOME.NOT_MEASURABLE;
  return worst(items.map((item) => item.outcome));
}

function evaluateRule(rule, checks) {
  const allowed = allowedMethods(rule);
  const usable = checks.filter((check) => allowed.includes(check.method));
  const ignored = checks.filter((check) => !allowed.includes(check.method));

  if (usable.length === 0) {
    return { outcome: GUARDIAN_OUTCOME.NOT_MEASURABLE, reason: 'RULE_NOT_CHECKED', ignored };
  }

  const effective = usable.map((check) => {
    // A model judgment can only ask for review; a hard FAIL needs a deterministic/human/gate check.
    if (check.method === M.MODEL && check.outcome === GUARDIAN_OUTCOME.FAIL) {
      return GUARDIAN_OUTCOME.REVIEW_REQUIRED;
    }
    return check.outcome;
  });
  let outcome = worst(effective);
  // Severity REVIEW downgrades a hard failure to a human review request.
  if (outcome === GUARDIAN_OUTCOME.FAIL && rule.severity === RULE_SEVERITY.REVIEW) {
    outcome = GUARDIAN_OUTCOME.REVIEW_REQUIRED;
  }
  // HYBRID rules need their deterministic part measured: a lone model PASS is not enough.
  if (
    outcome === GUARDIAN_OUTCOME.PASS
    && rule.enforcement === RULE_ENFORCEMENT.HYBRID
    && !usable.some((check) => check.method !== M.MODEL)
  ) {
    outcome = GUARDIAN_OUTCOME.NOT_MEASURABLE;
  }
  return { outcome, reason: null, ignored };
}

export function buildGuardianPlan(memory) {
  const phase1 = [];
  const phase2 = [];

  for (const rule of memory?.hard_rules ?? []) {
    const base = {
      rule_id: rule.id,
      severity: rule.severity,
      rule_type: rule.rule_type,
      allowed_methods: Object.freeze(allowedMethods(rule)),
      ...(rule.rule_type === BRAND_RULE_TYPE.PRODUCT_FIDELITY
        ? { delegate_to: 'creative-fidelity' }
        : {}),
    };
    if (rule.enforcement !== RULE_ENFORCEMENT.QUALITATIVE) {
      phase1.push(Object.freeze({ ...base, enforcement: rule.enforcement }));
    }
    if (
      rule.enforcement !== RULE_ENFORCEMENT.DETERMINISTIC
      && rule.rule_type !== BRAND_RULE_TYPE.PRODUCT_FIDELITY
    ) {
      phase2.push(Object.freeze({
        ...base,
        enforcement: RULE_ENFORCEMENT.QUALITATIVE,
        ...(rule.enforcement === RULE_ENFORCEMENT.HYBRID ? { fallback_only: true } : {}),
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
  const { memory, tenant } = input;
  assertObject(memory, 'guardian_report.memory');
  if (memory.status !== GOVERNED_DOCUMENT_STATUS.APPROVED) {
    throw new Error('GUARDIAN_REQUIRES_APPROVED_MEMORY');
  }
  assertSameTenant(tenant, memory.merchant_id, 'GUARDIAN_TENANT_MISMATCH');

  const checks = objectList(input.checks, 'guardian_report.checks', normalizeGuardianCheck);
  uniqueIds(checks, 'guardian_report.checks');

  const ruleIds = new Set(memory.hard_rules.map((rule) => rule.id));
  for (const check of checks) {
    if (!ruleIds.has(check.rule_id)) throw new Error('GUARDIAN_CHECK_REFERENCES_UNKNOWN_RULE');
  }

  const rules = memory.hard_rules.map((rule) => {
    const result = evaluateRule(rule, checks.filter((check) => check.rule_id === rule.id));
    return Object.freeze({
      rule_id: rule.id,
      outcome: result.outcome,
      reason: result.reason,
      ignored_check_ids: Object.freeze(result.ignored.map((check) => check.id)),
    });
  });

  return Object.freeze({
    id: requiredString(input.id, 'guardian_report.id'),
    merchant_id: memory.merchant_id,
    memory_ref: Object.freeze({ id: memory.id, version: memory.version }),
    target_ref: requiredString(input.target_ref, 'guardian_report.target_ref'),
    created_at: isoDate(input.created_at, 'guardian_report.created_at'),
    checks,
    rules: Object.freeze(rules),
    // Every required rule must be controlled for PASS; an empty rule set is NOT_MEASURABLE.
    outcome: aggregateGuardianOutcome(rules),
    execution_decision: null,
    policy_note: 'GUARDIAN_REPORT_IS_NOT_AN_EXECUTION_POLICY_DECISION',
  });
}
