// Pure classifiers for demand and inventory facts. Each returns the label AND
// the numbers it was derived from, so nothing downstream has to trust a label
// without its evidence. Labels describe observed facts; none is a judgement or
// a recommendation. With thin history the answer is INSUFFICIENT_*, never a guess.

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

export function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * NO_SALES | INSUFFICIENT_HISTORY | SINGLE_ORDER | ONE_OFF_SPIKE | CONSISTENT | INTERMITTENT
 * `weeklyUnits` covers the whole window (oldest first); `observableWeeks` counts the weeks the entity existed.
 */
export function classifyPattern({ units, orderCount, weeklyUnits, observableWeeks }, cfg) {
  const activeWeeks = weeklyUnits.filter((u) => u > 0).length;
  const topWeekUnits = Math.max(0, ...weeklyUnits);
  const evidence = { units, orders: orderCount, active_weeks: activeWeeks, observable_weeks: observableWeeks, top_week_units: topWeekUnits };
  if (units === 0) return { pattern: 'NO_SALES', evidence };
  if (observableWeeks < cfg.minObservableWeeks) return { pattern: 'INSUFFICIENT_HISTORY', evidence };
  if (orderCount === 1) return { pattern: 'SINGLE_ORDER', evidence };
  if (activeWeeks === 1 || (units >= cfg.spikeMinUnits && topWeekUnits / units >= cfg.spikeShare)) {
    return { pattern: 'ONE_OFF_SPIKE', evidence };
  }
  const needed = Math.max(cfg.consistentMinActiveWeeks, Math.ceil(cfg.consistentMinActiveShare * observableWeeks));
  return { pattern: activeWeeks >= needed ? 'CONSISTENT' : 'INTERMITTENT', evidence: { ...evidence, active_weeks_needed_for_consistent: needed } };
}

/** UP | DOWN | FLAT | INSUFFICIENT_DATA — recent half vs the equally long prior half of the observable weeks. */
export function classifyTrend({ weeklyUnits, observableWeeks }, cfg) {
  const t = cfg.trend;
  const units = weeklyUnits.reduce((a, b) => a + b, 0);
  if (observableWeeks < t.minObservableWeeks) return { direction: 'INSUFFICIENT_DATA', reason: 'OBSERVABLE_WEEKS_BELOW_MIN' };
  if (units < t.minUnits) return { direction: 'INSUFFICIENT_DATA', reason: 'UNITS_BELOW_MIN' };
  const observed = weeklyUnits.slice(weeklyUnits.length - observableWeeks);
  const half = Math.floor(observableWeeks / 2);
  const recent = observed.slice(-half).reduce((a, b) => a + b, 0);
  const prior = observed.slice(-2 * half, -half).reduce((a, b) => a + b, 0);
  const evidence = { recent_units: recent, prior_units: prior, weeks_each_side: half };
  if (recent - prior >= t.minUnitDelta && recent >= prior * (1 + t.changeRatio)) return { direction: 'UP', ...evidence };
  if (prior - recent >= t.minUnitDelta && recent <= prior * (1 - t.changeRatio)) return { direction: 'DOWN', ...evidence };
  return { direction: 'FLAT', ...evidence };
}

/** Weeks/days of cover = stock ÷ average weekly units. Only computed when the sales sample supports it. */
export function computeCover({ stockUnits, units, exposureWeeks, observableWeeks }, cfg) {
  if (stockUnits <= 0) return { status: 'NO_STOCK', weeks: null, days: null };
  if (observableWeeks < cfg.minObservableWeeks) return { status: 'INSUFFICIENT_HISTORY', weeks: null, days: null };
  if (units === 0) return { status: 'NO_DEMAND_OBSERVED', weeks: null, days: null }; // never "infinite"
  if (units < cfg.cover.minUnits) return { status: 'INSUFFICIENT_SALES_SAMPLE', weeks: null, days: null };
  const weekly = units / exposureWeeks;
  return { status: 'CALCULATED', weeks: round1(stockUnits / weekly), days: Math.round((stockUnits / weekly) * 7) };
}

/**
 * Sell-through as Shopify defines it: sold ÷ (sold + ending stock), with sales counted through the same
 * moment as the stock snapshot. Ending stock is unverified, so status is PARTIAL.
 */
export function sellThrough({ units, stockUnits }) {
  const denominator = units + Math.max(0, stockUnits);
  return { rate: denominator > 0 ? Math.round((units / denominator) * 10000) / 10000 : null, status: 'PARTIAL', definition: 'units_sold / (units_sold + current_stock)' };
}

/**
 * NO_STOCK | TOO_NEW | NO_SALE_IN_WINDOW | LIMITED_SALES_SAMPLE | SLOW_COVER | LOW_COVER | ACTIVE_COVER.
 * Facts about stock relative to demand, not verdicts.
 */
export function classifyInventory({ stockUnits, units, observableWeeks, cover }, cfg) {
  if (stockUnits <= 0) return 'NO_STOCK';
  if (observableWeeks < cfg.minObservableWeeks) return 'TOO_NEW';
  if (units === 0) return 'NO_SALE_IN_WINDOW';
  if (cover.status !== 'CALCULATED') return 'LIMITED_SALES_SAMPLE';
  if (cover.weeks >= cfg.cover.slowWeeks) return 'SLOW_COVER';
  if (cover.weeks < cfg.cover.lowWeeks) return 'LOW_COVER';
  return 'ACTIVE_COVER';
}

export function isRoundQuantity(units, cfg) {
  return units >= cfg.roundQuantity.minUnits && units % cfg.roundQuantity.multipleOf === 0;
}

/**
 * Stock quality of a Shopify-reported quantity. There is no physical-count
 * evidence in the data, so the best possible value is UNVERIFIED (never VERIFIED).
 */
export function stockQuality({ snapshotAt, units, roundVariants }, { now, maxAgeHours }) {
  if (!snapshotAt) return 'NO_STOCK_DATA';
  if ((now - snapshotAt) / 3600000 > maxAgeHours) return 'STALE';
  if (units < 0) return 'UNRELIABLE_NEGATIVE';
  if (roundVariants > 0) return 'SUSPECT_ROUND_QUANTITY';
  return 'UNVERIFIED';
}

export { round1, round2 };
