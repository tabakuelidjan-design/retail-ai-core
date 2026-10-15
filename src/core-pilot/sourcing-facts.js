// Sourcing case -> facts for the Buying & Suppliers subject (SOURCING_PURCHASE). Every number comes from the sourcing engine's own
// versioned code (assess / economicsScenario), the same code the phone runs offline: nothing is recomputed differently, nothing guessed.
import { assess, economicsScenario } from '../sourcing/core/case.js';

const major = (minor) => (Number.isFinite(minor) ? minor / 100 : null);
const num = (v) => { const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v; return Number.isFinite(n) ? n : null; };

/** @returns {{ input, assessment }} - `input` feeds buildSourcingPurchaseSubject; `assessment` keeps the verdict text for the answer. */
export function sourcingPurchaseFacts(state, { merchantId, now, externals = {} }) {
  const a = assess(state, { now, externals });
  const quote = state.quotes?.at(-1) ?? null;
  const qty = num(quote?.qty); const moq = num(quote?.moq);
  let moqScenario = null;
  if (quote && qty !== null && moq !== null && moq > 0 && moq < qty) {
    const sc = economicsScenario(state, { ...quote, qty: moq });
    if (sc.landed?.status === 'COMPLETE' && sc.economics?.status === 'COMPLETE') moqScenario = { landed_total: major(sc.landed.totals.landedTotalEurMinor), contribution_per_unit: major(sc.economics.contributionMinor) };
  }
  const landedOk = a.landed?.status === 'COMPLETE'; const econOk = a.economics?.status === 'COMPLETE';
  const input = {
    merchant_id: merchantId, case_id: state.id, case_version: String(state.updatedAt ?? state.createdAt ?? 'unknown'),
    product_name: state.identity?.workingName ?? '', detected_at: now, currency: 'EUR',
    verdict: a.decision?.verdict ?? null, can_commit_money: a.decision?.canCommitMoney === true,
    hard_blockers: (a.decision?.hardBlockers ?? []).map((b) => b.code),
    landed_total: landedOk ? major(a.landed.totals.landedTotalEurMinor) : null,
    landed_per_unit: landedOk ? major(a.landed.totals.landedPerUnitEurMinor) : null,
    landed_is_lower_bound: a.landed?.isLowerBound === true,
    contribution_per_unit: econOk ? major(a.economics.contributionMinor) : null,
    contribution_is_upper_bound: a.economics?.contributionIsUpperBound === true,
    price_basis: a.economics?.priceBasis ?? null,
    quote_qty: qty, moq, unit_price: num(quote?.unitPrice), quote_currency: quote?.currency ?? null, lead_time_days: num(quote?.leadTimeDays),
    max_unit_price: a.maxPurchasePrice?.status === 'COMPLETE' ? major(a.maxPurchasePrice.maxUnitPriceMinor) : null,
  };
  return { input, scenarios: { moq: moqScenario }, assessment: { verdict: input.verdict, nextAction: a.decision?.nextAction ?? null, conditions: a.decision?.conditions ?? [], hardBlockers: a.decision?.hardBlockers ?? [], asOf: a.asOf } };
}
