import { CONFIDENCE, REVERSIBILITY, RISK, SUBJECT_KIND, SUBJECT_TYPE } from '../constants.js';
import { createLever } from '../lever.js';
import { createSubject } from '../subject.js';
import { isNum } from '../util.js';

// Inventory domain: supplies FACTS and possible LEVERS only.
// No ranking, no choice, no recommendation lives here.
export const DOMAIN = 'inventory';
const T = [SUBJECT_TYPE.DORMANT_INVENTORY];

const fact = (key, value, unit = null, source_ref = null) => ({ key, value: value ?? null, unit, source_ref });

export function buildDormantInventorySubject(input) {
  const facts = [
    fact('units_on_hand', input.units_on_hand, 'units', input.source_ref),
    fact('units_sold_90d', input.units_sold_90d, 'units', input.source_ref),
    fact('immobilized_value', input.immobilized_value, input.currency, input.source_ref),
    fact('unit_price', input.unit_price, input.currency),
    fact('unit_cost', input.unit_cost, input.currency),
    fact('reorder_planned_units', input.reorder_planned_units, 'units'),
    fact('reorder_planned_value', input.reorder_planned_value, input.currency),
    fact('days_to_season_window', input.days_to_season_window, 'days'),
  ];
  const missing_data = [];
  if (!isNum(input.units_sold_90d)) missing_data.push({ field: 'units_sold_90d', reason: 'rotation unknown', blocking: true });
  if (!isNum(input.unit_cost)) missing_data.push({ field: 'unit_cost', reason: 'margin effects cannot be estimated', blocking: false });
  return createSubject({
    merchant_id: input.merchant_id,
    type: SUBJECT_TYPE.DORMANT_INVENTORY,
    key: `${SUBJECT_TYPE.DORMANT_INVENTORY}:${input.product_ref}`,
    kind: SUBJECT_KIND.OPPORTUNITY,
    title: input.title ?? `Dormant stock ${input.product_ref}`,
    summary: input.summary ?? '',
    materiality: input.immobilized_value,
    currency: input.currency,
    confidence: input.confidence ?? CONFIDENCE.MEDIUM,
    detected_at: input.detected_at,
    review_at: input.review_at,
    facts,
    missing_data,
    source_refs: input.source_refs ?? [],
  });
}

// Arithmetic only. If an assumption is absent the effect stays null (never invented).
function sellDown(subject, a) {
  const price = subject.facts.find((f) => f.key === 'unit_price')?.value;
  const cost = subject.facts.find((f) => f.key === 'unit_cost')?.value;
  const d = a.discount_pct;
  const units = a.expected_units_sold;
  const net = isNum(price) && isNum(d) ? price * (1 - d / 100) : null;
  return {
    cash_impact: net !== null && isNum(units) ? net * units : null,
    margin_impact: net !== null && isNum(cost) && isNum(units) ? (net - cost) * units : null,
    inventory_impact: isNum(units) ? -units : null,
    time_to_cash_days: a.days_to_cash ?? null,
    capacity_impact: a.capacity_impact ?? null,
    resulting_margin_pct: net !== null && isNum(cost) && net > 0 ? ((net - cost) / net) * 100 : null,
  };
}

// assumptions: { discount, bundle, marketing, b2b, wait_season, postpone_reorder } - all optional, supplied by caller/config.
export function inventoryLevers(subject, assumptions = {}) {
  const A = assumptions;
  const levers = [];
  const base = { domain: DOMAIN, eligibility: { subject_types: T } };

  if (A.postpone_reorder) {
    levers.push(createLever({
      ...base, id: 'inventory.POSTPONE_REORDER', label: 'Reporter le réassort',
      eligibility: { subject_types: T, requires_facts: ['reorder_planned_value', 'reorder_planned_units'] },
      estimated_effects: {
        cash_impact: subject.facts.find((f) => f.key === 'reorder_planned_value')?.value ?? null,
        inventory_impact: -(subject.facts.find((f) => f.key === 'reorder_planned_units')?.value ?? 0),
        margin_impact: 0, time_to_cash_days: 0, capacity_impact: 0,
      },
      estimated_cost: { amount: 0, currency: subject.currency },
      reversibility: REVERSIBILITY.REVERSIBLE, risk: A.postpone_reorder.risk ?? RISK.MEDIUM, confidence: CONFIDENCE.MEDIUM,
      assumptions: ['avoided outlay counted as cash preserved; stockout risk set by caller'],
    }));
  }
  if (A.discount) {
    levers.push(createLever({
      ...base, id: 'inventory.DISCOUNT', label: 'Réduction ciblée', touches_price: true, exclusive_group: 'price',
      eligibility: { subject_types: T, requires_facts: ['unit_price', 'units_on_hand'] },
      parameters: { discount_pct: A.discount.discount_pct },
      estimated_effects: sellDown(subject, A.discount),
      estimated_cost: { amount: A.discount.cost ?? 0, currency: subject.currency },
      reversibility: REVERSIBILITY.PARTIALLY_REVERSIBLE, risk: RISK.MEDIUM, confidence: A.discount.confidence ?? CONFIDENCE.MEDIUM,
      assumptions: ['expected units sold supplied by caller'],
    }));
  }
  if (A.bundle) {
    levers.push(createLever({
      ...base, id: 'inventory.BUNDLE', label: 'Bundle avec un produit rotatif', touches_price: true, exclusive_group: 'price',
      eligibility: { subject_types: T, requires_facts: ['unit_price'] },
      parameters: { discount_pct: A.bundle.discount_pct },
      estimated_effects: sellDown(subject, A.bundle),
      estimated_cost: { amount: A.bundle.cost ?? 0, currency: subject.currency },
      reversibility: REVERSIBILITY.REVERSIBLE, risk: RISK.LOW, confidence: A.bundle.confidence ?? CONFIDENCE.MEDIUM,
      combinable_with: ['inventory.MARKETING_PUSH'],
    }));
  }
  if (A.marketing) {
    levers.push(createLever({
      ...base, id: 'inventory.MARKETING_PUSH', label: 'Mise en avant marketing',
      eligibility: { subject_types: T, requires_facts: ['unit_price'] },
      estimated_effects: { ...sellDown(subject, { ...A.marketing, discount_pct: 0 }) },
      estimated_cost: { amount: A.marketing.budget ?? null, currency: subject.currency },
      reversibility: REVERSIBILITY.PARTIALLY_REVERSIBLE, risk: RISK.LOW, confidence: A.marketing.confidence ?? CONFIDENCE.LOW,
      combinable_with: ['inventory.BUNDLE'],
    }));
  }
  if (A.b2b) {
    levers.push(createLever({
      ...base, id: 'inventory.B2B_LIQUIDATION', label: 'Écoulement B2B', touches_price: true, exclusive_group: 'price',
      eligibility: { subject_types: T, requires_facts: ['unit_price', 'units_on_hand'] },
      parameters: { discount_pct: A.b2b.discount_pct },
      estimated_effects: sellDown(subject, A.b2b),
      estimated_cost: { amount: A.b2b.cost ?? 0, currency: subject.currency },
      reversibility: REVERSIBILITY.IRREVERSIBLE, risk: RISK.MEDIUM, confidence: A.b2b.confidence ?? CONFIDENCE.LOW,
    }));
  }
  if (A.wait_season) {
    levers.push(createLever({
      ...base, id: 'inventory.WAIT_SEASON', label: 'Attendre la période saisonnière',
      eligibility: { subject_types: T, requires_facts: ['days_to_season_window'] },
      estimated_effects: { cash_impact: A.wait_season.expected_cash ?? null, margin_impact: A.wait_season.expected_margin ?? null,
        time_to_cash_days: subject.facts.find((f) => f.key === 'days_to_season_window')?.value ?? null,
        inventory_impact: isNum(A.wait_season.expected_units_sold) ? -A.wait_season.expected_units_sold : null, capacity_impact: 0 },
      estimated_cost: { amount: 0, currency: subject.currency },
      reversibility: REVERSIBILITY.REVERSIBLE, risk: RISK.MEDIUM, confidence: CONFIDENCE.LOW,
    }));
  }
  return levers;
}
