import {
  BRAND_RULE_TYPE,
  CONTENT_KIND,
  GOVERNED_DOCUMENT_STATUS,
  GUARDIAN_METHOD,
  GUARDIAN_OUTCOME,
  RULE_SCOPE,
  RULE_SEVERITY,
} from './constants.js';
import { resolveBrand } from './brand.js';
import { EXTERNAL_GATES } from './hard-rules.js';
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

// Which methods may settle a hard rule. Hard rules are deterministic by construction, so a model
// judgment can never settle one; an external gate (product fidelity) is settled only by the
// creative-fidelity gate adapter or a human, never by an ad-hoc check.
function allowedMethods(rule) {
  if (rule.rule_type === BRAND_RULE_TYPE.EXTERNAL_GATE) return [M.FIDELITY_GATE, M.HUMAN];
  return [M.DETERMINISTIC, M.OCR, M.HUMAN];
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

  let outcome = worst(usable.map((check) => check.outcome));
  // Severity REVIEW downgrades a hard failure to a human review request.
  if (outcome === GUARDIAN_OUTCOME.FAIL && rule.severity === RULE_SEVERITY.REVIEW) {
    outcome = GUARDIAN_OUTCOME.REVIEW_REQUIRED;
  }
  return { outcome, reason: null, ignored };
}

const appliesTo = (rule, contentKind) => (
  contentKind == null || rule.scope === RULE_SCOPE.GLOBAL || rule.scope === contentKind
);

export function buildGuardianPlan(memory, { contentKind = null } = {}) {
  if (contentKind != null) enumValue(contentKind, CONTENT_KIND, 'contentKind');
  const rules = (memory?.hard_rules ?? [])
    .filter((rule) => appliesTo(rule, contentKind))
    .map((rule) => Object.freeze({
      rule_id: rule.id,
      rule_type: rule.rule_type,
      severity: rule.severity,
      scope: rule.scope,
      allowed_methods: Object.freeze(allowedMethods(rule)),
      ...(rule.rule_type === BRAND_RULE_TYPE.EXTERNAL_GATE
        ? { delegate_to: EXTERNAL_GATES[rule.subject]?.source ?? null }
        : {}),
    }));
  return Object.freeze({ rules: Object.freeze(rules) });
}

export function buildGuardianReport(input) {
  assertObject(input, 'guardian_report');
  const { memory, tenant, brand } = input;
  // The brand is NEVER inferred from the candidate: it comes from the resolved brand, and must
  // be the one the approved Memory belongs to. A candidate manifest cannot carry a brand_id.
  if ('brand_id' in input) throw new TypeError('guardian_report.brand_id is not accepted: pass the resolved brand');
  assertObject(memory, 'guardian_report.memory');
  if (memory.status !== GOVERNED_DOCUMENT_STATUS.APPROVED) {
    throw new Error('GUARDIAN_REQUIRES_APPROVED_MEMORY');
  }
  assertSameTenant(tenant, memory.merchant_id, 'GUARDIAN_TENANT_MISMATCH');
  const { brandId } = resolveBrand(tenant, brand, { requireActive: false });
  if (memory.brand_id !== brandId) throw new Error('GUARDIAN_BRAND_MISMATCH');

  const checks = objectList(input.checks, 'guardian_report.checks', normalizeGuardianCheck);
  uniqueIds(checks, 'guardian_report.checks');

  const ruleIds = new Set(memory.hard_rules.map((rule) => rule.id));
  for (const check of checks) {
    if (!ruleIds.has(check.rule_id)) throw new Error('GUARDIAN_CHECK_REFERENCES_UNKNOWN_RULE');
  }

  if (input.contentKind != null) enumValue(input.contentKind, CONTENT_KIND, 'contentKind');
  const applicable = memory.hard_rules.filter((rule) => appliesTo(rule, input.contentKind));
  const notApplicable = memory.hard_rules.filter((rule) => !appliesTo(rule, input.contentKind));

  const rules = applicable.map((rule) => {
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
    brand_id: brandId,
    memory_ref: Object.freeze({ id: memory.id, version: memory.version }),
    target_ref: requiredString(input.target_ref, 'guardian_report.target_ref'),
    created_at: isoDate(input.created_at, 'guardian_report.created_at'),
    checks,
    rules: Object.freeze(rules),
    not_applicable_rule_ids: Object.freeze(notApplicable.map((rule) => rule.id)),
    // Every required rule must be controlled for PASS; an empty rule set is NOT_MEASURABLE.
    outcome: aggregateGuardianOutcome(rules),
    execution_decision: null,
    policy_note: 'GUARDIAN_REPORT_IS_NOT_AN_EXECUTION_POLICY_DECISION',
  });
}
