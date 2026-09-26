// Merchant-timezone-aware reporting windows. The timezone is always a
// parameter (merchant config); nothing here knows any specific merchant's zone.
// Every window is a half-open interval [start, end) of UTC instants.

export function localDateString(instant, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function offsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant at which local calendar date `dateStr` starts (00:00) in `timeZone`. DST-safe. */
export function localMidnight(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(new Date(guess), timeZone);
  const second = guess - offsetMs(new Date(first), timeZone);
  return new Date(second);
}

/**
 * yesterday / last_7_days / last_30_days: complete local calendar days ending
 * at the start of today (today's partial day is excluded so windows are comparable).
 * available_window: the last `availableDays` local days through `now` - the
 * span of order history the source system exposes.
 */
export function buildWindows(now, timeZone, { availableDays = 60, historyStart = null } = {}) {
  const today = localDateString(now, timeZone);
  const startOfToday = localMidnight(today, timeZone);
  const mk = (key, label, startStr, end) => ({
    key, label, timeZone, start: localMidnight(startStr, timeZone), end,
    localStart: startStr, localEnd: today,
    // Local date (YYYY-MM-DD) of the first real order of the business, when known: the comparison logic uses it to tell whether the
    // previous period had any business history at all.
    historyStart,
  });
  return {
    yesterday: mk('yesterday', 'Yesterday', addDays(today, -1), startOfToday),
    last_7_days: mk('last_7_days', 'Last 7 days', addDays(today, -7), startOfToday),
    last_30_days: mk('last_30_days', 'Last 30 days', addDays(today, -30), startOfToday),
    available_window: mk('available_window', `Available ${availableDays}-day order window`, addDays(today, -availableDays), now),
  };
}

/**
 * `weeks` consecutive 7-local-day buckets ending at today's local midnight,
 * oldest first (index 0 .. weeks-1). DST-safe: each boundary is a local midnight.
 */
export function buildWeekBuckets(now, timeZone, weeks = 8) {
  const today = localDateString(now, timeZone);
  const buckets = [];
  for (let i = weeks; i >= 1; i -= 1) {
    const startStr = addDays(today, -7 * i);
    buckets.push({
      index: weeks - i, localStart: startStr,
      start: localMidnight(startStr, timeZone), end: localMidnight(addDays(today, -7 * (i - 1)), timeZone),
    });
  }
  return buckets;
}

/**
 * `days` consecutive single-local-day buckets ending at today's local midnight (today itself
 * excluded, same convention as last_30_days), oldest first. For real day-by-day series (e.g. a
 * revenue sparkline) - never a fabricated or interpolated point, each bucket is a real half-open
 * [start, end) instant range a caller can pass straight to windowFacts/computeSalesMetrics.
 */
export function buildDayBuckets(now, timeZone, days = 30) {
  const today = localDateString(now, timeZone);
  const buckets = [];
  for (let i = days; i >= 1; i -= 1) {
    const startStr = addDays(today, -i);
    const endStr = addDays(today, -i + 1);
    buckets.push({
      key: startStr, label: startStr, timeZone,
      localStart: startStr, localEnd: endStr,
      start: localMidnight(startStr, timeZone), end: localMidnight(endStr, timeZone),
    });
  }
  return buckets;
}

/**
 * One bucket per local calendar day of an arbitrary window [localStart, localEnd) (same bucket shape as buildDayBuckets). The Explorer's series, weekly
 * trends and day-by-day comparison are built from these, so they follow whatever period is asked for instead of a fixed 30 days.
 */
export function dayBucketsOfWindow(window) {
  const out = [];
  for (let d = window.localStart; d < window.localEnd; d = addDays(d, 1)) {
    const next = addDays(d, 1);
    out.push({ key: d, label: d, timeZone: window.timeZone, localStart: d, localEnd: next, start: localMidnight(d, window.timeZone), end: localMidnight(next, window.timeZone) });
  }
  return out;
}

export function inWindow(instant, window) {
  const t = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  return t >= window.start.getTime() && t < window.end.getTime();
}

/**
 * `months` consecutive local-calendar-month buckets ending at today's local midnight, oldest first.
 * The current, still-open month is included as a partial bucket (its own start through `now`) so a
 * trend line never silently drops the most recent activity; callers that need only complete months
 * can drop the last bucket when `partial` is true.
 */
export function buildMonthBuckets(now, timeZone, months = 12) {
  const today = localDateString(now, timeZone);
  const [y, m] = today.split('-').map(Number);
  const buckets = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const idx = y * 12 + (m - 1) - i;
    const by = Math.floor(idx / 12);
    const bm = (idx % 12) + 1;
    const startStr = `${by}-${String(bm).padStart(2, '0')}-01`;
    const nextIdx = idx + 1;
    const ny = Math.floor(nextIdx / 12);
    const nm = (nextIdx % 12) + 1;
    const nextStartStr = `${ny}-${String(nm).padStart(2, '0')}-01`;
    const start = localMidnight(startStr, timeZone);
    const cappedEndStr = nextStartStr > today ? today : nextStartStr;
    const end = nextStartStr > today ? now : localMidnight(nextStartStr, timeZone);
    buckets.push({ key: startStr.slice(0, 7), localStart: startStr, localEnd: cappedEndStr, start, end, partial: nextStartStr > today });
  }
  return buckets;
}

/**
 * The immediately preceding window of the same local-day length, for period-over-period comparison.
 * `available_window` and other windows without a `localStart`/`localEnd` pair are not comparable this way.
 */
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / (24 * 60 * 60 * 1000));

/**
 * Factual coverage of a comparison: how many days each side has real business history for (history starts at the first real order).
 * `sufficient` only when the previous period has exactly as many days of history as the current one - no arbitrary threshold.
 * Returns null when the start of the history is unknown (coverage then cannot be asserted either way).
 */
export function comparisonCoverage(window) {
  if (!window?.localStart || !window?.localEnd || !window.historyStart) return null;
  const days = daysBetween(window.localStart, window.localEnd);
  const prevStart = addDays(window.localStart, -days);
  const covered = (start, end) => Math.max(0, Math.min(days, daysBetween(start > window.historyStart ? start : window.historyStart, end)));
  const currentCovered = covered(window.localStart, window.localEnd);
  const previousCovered = covered(prevStart, window.localStart);
  return {
    sufficient: previousCovered === currentCovered && previousCovered === days,
    history_start: window.historyStart, current_days: days, current_days_with_history: currentCovered,
    previous_days: days, previous_days_with_history: previousCovered,
  };
}

export function previousEquivalentWindow(window) {
  if (!window.localStart || !window.localEnd) return null;
  const days = Math.round((new Date(`${window.localEnd}T00:00:00Z`) - new Date(`${window.localStart}T00:00:00Z`)) / (24 * 60 * 60 * 1000));
  const prevEnd = window.localStart;
  const prevStart = addDays(window.localStart, -days);
  // A previous period that is not fully inside the business history is not a comparable period: no comparison is offered.
  const cov = comparisonCoverage(window);
  if (cov && !cov.sufficient) return null;
  return {
    key: `${window.key}_previous`, label: `Previous ${window.label ?? window.key}`, timeZone: window.timeZone,
    start: localMidnight(prevStart, window.timeZone), end: localMidnight(prevEnd, window.timeZone),
    localStart: prevStart, localEnd: prevEnd,
  };
}
