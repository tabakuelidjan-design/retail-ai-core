// Growth > revue of an applied site-page action: the OBSERVED change of the quote-form completion rate, before and after the day the merchant applied the change.
// Same two-window rule as the product review (src/growth/review/compare.js, reviewWindows): the application day is excluded, both windows are complete, whole weeks of equal
// length (weekdays balanced from 7 days), ending before the review day / today. Pure: the site's daily facts in, a comparison out.
//
// THE SAME DEFINITION ON BOTH SIDES: rate = sessions that started the form AND submitted it successfully / sessions that started it (the SAME sessions, the same page, the
// same events). Result in percentage points. COMPARABLE only when all of these hold, otherwise LIMITED (numbers kept for information, the review stays manual, nothing is stored):
//   DATA_INCOMPLETE       a window has day rows for less than 95 % of its days, or a figure is unavailable
//   NO_SEQUENTIAL_DATA    the source gives separate totals only: no same-session rate can be built
//   TRACKING_CHANGED      a form event was reconfigured (changed_on) between the start of BEFORE and the end of AFTER, other than before the plan: the two periods do not measure the same thing
//   LOW_STARTS            fewer form starts than the minimum in either window (config minFormStarts)
//   SHORT_PERIOD          (non blocking) fewer than 7 days: weekdays not balanced
// The difference is an observed evolution, never a proof of cause (no control group, no attribution).
import { reviewWindows } from '../review/compare.js';
import { aggregatePage, SITE_CONFIG } from './site.js';

export const SITE_REVIEW_RULE = 'growth-review-rate.1';
const round4 = (x) => Math.round(x * 10000) / 10000;

/** @param {{ site: object|null, path: string, appliedDate: string, reviewDate: string, now: Date, timeZone: string, config?: object }} p */
export function compareFormRate({ site, path, appliedDate, reviewDate, now, timeZone, config = SITE_CONFIG }) {
  const cfg = { ...SITE_CONFIG, ...config };
  const base = { rule: SITE_REVIEW_RULE, metric: 'rate', timeZone, calculatedAt: new Date(now).toISOString(), target: { type: 'page', id: path } };
  const w = reviewWindows({ appliedDate, reviewDate, now, timeZone });
  if (!w.ok) return { ...base, state: 'LIMITED', limits: [w.limit], before: null, after: null, difference: null };
  const windows = { before: w.before, after: w.after, days: w.days, weekdaysBalanced: w.weekdaysBalanced, appliedDate, applicationDayExcluded: true };
  if (!site) return { ...base, state: 'LIMITED', limits: ['DATA_INCOMPLETE'], windows, before: null, after: null, difference: null };
  const side = (win) => { const a = aggregatePage(site, path, win.localStart, win.localEnd); return { ...win, sessions: a.sessions, starts: a.starts, submits: a.submits, converted: a.seq, rate: a.seq !== null && a.starts > 0 ? round4(a.seq / a.starts) : null, coverage: Math.round(a.coverage * 100) / 100 }; };
  const before = side(w.before); const after = side(w.after);
  const limits = [];
  if (before.coverage < cfg.minCoverage || after.coverage < cfg.minCoverage || before.starts === null || after.starts === null) limits.push('DATA_INCOMPLETE');
  else if (before.converted === null || after.converted === null) limits.push('NO_SEQUENTIAL_DATA');
  if (site.events.some((e) => e.changedOn && e.changedOn >= w.before.localStart && e.changedOn <= w.after.localEnd)) limits.push('TRACKING_CHANGED');
  if (before.starts !== null && after.starts !== null && (before.starts < cfg.minFormStarts || after.starts < cfg.minFormStarts)) limits.push('LOW_STARTS');
  const diff = before.rate !== null && after.rate !== null ? { points: Math.round((after.rate - before.rate) * 10000) / 100 } : null; // percentage points, 2 decimals
  return { ...base, state: limits.length ? 'LIMITED' : 'COMPARABLE', limits: [...limits, ...(w.weekdaysBalanced ? [] : ['SHORT_PERIOD'])], windows, before, after, difference: diff,
    scope: { population: 'sessions that started the form', event: 'successful submission', page: path } };
}
