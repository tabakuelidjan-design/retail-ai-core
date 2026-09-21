// Search-visibility import contract (queries, impressions, clicks, position, landing page).
// Branded vs non-branded exists ONLY through explicit merchant rules
// (config.marketing.brandRules); with no rules every query is 'unclassified'.
//
// { source_system, window: { start, end /* exclusive */ }, retrieved_at,
//   rows: [{ date?, query, page?, country?, device?, impressions, clicks, ctr?, position }] }

import { classifyQuery } from './taxonomy.js';
import { parseLandingPath } from './channel-facts.js';
import { provenance } from './provenance.js';

const round4 = (x) => Math.round(x * 10000) / 10000;
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const dateMs = (s) => Date.parse(`${s}T00:00:00Z`);
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

export function normalizeSearch(raw) {
  const errors = [];
  const issues = [];
  if (!raw || typeof raw !== 'object') return { search: null, errors: ['search file must be a JSON object'], issues };
  if (!raw.source_system) errors.push('source_system: required');
  const w = raw.window;
  if (!w || Number.isNaN(dateMs(w.start)) || Number.isNaN(dateMs(w.end)) || dateMs(w.end) <= dateMs(w.start)) errors.push('window: { start, end } as YYYY-MM-DD, end exclusive');
  const rows = [];
  for (const r of Array.isArray(raw.rows) ? raw.rows : []) {
    if (typeof r.query !== 'string' || r.query.trim() === '' || !finite(r.impressions) || !finite(r.clicks) || r.impressions < 0 || r.clicks < 0 || r.clicks > r.impressions) { errors.push(`row "${r.query}": needs a query and 0 <= clicks <= impressions`); continue; }
    if (r.position != null && (!finite(r.position) || r.position < 1)) { errors.push(`row "${r.query}": position must be >= 1`); continue; }
    const recomputed = r.impressions > 0 ? r.clicks / r.impressions : null;
    if (finite(r.ctr) && recomputed !== null && Math.abs(r.ctr - recomputed) > 0.005) issues.push({ code: 'CTR_DISAGREES_WITH_CLICKS_OVER_IMPRESSIONS', query: r.query });
    rows.push({ date: r.date ?? null, query: r.query.trim(), page: r.page ?? null, country: r.country ?? null, device: r.device ?? null, impressions: r.impressions, clicks: r.clicks, position: finite(r.position) ? r.position : null });
  }
  if (errors.length) return { search: null, errors, issues };
  return { search: { source_system: raw.source_system, window: { start: w.start, end: w.end }, retrieved_at: raw.retrieved_at ?? null, rows }, errors, issues };
}

/** CTR is always recomputed (clicks / impressions); position is impressions-weighted, never a plain mean. */
function totals(rows) {
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
      source_system: search.source_system, fields: ['search rows (imported)'], window: search.window,
      limitations: ['ANONYMISED_QUERIES_ARE_NOT_INCLUDED_BY_SEARCH_PLATFORMS', 'POSITION_IS_AN_IMPRESSION_WEIGHTED_AVERAGE', 'SEARCH_VISIBILITY_IS_NOT_SALES'], completeness: 'PARTIAL', evidence_kind: 'observed',
    }),
  };
}
