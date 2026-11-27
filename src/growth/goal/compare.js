// Nordla Growth - the weekly target against the realised sales of ONE complete week, computed on the SERVER (rule growth-goal-compare.1).
// Never by a model. The reference week is the LAST week of the store engine (its rows are the complete weeks before today). Rules:
//  - no target (absent, not a whole number, outside 0..100 000 000 EUR)            -> unavailable NO_TARGET
//  - no store sales payload                                                         -> unavailable NO_SALES_DATA
//  - the last week is not complete (the sales history starts after its first day)  -> unavailable PARTIAL_WEEK
//  - a store or online figure of that week is missing                               -> unavailable SALES_MISSING (no other week is picked)
//  - no complete week at all (history starts after the last week)                   -> unavailable NO_COMPLETE_WEEK
//  - target 0: no rate can be computed                                              -> unavailable TARGET_ZERO
// Realised = store + online of that week ONLY (channel "other" is not part of the comparison, and the answer says so).

export const COMPARE_RULE = 'growth-goal-compare.1';
const round2 = (x) => Math.round(x * 100) / 100;

const unavailable = (reason, extra = {}) => ({ status: 'unavailable', rule: COMPARE_RULE, reason, ...extra });

/** The last day of a week that starts on `start` (YYYY-MM-DD) and is seven days long, inclusive. */
export function lastDayOf(start) {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

export function compareWeeklyTarget({ target, store }) {
  if (!Number.isInteger(target) || target < 0 || target > 100000000) return unavailable('NO_TARGET');
  if (!store || !Array.isArray(store.weekly) || store.weekly.length === 0) return unavailable('NO_SALES_DATA');
  const week = store.weekly[store.weekly.length - 1];
  if (!week || typeof week.start !== 'string') return unavailable('NO_SALES_DATA');
  if (store.weekly.every((w) => !w || w.complete !== true)) return unavailable('NO_COMPLETE_WEEK');
  if (week.complete !== true) return unavailable('PARTIAL_WEEK', { period: { start: week.start, end: lastDayOf(week.start) } });
  const period = { start: week.start, end: lastDayOf(week.start) };
  if (!Number.isFinite(week.storeNet) || !Number.isFinite(week.onlineNet)) return unavailable('SALES_MISSING', { period });
  if (target === 0) return unavailable('TARGET_ZERO', { period });
  const realisedTotal = round2(week.storeNet + week.onlineNet);
  return {
    status: 'computed', rule: COMPARE_RULE, period,
    basis: 'boutique + en ligne, semaine complète ; le canal « autre » n’est pas compté',
    target, realised: { storeNet: round2(week.storeNet), onlineNet: round2(week.onlineNet), total: realisedTotal },
    gap: round2(realisedTotal - target),
    ratePercent: Math.round((realisedTotal / target) * 100),
  };
}
