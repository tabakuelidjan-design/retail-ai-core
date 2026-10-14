import { LEVER_TYPE, RISK, RULE_RESULT, RULE_TYPE } from './constants.js';
import { SocleError, deepFreeze, isNum, nonEmpty, oneOf } from './util.js';
import { factNumber } from './subject.js';

// Owner rules / constraints. Each evaluation returns PASS | FAIL | NEEDS_HUMAN
// with an explicit reason. No score, no weighting.
const REQUIRED_PARAMS = {
  [RULE_TYPE.MIN_CASH]: ['min_cash', 'horizon_days'],
  [RULE_TYPE.MIN_MARGIN]: ['min_margin_pct'],
  [RULE_TYPE.MAX_DISCOUNT]: ['max_discount_pct'],
  [RULE_TYPE.MAX_BUDGET]: ['max_budget'],
  [RULE_TYPE.MAX_CAPACITY]: ['max_capacity_units'],
  [RULE_TYPE.MAX_RISK]: [],
};

export function createRule(input) {
  const type = oneOf(input.type, RULE_TYPE, 'rule.type');
  const params = { ...(input.params ?? {}) };
  for (const p of REQUIRED_PARAMS[type]) {
    if (!isNum(params[p])) throw new SocleError('INVALID_FIELD', `rule ${input.id}: params.${p} must be a number`);
  }
  if (type === RULE_TYPE.MAX_RISK) oneOf(params.max_risk, RISK, 'params.max_risk');
  if (type === RULE_TYPE.MIN_CASH) params.fact_key = params.fact_key ?? 'projected_cash';
  return deepFreeze({
    id: nonEmpty(input.id, 'rule.id'),
    type,
    label: input.label ?? type,
    params,
    applies_to_types: Array.isArray(input.applies_to_types) ? [...input.applies_to_types] : null,
  });
}

// Rule sets belong to exactly one merchant.
export function createRuleSet(merchant_id, rules) {
  return deepFreeze({ merchant_id: nonEmpty(merchant_id, 'merchant_id'), rules: rules.map(createRule) });
}

const out = (rule, result, reason, evidence = {}) => ({ rule_id: rule.id, type: rule.type, label: rule.label, result, reason, evidence });
const pass = (r, reason, ev) => out(r, RULE_RESULT.PASS, reason, ev);
const fail = (r, reason, ev) => out(r, RULE_RESULT.FAIL, reason, ev);
const human = (r, reason, ev) => out(r, RULE_RESULT.NEEDS_HUMAN, reason, ev);
const RISK_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 };

const EVALUATORS = {
  [RULE_TYPE.MIN_CASH](rule, lever, subject) {
    const { min_cash, horizon_days, fact_key } = rule.params;
    const base = factNumber(subject, fact_key);
    if (base === null) return human(rule, `fact "${fact_key}" is missing - cash floor cannot be checked`);
    const cost = lever.estimated_cost.amount;
    if (cost === null) return human(rule, 'lever cost is unknown - cash floor cannot be checked');
    const inflow = lever.estimated_effects.cash_impact;
    const ttc = lever.estimated_effects.time_to_cash_days;
    // Worst case: an inflow counts only when it is known AND arrives within the horizon.
    const counted = inflow !== null && ttc !== null && ttc <= horizon_days ? inflow : 0;
    const after = base - cost + counted;
    const ev = { baseline: base, cost, counted_inflow: counted, cash_at_horizon: after, min_cash, horizon_days };
    const breachBefore = base < min_cash;
    const resolves = breachBefore && after >= min_cash;
    ev.resolves_breach = resolves;
    ev.breach_before = breachBefore;
    if (after >= min_cash) return pass(rule, `cash at ${horizon_days}d ${after} >= floor ${min_cash}`, ev);
    if (after < base) {
      return fail(rule, `worsens a hard constraint: cash at ${horizon_days}d ${after} < baseline ${base} and below floor ${min_cash}`, ev);
    }
    return pass(rule, `still below floor ${min_cash} (cash ${after}) but does not worsen the baseline ${base}`, ev);
  },

  [RULE_TYPE.MIN_MARGIN](rule, lever) {
    const { min_margin_pct } = rule.params;
    if (!lever.touches_price) return pass(rule, 'lever does not touch the selling price');
    const m = lever.estimated_effects.resulting_margin_pct;
    if (m === null) return human(rule, 'lever touches price but resulting margin is unknown');
    if (m < min_margin_pct) return fail(rule, `resulting margin ${m}% < minimum ${min_margin_pct}%`, { margin_pct: m });
    return pass(rule, `resulting margin ${m}% >= minimum ${min_margin_pct}%`, { margin_pct: m });
  },

  [RULE_TYPE.MAX_DISCOUNT](rule, lever) {
    const { max_discount_pct } = rule.params;
    if (!lever.touches_price) return pass(rule, 'lever does not touch the selling price');
    const d = lever.parameters.discount_pct;
    if (!isNum(d)) return human(rule, 'lever touches price but its discount is unknown');
    if (d > max_discount_pct) return fail(rule, `discount ${d}% > maximum ${max_discount_pct}%`, { discount_pct: d });
    return pass(rule, `discount ${d}% <= maximum ${max_discount_pct}%`, { discount_pct: d });
  },

  [RULE_TYPE.MAX_BUDGET](rule, lever, subject) {
    const { max_budget } = rule.params;
    const c = lever.estimated_cost;
    if (c.amount === null) return human(rule, 'lever cost is unknown');
    if (c.amount > 0 && c.currency !== subject.currency) return human(rule, `cost currency ${c.currency} differs from ${subject.currency}`);
    if (c.amount > max_budget) return fail(rule, `cost ${c.amount} > budget ${max_budget}`, { cost: c.amount });
    return pass(rule, `cost ${c.amount} <= budget ${max_budget}`, { cost: c.amount });
  },

  [RULE_TYPE.MAX_CAPACITY](rule, lever) {
    const { max_capacity_units } = rule.params;
    const c = lever.estimated_effects.capacity_impact;
    if (c === null) return human(rule, 'capacity impact is unknown');
    if (c > max_capacity_units) return fail(rule, `capacity ${c} > maximum ${max_capacity_units}`, { capacity: c });
    return pass(rule, `capacity ${c} <= maximum ${max_capacity_units}`, { capacity: c });
  },

  [RULE_TYPE.MAX_RISK](rule, lever) {
    const max = rule.params.max_risk;
    if (RISK_RANK[lever.risk] > RISK_RANK[max]) return fail(rule, `risk ${lever.risk} > maximum ${max}`, { risk: lever.risk });
    return pass(rule, `risk ${lever.risk} <= maximum ${max}`, { risk: lever.risk });
  },
};

export function evaluateRule(rule, lever, subject) {
  if (rule.applies_to_types && !rule.applies_to_types.includes(subject.type)) {
    return pass(rule, `rule not applicable to subject type ${subject.type}`);
  }
  return EVALUATORS[rule.type](rule, lever, subject);
}

export const evaluateRules = (rules, lever, subject) => rules.map((r) => evaluateRule(r, lever, subject));
export const isDoNothing = (lever) => lever.type === LEVER_TYPE.DO_NOTHING;
