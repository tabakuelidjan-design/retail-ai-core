// The named checks behind a verdict. Each returns
//   { id, status, summary, evidence, conditional_on[], needs[] }
// status:
//   PASS              met, with the uncertainty it rests on listed in conditional_on
//   FAIL_ROBUST       fails even under the most favourable reading of every uncertain input,
//                     on evidence trustworthy enough to reject on - the ONLY status that can support AVOID
//   FAIL_CONDITIONAL  fails on the values entered, but uncertainty could change that -> NEED MORE DATA
//   INCOMPLETE        a required input or merchant policy is missing
//   BLOCKED           the evidence needed is not trustworthy enough to conclude anything
//   WAIVED            deliberately replaced by the exploratory path
//   NOT_APPLICABLE    nothing to check
// Thresholds are merchant configuration; nothing is defaulted to a money value.

import { band, breakEvenRetail, marginPct, round2, round4 } from './economics.js';

export const AVOID_ELIGIBLE = ['unit_margin', 'test_capital', 'peer_exposure', 'capability_fit', 'lead_time'];
const SEVERITY = { FAIL_ROBUST: 5, BLOCKED: 4, INCOMPLETE: 3, FAIL_CONDITIONAL: 2, PASS: 1, NOT_APPLICABLE: 1, WAIVED: 1 };

const need = (code, text) => ({ code, text });
const res = (id, status, summary, extra = {}) => ({ id, status, summary, evidence: {}, conditional_on: [], needs: [], ...extra });
const worst = (results) => results.reduce((w, r) => (SEVERITY[r.status] > SEVERITY[w.status] ? r : w), results[0]);

/** Merges per-peer-set results into one check: the most severe one decides; every set's evidence is kept. */
function aggregate(id, perSet, empty) {
  if (perSet.length === 0) return empty;
  const decisive = worst(perSet.map((r) => r));
  return { ...decisive, id, evidence: { decisive_set: decisive.evidence.set ?? null, by_peer_set: perSet.map((r) => ({ set: r.evidence.set, status: r.status, ...r.evidence })) },
    conditional_on: [...new Set(perSet.flatMap((r) => r.conditional_on))], needs: perSet.flatMap((r) => r.needs) };
}

/** Total units to buy: MOQ (per order or per planned variant) and the merchant's test quantity, with an uncertainty band. */
export function quantityOf(candidate, tol) {
  const moq = candidate.moq;
  if (!moq) return { status: 'MOQ_MISSING' };
  if (moq.per === 'per_variant' && !candidate.variants_planned) return { status: 'VARIANTS_PLANNED_MISSING' };
  const mult = moq.per === 'per_variant' ? candidate.variants_planned : 1;
  const b = band(moq, tol);
  const test = candidate.test_quantity?.value ?? 0;
  return {
    status: 'OK', moq_total: moq.value * mult, moq_basis: moq.basis,
    best: Math.max(b.best * mult, test), nominal: Math.max(b.nominal * mult, test), worst: Math.max(b.worst * mult, test),
    test_below_moq: candidate.test_quantity != null && test < moq.value * mult,
  };
}

export function inputsComplete({ candidate, cfg, econ, exploratory }) {
  const missing = [];
  const add = (code, text) => missing.push(need(code, text));
  if (!candidate.unit_price) add('unit_price', 'Supplier unit price.');
  if (!candidate.moq) add('moq', 'Minimum order quantity.');
  else if (candidate.moq.per === 'per_variant' && !candidate.variants_planned) add('variants_planned', 'Number of variants planned (the MOQ is per variant).');
  if (!candidate.retail) add('expected_retail_price', 'Expected retail price - required from the merchant; the peer median is comparison context only and is never used as the price.');
  else if (econ.retail.status === 'TAX_BASIS_MISSING') add('expected_retail_price.tax_basis', 'Whether the expected retail price includes tax (incl) or not (excl).');
  else if (econ.retail.status === 'TAX_RATE_MISSING') add('expected_retail_price.tax_rate', 'Tax rate to convert a tax-inclusive price (or set buying.taxRateAssumption).');
  if (econ.landed.status === 'FX_MISSING') add('fx_rate_assumption', 'FX rate assumption: the candidate currency differs from the merchant currency.');
  if (candidate.peer_sets.length === 0 && !cfg.allowExploratoryTests) add('peer_sets', 'At least one merchant-chosen peer set (product ids, collection ids or a product_type), or enable exploratory tests.');
  const budgetKey = exploratory ? 'exploratoryBudget' : 'testBudget';
  for (const key of [budgetKey, 'minUnitMarginPct', 'paymentCostPct']) if (cfg[key] == null) add(`config.${key}`, `Merchant policy buying.${key} is not set.`);
  return missing.length ? res('inputs_complete', 'INCOMPLETE', 'Required inputs are missing.', { needs: missing })
    : res('inputs_complete', 'PASS', 'All required inputs and policies are present.');
}

export function unitMargin({ candidate, cfg, econ }) {
  const L = econ.landed;
  const R = econ.retail;
  if (L.status !== 'OK' || R.status !== 'OK' || cfg.minUnitMarginPct == null || cfg.paymentCostPct == null) {
    return res('unit_margin', 'INCOMPLETE', 'Unit margin cannot be computed yet.', { needs: [need('unit_margin_inputs', 'Unit price, expected retail price (with tax basis) and merchant margin/payment policy.')] });
  }
  const pay = cfg.paymentCostPct;
  const hurdle = cfg.minUnitMarginPct;
  const retailEx = R.ex_tax;
  const best = marginPct(retailEx, L.best, pay);
  const nominal = marginPct(retailEx, L.nominal, pay);
  const worstM = L.worst == null ? null : marginPct(retailEx, L.worst, pay);
  const evidence = {
    retail_ex_tax: round2(retailEx), retail_basis: R.basis, landed_unit_cost: { best: round4(L.best), nominal: round4(L.nominal), worst: L.worst == null ? null : round4(L.worst), basis: L.basis, missing_components: L.missing },
    margin_pct: { best: round4(best), nominal: round4(nominal), worst: worstM == null ? null : round4(worstM) }, hurdle,
    min_retail_ex_tax_for_hurdle: { nominal_cost: breakEvenRetail(L.nominal, hurdle, pay), worst_cost: L.worst == null ? null : breakEvenRetail(L.worst, hurdle, pay) },
  };
  const conditional = [];
  if (!R.decided) conditional.push('EXPECTED_RETAIL_PRICE_IS_ASSUMPTION');
  if (!R.tax_trusted && candidate.retail.tax_basis === 'incl') conditional.push('TAX_RATE_IS_ASSUMPTION');
  if (L.missing.length) conditional.push(`LANDED_COST_MISSING_${L.missing.join('_').toUpperCase()}`);
  if (['ESTIMATED', 'ASSUMPTION'].includes(L.basis)) conditional.push('LANDED_COST_INCLUDES_ESTIMATES');

  if (best < hurdle) {
    const robust = R.decided && R.tax_trusted && !L.hasAssumption;
    return res('unit_margin', robust ? 'FAIL_ROBUST' : 'FAIL_CONDITIONAL',
      robust ? 'Margin is below the hurdle even with the most favourable landed cost, at a decided price.'
        : 'Margin is below the hurdle on the values entered, but the result depends on uncertain inputs.',
      { evidence, conditional_on: robust ? [] : conditional, needs: robust ? [] : [
        ...(!R.decided ? [need('confirm_retail_price', 'Confirm the selling price (mark it DECIDED) - an assumed price cannot support a rejection.')] : []),
        ...(L.hasAssumption ? [need('replace_assumed_cost', 'Replace ASSUMPTION cost components with estimates or quotes.')] : []),
        ...(!R.tax_trusted && candidate.retail.tax_basis === 'incl' ? [need('confirm_tax_rate', 'Confirm the tax rate used to convert the retail price.')] : []),
      ] });
  }
  if (L.missing.length) {
    return res('unit_margin', 'INCOMPLETE', 'Margin clears the hurdle only if the missing landed-cost components are small; they are missing, not zero.',
      { evidence, conditional_on: conditional, needs: L.missing.map((m) => need(`landed_${m}`, `Landed cost component: ${m} per unit (or mark it not_applicable if it truly is).`)) });
  }
  if (worstM >= hurdle) return res('unit_margin', 'PASS', 'Margin clears the hurdle even with estimates at their unfavourable end.', { evidence, conditional_on: conditional });
  return res('unit_margin', 'FAIL_CONDITIONAL', 'Margin clears the hurdle at the entered values but not if the estimated costs come in high.',
    { evidence, conditional_on: conditional, needs: [need('firm_up_estimated_costs', 'Replace ESTIMATED landed-cost components with quotes.')] });
}

export function testCapital({ candidate, cfg, econ, exploratory }) {
  const L = econ.landed;
  const budget = exploratory ? cfg.exploratoryBudget : cfg.testBudget;
  const q = quantityOf(candidate, cfg.estimateTolerancePct);
  if (L.status !== 'OK' || q.status !== 'OK' || budget == null) {
    return res('test_capital', 'INCOMPLETE', 'Capital at risk cannot be computed yet.', { needs: [need('capital_inputs', 'Unit price, MOQ (and variants planned if per variant) and the merchant test budget.')] });
  }
  const capital = { best: L.best * q.best, nominal: L.nominal * q.nominal, worst: L.worst == null ? null : L.worst * q.worst };
  const evidence = {
    budget, budget_kind: exploratory ? 'exploratory' : 'test', quantity: { moq_total: q.moq_total, best: q.best, nominal: q.nominal, worst: q.worst, moq_basis: q.moq_basis },
    capital_at_risk: { best: round2(capital.best), nominal: round2(capital.nominal), worst: capital.worst == null ? null : round2(capital.worst), lower_bound: L.missing.length > 0 },
    max_units_within_budget: L.nominal > 0 ? Math.floor(budget / (L.worst ?? L.nominal)) : null,
  };
  const conditional = [];
  if (L.missing.length) conditional.push('CAPITAL_IS_LOWER_BOUND');
  if (q.moq_basis !== 'QUOTED') conditional.push('MOQ_NOT_QUOTED');
  if (['ESTIMATED', 'ASSUMPTION'].includes(L.basis)) conditional.push('LANDED_COST_INCLUDES_ESTIMATES');
  if (q.test_below_moq) conditional.push('TEST_QUANTITY_BELOW_MOQ_USING_MOQ');

  if (capital.best > budget) {
    const robust = q.moq_basis === 'QUOTED' && !L.hasAssumption;
    return res('test_capital', robust ? 'FAIL_ROBUST' : 'FAIL_CONDITIONAL',
      robust ? 'The minimum purchase exceeds the test budget even with the most favourable cost.' : 'The minimum purchase exceeds the test budget on the values entered, but depends on uncertain inputs.',
      { evidence, conditional_on: robust ? [] : conditional, needs: robust ? [] : [need('firm_up_moq_and_cost', 'Firm up the MOQ and replace assumed costs with quotes.')] });
  }
  if (L.missing.length) return res('test_capital', 'INCOMPLETE', 'Capital fits the budget only as a lower bound; landed-cost components are missing.', { evidence, conditional_on: conditional, needs: L.missing.map((m) => need(`landed_${m}`, `Landed cost component: ${m} per unit.`)) });
  if (capital.worst <= budget) return res('test_capital', 'PASS', 'The minimum purchase fits the test budget; this is also the maximum loss if nothing sells.', { evidence, conditional_on: conditional });
  return res('test_capital', 'FAIL_CONDITIONAL', 'Capital fits the budget at nominal values but not if estimates come in high.', { evidence, conditional_on: conditional, needs: [need('firm_up_estimated_costs', 'Replace ESTIMATED costs / MOQ with quotes.')] });
}

const QUALITY_RANK = { USABLE: 3, THIN: 2, NO_DEMAND_EVIDENCE: 1, NONE: 0 };

export function peerBenchmark({ candidate, peers, exploratory }) {
  if (exploratory) return res('peer_benchmark', 'WAIVED', 'Exploratory test: no usable peer demand evidence is required (budget is capped instead).', { evidence: { peer_sets: peers.map((p) => ({ set: p.label, quality: p.quality })) } });
  if (peers.length === 0) return res('peer_benchmark', 'INCOMPLETE', 'No peer set was provided.', { needs: [need('peer_sets', 'A merchant-chosen peer set.')] });
  const best = peers.reduce((b, p) => (QUALITY_RANK[p.quality] > QUALITY_RANK[b.quality] ? p : b), peers[0]);
  const evidence = { peer_sets: peers.map((p) => ({ set: p.label, quality: p.quality, observable_peers: p.observable_peers, selling_peers: p.selling_peers, min_peers_required: p.min_peers_required, unresolved_ids: p.unresolved_ids })) };
  if (best.quality === 'USABLE') return res('peer_benchmark', 'PASS', `Peer benchmark is usable (${best.selling_peers} selling peers of ${best.observable_peers} observable).`, { evidence });
  if (best.quality === 'THIN') return res('peer_benchmark', 'INCOMPLETE', `Only ${best.selling_peers} selling peers; ${best.min_peers_required} needed for a benchmark.`, { evidence, needs: [need('broader_peer_set', 'A broader peer set with more selling products, or enable exploratory tests.')] });
  return res('peer_benchmark', 'BLOCKED', best.quality === 'NONE' ? 'No observable peers: nothing internal to compare against.' : 'Observable peers exist but none has sold: no internal demand evidence.',
    { evidence, needs: [need('peer_evidence_or_exploratory', 'Choose a peer set with selling products, or enable exploratory tests with a strict budget.')] });
}

export function sellThrough({ candidate, cfg, peers, exploratory }) {
  if (exploratory) return res('sell_through', 'WAIVED', 'Exploratory test: sell-through against peers is not required.');
  const q = quantityOf(candidate, cfg.estimateTolerancePct);
  const usable = peers.filter((p) => p.quality === 'USABLE');
  if (q.status !== 'OK' || usable.length === 0) return res('sell_through', 'INCOMPLETE', 'Needs an MOQ and a usable peer benchmark.', { needs: [need('moq_and_benchmark', 'MOQ and a peer set with a usable benchmark.')] });
  const horizon = cfg.maxSellThroughWeeks;
  const perSet = usable.map((p) => {
    const m = p.velocity.median;
    const weeks = (v) => (v > 0 ? round2(q.nominal / v) : null);
    const evidence = {
      set: p.label, test_quantity: q.nominal, horizon_weeks: horizon, peer_velocity_units_per_week: { p25: p.velocity.p25, median: m, p75: p.velocity.p75 },
      weeks_to_sell_if_it_sells_like: { p25_peer: weeks(p.velocity.p25), median_peer: weeks(m), p75_peer: weeks(p.velocity.p75) },
      max_units_for_horizon_at_median: Math.floor(horizon * m), sell_rate: `${p.sell_rate.selling} of ${p.sell_rate.observable} observable peers sold anything`,
    };
    const conditional = ['CONDITIONAL_ON_CANDIDATE_SELLING_LIKE_ITS_PEERS', 'SHORT_HISTORY_NO_SEASONALITY'];
    if (p.sell_rate.selling < p.sell_rate.observable) conditional.push('SOME_PEERS_SOLD_NOTHING');
    return m > 0 && q.nominal / m <= horizon
      ? res('sell_through', 'PASS', 'At the median selling peer\'s velocity the test quantity sells within the horizon.', { evidence, conditional_on: conditional })
      : res('sell_through', 'FAIL_CONDITIONAL', 'At the median selling peer\'s velocity the test quantity would take longer than the horizon.',
        { evidence, conditional_on: conditional, needs: [need('reduce_quantity_or_evidence', `A test quantity of at most ${evidence.max_units_for_horizon_at_median} fits the horizon at peer-median velocity; otherwise evidence of higher demand is needed.`)] });
  });
  return aggregate('sell_through', perSet, res('sell_through', 'INCOMPLETE', 'No usable peer set.'));
}

export function peerExposure({ candidate, cfg, peers }) {
  const q = quantityOf(candidate, cfg.estimateTolerancePct);
  const relevant = peers.filter((p) => p.peers_total > 0);
  const perSet = relevant.map((p) => {
    const t = p.stock_trust;
    const x = p.exposure;
    const moqWeeks = q.status === 'OK' && p.velocity.median > 0 ? round2(q.moq_total / p.velocity.median) : null;
    const evidence = {
      set: p.label, stock_trust: t.trust, verified_share: t.verified_share, unverified_share: t.unverified_share, unreliable_share: t.unreliable_share,
      peer_stock_units: x.stock_units, no_sale_share: x.no_sale_share, slow_share: x.slow_share, too_new_share: x.too_new_share, cover_weeks: x.cover_weeks,
      peer_units_8w: x.peer_units_8w, moq_weeks_of_supply_at_peer_median: moqWeeks, thresholds: cfg.exposure, horizon_weeks: cfg.maxSellThroughWeeks,
      largest_unverified_variants: t.largest_unverified_variants,
    };
    if (t.trust === 'BLOCKED') {
      return res('peer_exposure', 'BLOCKED', 'Peer stock quantities are not trustworthy enough (suspect, stale or missing) to judge exposure either way.',
        { evidence, needs: [need('count_peer_stock', 'Physically count the flagged peer variants and correct Shopify, then re-sync (share of unreliable units: ' + t.unreliable_share + ').')] });
    }
    if (t.trust === 'NO_STOCK' || x.no_sale_share === null) return res('peer_exposure', 'PASS', 'The peer set holds no stock: no existing exposure.', { evidence });

    const noDemand = x.peer_units_8w === 0;
    if (x.cover_weeks === null && !noDemand) {
      return res('peer_exposure', 'INCOMPLETE', 'Peer demand sample is too thin to compute cover, so exposure cannot be judged.', { evidence, needs: [need('peer_demand_sample', 'More peer sales history or a broader peer set.')] });
    }
    const saturated = x.no_sale_share >= cfg.exposure.noSaleShare && (noDemand || x.cover_weeks >= cfg.exposure.coverWeeks)
      && (moqWeeks === null || moqWeeks > cfg.maxSellThroughWeeks);
    if (!saturated) {
      if (t.trust === 'TRUSTED') return res('peer_exposure', 'PASS', 'Peer stock is verified and exposure is within the configured limits.', { evidence });
      if (cfg.stockTrust.unverifiedMaySupportPass) return res('peer_exposure', 'PASS', 'Exposure is within limits on Shopify quantities that have not been physically verified.', { evidence, conditional_on: ['PEER_STOCK_UNVERIFIED'] });
      return res('peer_exposure', 'INCOMPLETE', 'Exposure looks acceptable but peer stock is unverified and policy requires verified stock for a pass.', { evidence, needs: [need('verify_peer_stock', 'Physically verify peer stock.')] });
    }
    if (t.trust === 'TRUSTED') {
      return res('peer_exposure', 'FAIL_ROBUST', 'Verified peer stock is already high relative to demand and the MOQ would add more than the horizon can absorb.', { evidence });
    }
    return res('peer_exposure', 'FAIL_CONDITIONAL', 'Peer stock looks high, but it is not physically verified, so it cannot support a rejection.',
      { evidence, conditional_on: ['PEER_STOCK_UNVERIFIED'], needs: [need('verify_peer_stock', 'Physically count the largest unverified peer variants (listed in evidence), correct Shopify, and re-sync.')] });
  });
  return aggregate('peer_exposure', perSet, res('peer_exposure', 'NOT_APPLICABLE', 'No peer set with products: exposure is not assessable (and not required for an exploratory test).'));
}

export function capabilityFit({ candidate }) {
  const required = candidate.required_capabilities;
  if (required.length === 0) return res('capability_fit', 'NOT_APPLICABLE', 'No required capabilities were stated.');
  const state = Object.fromEntries(required.map((k) => [k, candidate.supplier_capabilities[k] ?? 'unknown']));
  const no = required.filter((k) => state[k] === 'no');
  const unknown = required.filter((k) => state[k] === 'unknown');
  if (no.length) return res('capability_fit', 'FAIL_ROBUST', `The supplier states it cannot provide: ${no.join(', ')}.`, { evidence: { state } });
  if (unknown.length) return res('capability_fit', 'INCOMPLETE', `Supplier capability unknown: ${unknown.join(', ')}.`, { evidence: { state }, needs: unknown.map((k) => need(`capability_${k}`, `Ask the supplier whether it supports: ${k}.`)) });
  return res('capability_fit', 'PASS', 'The supplier supports every required capability.', { evidence: { state } });
}

export function leadTime({ candidate, cfg }) {
  if (cfg.maxLeadTimeDays == null) return res('lead_time', 'NOT_APPLICABLE', 'No maximum lead time is configured.');
  const lt = candidate.lead_time_days;
  if (!lt) return res('lead_time', 'INCOMPLETE', 'Lead time is missing.', { needs: [need('lead_time_days', 'Supplier lead time in days.')] });
  const b = band(lt, cfg.estimateTolerancePct);
  const evidence = { max_days: cfg.maxLeadTimeDays, lead_time_days: { best: b.best, nominal: b.nominal, worst: b.worst, basis: lt.basis } };
  if (b.best > cfg.maxLeadTimeDays) return lt.basis === 'QUOTED'
    ? res('lead_time', 'FAIL_ROBUST', 'The quoted lead time exceeds the maximum.', { evidence })
    : res('lead_time', 'FAIL_CONDITIONAL', 'The estimated lead time exceeds the maximum but is not a quote.', { evidence, conditional_on: ['LEAD_TIME_NOT_QUOTED'], needs: [need('quote_lead_time', 'Get a quoted lead time.')] });
  if (b.worst <= cfg.maxLeadTimeDays) return res('lead_time', 'PASS', 'Lead time is within the maximum.', { evidence, conditional_on: lt.basis === 'QUOTED' ? [] : ['LEAD_TIME_NOT_QUOTED'] });
  return res('lead_time', 'FAIL_CONDITIONAL', 'Lead time is within the maximum only if the estimate holds.', { evidence, conditional_on: ['LEAD_TIME_NOT_QUOTED'], needs: [need('quote_lead_time', 'Get a quoted lead time.')] });
}
