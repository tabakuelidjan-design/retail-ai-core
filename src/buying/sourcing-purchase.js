import { CONFIDENCE, REQUIRED_APPROVAL, REVERSIBILITY, RISK, SUBJECT_KIND, createLever, createSubject, SocleError } from '../socle-decision/index.js';
import { DEFAULT_PROFILE } from '../socle-decision/compare.js';

// Buying & Suppliers domain (Level 2): "should this sourced product be bought, and how much?"
// It supplies FACTS (computed by the sourcing engine's versioned code, never by a model) and possible LEVERS only.
// No ranking, no choice: the common Socle engine (decide) arbitrates once, a human approves. Nothing here orders or pays anything.
export const DOMAIN = 'buying';
export const SOURCING_PURCHASE = 'SOURCING_PURCHASE';
const T = [SOURCING_PURCHASE];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nonEmpty = (v, field) => { if (typeof v !== 'string' || !v.trim()) throw new SocleError('INVALID_FIELD', `${field} is required`); return v.trim(); };
// Comparison axes for this subject type, given to the common engine as configuration (config.profiles): a purchase always spends cash
// first, so comparing on cash would always pick "do nothing". The question is whether the margin it can earn is worth its risk -
// hard blockers (documents, compliance, money not committable) and owner rules have already eliminated what may not be bought.
export const SOURCING_PURCHASE_PROFILE = Object.freeze({ ...DEFAULT_PROFILE, axis_priority: ['margin_impact', 'risk', 'reversibility', 'cash_impact', 'confidence', 'time_to_cash_days', 'capacity_impact', 'inventory_impact'] });
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);

/**
 * @param {object} input facts already computed for one sourcing case (see src/core-pilot/sourcing-facts.js):
 *   merchant_id, case_id, case_version, product_name, detected_at, currency ('EUR'), verdict, can_commit_money, hard_blockers[],
 *   landed_total, landed_per_unit, landed_is_lower_bound, contribution_per_unit, contribution_is_upper_bound, price_basis,
 *   quote_qty, moq, unit_price, quote_currency, lead_time_days, max_unit_price, moq_scenario { landed_total, contribution_per_unit } | null
 * Unknown values stay null: nothing is guessed.
 */
export function buildSourcingPurchaseSubject(input) {
  const caseId = nonEmpty(input.case_id, 'case_id');
  const src = `sourcing-case:${caseId}@${nonEmpty(input.case_version, 'case_version')}`;
  const cur = input.currency;
  const fact = (key, value, unit = null) => ({ key, value: value ?? null, unit, source_ref: src });
  const blockers = Array.isArray(input.hard_blockers) ? input.hard_blockers.map(String) : [];
  const missing_data = [];
  if (!isNum(input.landed_total)) missing_data.push({ field: 'landed_total', reason: 'landed cost incomplete in the sourcing case', blocking: true });
  if (!isNum(input.contribution_per_unit)) missing_data.push({ field: 'contribution_per_unit', reason: 'unit economics incomplete (selling price or costs missing)', blocking: true });
  if (input.price_basis !== 'OBSERVED') missing_data.push({ field: 'observed_selling_price', reason: `selling price is ${input.price_basis ?? 'unknown'}, not observed on the market`, blocking: false });
  if (input.landed_is_lower_bound === true) missing_data.push({ field: 'landed_total_complete', reason: 'landed cost is a lower bound (some costs unknown)', blocking: false });
  const solid = input.price_basis === 'OBSERVED' && input.landed_is_lower_bound !== true && input.contribution_is_upper_bound !== true;
  return createSubject({
    merchant_id: input.merchant_id,
    type: SOURCING_PURCHASE,
    key: `${SOURCING_PURCHASE}:${caseId}`,
    kind: SUBJECT_KIND.OPPORTUNITY,
    title: `Achat sourcing : ${input.product_name || caseId}`,
    summary: `Verdict sourcing ${input.verdict ?? 'inconnu'}${blockers.length ? `, ${blockers.length} blocage(s) dur(s)` : ''}`,
    materiality: isNum(input.landed_total) ? r2(input.landed_total) : 0, // the money at stake; unknown = 0 and the subject stays TO_VERIFY
    currency: cur,
    confidence: solid ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW, // never HIGH: a new product has no sales history
    detected_at: input.detected_at,
    facts: [
      fact('verdict', input.verdict ?? null),
      fact('can_commit_money', typeof input.can_commit_money === 'boolean' ? input.can_commit_money : null),
      fact('hard_blockers', blockers.length, 'count'),
      fact('landed_total', r2(input.landed_total), cur),
      fact('landed_per_unit', r2(input.landed_per_unit), cur),
      fact('contribution_per_unit', r2(input.contribution_per_unit), cur),
      fact('price_basis', input.price_basis ?? null),
      fact('quote_qty', isNum(input.quote_qty) ? input.quote_qty : null, 'units'),
      fact('moq', isNum(input.moq) ? input.moq : null, 'units'),
      fact('unit_price', isNum(input.unit_price) ? input.unit_price : null, input.quote_currency ?? null),
      fact('max_unit_price', isNum(input.max_unit_price) ? input.max_unit_price : null, input.quote_currency ?? null),
      fact('lead_time_days', isNum(input.lead_time_days) ? input.lead_time_days : null, 'days'),
    ],
    missing_data,
    source_refs: [src],
  });
}

const val = (s, k) => s.facts.find((f) => f.key === k)?.value ?? null;

function orderLever(subject, { id, qty, landedTotal, contribution, label }) {
  const verdict = val(subject, 'verdict');
  return createLever({
    domain: DOMAIN, id, label, exclusive_group: 'order_size',
    description: 'Passer commande au fournisseur (acompte). Nordla ne commande et ne paie rien : c’est une action humaine, hors de Nordla.',
    eligibility: { subject_types: T, requires_facts: ['landed_total', 'contribution_per_unit', 'quote_qty'], conditions: [{ fact: 'can_commit_money', op: 'eq', value: true }, { fact: 'hard_blockers', op: 'eq', value: 0 }] },
    estimated_effects: {
      cash_impact: isNum(landedTotal) ? -r2(landedTotal) : null,
      margin_impact: isNum(contribution) && isNum(qty) ? r2(contribution * qty) : null, // only if every unit sells at the entered price
      inventory_impact: isNum(qty) ? qty : null,
      time_to_cash_days: null, // lead time + selling time: not known, not guessed
      capacity_impact: null,
    },
    estimated_cost: { amount: isNum(landedTotal) ? r2(landedTotal) : null, currency: subject.currency },
    reversibility: REVERSIBILITY.IRREVERSIBLE,
    risk: verdict === 'GO' ? RISK.MEDIUM : RISK.HIGH,
    confidence: subject.confidence === CONFIDENCE.MEDIUM ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW,
    required_approval: REQUIRED_APPROVAL.OWNER,
    assumptions: ['la marge suppose que chaque unité se vend au prix saisi', `prix de vente : ${val(subject, 'price_basis') ?? 'inconnu'}`],
  });
}

/** Levers for a SOURCING_PURCHASE subject. `scenarios.moq` (landed total and unit contribution at the MOQ) comes from the same engine. */
export function sourcingPurchaseLevers(subject, scenarios = {}) {
  if (subject.type !== SOURCING_PURCHASE) throw new SocleError('INVALID_FIELD', 'not a SOURCING_PURCHASE subject');
  const out = [];
  const qty = val(subject, 'quote_qty');
  if (isNum(qty)) out.push(orderLever(subject, { id: 'buying.ORDER_QUOTED_QTY', qty, landedTotal: val(subject, 'landed_total'), contribution: val(subject, 'contribution_per_unit'), label: `Commander ${qty} unités (quantité du devis)` }));
  const moq = val(subject, 'moq'); const m = scenarios.moq;
  if (isNum(moq) && isNum(qty) && moq > 0 && moq < qty && m && isNum(m.landed_total) && isNum(m.contribution_per_unit)) {
    out.push(orderLever(subject, { id: 'buying.ORDER_MOQ', qty: moq, landedTotal: m.landed_total, contribution: m.contribution_per_unit, label: `Commander ${moq} unités seulement (minimum fournisseur)` }));
  }
  return out;
}
