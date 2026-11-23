// Core home: the sales figures read-only, from the Analytics brief (the report the Analytics module already
// produces). Core never computes a metric here: it reshapes what Analytics reports, or says why it cannot.
//
// Contract (checked in src/analytics-premium/server/hosting.js and app.js):
//   - Analytics refuses its access token on staging (NORDLA_SSO_ONLY=1): the brief is read with a Nordla session.
//   - Core signs a one-time ticket for the signed-in person (the same ticket that opens Analytics, ANALYTICS_SSO_SECRET).
//   - GET <analytics>/sso?t=<ticket> answers 302 with a session cookie (an_sid); that cookie is sent to GET /api/brief.
//   - Analytics re-checks the person's access on every request. 404 = no report for this merchant yet.
// Missing configuration or no personal session: NOT_CONNECTED. Any failure: UNAVAILABLE. Never a zero in place of a figure.

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

/**
 * Reads the Analytics brief for the signed-in person. `publicUrl` and `ticket` come from the Core server (ANALYTICS_PUBLIC_URL
 * and a ticket signed just now for this person). Nothing is stored; the session cookie lives for this one read.
 */
export async function loadSalesHome({ publicUrl = '', ticket = '', headers = {}, fetchImpl = globalThis.fetch } = {}) {
  if (!publicUrl || !ticket) return { status: 'NOT_CONNECTED', source: 'Analytics' };
  let base;
  try { base = new URL(publicUrl); } catch { return { status: 'UNAVAILABLE', source: 'Analytics' }; }
  if (base.protocol !== 'https:' && base.hostname !== 'localhost') return { status: 'UNAVAILABLE', source: 'Analytics' }; // the ticket is never sent in clear
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const at = (p) => new URL((base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname) + p, base.origin).href; // keeps a gateway prefix such as /analyses
    const sso = await fetchImpl(at(`/sso?t=${encodeURIComponent(ticket)}`), { redirect: 'manual', signal, headers });
    const cookie = (sso.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('an_sid='));
    if (sso.status !== 302 || !cookie) return { status: 'UNAVAILABLE', source: 'Analytics', reason: `SSO_HTTP_${sso.status}${cookie ? '' : '_NO_COOKIE'}` };
    const sid = cookie.split(';')[0];
    const res = await fetchImpl(at('/api/brief'), { headers: { ...headers, cookie: sid, accept: 'application/json' }, signal });
    if (res.status === 404) return { status: 'NOT_CONNECTED', source: 'Analytics' }; // no report for this merchant yet
    if (!res.ok) return { status: 'UNAVAILABLE', source: 'Analytics', reason: `BRIEF_HTTP_${res.status}` };
    return salesHomeFromBrief(await res.json());
  } catch (e) {
    // a short, non-secret reason only (never the ticket, the cookie or a response body)
    return { status: 'UNAVAILABLE', source: 'Analytics', reason: `ERROR_${String(e?.name ?? 'Error').slice(0, 40)}` };
  }
}
