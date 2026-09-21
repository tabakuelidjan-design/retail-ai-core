// Cost resolution. The single place that decides whether a cost is usable and
// how much it can be trusted. Rule: a missing/unusable cost is MISSING - it is
// never estimated, defaulted, averaged, or borrowed from another product.

export const COST_STATUS = {
  VERIFIED: 'VERIFIED',
  UNVERIFIED: 'UNVERIFIED',
  ESTIMATED: 'ESTIMATED',
  STALE: 'STALE',
  MISSING: 'MISSING',
};

const FROM_VALIDATION = { verified: 'VERIFIED', unverified: 'UNVERIFIED', estimated: 'ESTIMATED', stale: 'STALE' };

/** Trust order, most to least: used to pick the weakest status across several lines. */
export const COST_TRUST_ORDER = ['VERIFIED', 'UNVERIFIED', 'ESTIMATED', 'STALE', 'MISSING'];

export function weakestStatus(statuses) {
  return statuses.reduce((w, s) => (COST_TRUST_ORDER.indexOf(s) > COST_TRUST_ORDER.indexOf(w) ? s : w), 'VERIFIED');
}

const MISSING = (reason) => ({ status: COST_STATUS.MISSING, unit_cost: null, currency: null, source: null, basis: 'NONE', reason });

/**
 * @param {Array<{unit_cost:number|string,currency:string,effective_from:string,source:string,validation_status:string}>} rows costs of ONE variant
 * @param {Date} at time of sale (or "now" for current valuation)
 * @param {string} currency currency the result must be in - costs are never FX-converted
 */
export function resolveUnitCost(rows, at, currency) {
  if (!rows || rows.length === 0) return MISSING('NO_COST_ROW');
  const sorted = [...rows].sort((a, b) => new Date(a.effective_from) - new Date(b.effective_from));
  const asOf = sorted.filter((r) => new Date(r.effective_from) <= at).at(-1);
  // Only cost rows recorded after the sale exist (cost tracking began later):
  // use the earliest one, but say so - it is today's cost applied to history.
  const row = asOf ?? sorted[0];
  const basis = asOf ? 'AS_OF_SALE' : 'CURRENT_COST_APPLIED_TO_HISTORY';
  const unit = Number(row.unit_cost);
  if (!(unit > 0)) return MISSING('NON_POSITIVE_COST');
  if (currency && row.currency !== currency) return MISSING('CURRENCY_MISMATCH');
  return {
    status: FROM_VALIDATION[row.validation_status] ?? COST_STATUS.UNVERIFIED,
    unit_cost: unit, currency: row.currency, source: row.source, basis, reason: null,
  };
}
