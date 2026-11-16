import { createHash } from 'node:crypto';
import {
  BRAND_CONTEXT_STATUS,
  BRAND_REVIEW_SIGNAL,
  BRAND_RULE_TYPE as T,
  GUARDIAN_OUTCOME as OUT,
  GUARDIAN_REASON as R,
  GUARDIAN_SIGNAL,
  OBSERVATION_COVERAGE as COVERAGE,
  RULE_OPERATOR as OP,
  RULE_SCOPE,
  RULE_SEVERITY,
  SEMANTIC_METHOD,
  SEMANTIC_OUTCOME,
} from './constants.js';
import { normalizeCandidateManifest, normalizeMatchText } from './candidate-manifest.js';
import { buildBrandContext } from './interfaces.js';
import {
  assertObject,
  deepFreeze,
  enumValue,
  isoDate,
  optionalString,
  requiredString,
  tenantMerchantId,
} from './validation.js';
import { opaqueRef } from './hard-rules.js';
import { FIDELITY_GATE_OUTCOME } from '../creative-fidelity/constants.js';

// Brand Guardian V1 - a PURE, deterministic compliance engine.
//
//   READY Brand Context  +  Candidate Manifest  ->  Guardian Report
//
// * It evaluates hard rules against structured observations; it never inspects raw media, calls a
//   model, reads a clock, the network or a disk. Same Memory + Manifest + inputs = same report.
// * It never decides to execute or publish (NDR-003/009): `execution_decision` stays null and
//   there is no override / forcePass / publishAnyway. A human observation enters through the
//   manifest (via a trusted adapter), it is not a policy override.
// * Trust boundary: the Candidate Manifest and the semanticAssessment come from trusted adapters / server
//   context (OCR, color extraction, creative-fidelity adapter, a human review tool, a model run...).
//   They must NEVER be built straight from an untrusted client payload. The Guardian is pure: it
//   validates their shape but authenticates neither the manifest nor the assessment, and it cannot
//   tell a truthful observation from a forged one.
// * Product fidelity belongs to creative-fidelity: the Guardian only consumes its status through
//   the `product_fidelity` external gate.
// * Truthfulness of measurement first: a violation is only reported from something that was
//   measured, and PASS only when the measurement is enough to conclude. Anything else is
//   NOT_MEASURABLE (NDR-007) with the reason why.

const CHANNEL = Object.freeze({
  [T.ASSET_REF]: 'assets',
  [T.COLOR]: 'colors',
  [T.TYPOGRAPHY]: 'typography',
  [T.TEXT]: 'text',
  [T.CLAIM_REF]: 'claims',
  [T.EXTERNAL_GATE]: 'external_gates',
});

const VIOLATION = 'VIOLATION'; // raw failure, before severity is applied
const INPUT_KEYS = ['tenant', 'brandContext', 'candidateManifest', 'targetRef', 'evaluatedAt', 'semanticAssessment'];
const MAX_SUMMARY_VALUES = 3;
const MAX_SUMMARY_VALUE = 40;

// ---------------------------------------------------------------- compact, deterministic summaries
const clip = (value) => {
  const text = String(value);
  return text.length > MAX_SUMMARY_VALUE ? `${text.slice(0, MAX_SUMMARY_VALUE)}...` : text;
};

function summarize(observation, extra = '') {
  if (!observation) return 'no observation';
  const base = observation.status !== undefined
    ? `coverage=${observation.coverage} status=${observation.status ?? 'none'}`
    : `coverage=${observation.coverage} values=${observation.values.length}`;
  return extra ? `${base} ${extra}` : base;
}

const offendingSummary = (offending) => (
  offending.length
    ? `offending=${offending.slice(0, MAX_SUMMARY_VALUES).map(clip).join(',')}${offending.length > MAX_SUMMARY_VALUES ? ',...' : ''}`
    : ''
);

// ---------------------------------------------------------------- raw evaluation (no severity yet)
const verdict = (raw, reason, observation, extra = '') => ({
  raw,
  reason,
  evidence_refs: observation ? observation.evidence_refs : [],
  observed_summary: summarize(observation, extra),
});

function evaluateGate(rule, observation) {
  const status = observation?.status ?? null;
  // Absent, unavailable, or "the gate itself could not measure" is never a brand violation.
  if (!observation || observation.coverage === COVERAGE.UNAVAILABLE || status === null
      || status === FIDELITY_GATE_OUTCOME.NOT_MEASURABLE) {
    return verdict(OUT.NOT_MEASURABLE, R.EXTERNAL_GATE_NOT_MEASURED, observation);
  }
  if (rule.operator === OP.REQUIRED) return verdict(OUT.PASS, R.RULE_PASSED, observation);
  // STATUS_IN
  if (!rule.value.includes(status)) {
    return verdict(VIOLATION, R.EXTERNAL_GATE_STATUS_NOT_ALLOWED, observation);
  }
  return observation.coverage === COVERAGE.COMPLETE
    ? verdict(OUT.PASS, R.RULE_PASSED, observation)
    : verdict(OUT.NOT_MEASURABLE, R.MEASUREMENT_PARTIAL, observation);
}

function evaluateText(rule, observation) {
  // Only fragments of the SAME subject are concatenated, then compared after one shared normalization.
  const haystack = normalizeMatchText(observation.values.join('\n'));
  const found = haystack.includes(normalizeMatchText(rule.value));
  const complete = observation.coverage === COVERAGE.COMPLETE;
  const summary = `matched=${found}`;

  if (rule.operator === OP.CONTAINS) {
    if (found) return verdict(OUT.PASS, R.RULE_PASSED, observation, summary);
    return complete
      ? verdict(VIOLATION, R.REQUIRED_TEXT_MISSING, observation, summary)
      : verdict(OUT.NOT_MEASURABLE, R.MEASUREMENT_PARTIAL, observation, summary);
  }
  // NOT_CONTAINS: a partial observation can prove presence of a forbidden text, never its absence.
  if (found) return verdict(VIOLATION, R.FORBIDDEN_TEXT_FOUND, observation, summary);
  return complete
    ? verdict(OUT.PASS, R.RULE_PASSED, observation, summary)
    : verdict(OUT.NOT_MEASURABLE, R.MEASUREMENT_PARTIAL, observation, summary);
}

function evaluateValues(rule, observation) {
  const { values } = observation;
  const complete = observation.coverage === COVERAGE.COMPLETE;

  if (rule.operator === OP.REQUIRED) {
    if (values.length > 0) return verdict(OUT.PASS, R.RULE_PASSED, observation);
    return complete
      ? verdict(VIOLATION, R.REQUIRED_VALUE_MISSING, observation)
      : verdict(OUT.NOT_MEASURABLE, R.MEASUREMENT_PARTIAL, observation);
  }

  // EQUALS / ONE_OF: every observed value of the subject must be allowed.
  const allowed = rule.operator === OP.EQUALS ? [rule.value] : rule.value;
  const offending = values.filter((value) => !allowed.includes(value));
  if (offending.length > 0) {
    const reason = rule.operator === OP.EQUALS ? R.OBSERVED_VALUE_MISMATCH : R.OBSERVED_VALUE_NOT_ALLOWED;
    return verdict(VIOLATION, reason, observation, offendingSummary(offending));
  }
  if (!complete) return verdict(OUT.NOT_MEASURABLE, R.MEASUREMENT_PARTIAL, observation);
  return values.length > 0
    ? verdict(OUT.PASS, R.RULE_PASSED, observation)
    : verdict(VIOLATION, R.REQUIRED_VALUE_MISSING, observation);
}

function evaluateRaw(rule, manifest) {
  const observation = manifest[CHANNEL[rule.rule_type]].find((entry) => entry.subject === rule.subject) ?? null;
  if (rule.rule_type === T.EXTERNAL_GATE) return evaluateGate(rule, observation);
  if (!observation) return verdict(OUT.NOT_MEASURABLE, R.OBSERVATION_NOT_PROVIDED, null);
  if (observation.coverage === COVERAGE.UNAVAILABLE) {
    return verdict(OUT.NOT_MEASURABLE, R.MEASUREMENT_UNAVAILABLE, observation);
  }
  if (rule.rule_type === T.TEXT && rule.operator !== OP.REQUIRED) return evaluateText(rule, observation);
  return evaluateValues(rule, observation);
}

const RANK = Object.freeze({
  [OUT.FAIL]: 4, [OUT.REVIEW_REQUIRED]: 3, [OUT.NOT_MEASURABLE]: 2, [OUT.PASS]: 1,
});
const worst = (outcomes) => outcomes.reduce((acc, o) => (RANK[o] > RANK[acc] ? o : acc), OUT.PASS);

const appliesTo = (rule, contentKind) => rule.scope === RULE_SCOPE.GLOBAL || rule.scope === contentKind;

/**
 * Pure hard-rule evaluation of a Memory against a normalized manifest.
 * Severity is applied here: raw violation + BLOCK -> FAIL, + REVIEW -> REVIEW_REQUIRED;
 * PASS and NOT_MEASURABLE never change with severity.
 */
export function evaluateHardRules(memory, manifest) {
  const applicable = memory.hard_rules.filter((rule) => appliesTo(rule, manifest.content_kind));
  const notApplicable = memory.hard_rules.filter((rule) => !appliesTo(rule, manifest.content_kind));

  const ruleResults = applicable.map((rule) => {
    const raw = evaluateRaw(rule, manifest);
    let outcome = raw.raw;
    if (raw.raw === VIOLATION) {
      outcome = rule.severity === RULE_SEVERITY.BLOCK ? OUT.FAIL : OUT.REVIEW_REQUIRED;
    }
    return {
      rule_id: rule.id,
      subject: rule.subject,
      rule_type: rule.rule_type,
      severity: rule.severity,
      scope: rule.scope,
      outcome,
      reason: raw.reason,
      evidence_refs: [...raw.evidence_refs],
      observed_summary: raw.observed_summary,
    };
  });

  // Zero applicable rule is NOT compliance: nothing was verified.
  const hardOutcome = ruleResults.length === 0 ? OUT.NOT_MEASURABLE : worst(ruleResults.map((r) => r.outcome));
  return deepFreeze({
    rule_results: ruleResults,
    not_applicable_rule_ids: notApplicable.map((rule) => rule.id),
    hard_outcome: hardOutcome,
    hard_outcome_reason: ruleResults.length === 0 ? R.NO_APPLICABLE_HARD_RULES : null,
  });
}

// ---------------------------------------------------------------- semantic lane (advisory)
/**
 * A semantic assessment is produced ELSEWHERE (model or human); Guardian makes no model call.
 * FAIL does not exist in this lane, and it carries no rule id: it can never settle a hard rule.
 */
export function normalizeSemanticAssessment(input) {
  assertObject(input, 'semanticAssessment');
  for (const key of Object.keys(input)) {
    if (!['outcome', 'method', 'evidence_refs', 'note'].includes(key)) {
      throw new TypeError(`semanticAssessment.${key} is not part of the semantic assessment contract`);
    }
  }
  const refs = input.evidence_refs == null ? [] : input.evidence_refs;
  if (!Array.isArray(refs)) throw new TypeError('semanticAssessment.evidence_refs must be an array');
  return deepFreeze({
    outcome: enumValue(input.outcome, SEMANTIC_OUTCOME, 'semanticAssessment.outcome'),
    method: enumValue(input.method, SEMANTIC_METHOD, 'semanticAssessment.method'),
    evidence_refs: refs.map((ref, index) => opaqueRef(ref, `semanticAssessment.evidence_refs[${index}]`)),
    note: optionalString(input.note, 'semanticAssessment.note'),
  });
}

function overallOutcome(hardOutcome, semantic) {
  if (hardOutcome !== OUT.PASS) return hardOutcome; // hard FAIL / REVIEW_REQUIRED / NOT_MEASURABLE dominate
  if (semantic?.outcome === SEMANTIC_OUTCOME.REVIEW_REQUIRED) return OUT.REVIEW_REQUIRED;
  return OUT.PASS; // semantic PASS, absent, or NOT_MEASURABLE (which only raises a signal)
}

// ---------------------------------------------------------------- brand context gate
const KNOWN_SIGNALS = new Set(Object.values(BRAND_REVIEW_SIGNAL));

function assertReadyBrandContext(tenant, brandContext) {
  assertObject(brandContext, 'brandContext');
  if (brandContext.status !== BRAND_CONTEXT_STATUS.READY) {
    throw new Error(`GUARDIAN_REQUIRES_READY_BRAND_CONTEXT: ${(brandContext.reasons ?? []).join(', ') || 'context not ready'}`);
  }
  // Do not trust a READY flag blindly: rebuild the gate from the brand, the approved documents and the
  // tenant. This also verifies that Core and Memory belong to THIS brand (BRAND_CORE_BRAND_MISMATCH,
  // BRAND_MEMORY_BRAND_MISMATCH) and that the brand belongs to the tenant (BRAND_TENANT_MISMATCH).
  const rebuilt = buildBrandContext({
    tenant, brand: brandContext.brand, core: brandContext.core, memory: brandContext.memory,
  });
  if (rebuilt.status !== BRAND_CONTEXT_STATUS.READY) {
    throw new Error(`GUARDIAN_REQUIRES_READY_BRAND_CONTEXT: ${rebuilt.reasons.join(', ')}`);
  }
  const signals = brandContext.review_signals ?? [];
  if (!Array.isArray(signals) || signals.some((signal) => !KNOWN_SIGNALS.has(signal))) {
    throw new TypeError('brandContext.review_signals contains an unknown signal');
  }
  return { signals, brand: rebuilt.brand };
}

/**
 * Evaluate a candidate against the approved Brand Memory.
 * Returns a report; persists nothing, decides nothing, calls nothing.
 */
export function evaluateBrandGuardian(input) {
  assertObject(input, 'guardian input');
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.includes(key)) throw new TypeError(`${key} is not part of the Guardian input`);
  }

  const merchantId = tenantMerchantId(input.tenant);
  // The brand is NEVER inferred from the candidate and is not an input of its own: it comes from the
  // READY Brand Context, which is the single source of truth (no `brand` / `brand_id` input key).
  const { signals: brandReviewSignals, brand } = assertReadyBrandContext(input.tenant, input.brandContext);
  const { core, memory } = input.brandContext;

  // content_kind has ONE source of truth: the manifest.
  const manifest = normalizeCandidateManifest(input.candidateManifest);
  const targetRef = requiredString(input.targetRef, 'targetRef');
  const evaluatedAt = isoDate(input.evaluatedAt, 'evaluatedAt');
  const semantic = input.semanticAssessment == null ? null : normalizeSemanticAssessment(input.semanticAssessment);

  const hard = evaluateHardRules(memory, manifest);
  const guardianSignals = semantic?.outcome === SEMANTIC_OUTCOME.NOT_MEASURABLE
    ? [GUARDIAN_SIGNAL.SEMANTIC_NOT_MEASURABLE]
    : [];

  const body = {
    merchant_id: merchantId,
    brand_id: brand.brand_id,
    core_ref: { id: core.id, version: core.version },
    memory_ref: { id: memory.id, version: memory.version },
    target_ref: targetRef,
    content_kind: manifest.content_kind,
    evaluated_at: evaluatedAt,
  };
  // Deterministic id (no randomness, no clock): derived from the explicit inputs.
  const id = `gr_${createHash('sha256').update(JSON.stringify({ body, manifest, semantic, brandReviewSignals })).digest('hex').slice(0, 32)}`;

  return deepFreeze({
    id,
    ...body,
    rule_results: hard.rule_results,
    not_applicable_rule_ids: hard.not_applicable_rule_ids,
    hard_outcome: hard.hard_outcome,
    hard_outcome_reason: hard.hard_outcome_reason,
    semantic_outcome: semantic ? semantic.outcome : null,
    semantic_assessment: semantic,
    brand_review_signals: [...brandReviewSignals],
    guardian_review_signals: guardianSignals,
    outcome: overallOutcome(hard.hard_outcome, semantic),
    execution_decision: null,
    policy_note: 'GUARDIAN_REPORT_IS_NOT_AN_EXECUTION_POLICY_DECISION',
  });
}
