import { CONFIDENCE, REVERSIBILITY, RISK, SUBJECT_KIND, SUBJECT_TYPE } from '../constants.js';
import { createLever } from '../lever.js';
import { createSubject } from '../subject.js';
import { isNum } from '../util.js';

// Cash domain: supplies FACTS and possible LEVERS only. The owner's floor is a
// RULE (MIN_CASH), enforced by the common engine - not decided here.
export const DOMAIN = 'cash';
const T = [SUBJECT_TYPE.CASH_FLOOR_RISK];
const fact = (key, value, unit = null) => ({ key, value: value ?? null, unit });

export function buildCashFloorRiskSubject(input) {
  const shortfall = isNum(input.projected_cash) && isNum(input.observed_floor) ? Math.max(0, input.observed_floor - input.projected_cash) : 0;
  const missing_data = [];
  if (!isNum(input.projected_cash)) missing_data.push({ field: 'projected_cash', reason: 'no projection', blocking: true });
  return createSubject({
    merchant_id: input.merchant_id,
    type: SUBJECT_TYPE.CASH_FLOOR_RISK,
    key: `${SUBJECT_TYPE.CASH_FLOOR_RISK}:${input.horizon_days}d`,
    kind: SUBJECT_KIND.RISK,
    title: input.title ?? `Projected cash below the owner floor within ${input.breach_in_days} days`,
    materiality: shortfall,
    currency: input.currency,
    confidence: input.confidence ?? CONFIDENCE.MEDIUM,
    detected_at: input.detected_at,
    review_at: input.review_at,
    facts: [
      fact('projected_cash', input.projected_cash, input.currency),
      fact('observed_floor', input.observed_floor, input.currency),
      fact('breach_in_days', input.breach_in_days, 'days'),
      fact('shortfall', shortfall, input.currency),
      fact('payables_deferrable', input.payables_deferrable, input.currency),
      fact('receivables_accelerable', input.receivables_accelerable, input.currency),
      fact('sellable_stock_value', input.sellable_stock_value, input.currency),
      fact('purchases_deferrable', input.purchases_deferrable, input.currency),
    ],
    missing_data,
    source_refs: input.source_refs ?? [],
  });
}

const val = (s, k) => s.facts.find((f) => f.key === k)?.value ?? null;

// assumptions: { delay_payment, collections, sell_down, defer_purchase } - optional, from caller/config.
export function cashLevers(subject, assumptions = {}) {
  const A = assumptions;
  const cost0 = { amount: 0, currency: subject.currency };
  const out = [];
  if (A.delay_payment) {
    out.push(createLever({
      domain: DOMAIN, id: 'cash.DELAY_SUPPLIER_PAYMENT', label: 'Décaler un paiement fournisseur',
      eligibility: { subject_types: T, requires_facts: ['payables_deferrable'] },
      estimated_effects: { cash_impact: val(subject, 'payables_deferrable'), time_to_cash_days: 0, margin_impact: 0, capacity_impact: 0, inventory_impact: 0 },
      estimated_cost: cost0, reversibility: REVERSIBILITY.PARTIALLY_REVERSIBLE, risk: RISK.MEDIUM, confidence: CONFIDENCE.MEDIUM,
      combinable_with: ['cash.ACCELERATE_COLLECTIONS', 'cash.DEFER_PURCHASE'],
    }));
  }
  if (A.collections) {
    out.push(createLever({
      domain: DOMAIN, id: 'cash.ACCELERATE_COLLECTIONS', label: 'Accélérer les encaissements',
      eligibility: { subject_types: T, requires_facts: ['receivables_accelerable'] },
      estimated_effects: { cash_impact: val(subject, 'receivables_accelerable'), time_to_cash_days: A.collections.days_to_cash ?? null, margin_impact: 0, capacity_impact: 0, inventory_impact: 0 },
      estimated_cost: cost0, reversibility: REVERSIBILITY.REVERSIBLE, risk: RISK.LOW, confidence: CONFIDENCE.MEDIUM,
      combinable_with: ['cash.DELAY_SUPPLIER_PAYMENT', 'cash.DEFER_PURCHASE'],
    }));
  }
  if (A.sell_down) {
    out.push(createLever({
      domain: DOMAIN, id: 'cash.SELL_DOWN_STOCK', label: 'Écouler du stock à prix réduit', touches_price: true,
      eligibility: { subject_types: T, requires_facts: ['sellable_stock_value'] },
      parameters: { discount_pct: A.sell_down.discount_pct },
      estimated_effects: {
        cash_impact: isNum(val(subject, 'sellable_stock_value')) && isNum(A.sell_down.discount_pct) ? val(subject, 'sellable_stock_value') * (1 - A.sell_down.discount_pct / 100) : null,
        margin_impact: A.sell_down.margin_impact ?? null, time_to_cash_days: A.sell_down.days_to_cash ?? null,
        capacity_impact: A.sell_down.capacity_impact ?? null, inventory_impact: A.sell_down.inventory_impact ?? null,
        resulting_margin_pct: A.sell_down.resulting_margin_pct ?? null,
      },
      estimated_cost: cost0, reversibility: REVERSIBILITY.IRREVERSIBLE, risk: RISK.MEDIUM, confidence: CONFIDENCE.MEDIUM,
    }));
  }
  if (A.defer_purchase) {
    out.push(createLever({
      domain: DOMAIN, id: 'cash.DEFER_PURCHASE', label: 'Reporter un achat prévu',
      eligibility: { subject_types: T, requires_facts: ['purchases_deferrable'] },
      estimated_effects: { cash_impact: val(subject, 'purchases_deferrable'), time_to_cash_days: 0, margin_impact: 0, capacity_impact: 0, inventory_impact: A.defer_purchase.inventory_impact ?? null },
      estimated_cost: cost0, reversibility: REVERSIBILITY.REVERSIBLE, risk: RISK.LOW, confidence: CONFIDENCE.MEDIUM,
      combinable_with: ['cash.DELAY_SUPPLIER_PAYMENT', 'cash.ACCELERATE_COLLECTIONS'],
    }));
  }
  return out;
}
