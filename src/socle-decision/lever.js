import { CONFIDENCE, FACT_QUALITY, LEVER_TYPE, RISK, REQUIRED_APPROVAL, REVERSIBILITY } from './constants.js';
import { SocleError, deepFreeze, isNum, nonEmpty, numOrNull, oneOf } from './util.js';
import { getFact } from './subject.js';

const EFFECT_KEYS = ['cash_impact', 'margin_impact', 'time_to_cash_days', 'capacity_impact', 'inventory_impact', 'resulting_margin_pct'];

// A Lever is a possible action offered by a business domain. It never decides.
// Unknown effects stay null: nothing is guessed.
export function createLever(input) {
  const type = oneOf(input.type ?? LEVER_TYPE.ACTION, LEVER_TYPE, 'lever.type');
  const effects = {};
  for (const k of EFFECT_KEYS) effects[k] = numOrNull(input.estimated_effects?.[k], `estimated_effects.${k}`);
  const elig = input.eligibility ?? {};
  const lever = {
    id: nonEmpty(input.id, 'lever.id'),
    domain: nonEmpty(input.domain, 'lever.domain'),
    type,
    label: nonEmpty(input.label, 'lever.label'),
    description: input.description ?? '',
    eligibility: {
      subject_types: Array.isArray(elig.subject_types) ? [...elig.subject_types] : null,
      requires_facts: [...(elig.requires_facts ?? [])],
      conditions: (elig.conditions ?? []).map((c) => ({ fact: nonEmpty(c.fact, 'condition.fact'), op: c.op, value: c.value })),
    },
    estimated_effects: effects,
    estimated_cost: {
      amount: numOrNull(input.estimated_cost?.amount, 'estimated_cost.amount'),
      currency: input.estimated_cost?.currency ?? null,
    },
    time_to_effect_days: numOrNull(input.time_to_effect_days, 'time_to_effect_days'),
    reversibility: oneOf(input.reversibility, REVERSIBILITY, 'reversibility'),
    risk: oneOf(input.risk, RISK, 'risk'),
    confidence: oneOf(input.confidence ?? CONFIDENCE.MEDIUM, CONFIDENCE, 'confidence'),
    required_approval: oneOf(input.required_approval ?? REQUIRED_APPROVAL.OWNER, REQUIRED_APPROVAL, 'required_approval'),
    required_data: [...(input.required_data ?? [])],
    parameters: { ...(input.parameters ?? {}) }, // e.g. discount_pct
    touches_price: input.touches_price === true,
    exclusive_group: input.exclusive_group ?? null,
    combinable_with: [...(input.combinable_with ?? [])],
    assumptions: [...(input.assumptions ?? [])],
  };
  return deepFreeze(lever);
}

export function createDoNothingLever(subject) {
  return createLever({
    id: 'DO_NOTHING',
    domain: 'common',
    type: LEVER_TYPE.DO_NOTHING,
    label: 'Ne rien faire',
    description: 'Baseline: no action. Always available.',
    estimated_effects: { cash_impact: 0, margin_impact: 0, time_to_cash_days: 0, capacity_impact: 0, inventory_impact: 0 },
    estimated_cost: { amount: 0, currency: subject.currency },
    time_to_effect_days: 0,
    reversibility: REVERSIBILITY.REVERSIBLE,
    risk: RISK.LOW,
    confidence: CONFIDENCE.HIGH,
    required_approval: REQUIRED_APPROVAL.NONE,
  });
}

// Small, reversible experiment that buys information. Budget comes from config.
export function createTestSmallLever(subject, testSmall) {
  return createLever({
    id: 'TEST_SMALL',
    domain: 'common',
    type: LEVER_TYPE.TEST_SMALL,
    label: 'Tester petit',
    description: 'Limited reversible experiment to learn before committing. Effects are unknown by design.',
    estimated_effects: { capacity_impact: null },
    estimated_cost: { amount: testSmall.budget, currency: subject.currency },
    time_to_effect_days: testSmall.time_to_effect_days ?? null,
    reversibility: REVERSIBILITY.REVERSIBLE,
    risk: RISK.LOW,
    confidence: CONFIDENCE.MEDIUM,
    required_approval: REQUIRED_APPROVAL.OWNER,
  });
}

const OPS = {
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
};

// Eligibility is declarative data: applicable type, required facts, conditions.
export function checkEligibility(lever, subject) {
  const reasons = [];
  const types = lever.eligibility.subject_types;
  if (types && !types.includes(subject.type)) reasons.push(`NOT_APPLICABLE_TO_TYPE:${subject.type}`);
  for (const key of new Set([...lever.eligibility.requires_facts, ...lever.required_data])) {
    const f = getFact(subject, key);
    if (!f || f.value === null) reasons.push(`MISSING_FACT:${key}`);
    else if (f.quality === FACT_QUALITY.SUSPECT) reasons.push(`SUSPECT_FACT:${key}`);
  }
  for (const c of lever.eligibility.conditions) {
    if (!OPS[c.op]) throw new SocleError('INVALID_FIELD', `unknown condition operator ${c.op}`);
    const f = getFact(subject, c.fact);
    if (!f || f.value === null) {
      if (!reasons.includes(`MISSING_FACT:${c.fact}`)) reasons.push(`MISSING_FACT:${c.fact}`);
    } else if (!OPS[c.op](f.value, c.value)) {
      reasons.push(`CONDITION_NOT_MET:${c.fact} ${c.op} ${c.value} (actual ${f.value})`);
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

const RISK_ORDER = [RISK.LOW, RISK.MEDIUM, RISK.HIGH];
const REV_ORDER = [REVERSIBILITY.REVERSIBLE, REVERSIBILITY.PARTIALLY_REVERSIBLE, REVERSIBILITY.IRREVERSIBLE];
const CONF_ORDER = [CONFIDENCE.HIGH, CONFIDENCE.MEDIUM, CONFIDENCE.LOW];
const worst = (order, vals) => order[Math.max(...vals.map((v) => order.indexOf(v)))];
const sumOrNull = (vals) => (vals.some((v) => v === null) ? null : vals.reduce((a, b) => a + b, 0));

// Combination of levers that DECLARE each other combinable (additive effects).
export function combineLevers(levers) {
  const eff = (k) => sumOrNull(levers.map((l) => l.estimated_effects[k]));
  const days = levers.map((l) => l.estimated_effects.time_to_cash_days);
  const pcts = levers.map((l) => l.estimated_effects.resulting_margin_pct).filter(isNum);
  return createLever({
    id: levers.map((l) => l.id).join('+'),
    domain: [...new Set(levers.map((l) => l.domain))].join('+'),
    label: levers.map((l) => l.label).join(' + '),
    description: 'Combination of levers declared combinable; effects assumed additive.',
    estimated_effects: {
      cash_impact: eff('cash_impact'),
      margin_impact: eff('margin_impact'),
      capacity_impact: eff('capacity_impact'),
      inventory_impact: eff('inventory_impact'),
      time_to_cash_days: days.some((d) => d === null) ? null : Math.max(...days),
      resulting_margin_pct: pcts.length ? Math.min(...pcts) : null,
    },
    estimated_cost: { amount: sumOrNull(levers.map((l) => l.estimated_cost.amount)), currency: levers[0].estimated_cost.currency },
    reversibility: worst(REV_ORDER, levers.map((l) => l.reversibility)),
    risk: worst(RISK_ORDER, levers.map((l) => l.risk)),
    confidence: worst(CONF_ORDER, levers.map((l) => l.confidence)),
    required_approval: REQUIRED_APPROVAL.OWNER,
    touches_price: levers.some((l) => l.touches_price),
    parameters: levers.reduce((p, l) => ({ ...p, ...l.parameters }), {}),
  });
}
