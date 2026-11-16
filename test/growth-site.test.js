// Growth > Site indépendant (lot _07): a service page that receives quote requests. Page exact, source of each figure, real zero vs unavailable, missing / unlinkable events,
// low volume, a valid before / after comparison, a stored review that survives changed numbers, merchant isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSiteFunnel, diagnoseSite, siteItems } from '../src/growth/site/site.js';
import { compareFormRate } from '../src/growth/site/compare.js';
import { createSiteSource, createSiteReviewSource } from '../src/growth/server/site.js';
import { createPrioritiesSource } from '../src/growth/server/priorities.js';

const NOW = new Date('2026-11-15T09:00:00Z'); const TZ = 'Europe/Brussels'; const PAGE = '/demander-un-devis'; const OTHER = '/contact';
const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
const split = (total, n) => Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));
/** daily rows of one page over n days from `from`: totals spread over the days */
const rows = (path, from, n, t) => { const s = split(t.sessions, n); const a = t.starts == null ? null : split(t.starts, n); const b = t.submits == null ? null : split(t.submits, n); const c = t.seq == null ? null : split(t.seq, n);
  return days(from, n).map((date, i) => ({ date, page_path: path, sessions: s[i], form_start_sessions: a ? a[i] : null, form_submit_sessions: b ? b[i] : null, started_then_submitted_sessions: c ? c[i] : null })); };
const EV = [{ kind: 'form_start', name: 'form_start', configured: true, confirms: 'unknown', page_attributable: true }, { kind: 'form_submit', name: 'generate_lead', configured: true, confirms: 'server_success', page_attributable: true }];
const funnel = (daily, o = {}) => ({ source_system: 'ga4', method: 'manual_export', property_id: '381000111', site_url: 'https://www.atelier-exemple.be', time_zone: TZ, window: { start: '2026-09-28', end: '2026-10-19' }, retrieved_at: '2026-11-15T06:00:00Z', filters: { channel: 'all' }, daily, events: EV, ...o });
const diag = (raw) => { const { site, errors } = normalizeSiteFunnel(raw); assert.deepEqual(errors, []); return diagnoseSite({ site, now: NOW, timeZone: TZ }); };
const one = (d, p = PAGE) => d.find((x) => x.path === p);
const EXAMPLE = { sessions: 240, starts: 60, submits: 12, seq: 12 }; // the lot's example: 240 visits, 60 started, 12 of those submitted = 20 %

test('ST-1 the example: 240 sessions, 60 started, 12 of the same sessions submitted = 20 %; the exact page, its figures, period, source and the change to test', () => {
  const d = one(diag(funnel(rows(PAGE, '2026-09-28', 21, EXAMPLE)))); assert.equal(d.status, 'GAP');
  assert.deepEqual([d.evidence.sessions, d.evidence.starts, d.evidence.converted, d.evidence.rate, d.evidence.basis, d.path, d.url, d.source, d.timeZone, d.window.start, d.window.end],
    [240, 60, 12, 0.2, 'SAME_SESSIONS', PAGE, 'https://www.atelier-exemple.be/demander-un-devis', 'ga4', TZ, '2026-09-28', '2026-10-19']);
  const [item] = siteItems([d]); assert.deepEqual([item.id, item.kind, item.preparedAction.code, item.preparedAction.change, item.preparedAction.page.url, item.target.url, item.reliability], ['site:381000111:/demander-un-devis', 'sitePage', 'siteForm', 'reviewForm', 'https://www.atelier-exemple.be/demander-un-devis', 'https://www.atelier-exemple.be/demander-un-devis', 'limited']);
  assert.deepEqual([item.measurement.start, item.measurement.end], ['2026-09-28', '2026-10-19']);
});

test('ST-2 a real zero is 0 %, a figure that is unavailable is NOT zero (totals only, no drop-off deduced), full conversion is "no gap"', () => {
  const zero = one(diag(funnel(rows(PAGE, '2026-09-28', 21, { sessions: 240, starts: 60, submits: 0, seq: 0 })))); assert.deepEqual([zero.status, zero.evidence.converted, zero.evidence.rate], ['GAP', 0, 0], 'a real zero');
  const totals = one(diag(funnel(rows(PAGE, '2026-09-28', 21, { sessions: 240, starts: 60, submits: 12, seq: null })))); assert.equal(totals.status, 'TOTALS_ONLY'); assert.equal(totals.evidence.rate, undefined, 'no rate from separate totals'); assert.deepEqual([totals.evidence.starts, totals.evidence.submits, totals.evidence.seq], [60, 12, null]); assert.equal(totals.actionable, false);
  assert.equal(one(diag(funnel(rows(PAGE, '2026-09-28', 21, { sessions: 240, starts: 60, submits: 60, seq: 60 })))).status, 'NO_GAP');
  const missing = one(diag(funnel(rows(PAGE, '2026-09-28', 21, { sessions: 240, starts: null, submits: null, seq: null })))); assert.equal(missing.status, 'LOW_VOLUME'); assert.equal(missing.evidence.reason, 'FIGURE_UNAVAILABLE');
});

test('ST-3 missing or unlinkable events: the first action completes the measure and names the missing step; a click on "Envoyer" is not a received request', () => {
  const daily = rows(PAGE, '2026-09-28', 21, EXAMPLE); const ev = (patch) => EV.map((e) => ({ ...e, ...(patch[e.kind] ?? {}) }));
  const noStart = one(diag(funnel(daily, { events: ev({ form_start: { configured: false } }) }))); assert.deepEqual([noStart.status, noStart.missing, noStart.actionable], ['START_NOT_TRACKED', 'start', true]);
  assert.equal(siteItems([noStart])[0].preparedAction.change, 'fixMeasure'); assert.equal(siteItems([noStart])[0].preparedAction.missing, 'start');
  assert.deepEqual(['SUBMIT_NOT_TRACKED', 'submit'], [one(diag(funnel(daily, { events: ev({ form_submit: { configured: false } }) }))).status, one(diag(funnel(daily, { events: ev({ form_submit: { configured: false } }) }))).missing]);
  const click = one(diag(funnel(daily, { events: ev({ form_submit: { confirms: 'click' } }) }))); assert.deepEqual([click.status, click.missing, click.evidence.confirms], ['SUBMIT_NOT_CONFIRMED', 'confirm', 'click']);
  const shared = one(diag(funnel(daily, { events: ev({ form_submit: { page_attributable: false } }) }))); assert.deepEqual([shared.status, shared.missing], ['EVENTS_NOT_LINKABLE', 'link']);
  assert.equal(one(diag(funnel(daily, { events: [EV[1]] }))).status, 'START_NOT_TRACKED', 'an absent event is not configured');
});

test('ST-4 low volume and incomplete data: the limit is said, no action; an incomplete or still-running period and a different reporting time zone give no conclusion', () => {
  const low = one(diag(funnel(rows(PAGE, '2026-09-28', 21, { sessions: 60, starts: 12, submits: 3, seq: 3 })))); assert.deepEqual([low.status, low.actionable, low.evidence.minFormStarts], ['LOW_VOLUME', false, 30]);
  assert.equal(one(diag(funnel(rows(PAGE, '2026-09-28', 12, EXAMPLE)))).status, 'INCOMPLETE_PERIOD', '12 of 21 days');
  assert.equal(one(diag(funnel(rows(PAGE, '2026-11-01', 14, EXAMPLE), { window: { start: '2026-11-01', end: '2026-11-20' } }))).status, 'INCOMPLETE_PERIOD', 'the window is not over');
  const tz = one(diag(funnel(rows(PAGE, '2026-09-28', 21, EXAMPLE), { time_zone: 'America/New_York' }))); assert.deepEqual([tz.status, tz.evidence.reason], ['INCOMPLETE_PERIOD', 'TIME_ZONE_DIFFERENT']);
});

test('ST-5 the exact page and Search Console apart: pages are told apart (path normalised), GSC clicks are never mixed with GA4 sessions, a property of another site is set aside', () => {
  const daily = [...rows(PAGE, '2026-09-28', 21, EXAMPLE), ...rows(`${OTHER}/`.toUpperCase(), '2026-09-28', 21, { sessions: 300, starts: 40, submits: 20, seq: 20 })];
  const gsc = { property_url: 'https://www.atelier-exemple.be/', window: { start: '2026-09-28', end: '2026-10-19' }, retrieved_at: '2026-11-14T06:00:00Z', filters: { search_type: 'web' }, page_rows: [{ page: 'https://www.atelier-exemple.be/demander-un-devis/', impressions: 5200, clicks: 190 }], query_page_rows: [{ query: 'devis peinture namur', page: '/demander-un-devis', impressions: 900, clicks: 41 }] };
  const d = diag(funnel(daily, { search_console: gsc })); assert.deepEqual(d.map((x) => x.path).sort(), [OTHER, PAGE]); assert.equal(one(d).status, 'GAP'); assert.equal(one(d, OTHER).status, 'GAP');
  const s = one(d).evidence.search; assert.deepEqual([s.impressions, s.clicks, s.queries[0].query], [5200, 190, 'devis peinture namur']); assert.equal(one(d).evidence.rate, 0.2, 'the rate uses form sessions only; GSC clicks are not in it');
  assert.equal(one(d, OTHER).evidence.search.impressions, null, 'no Search Console row for that page: unavailable, not 0');
  const bad = normalizeSiteFunnel(funnel(daily, { search_console: { ...gsc, property_url: 'https://autre-site.be/' } })); assert.equal(bad.site.search, null); assert.equal(bad.issues[0].code, 'GSC_PROPERTY_MISMATCH');
});

/** site data covering BEFORE [28 Sep, 19 Oct), the application day 19 Oct, AFTER [20 Oct, 10 Nov) */
const reviewData = (before, after, o = {}) => funnel([...rows(PAGE, '2026-09-28', 21, before), ...rows(PAGE, '2026-10-19', 1, { sessions: 11, starts: 3, submits: 1, seq: 1 }), ...rows(PAGE, '2026-10-20', 21, after)], { window: { start: '2026-09-28', end: '2026-11-10' }, ...o });
const compare = (raw) => compareFormRate({ site: normalizeSiteFunnel(raw).site, path: PAGE, appliedDate: '2026-10-19', reviewDate: '2026-11-09', now: NOW, timeZone: TZ });

test('ST-6 a valid before / after: 12/60 -> 18/60 = +10 points, two complete equal windows, the application day excluded, weekdays balanced', () => {
  const c = compare(reviewData(EXAMPLE, { sessions: 240, starts: 60, submits: 18, seq: 18 })); assert.equal(c.state, 'COMPARABLE'); assert.deepEqual(c.limits, []);
  assert.deepEqual([c.before.converted, c.before.starts, c.before.rate, c.after.converted, c.after.starts, c.after.rate, c.difference.points], [12, 60, 0.2, 18, 60, 0.3, 10]);
  assert.deepEqual([c.windows.days, c.windows.weekdaysBalanced, c.windows.applicationDayExcluded, c.before.localStart, c.before.localEnd, c.after.localStart, c.after.localEnd], [21, true, true, '2026-09-28', '2026-10-19', '2026-10-20', '2026-11-10']);
  assert.deepEqual([c.metric, c.rule, c.target], ['rate', 'growth-review-rate.1', { type: 'page', id: PAGE }]);
});

test('ST-7 uncertain or unavailable: low volume, a tracking change between the periods, separate totals only, incomplete days, no data; numbers kept, never "comparable"', () => {
  const after = { sessions: 240, starts: 60, submits: 18, seq: 18 };
  const low = compare(reviewData({ sessions: 90, starts: 20, submits: 5, seq: 5 }, { sessions: 90, starts: 20, submits: 7, seq: 7 })); assert.deepEqual([low.state, low.limits.includes('LOW_STARTS')], ['LIMITED', true]); assert.equal(low.difference.points, 10, 'kept for information');
  const changed = compare(reviewData(EXAMPLE, after, { events: EV.map((e) => (e.kind === 'form_submit' ? { ...e, changed_on: '2026-10-05' } : e)) })); assert.deepEqual([changed.state, changed.limits.includes('TRACKING_CHANGED')], ['LIMITED', true]);
  const totals = compare(reviewData({ ...EXAMPLE, seq: null }, { ...after, seq: null })); assert.deepEqual([totals.state, totals.limits.includes('NO_SEQUENTIAL_DATA'), totals.difference], ['LIMITED', true, null]);
  const gap = compare(funnel([...rows(PAGE, '2026-09-28', 21, EXAMPLE), ...rows(PAGE, '2026-10-20', 10, { sessions: 100, starts: 30, submits: 9, seq: 9 })], { window: { start: '2026-09-28', end: '2026-11-10' } })); assert.deepEqual([gap.state, gap.limits.includes('DATA_INCOMPLETE')], ['LIMITED', true]);
  const none = compareFormRate({ site: null, path: PAGE, appliedDate: '2026-10-19', reviewDate: '2026-11-09', now: NOW, timeZone: TZ }); assert.deepEqual([none.state, none.limits], ['LIMITED', ['DATA_INCOMPLETE']]);
  const early = compareFormRate({ site: normalizeSiteFunnel(reviewData(EXAMPLE, after)).site, path: PAGE, appliedDate: '2026-11-14', reviewDate: '2026-11-20', now: NOW, timeZone: TZ }); assert.equal(early.limits[0], 'PERIOD_NOT_COMPLETE');
  const short = compareFormRate({ site: normalizeSiteFunnel(reviewData(EXAMPLE, after)).site, path: PAGE, appliedDate: '2026-11-07', reviewDate: '2026-11-12', now: NOW, timeZone: TZ }); assert.ok(short.limits.includes('SHORT_PERIOD'));
});

test('ST-8 sources: NOT_CONNECTED (nothing invented, the missing connections are named), INVALID, UNAVAILABLE; one merchant never sees another one\'s property; the review source answers for the exact page', async () => {
  const none = await createSiteSource({ timeZone: TZ, now: () => NOW })(); assert.deepEqual([none.state, none.missing, none.items.length], ['NOT_CONNECTED', ['GA4_PROPERTY', 'SEARCH_CONSOLE_PROPERTY'], 0]);
  assert.equal((await createSiteSource({ timeZone: TZ, now: () => NOW, load: async () => ({ daily: [] }) })()).state, 'INVALID');
  assert.equal((await createSiteSource({ timeZone: TZ, now: () => NOW, load: async () => { throw new Error('x'); } })()).state, 'UNAVAILABLE');
  const a = createSiteSource({ timeZone: TZ, now: () => NOW, cacheMs: 0, load: async () => funnel(rows(PAGE, '2026-09-28', 21, EXAMPLE), { property_id: 'A-111' }) }); const b = createSiteSource({ timeZone: TZ, now: () => NOW, cacheMs: 0, load: async () => funnel(rows('/autre', '2026-09-28', 21, EXAMPLE), { property_id: 'B-222', site_url: 'https://autre.be' }) });
  const [pa, pb] = [await a(), await b()]; assert.deepEqual([pa.items[0].id, pb.items[0].id, pa.propertyId, pb.propertyId], ['site:A-111:/demander-un-devis', 'site:B-222:/autre', 'A-111', 'B-222']); assert.ok(!JSON.stringify(pa).includes('autre'));
  const rv = await createSiteReviewSource({ timeZone: TZ, now: () => NOW, load: async () => reviewData(EXAMPLE, { sessions: 240, starts: 60, submits: 18, seq: 18 }) })({ id: PAGE, applied: '2026-10-19', review: '2026-11-09' }); assert.equal(rv.difference.points, 10);
  const other = await createSiteReviewSource({ timeZone: TZ, now: () => NOW, load: async () => reviewData(EXAMPLE, { sessions: 240, starts: 60, submits: 18, seq: 18 }) })({ id: '/contact', applied: '2026-10-19', review: '2026-11-09' }); assert.equal(other.state, 'LIMITED', 'another page has no data: not comparable');
});

test('ST-9 priorities: the site block exists only when a site source is wired and never enters the commercial ranking', async () => {
  const wire = (site) => createPrioritiesSource({ productPotential: async () => null, audience: async () => null, content: async () => null, store: async () => null, site, now: () => NOW });
  assert.equal(Object.hasOwn(await wire(null)(), 'site'), false);
  const p = await wire(createSiteSource({ timeZone: TZ, now: () => NOW, load: async () => funnel(rows(PAGE, '2026-09-28', 21, EXAMPLE)) }))(); assert.deepEqual([p.site.state, p.site.items.length, p.sections.commercial.length, p.weekly.items.length], ['OK', 1, 0, 0]);
});
