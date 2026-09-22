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
export function previousEquivalentWindow(window) {
  if (!window.localStart || !window.localEnd) return null;
  const days = Math.round((new Date(`${window.localEnd}T00:00:00Z`) - new Date(`${window.localStart}T00:00:00Z`)) / (24 * 60 * 60 * 1000));
  const prevEnd = window.localStart;
  const prevStart = addDays(window.localStart, -days);
  return {
    key: `${window.key}_previous`, label: `Previous ${window.label ?? window.key}`, timeZone: window.timeZone,
    start: localMidnight(prevStart, window.timeZone), end: localMidnight(prevEnd, window.timeZone),
    localStart: prevStart, localEnd: prevEnd,
  };
}
