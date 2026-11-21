// Core home: the sales figures read-only, from the Analytics brief (the report the Analytics module already
// produces). Core never computes a metric here: it reshapes what Analytics reports, or says why it cannot.
//
// Configuration (both required, never committed):
//   ANALYTICS_BRIEF_URL    base address of the Analytics server (https), e.g. the Analytics staging address
//   ANALYTICS_BRIEF_TOKEN  the Analytics access token, sent as the Basic password (same as the Analytics dashboard)
// Without both: status NOT_CONNECTED. A failed or slow call: UNAVAILABLE. Never a zero in place of a missing figure.

const TIMEOUT_MS = 4000;

/** Pure: an Analytics brief (src/analytics-premium/server/brief.js) in, the Core home's sales shape out. */
export function salesHomeFromBrief(brief) {
  const net = brief?.kpis?.netRevenue?.value;
  const orders = brief?.kpis?.orders?.value;
  if (!brief || typeof net !== 'number') return { status: 'NOT_CONNECTED', source: 'Analytics', currency: brief?.currency ?? 'EUR' };
  const values = [{ key: 'net_sales_ex_tax', value: net, unit: brief.currency ?? 'EUR' }];
  if (typeof orders === 'number') values.push({ key: 'order_count', value: orders, unit: 'count' });
  const weekly = weeklyOf(brief.series);
  return {
    status: 'AVAILABLE', source: 'Analytics (rapport des 30 derniers jours)', currency: brief.currency ?? 'EUR',
    values,
    // The brief holds no previous-period figures: the deltas are absent, so the home shows no percentage (never an invented one).
    comparison: { rows: [] },
    weekly,
    channels: [],
    generatedAt: brief.generatedAt ?? null,
  };
}

/** Daily series of the brief, grouped by ISO week (Monday start), oldest first. Null days stay null. */
function weeklyOf(series) {
  const dates = series?.dates ?? []; const net = series?.netRevenue ?? []; const ord = series?.orders ?? [];
  const buckets = new Map();
  dates.forEach((d, i) => {
    const day = new Date(`${String(d).slice(0, 10)}T00:00:00Z`); if (Number.isNaN(day.getTime())) return;
    const dow = (day.getUTCDay() + 6) % 7; day.setUTCDate(day.getUTCDate() - dow);
    const key = day.toISOString().slice(0, 10);
    const b = buckets.get(key) ?? { week_start: key, net_sales_ex_tax: 0, order_count: 0, netSeen: false, ordSeen: false };
    if (typeof net[i] === 'number') { b.net_sales_ex_tax += net[i]; b.netSeen = true; }
    if (typeof ord[i] === 'number') { b.order_count += ord[i]; b.ordSeen = true; }
    buckets.set(key, b);
  });
  return [...buckets.values()].sort((a, b) => (a.week_start < b.week_start ? -1 : 1))
    .map(({ netSeen, ordSeen, ...w }) => ({ ...w, net_sales_ex_tax: netSeen ? w.net_sales_ex_tax : null, order_count: ordSeen ? w.order_count : null }));
}

/** Reads the Analytics brief with the configured address and token. Any failure is UNAVAILABLE, never a figure. */
export async function loadSalesHome({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = String(env.ANALYTICS_BRIEF_URL ?? '').trim(); const token = String(env.ANALYTICS_BRIEF_TOKEN ?? '');
  if (!base || !token) return { status: 'NOT_CONNECTED', source: 'Analytics' };
  let url;
  try { url = new URL('/api/brief', base); } catch { return { status: 'UNAVAILABLE', source: 'Analytics' }; }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') return { status: 'UNAVAILABLE', source: 'Analytics' };
  try {
    const res = await fetchImpl(url.href, { headers: { authorization: `Basic ${Buffer.from(`nordla:${token}`).toString('base64')}`, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return { status: 'NOT_CONNECTED', source: 'Analytics' }; // no report for this merchant yet
    if (!res.ok) return { status: 'UNAVAILABLE', source: 'Analytics' };
    return salesHomeFromBrief(await res.json());
  } catch {
    return { status: 'UNAVAILABLE', source: 'Analytics' };
  }
}
