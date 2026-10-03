// Selling-side unit economics and the MAXIMUM PURCHASE PRICE. Deterministic. No marketplace fee is ever invented: every fee is an explicit input with a status
// (KNOWN | ESTIMATED | UNKNOWN). With an unknown fee the result is an UPPER BOUND, labelled as such, and never a verdict.
//
// Selling price is the consumer price INCLUDING VAT (what a shopper sees in the EU). Net revenue = gross / (1 + VAT). Cost line kinds:
//   pct_of_gross  a % of the VAT-inclusive price       (e.g. a marketplace referral fee when the marketplace states it is charged on the gross price)
//   pct_of_net    a % of the price without VAT          (returns allowance, advertising budget)
//   per_unit      a fixed amount per unit               (fulfilment fee, prep, storage)
import { toMinor, pctToBps, roundHalfAway, applyBps, MoneyError } from './money.js';
import { landedCost } from './landed.js';
import { FACT_CLASS } from './levels.js';

export const EUR_VAT_STANDARD_PCT = Object.freeze({ BE: 21, FR: 20, DE: 19, NL: 21 }); // standard rates as checked on 2026-10-03 (see the rulebook source record); always overridable

function lineOf(spec) {
  const status = spec.status === 'UNKNOWN' || spec.value === undefined || spec.value === null || spec.value === '' ? 'UNKNOWN' : spec.status === 'ESTIMATED' ? 'ESTIMATED' : 'KNOWN';
  return { key: spec.key, label: spec.label ?? spec.key, kind: spec.kind, status, value: status === 'UNKNOWN' ? null : spec.value, source: spec.source ?? null, note: spec.note ?? null };
}

/**
 * @param {{ sellingPriceGross: number|string, vatRatePct: number|string, landedPerUnitMinor: number|null, lines?: object[], targetContributionPct?: number|null }} input
 * @returns unit economics with the contribution per unit, contribution % of net revenue, break-even gross price and a classification
 */
export function unitEconomics(input) {
  const gross = toMinor(input.sellingPriceGross); if (gross === null || gross <= 0) throw new MoneyError('SELLING_PRICE_REQUIRED');
  const vatBps = pctToBps(input.vatRatePct); if (vatBps === null) throw new MoneyError('VAT_RATE_REQUIRED');
  const net = roundHalfAway((gross * 10000) / (10000 + vatBps));
  const lines = (input.lines ?? []).map(lineOf);
  const amountOf = (l) => (l.kind === 'pct_of_gross' ? applyBps(gross, pctToBps(l.value)) : l.kind === 'pct_of_net' ? applyBps(net, pctToBps(l.value)) : l.kind === 'per_unit' ? toMinor(l.value) : (() => { throw new MoneyError('LINE_KIND_UNKNOWN', l.kind); })());
  const priced = lines.map((l) => ({ ...l, amountMinor: l.status === 'UNKNOWN' ? null : amountOf(l) }));
  const unknownLines = priced.filter((l) => l.status === 'UNKNOWN').map((l) => l.key);
  const known = priced.filter((l) => l.amountMinor !== null).reduce((a, l) => a + l.amountMinor, 0);
  const landed = input.landedPerUnitMinor;
  const landedKnown = landed !== null && landed !== undefined;
  const contribution = landedKnown ? net - landed - known : null;
  const pct = contribution === null ? null : contribution / net;
  const target = input.targetContributionPct === null || input.targetContributionPct === undefined ? null : Number(input.targetContributionPct) / 100;
  const complete = landedKnown && unknownLines.length === 0;
  let classification = 'UNKNOWN';
  if (landedKnown && complete) classification = contribution < 0 ? 'UNATTRACTIVE' : target !== null && pct >= target ? 'ATTRACTIVE' : target === null ? 'BORDERLINE' : 'BORDERLINE';
  else if (landedKnown && contribution < 0) classification = 'UNATTRACTIVE'; // negative even before the unknown fees: they can only make it worse
  return {
    status: complete ? 'COMPLETE' : landedKnown ? 'UPPER_BOUND' : 'INFORMATION_INSUFFICIENT',
    sellingPriceGrossMinor: gross, vatRatePct: Number(input.vatRatePct), netRevenueMinor: net, vatMinor: gross - net, landedPerUnitMinor: landedKnown ? landed : null,
    lines: priced, unknownLines, knownCostsMinor: known, contributionMinor: contribution, contributionPct: pct === null ? null : Math.round(pct * 10000) / 10000,
    contributionIsUpperBound: landedKnown && !complete, targetContributionPct: input.targetContributionPct ?? null, classification,
    breakEvenGrossMinor: landedKnown ? breakEvenGross({ vatBps, landed, lines: priced }) : null,
    factClass: complete ? FACT_CLASS.CALCULATED_VALUE : FACT_CLASS.UNKNOWN,
    warnings: [...(unknownLines.length ? [`FEES_UNKNOWN: ${unknownLines.join(', ')} are excluded - the contribution is an upper bound`] : []), ...(landedKnown ? [] : ['LANDED_COST_UNKNOWN'])],
  };
}

/** The consumer price (VAT incl.) at which the contribution is exactly zero, given the KNOWN lines. Solved analytically, then verified to the cent. */
function breakEvenGross({ vatBps, landed, lines }) {
  const r = 10000 / (10000 + vatBps);
  let pg = 0; let pn = 0; let fixed = landed;
  for (const l of lines) { if (l.amountMinor === null) continue; const f = Number(l.value); if (l.kind === 'pct_of_gross') pg += f / 100; else if (l.kind === 'pct_of_net') pn += f / 100; else fixed += toMinor(l.value); }
  const k = r * (1 - pn) - pg; if (k <= 0) return null; // the percentage lines alone exceed the price: no break-even exists
  let g = Math.ceil(fixed / k);
  const contributionAt = (price) => { const n = roundHalfAway((price * 10000) / (10000 + vatBps)); return n - landed - lines.filter((l) => l.amountMinor !== null).reduce((a, l) => a + (l.kind === 'pct_of_gross' ? applyBps(price, pctToBps(l.value)) : l.kind === 'pct_of_net' ? applyBps(n, pctToBps(l.value)) : toMinor(l.value)), 0); };
  while (g > 0 && contributionAt(g - 1) >= 0) g -= 1;
  while (contributionAt(g) < 0) g += 1;
  return g;
}

/**
 * MAXIMUM PURCHASE PRICE: the highest supplier unit price (in the supplier currency, minor units) for which the contribution per unit still reaches the target
 * contribution % of net revenue. Exact: it re-runs the real landed-cost and economics functions (monotone in the price) and bisects on whole minor units.
 * Returns null reasons instead of a number when a critical input is missing.
 */
export function maxPurchasePrice({ landedInput, sale, targetContributionPct }) {
  if (targetContributionPct === null || targetContributionPct === undefined) return { status: 'INFORMATION_INSUFFICIENT', reason: 'TARGET_MARGIN_NOT_SET', maxUnitPriceMinor: null };
  const at = (priceMinor) => {
    const l = landedCost({ ...landedInput, supplier: { ...landedInput.supplier, unitPrice: priceMinor / 100 } });
    if (l.status === 'INFORMATION_INSUFFICIENT') return { l, e: null };
    return { l, e: unitEconomics({ ...sale, landedPerUnitMinor: l.totals.landedPerUnitEurMinor, targetContributionPct }) };
  };
  const probe = at(100);
  if (!probe.e) return { status: 'INFORMATION_INSUFFICIENT', reason: `CRITICAL_COST_UNKNOWN: ${probe.l.criticalUnknown.filter((c) => c !== 'supplier.unitPrice').join(', ')}`, maxUnitPriceMinor: null };
  if (probe.e.unknownLines.length) return { status: 'UPPER_BOUND', reason: `FEES_UNKNOWN: ${probe.e.unknownLines.join(', ')}`, maxUnitPriceMinor: searchMax(at, targetContributionPct), upperBound: true, currency: landedInput.supplier.currency ?? 'EUR' };
  return { status: 'COMPLETE', maxUnitPriceMinor: searchMax(at, targetContributionPct), upperBound: false, currency: landedInput.supplier.currency ?? 'EUR' };
}
function searchMax(at, targetPct) {
  const ok = (p) => { const { e } = at(p); return e.contributionMinor !== null && e.contributionPct >= targetPct / 100 && e.contributionMinor >= 0; };
  if (!ok(1)) return 0; // even a one-cent supplier price misses the target
  let lo = 1; let hi = 1000000; // up to 10 000.00 in the supplier currency
  if (ok(hi)) return hi;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (ok(mid)) lo = mid; else hi = mid; }
  return lo;
}
