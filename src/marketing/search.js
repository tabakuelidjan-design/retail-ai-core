// Search-visibility import contract (queries, impressions, clicks, position, landing page).
// Branded vs non-branded, and intent, exist ONLY through explicit merchant rules; with no rules every
// query is 'unclassified'. No model guesses intent.
//
// { source_system, method: 'api'|'manual_export', window: { start, end /* exclusive */ }, retrieved_at,
//   filters: { search_type, country, device, ... }          // the filters the data was pulled with (provenance)
//   reported_totals: { clicks, impressions },               // the source's own site-level totals
//   query_rows: [{ query, impressions, clicks, position }], query_rows_complete, query_rows_omitted: { count, clicks, impressions, position? },
//   query_page_rows: [{ query, page, impressions, clicks, position }],   // pulled per page: NOT additive with query_rows
//   page_rows: [{ page, impressions, clicks, position }], page_rows_complete, page_rows_omitted: { count, clicks, impressions },
//   country_rows: [{ country, impressions, clicks, position }], device_rows: [{ device, ... }] }
// The 2D.1 shape `rows: [...]` is still accepted as query rows.

import { classifyQuery } from './taxonomy.js';
import { parseLandingPath } from './channel-facts.js';
import { provenance } from './provenance.js';

const round4 = (x) => Math.round(x * 10000) / 10000;
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const dateMs = (s) => Date.parse(`${s}T00:00:00Z`);
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

function readRows(list, keyName, errors, issues, { requireKey = true } = {}) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    const key = r[keyName];
    if (requireKey && (typeof key !== 'string' || key.trim() === '')) { errors.push(`${keyName} row needs a ${keyName}`); continue; }
    if (!finite(r.impressions) || !finite(r.clicks) || r.impressions < 0 || r.clicks < 0 || r.clicks > r.impressions) { errors.push(`${keyName} "${key}": needs 0 <= clicks <= impressions`); continue; }
    if (r.position != null && (!finite(r.position) || r.position < 1)) { errors.push(`${keyName} "${key}": position must be >= 1`); continue; }
    const recomputed = r.impressions > 0 ? r.clicks / r.impressions : null;
    if (finite(r.ctr) && recomputed !== null && Math.abs(r.ctr - recomputed) > 0.005) issues.push({ code: 'CTR_DISAGREES_WITH_CLICKS_OVER_IMPRESSIONS', [keyName]: key });
    out.push({ ...(keyName === 'query' ? { query: key.trim(), page: r.page ?? null } : { [keyName]: key.trim() }), date: r.date ?? null, country: r.country ?? null, device: r.device ?? null, impressions: r.impressions, clicks: r.clicks, position: finite(r.position) ? r.position : null });
  }
  return out;
}

const omitted = (o) => (o && finite(o.clicks) && finite(o.impressions) ? { count: finite(o.count) ? o.count : null, clicks: o.clicks, impressions: o.impressions, position: finite(o.position) ? o.position : null } : null);

export function normalizeSearch(raw) {
  const errors = [];
  const issues = [];
  if (!raw || typeof raw !== 'object') return { search: null, errors: ['search file must be a JSON object'], issues };
  if (!raw.source_system) errors.push('source_system: required');
  const w = raw.window;
  if (!w || Number.isNaN(dateMs(w.start)) || Number.isNaN(dateMs(w.end)) || dateMs(w.end) <= dateMs(w.start)) errors.push('window: { start, end } as YYYY-MM-DD, end exclusive');

  const rows = readRows(raw.query_rows ?? raw.rows, 'query', errors, issues);
  const queryPageRows = readRows(raw.query_page_rows, 'query', errors, issues).map((r, i) => ({ ...r, page: (raw.query_page_rows[i] ?? {}).page ?? null }));
  if (queryPageRows.some((r) => !r.page)) errors.push('query_page_rows: every row needs a page');
  const pageRows = readRows(raw.page_rows, 'page', errors, issues);
  const countryRows = readRows(raw.country_rows, 'country', errors, issues);
  const deviceRows = readRows(raw.device_rows, 'device', errors, issues);
  let reported = null;
  if (raw.reported_totals) {
    if (!finite(raw.reported_totals.clicks) || !finite(raw.reported_totals.impressions)) errors.push('reported_totals: numeric clicks and impressions');
    else reported = { clicks: raw.reported_totals.clicks, impressions: raw.reported_totals.impressions };
  }
  if (errors.length) return { search: null, errors, issues };
  if (!raw.filters) issues.push({ code: 'FILTERS_NOT_STATED' });
  if (raw.method && !['api', 'manual_export'].includes(raw.method)) return { search: null, errors: ['method: api or manual_export'], issues };

  return {
    search: {
      source_system: raw.source_system, method: raw.method ?? null, window: { start: w.start, end: w.end }, retrieved_at: raw.retrieved_at ?? null,
      filters: raw.filters ?? null, reported_totals: reported,
      rows, query_rows_complete: raw.query_rows_complete === true, query_rows_omitted: omitted(raw.query_rows_omitted),
      query_page_rows: queryPageRows,
      page_rows: pageRows, page_rows_complete: raw.page_rows_complete === true, page_rows_omitted: omitted(raw.page_rows_omitted),
      country_rows: countryRows, device_rows: deviceRows,
    },
    errors, issues,
  };
}

/** CTR is always recomputed (clicks / impressions); position is impressions-weighted, never a plain mean. */
export function totals(rows) {
  const impressions = rows.reduce((a, r) => a + r.impressions, 0);
  const clicks = rows.reduce((a, r) => a + r.clicks, 0);
  const withPos = rows.filter((r) => r.position !== null && r.impressions > 0);
  const posWeight = withPos.reduce((a, r) => a + r.impressions, 0);
  return { queries: new Set(rows.map((r) => r.query)).size, impressions, clicks, ctr: impressions > 0 ? round4(clicks / impressions) : null, avg_position: posWeight > 0 ? round2(withPos.reduce((a, r) => a + r.position * r.impressions, 0) / posWeight) : null };
}

function topQueries(rows, rules) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.query)) by.set(r.query, []);
    by.get(r.query).push(r);
  }
  return [...by.entries()].map(([query, rs]) => ({ query, class: classifyQuery(query, rules), ...totals(rs) })).sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query)).slice(0, 25);
}

/** The 2D.1 summary, kept as is: totals, brand split, top pages/queries. */
export function summarizeSearch(search, cfg) {
  const rules = cfg.marketing.brandRules;
  const classify = (r) => classifyQuery(r.query, rules);
  const groups = { branded: [], non_branded: [], unclassified: [] };
  for (const r of search.rows) groups[classify(r)].push(r);
  const byPage = new Map();
  for (const r of search.rows) {
    const p = r.page ? parseLandingPath(new URL(r.page, 'https://x.invalid').pathname).normalized : null;
    if (!p) continue;
    if (!byPage.has(p)) byPage.set(p, []);
    byPage.get(p).push(r);
  }
  return {
    window: search.window, totals: totals(search.rows),
    by_query_class: Object.fromEntries(Object.entries(groups).map(([k, rows]) => [k, totals(rows)])),
    branded_split_gate: rules.length > 0 ? { status: 'OPEN', basis: 'explicit merchant brandRules' } : { status: 'GATED', reasons: ['NO_BRAND_RULES_CONFIGURED'] },
    top_pages: [...byPage.entries()].map(([page, rows]) => ({ page, ...totals(rows) })).sort((a, b) => b.impressions - a.impressions).slice(0, 25),
    top_queries: topQueries(search.rows, rules),
    provenance: provenance({
      source_system: search.source_system, fields: ['search rows (imported)'], window: search.window, filters: search.filters,
      limitations: ['ANONYMISED_QUERIES_ARE_NOT_INCLUDED_BY_SEARCH_PLATFORMS', 'POSITION_IS_AN_IMPRESSION_WEIGHTED_AVERAGE', 'SEARCH_VISIBILITY_IS_NOT_SALES'], completeness: 'PARTIAL', evidence_kind: 'observed',
    }),
  };
}
