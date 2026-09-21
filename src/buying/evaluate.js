// Buying Intelligence Lite: candidate + Phase 2B demand facts -> structured decision.
// Deterministic, no score, no LLM. The verdict is a decision table over named
// checks (see checks.js); every negative verdict needs a check that is robust
// under the most favourable reading of its uncertain inputs on trustworthy evidence.
//
// Output sections (never mixed):
//   facts         what the merchant's own data shows (with provenance and gates)
//   inputs        what the merchant entered about the candidate (with bases)
//   assumptions   every estimate, assumption and policy the result rests on
//   missing       what is absent, exactly
//   derived       deterministic computations, each carrying the weakest basis of its inputs
//   blocked_conclusions   conclusions the data does not allow, and what unlocks them

import { BUYING_VERSION } from '../metrics/config.js';
import { normalizeCandidate } from './contract.js';
import {
  AVOID_ELIGIBLE, capabilityFit, inputsComplete, leadTime, peerBenchmark, peerExposure, quantityOf, sellThrough, testCapital, unitMargin,
} from './checks.js';
import { landedCost, retailExTax, round4 } from './economics.js';
import { reconcileVerification } from './inventory-trust.js';
import { resolvePeerSet } from './peers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const VERDICTS = { TEST: 'TEST CANDIDATE', MORE_DATA: 'NEED MORE DATA', AVOID: 'AVOID FOR NOW' };

export function evaluateCandidate({ rawCandidate, demandFacts, config, preparedVerification = new Map(), now }) {
  const cfg = config.buying;
  const { candidate, errors, warnings } = normalizeCandidate(rawCandidate, { merchantCurrency: demandFacts.currency });
  if (!candidate) {
    return { buying_version: BUYING_VERSION, verdict: VERDICTS.MORE_DATA, reason_codes: ['INVALID_CANDIDATE_FILE'], validation_errors: errors, validation_warnings: warnings };
  }

  const verifications = reconcileVerification(preparedVerification, demandFacts.variants, { now, maxAgeDays: cfg.stockTrust.verificationMaxAgeDays });
  const peers = candidate.peer_sets.map((s) => resolvePeerSet(s, demandFacts, verifications, config));
  const exploratory = cfg.allowExploratoryTests && !peers.some((p) => p.quality === 'USABLE');
  const econ = { landed: landedCost(candidate, { merchantCurrency: demandFacts.currency, tol: cfg.estimateTolerancePct }), retail: retailExTax(candidate, cfg) };
  const ctx = { candidate, cfg, config, econ, peers, exploratory, facts: demandFacts };

  const checks = [inputsComplete(ctx), unitMargin(ctx), testCapital(ctx), peerBenchmark(ctx), sellThrough(ctx), peerExposure(ctx), capabilityFit(ctx), leadTime(ctx)]
    .map((c) => ({ ...c, required: cfg.requiredChecks.includes(c.id) }));
  const required = checks.filter((c) => c.required);

  const robust = required.filter((c) => c.status === 'FAIL_ROBUST' && AVOID_ELIGIBLE.includes(c.id));
  const open = required.filter((c) => ['INCOMPLETE', 'BLOCKED', 'FAIL_CONDITIONAL'].includes(c.status));
  let verdict;
  let reasons;
  if (robust.length) { verdict = VERDICTS.AVOID; reasons = robust.map((c) => `${c.id}:FAIL_ROBUST`); }
  else if (open.length) { verdict = VERDICTS.MORE_DATA; reasons = open.map((c) => `${c.id}:${c.status}`); }
  else { verdict = VERDICTS.TEST; reasons = ['ALL_REQUIRED_CHECKS_PASSED']; }

  const q = quantityOf(candidate, cfg.estimateTolerancePct);
  const L = econ.landed;
  const capitalCheck = checks.find((c) => c.id === 'test_capital');
  const caveats = [...new Set([
    ...checks.filter((c) => c.status === 'PASS').flatMap((c) => c.conditional_on),
    ...(demandFacts.window.history_days < config.demand.historyVerifiedDays ? [`SHORT_HISTORY_${demandFacts.window.history_days}_DAYS`] : []),
    'SEASONALITY_NOT_ASSESSED',
  ])];

  const blocked = [
    { id: 'seasonal_fit', status: candidate.external_signals.some((s) => s.signal_type === 'seasonality_index') ? 'LIMITED' : 'BLOCKED',
      why: `Internal history is ${demandFacts.window.history_days} days: seasonal demand cannot be inferred.`,
      unlocks: ['A multi-year seasonality or search-interest series for the merchant\'s own market, supplied as external_signals (tagged EXTERNAL_UNVERIFIED; it can only move this from BLOCKED to LIMITED).'] },
    { id: 'margin_vs_existing_products', status: demandFacts.gates.margin.status === 'OPEN' ? 'NOT_IMPLEMENTED' : 'BLOCKED',
      why: 'Existing products\' margins are not decision-grade.', reasons: demandFacts.gates.margin.reasons, unlocks: ['Verified, all-in unit costs for the comparison products.'] },
    { id: 'capital_exposure_value', status: demandFacts.gates.capital_exposure_value.status === 'OPEN' ? 'NOT_IMPLEMENTED' : 'BLOCKED',
      why: 'Existing stock value at cost is not decision-grade; exposure is judged in units.', reasons: demandFacts.gates.capital_exposure_value.reasons, unlocks: ['Verified costs and physically verified stock quantities.'] },
  ];

  const assumptions = [];
  const note = (name, v) => { if (v && v.basis && v.basis !== 'QUOTED') assumptions.push({ item: name, value: v.value, basis: v.basis }); };
  note('unit_price', candidate.unit_price); note('moq', candidate.moq); note('lead_time_days', candidate.lead_time_days);
  for (const k of ['freight', 'duties', 'other']) note(`landed_cost.${k}_per_unit`, candidate.landed[k]);
  if (candidate.retail) assumptions.push({ item: 'expected_retail_price', value: candidate.retail.value, basis: candidate.retail.basis === 'DECIDED' ? 'DECIDED' : 'ASSUMPTION', tax_basis: candidate.retail.tax_basis });
  if (candidate.fx_rate) assumptions.push({ item: 'fx_rate_assumption', value: candidate.fx_rate.value, basis: 'ASSUMPTION' });
  assumptions.push({ item: 'policy', estimate_tolerance_pct: cfg.estimateTolerancePct, payment_cost_pct: cfg.paymentCostPct, min_unit_margin_pct: cfg.minUnitMarginPct, test_budget: cfg.testBudget, exploratory_budget: cfg.exploratoryBudget, max_sell_through_weeks: cfg.maxSellThroughWeeks, basis: 'MERCHANT_CONFIG' });

  const missing = [
    ...(L.status === 'OK' ? L.missing.map((m) => ({ item: `landed_cost.${m}_per_unit`, effect: 'landed cost is a lower bound' })) : []),
    ...checks.filter((c) => c.status === 'INCOMPLETE').flatMap((c) => c.needs.map((n) => ({ item: n.code, needed_for: c.id, text: n.text }))),
  ];
  const seen = new Set();
  const missingUnique = missing.filter((m) => (seen.has(`${m.item}|${m.needed_for}`) ? false : seen.add(`${m.item}|${m.needed_for}`)));

  const unlocks = checks.filter((c) => c.required && c.needs.length).map((c) => ({ check: c.id, status: c.status, needs: c.needs }));

  return {
    buying_version: BUYING_VERSION,
    generated_at: now.toISOString(),
    candidate_id: candidate.candidate_id,
    verdict, test_type: verdict === VERDICTS.TEST ? (exploratory ? 'EXPLORATORY' : 'EVIDENCE_SUPPORTED') : null,
    reason_codes: reasons,
    conditions: verdict === VERDICTS.TEST ? {
      test_quantity_units: q.status === 'OK' ? q.nominal : null,
      capital_at_risk_nominal: capitalCheck.evidence.capital_at_risk?.nominal ?? null, this_is_also_the_maximum_loss: true,
      budget_kind: exploratory ? 'exploratory' : 'test',
    } : null,
    caveats,
    unlocks,
    checks,
    required_checks: cfg.requiredChecks,
    facts: {
      source: { demand_facts_generated_at: demandFacts.generated_at, schema_version: demandFacts.schema_version, history_days: demandFacts.window.history_days,
        sales_history: demandFacts.input_status.sales_history, sales_reconciled: demandFacts.input_status.sales_reconciliation?.all_match ?? null },
      gates: { demand: demandFacts.gates.demand.status, margin: demandFacts.gates.margin.status, capital_exposure_value: demandFacts.gates.capital_exposure_value.status, cover: demandFacts.gates.cover.status },
      peer_sets: peers,
      stock_verification: [...verifications].map(([variant_id, v]) => ({ variant_id, ...v })),
    },
    inputs: candidate,
    assumptions,
    missing: missingUnique,
    derived: {
      landed_unit_cost: L.status === 'OK' ? { best: round4(L.best), nominal: round4(L.nominal), worst: L.worst == null ? null : round4(L.worst), basis: L.basis, missing_components: L.missing, lower_bound: L.missing.length > 0 } : L,
      retail_ex_tax: econ.retail.status === 'OK' ? { value: round4(econ.retail.ex_tax), basis: econ.retail.basis } : econ.retail,
      arrival_date_if_ordered_now: candidate.lead_time_days ? new Date(now.getTime() + candidate.lead_time_days.value * DAY_MS).toISOString().slice(0, 10) : null,
      exploratory_mode: exploratory,
    },
    blocked_conclusions: blocked,
    validation_warnings: warnings,
  };
}
