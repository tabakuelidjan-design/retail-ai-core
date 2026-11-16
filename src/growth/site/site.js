// Développement des ventes > Site indépendant (lot _07, first journey): a service page that receives quote requests. Pure and deterministic: the facts a web-analytics
// source provides (an import contract, GA4-shaped; see docs/GROWTH_DATA_LINEAGE.md) in, a diagnosis per page out. It reads nothing, writes nothing, never changes a site.
//
// WHO PROVIDES WHAT (each figure keeps its source):
//   GA4 (web analytics)  -> sessions of the page, sessions that STARTED the quote form, sessions that SUBMITTED it, and - only when the source can provide it
//                           (GA4 funnel exploration / BigQuery) - the sessions that started AND then submitted ("same sessions"). Day by day, so any window can be rebuilt.
//   Search Console (opt) -> impressions, clicks and queries of the page IN GOOGLE SEARCH. Search Console clicks and GA4 sessions have different definitions: they are
//                           shown side by side and NEVER used as numerator and denominator of one rate.
//   Nordla               -> the site / property / page match, the window, the time zone, the diagnosis and the action. Aggregates only: no visitor, no session id.
//
// THE FUNNEL: page viewed (sessions) -> form started -> form submitted SUCCESSFULLY. A click on "Envoyer" is not a received request: a submit event that only records the
// click is reported as such (SUBMIT_NOT_CONFIRMED), never used as a conversion.
//
// RULE growth-site.1 (one page, the window the source gave):
//   0. MATCH      the page must belong to the merchant's site (property site URL) and Search Console data to the same site, or it is set aside (said, not silent).
//   1. PERIOD     the window must be over (end <= today, merchant time zone) and have day rows for >= config.marketing.minSpendCoverage (0.95) of its days: INCOMPLETE_PERIOD.
//   2. MEASURE    start event not configured -> START_NOT_TRACKED; submit event not configured -> SUBMIT_NOT_TRACKED; submit that is only a click -> SUBMIT_NOT_CONFIRMED;
//                 events of a shared form that cannot tell the page of origin -> EVENTS_NOT_LINKABLE. Each gives a "complete / verify the measurement" action naming the step.
//   3. VOLUME     sessions < config.marketing.minSessionsForConversion (100, existing) or form starts < minFormStarts (30) -> LOW_VOLUME: the limit is said, a signal is kept.
//   4. RATE       with the sequential figure: rate = sessions that started AND submitted / sessions that started (the SAME sessions) -> GAP when below 100 %
//                 (no invented "weak" threshold: the gap is a signal, reliability 'limited', its cause is not identified), NO_GAP at 100 %. A real 0 is a rate of 0 %.
//                 Without it (separate totals only): TOTALS_ONLY - both totals are shown as totals, no sequential drop-off is deduced.
//   A figure that is null in the source is UNAVAILABLE, never 0.

import { localDateString, addDays } from '../../metrics/windows.js';

export const SITE_RULE = 'growth-site.1';
export const SITE_CONFIG = Object.freeze({ minSessions: 100, minFormStarts: 30, minCoverage: 0.95 });
export const SITE_ACTIONABLE = Object.freeze(['GAP', 'START_NOT_TRACKED', 'SUBMIT_NOT_TRACKED', 'SUBMIT_NOT_CONFIRMED', 'EVENTS_NOT_LINKABLE']);

const DAY = 86400000;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const nn = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
const round4 = (x) => Math.round(x * 10000) / 10000;
export const normPath = (p) => { try { const u = new URL(String(p), 'https://x.invalid'); return (u.pathname.replace(/\/+$/, '') || '/').toLowerCase(); } catch { return null; } };
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };

/** @returns {{ site: object|null, errors: string[], issues: object[] }} */
export function normalizeSiteFunnel(raw) {
  const errors = []; const issues = [];
  if (!raw || typeof raw !== 'object') return { site: null, errors: ['site funnel must be a JSON object'], issues };
  for (const k of ['source_system', 'property_id', 'site_url', 'time_zone']) if (!raw[k]) errors.push(`${k}: required`);
  if (raw.site_url && !host(raw.site_url)) errors.push('site_url: must be an absolute URL');
  const w = raw.window; if (!w || !isDate(w.start) || !isDate(w.end) || dayDiff(w.start, w.end) <= 0) errors.push('window: { start, end } as YYYY-MM-DD, end exclusive');
  const days = [];
  for (const r of Array.isArray(raw.daily) ? raw.daily : []) {
    const path = normPath(r.page_path);
    if (!isDate(r.date) || !path || nn(r.sessions) === null) { errors.push(`daily row: date, page_path and sessions are required (${r.date ?? '?'} ${r.page_path ?? '?'})`); continue; }
    days.push({ date: r.date, path, sessions: r.sessions, starts: nn(r.form_start_sessions), submits: nn(r.form_submit_sessions), seq: nn(r.started_then_submitted_sessions) });
  }
  const events = (Array.isArray(raw.events) ? raw.events : []).map((e) => ({ kind: e.kind, name: e.name ?? null, configured: e.configured === true, confirms: ['server_success', 'click', 'unknown'].includes(e.confirms) ? e.confirms : 'unknown', pageAttributable: e.page_attributable !== false, changedOn: isDate(e.changed_on) ? e.changed_on : null }));
  if (errors.length) return { site: null, errors, issues };
  const gsc = raw.search_console && typeof raw.search_console === 'object' ? raw.search_console : null; let search = null;
  if (gsc) {
    if (host(gsc.property_url ?? '') !== host(raw.site_url)) issues.push({ code: 'GSC_PROPERTY_MISMATCH', property: gsc.property_url ?? null });
    else search = { propertyUrl: gsc.property_url, window: gsc.window ?? null, retrievedAt: gsc.retrieved_at ?? null, filters: gsc.filters ?? null, pages: (gsc.page_rows ?? []).map((p) => ({ path: normPath(p.page), impressions: nn(p.impressions), clicks: nn(p.clicks) })), queries: (gsc.query_page_rows ?? []).map((q) => ({ query: q.query, path: normPath(q.page), impressions: nn(q.impressions), clicks: nn(q.clicks) })) };
  }
  return { site: { source: raw.source_system, method: raw.method ?? null, propertyId: String(raw.property_id), siteUrl: raw.site_url, timeZone: raw.time_zone, window: { start: w.start, end: w.end }, retrievedAt: raw.retrieved_at ?? null, filters: raw.filters ?? null,
    pages: raw.pages ?? null, days, events, search }, errors, issues };
}

/** Totals of one page over [start, end): null stays null (an unavailable figure is never summed as 0); coverage = days with a row / days of the window. */
export function aggregatePage(site, path, start, end) {
  const n = dayDiff(start, end); const rows = site.days.filter((d) => d.path === path && d.date >= start && d.date < end);
  const sum = (key) => (rows.length && rows.every((r) => r[key] !== null) ? rows.reduce((a, r) => a + r[key], 0) : null);
  return { days: n, daysWithData: new Set(rows.map((r) => r.date)).size, coverage: n > 0 ? new Set(rows.map((r) => r.date)).size / n : 0, sessions: sum('sessions'), starts: sum('starts'), submits: sum('submits'), seq: sum('seq') };
}
const eventOf = (site, kind) => site.events.find((e) => e.kind === kind) ?? null;

/** @returns {object[]} one diagnosis per page present in the data */
export function diagnoseSite({ site, now, timeZone, config = SITE_CONFIG }) {
  const cfg = { ...SITE_CONFIG, ...config }; const today = localDateString(now, timeZone); const { start, end } = site.window;
  const paths = [...new Set(site.days.map((d) => d.path))].sort();
  return paths.map((path) => {
    const base = { site: site.siteUrl, propertyId: site.propertyId, source: site.source, path, url: new URL(path, site.siteUrl).toString(), window: { start, end }, timeZone: site.timeZone, retrievedAt: site.retrievedAt, filters: site.filters };
    const out = (status, evidence = {}, extra = {}) => ({ ...base, status, actionable: SITE_ACTIONABLE.includes(status), evidence: { ...evidence, search: searchOf(site, path) }, rule: SITE_RULE, ...extra });
    const a = aggregatePage(site, path, start, end);
    if (site.timeZone !== timeZone) return out('INCOMPLETE_PERIOD', { reason: 'TIME_ZONE_DIFFERENT', reportingTimeZone: site.timeZone, merchantTimeZone: timeZone });
    if (end > today || a.coverage < cfg.minCoverage) return out('INCOMPLETE_PERIOD', { daysWithData: a.daysWithData, days: a.days, coverage: Math.round(a.coverage * 100) / 100, windowEnd: end, today });
    const ev = { start: eventOf(site, 'form_start'), submit: eventOf(site, 'form_submit') };
    const figures = { sessions: a.sessions, starts: a.starts, submits: a.submits, seq: a.seq, days: a.days };
    if (!ev.start || !ev.start.configured) return out('START_NOT_TRACKED', figures, { missing: 'start' });
    if (!ev.submit || !ev.submit.configured) return out('SUBMIT_NOT_TRACKED', figures, { missing: 'submit' });
    if (ev.submit.confirms !== 'server_success') return out('SUBMIT_NOT_CONFIRMED', { ...figures, submitEvent: ev.submit.name, confirms: ev.submit.confirms }, { missing: 'confirm' });
    if (!ev.start.pageAttributable || !ev.submit.pageAttributable) return out('EVENTS_NOT_LINKABLE', figures, { missing: 'link' });
    if (a.sessions === null || a.starts === null) return out('LOW_VOLUME', { ...figures, reason: 'FIGURE_UNAVAILABLE' });
    if (a.sessions < cfg.minSessions || a.starts < cfg.minFormStarts) return out('LOW_VOLUME', { ...figures, minSessions: cfg.minSessions, minFormStarts: cfg.minFormStarts });
    if (a.seq === null) return out('TOTALS_ONLY', figures);
    const rate = round4(a.seq / a.starts);
    return out(rate < 1 ? 'GAP' : 'NO_GAP', { ...figures, converted: a.seq, rate, basis: 'SAME_SESSIONS' });
  }).sort((x, y) => (y.evidence.sessions ?? -1) - (x.evidence.sessions ?? -1) || x.path.localeCompare(y.path));
}
/** Search Console figures of the page, apart (different definitions from the web-analytics sessions). */
function searchOf(site, path) {
  const s = site.search; if (!s) return null; const page = s.pages.find((p) => p.path === path);
  return { impressions: page ? page.impressions : null, clicks: page ? page.clicks : null, window: s.window, retrievedAt: s.retrievedAt, queries: s.queries.filter((q) => q.path === path).sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0)).slice(0, 3) };
}

/** Items for Opportunités: one per actionable page. The exact page, figures, period, reason and change to test (or the measure to complete). */
export function siteItems(diagnoses) {
  return diagnoses.filter((d) => d.actionable).map((d) => {
    const change = d.status === 'GAP' ? 'reviewForm' : 'fixMeasure';
    return {
      id: `site:${d.propertyId}:${d.path}`, category: 'site', kind: 'sitePage', sourcePage: 'site',
      title: { code: `site.${d.status}.title`, params: { path: d.path } }, explanation: { code: `site.${d.status}.why`, params: {} },
      entity: { type: 'sitePage', id: d.path, title: d.path },
      evidence: { ...d.evidence, status: d.status, site: d.site, propertyId: d.propertyId, path: d.path, url: d.url, source: d.source, timeZone: d.timeZone, filters: d.filters, missing: d.missing ?? null },
      reliability: 'limited', measurement: { start: d.window.start, end: d.window.end, calculatedAt: d.retrievedAt },
      preparedAction: { code: 'siteForm', change, missing: d.missing ?? null, page: { path: d.path, url: d.url } },
      target: { type: 'sitePage', available: true, id: d.path, url: d.url }, prerequisites: [], dataBlocker: null,
    };
  });
}
export { addDays };
