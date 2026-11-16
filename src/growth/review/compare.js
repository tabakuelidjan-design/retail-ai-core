// Growth > revue d'une mise en avant produit ou variante: the observed change in NET units sold, before and after the day the merchant applied the action.
// Pure and deterministic: a dataset in (the one src/metrics/load.js#loadDataset returns, for the ACTIVE merchant), a comparison out. Nothing is read or written here.
//
// THE RULE OF THE TWO WINDOWS (all in the merchant's time zone, half-open [start, end), whole local days only):
//   D  = the application date (a local calendar date, declared by the merchant)        R = the planned review date        today = the local date of `now`
//   the application day D is EXCLUDED from both periods (the action was applied during it: a partial day);
//   AFTER  starts at the start of D+1 and ends (excluded) at the start of min(R+1, today): the review day R is included when it is over, today (partial) never is;
//   N = the number of days of AFTER; when N >= 7 it is cut down to a whole number of weeks (floor(N / 7) * 7) so that both periods hold every weekday equally often;
//   BEFORE has the SAME duration N and ends (excluded) at the start of D:  [D - N, D).
//   With fewer than 7 days the weekdays are not balanced: the result is flagged (SHORT_PERIOD), not hidden. Fewer than 1 complete day = no comparison (PERIOD_NOT_COMPLETE).
// THE SAME SCOPE on both periods: the same product (or variant), every channel, test orders and cancelled orders counted 0, refunds known at `now` deducted per line, once
// (this is src/creative-autonomy/opportunity.js#variantRowsFromDataset, the net-units calculation Growth already uses; `quantity` of an order line is GROSS).
// LIMITS (the comparison is then not "comparable": the numbers are kept for information, the review stays manual):
//   TARGET_NOT_FOUND   the product / variant is not in the merchant's synced data          HISTORY_TOO_SHORT  BEFORE starts before the first order the merchant has in Nordla
//   SYNC_INCOMPLETE    an order of either period has an unfinished nested page (lines_truncated)
//   LOW_VOLUME         before + after < the product engine's own minimum sample (config.demand.cover.minUnits): no new threshold
// The difference is an OBSERVED evolution, never a proof of cause. A percentage exists only when the "before" value is above zero.
import { localDateString, localMidnight, addDays } from '../../metrics/windows.js';
import { variantRowsFromDataset } from '../../creative-autonomy/opportunity.js';

export const REVIEW_RULE = 'growth-review.1';
const DAY = 86_400_000;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/**
 * @returns {{ ok: true, before, after, days, weekdaysBalanced } | { ok: false, limit: string }}   before / after = { start, end (ISO instants, end excluded), localStart, localEnd, days }
 */
export function reviewWindows({ appliedDate, reviewDate, now, timeZone }) {
  if (!isoDate.test(appliedDate ?? '') || !isoDate.test(reviewDate ?? '')) return { ok: false, limit: 'BAD_DATES' };
  const today = localDateString(now, timeZone);
  const afterStart = addDays(appliedDate, 1);
  const reviewEnd = addDays(reviewDate, 1);
  const afterEnd = reviewEnd < today ? reviewEnd : today; // the review day is included once it is over; today (partial) never
  let n = daysBetween(afterStart, afterEnd);
  if (!(n >= 1)) return { ok: false, limit: 'PERIOD_NOT_COMPLETE' };
  const weekdaysBalanced = n >= 7;
  if (weekdaysBalanced) n = Math.floor(n / 7) * 7;
  const mk = (s, e) => ({ start: localMidnight(s, timeZone).toISOString(), end: localMidnight(e, timeZone).toISOString(), localStart: s, localEnd: e, days: n });
  return { ok: true, days: n, weekdaysBalanced, after: mk(afterStart, addDays(afterStart, n)), before: mk(addDays(appliedDate, -n), appliedDate) };
}

function netOf(data, target, w, now) {
  const rows = variantRowsFromDataset(data, { now, since: w.start, until: w.end }).filter((r) => (target.type === 'variant' ? r.variant_id === target.id : r.product_local_id === target.id));
  const sum = (f) => rows.reduce((a, r) => a + f(r.evidence), 0);
  return { units: sum((e) => e.units_net), gross: sum((e) => e.units_gross), refunded: sum((e) => e.units_refunded), cancelled: sum((e) => e.units_cancelled) };
}

/**
 * @param {{ data: object, target: {type: 'product'|'variant', id: string}, appliedDate: string, reviewDate: string, now: Date, timeZone: string, minUnits?: number }} p
 */
export function compareNetUnits({ data, target, appliedDate, reviewDate, now, timeZone, minUnits = 3 }) {
  const base = { rule: REVIEW_RULE, timeZone, calculatedAt: new Date(now).toISOString(), target };
  const w = reviewWindows({ appliedDate, reviewDate, now, timeZone });
  if (!w.ok) return { ...base, state: 'LIMITED', limits: [w.limit], before: null, after: null, difference: null };
  const found = target.type === 'variant' ? (data.variants ?? []).some((v) => v.source_id === target.id) : (data.products ?? []).some((p) => p.id === target.id);
  const windows = { before: w.before, after: w.after, days: w.days, weekdaysBalanced: w.weekdaysBalanced, appliedDate, applicationDayExcluded: true };
  if (!found) return { ...base, state: 'LIMITED', limits: ['TARGET_NOT_FOUND'], windows, before: null, after: null, difference: null };
  const before = netOf(data, target, w.before, now); const after = netOf(data, target, w.after, now);
  const limits = [];
  const first = data.firstOrderAt ? new Date(data.firstOrderAt) : null;
  if (!first || new Date(w.before.start) < first) limits.push('HISTORY_TOO_SHORT');
  const inWin = (o, win) => { const t = new Date(o.ordered_at); return t >= new Date(win.start) && t < new Date(win.end); };
  if ((data.orders ?? []).some((o) => o.lines_truncated && (inWin(o, w.before) || inWin(o, w.after)))) limits.push('SYNC_INCOMPLETE');
  if (before.units + after.units < minUnits) limits.push('LOW_VOLUME');
  const nonBlocking = w.weekdaysBalanced ? [] : ['SHORT_PERIOD'];
  const units = after.units - before.units;
  return { ...base, state: limits.length ? 'LIMITED' : 'COMPARABLE', limits: [...limits, ...nonBlocking], windows, before: { ...w.before, ...before }, after: { ...w.after, ...after },
    difference: { units, pct: before.units > 0 ? Math.round((units / before.units) * 10000) / 10000 : null },
    scope: { channels: 'all', orders: 'not test, not cancelled', refunds: 'known at the calculation date, deducted once per line' } };
}
