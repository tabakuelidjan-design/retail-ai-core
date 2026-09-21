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
export function buildWindows(now, timeZone, { availableDays = 60 } = {}) {
  const today = localDateString(now, timeZone);
  const startOfToday = localMidnight(today, timeZone);
  const mk = (key, label, startStr, end) => ({
    key, label, timeZone, start: localMidnight(startStr, timeZone), end,
    localStart: startStr, localEnd: today,
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

export function inWindow(instant, window) {
  const t = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  return t >= window.start.getTime() && t < window.end.getTime();
}
