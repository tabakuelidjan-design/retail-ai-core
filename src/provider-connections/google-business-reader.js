// Google Business Profile, READ ONLY: reviews and performance indicators of ONE location, with their period and last update date.
// First marketing connector (owner request 2026-11-17). It reads, it never replies, posts, edits or deletes anything at Google.
//
// Inputs are injected (nothing is read from the environment here):
//   getAccessToken() -> Promise<string>   (the Provider Token Manager supplies it; this file never sees a refresh token or a secret)
//   fetchImpl                              (default: global fetch; tests give a double)
// Access: Google gates these APIs behind a "Basic API Access" request (up to 14 days) - until approved every call answers 403/429 and this reader
// reports ACCESS_NOT_GRANTED, never an empty "0 reviews". Endpoints below follow Google's v4 reviews and Business Profile Performance v1 docs;
// the exact response shapes must be re-checked on the FIRST real call (that call is the owner's authorisation step).
const REVIEWS_URL = (loc) => `https://mybusiness.googleapis.com/v4/${loc}/reviews`;
const METRICS_URL = (loc) => `https://businessprofileperformance.googleapis.com/v1/${loc}:fetchMultiDailyMetricsTimeSeries`;
export const GBP_METRICS = Object.freeze(['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'WEBSITE_CLICKS', 'CALL_CLICKS', 'BUSINESS_DIRECTION_REQUESTS']);
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const LOCATION = /^accounts\/[0-9]{1,30}\/locations\/[0-9]{1,30}$/;
const err = (code, message, status) => Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
const ymd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s)); if (!m) throw err('PERIOD_INVALID', 'dates must be YYYY-MM-DD'); return { year: +m[1], month: +m[2], day: +m[3] }; };

export function createGoogleBusinessReader({ getAccessToken, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  if (typeof getAccessToken !== 'function') throw new TypeError('getAccessToken is required');
  const get = async (url) => {
    const token = await getAccessToken();
    let res; try { res = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } }); } catch { throw err('SOURCE_UNREACHABLE', 'Google could not be reached'); }
    if (res.status === 401) throw err('TOKEN_REJECTED', 'the connection must be renewed', 401);
    if (res.status === 403 || res.status === 429) throw err('ACCESS_NOT_GRANTED', 'Google has not granted API access for this project yet (Basic API Access request) or the quota is 0', res.status);
    if (!res.ok) throw err('SOURCE_ERROR', `Google answered ${res.status}`, res.status);
    return res.json();
  };
  return Object.freeze({
    /** Latest reviews + the totals Google reports. Never an invented figure: a missing field stays null. */
    async reviews({ location, limit = 50 }) {
      if (!LOCATION.test(String(location))) throw err('LOCATION_INVALID', 'accounts/<id>/locations/<id> expected');
      const j = await get(`${REVIEWS_URL(location)}?pageSize=${Math.min(Math.max(1, limit), 50)}&orderBy=updateTime%20desc`);
      const list = Array.isArray(j.reviews) ? j.reviews : [];
      return {
        source: 'Google Business Profile (lecture seule)', location, fetchedAt: now().toISOString(),
        averageRating: typeof j.averageRating === 'number' ? j.averageRating : null, totalReviewCount: Number.isInteger(j.totalReviewCount) ? j.totalReviewCount : null,
        lastUpdate: list.map((r) => r.updateTime ?? r.createTime ?? null).filter(Boolean).sort().at(-1) ?? null,
        reviews: list.map((r) => ({ id: r.reviewId ?? null, stars: STARS[r.starRating] ?? null, comment: typeof r.comment === 'string' ? r.comment.slice(0, 2000) : null, createdAt: r.createTime ?? null, updatedAt: r.updateTime ?? null, replied: Boolean(r.reviewReply?.comment) })),
        note: 'Les noms et photos des auteurs ne sont pas conservés. Aucune réponse n’est envoyée depuis Nordla.',
      };
    },
    /** Daily indicators summed over an explicit period [from, to] (inclusive). */
    async indicators({ location, from, to }) {
      if (!LOCATION.test(String(location))) throw err('LOCATION_INVALID', 'accounts/<id>/locations/<id> expected');
      const a = ymd(from); const b = ymd(to); if (`${from}` > `${to}`) throw err('PERIOD_INVALID', 'from is after to');
      const q = [...GBP_METRICS.map((m) => `dailyMetrics=${m}`), `dailyRange.startDate.year=${a.year}`, `dailyRange.startDate.month=${a.month}`, `dailyRange.startDate.day=${a.day}`, `dailyRange.endDate.year=${b.year}`, `dailyRange.endDate.month=${b.month}`, `dailyRange.endDate.day=${b.day}`].join('&');
      const j = await get(`${METRICS_URL(location)}?${q}`);
      const series = (j.multiDailyMetricTimeSeries ?? []).flatMap((x) => x.dailyMetricTimeSeries ?? []);
      const totals = {}; let lastDay = null;
      for (const s of series) { const pts = s.timeSeries?.datedValues ?? []; totals[s.dailyMetric] = pts.reduce((t, p) => t + (Number(p.value) || 0), 0); for (const p of pts) if (p.value !== undefined && p.date) { const d = `${p.date.year}-${String(p.date.month).padStart(2, '0')}-${String(p.date.day).padStart(2, '0')}`; if (!lastDay || d > lastDay) lastDay = d; } }
      return { source: 'Google Business Profile (lecture seule)', location, period: { from, to }, fetchedAt: now().toISOString(), lastDataDay: lastDay, totals, missing: GBP_METRICS.filter((m) => !(m in totals)), note: 'Google publie ces indicateurs avec un décalage de quelques jours.' };
    },
  });
}
