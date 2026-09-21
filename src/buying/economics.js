// Candidate economics with explicit uncertainty. Every derived number is
// computed at three levels so a conclusion can be tested for robustness:
//   best    most favourable value the inputs allow (missing component = 0, estimates -tolerance)
//   nominal the entered values
//   worst   least favourable (estimates +tolerance); null when a component is MISSING
// A conclusion is only "robust" if it holds at the level that favours the other side.
// Nothing here estimates a missing component or invents a price.

import { BASIS_RANK } from './contract.js';

export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
export const round4 = (x) => Math.round(x * 10000) / 10000;

/** Band for a single entered value under the tolerance. */
export function band(v, tol) {
  if (v.basis === 'QUOTED') return { best: v.value, nominal: v.value, worst: v.value };
  return { best: v.value * (1 - tol), nominal: v.value, worst: v.value * (1 + tol) };
}

const weakest = (bases) => bases.reduce((w, b) => (BASIS_RANK[b] < BASIS_RANK[w] ? b : w), 'QUOTED');

/**
 * Landed unit cost in the merchant currency.
 * A cost expressed in another currency is converted with the merchant's fx assumption and can never be better than ESTIMATED.
 */
export function landedCost(candidate, { merchantCurrency, tol }) {
  const foreign = candidate.currency !== merchantCurrency;
  if (foreign && !candidate.fx_rate) return { status: 'FX_MISSING' };
  const fx = foreign ? candidate.fx_rate.value : 1;
  const lift = (v) => (v ? { value: v.value * fx, basis: foreign && v.basis === 'QUOTED' ? 'ESTIMATED' : v.basis } : null);

  const parts = { unit_price: lift(candidate.unit_price), freight: lift(candidate.landed.freight), duties: lift(candidate.landed.duties), other: lift(candidate.landed.other) };
  const missing = [];
  for (const k of ['freight', 'duties']) if (!parts[k] && !candidate.landed.not_applicable.includes(k)) missing.push(k);
  if (!parts.unit_price) return { status: 'UNIT_PRICE_MISSING', missing: ['unit_price', ...missing] };

  const present = Object.entries(parts).filter(([, v]) => v);
  const bands = present.map(([, v]) => band(v, tol));
  const sum = (key) => bands.reduce((a, b) => a + b[key], 0);
  return {
    status: 'OK',
    best: sum('best'), nominal: sum('nominal'), worst: missing.length ? null : sum('worst'),
    missing, // absent components: nominal is then a LOWER BOUND, worst is unknown
    basis: missing.length ? 'MISSING' : weakest(present.map(([, v]) => v.basis)),
    hasAssumption: present.some(([, v]) => v.basis === 'ASSUMPTION'),
    components: Object.fromEntries(present.map(([k, v]) => [k, { value: round4(v.value), basis: v.basis }])),
    not_applicable: candidate.landed.not_applicable,
    converted_with_fx_assumption: foreign,
  };
}

/** Expected retail price ex tax, with the reason it is unusable when it is. */
export function retailExTax(candidate, cfg) {
  const r = candidate.retail;
  if (!r) return { status: 'MISSING' };
  const decided = r.basis === 'DECIDED';
  if (r.tax_basis === 'excl') return { status: 'OK', ex_tax: r.value, basis: r.basis, decided, tax_trusted: true };
  if (r.tax_basis === null) return { status: 'TAX_BASIS_MISSING' };
  const rate = r.tax_rate ?? (cfg.taxRateAssumption != null ? { value: cfg.taxRateAssumption, basis: 'ASSUMPTION' } : null);
  if (!rate) return { status: 'TAX_RATE_MISSING' };
  return { status: 'OK', ex_tax: r.value / (1 + rate.value), basis: r.basis, decided, tax_trusted: rate.basis === 'QUOTED', tax_rate: rate };
}

export const marginPct = (retailEx, landed, pay) => (retailEx - landed - pay * retailEx) / retailEx;

/** Lowest retail ex tax at which the hurdle is met for a landed cost (null when the hurdle can never be met). */
export function breakEvenRetail(landed, hurdle, pay) {
  const denom = 1 - hurdle - pay;
  return denom > 0 ? round2(landed / denom) : null;
}

/** Percentile with linear interpolation over a sorted array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return round4(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}
