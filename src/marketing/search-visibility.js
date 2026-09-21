// Phase 2D.2 - search visibility FACTS. Everything here is observed or deterministically derived from
// imported search rows; classification uses explicit merchant rules only; opportunity signals are
// rule-based FACTS with the thresholds that fired, never recommendations. Search visibility is not sales.

import { classifyQuery, classifyIntent } from './taxonomy.js';
import { parseLandingPath } from './channel-facts.js';
import { provenance } from './provenance.js';
import { totals } from './search.js';

const round4 = (x) => Math.round(x * 10000) / 10000;
const share = (a, b) => (b > 0 ? round4(a / b) : null);
const pagePath = (p) => parseLandingPath(new URL(p, 'https://x.invalid').pathname).normalized;

const LIMITS = ['SEARCH_VISIBILITY_IS_NOT_SALES', 'POSITION_IS_AN_IMPRESSION_WEIGHTED_AVERAGE'];

/** Group rows by a key and re-aggregate (CTR recomputed, position impression-weighted). */
function aggregate(rows, keyOf) {
  const by = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k == null) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return [...by.entries()].map(([key, rs]) => ({ key, ...totals(rs) }));
}

function concentration(items, topN, metric) {
  const total = items.reduce((a, i) => a + i[metric], 0);
  if (total <= 0) return { status: 'GATED', reasons: ['NO_' + metric.toUpperCase()] };
  const sorted = [...items].sort((a, b) => b[metric] - a[metric]);
  const shares = sorted.map((i) => i[metric] / total);
  return {
    status: 'OK', metric, items: items.length, top1: { key: sorted[0].key ?? sorted[0].query ?? sorted[0].page, share: round4(shares[0]) },
    [`top${topN}_share`]: round4(shares.slice(0, topN).reduce((a, s) => a + s, 0)), hhi: Math.round(shares.reduce((a, s) => a + s * s, 0) * 10000),
  };
}

/**
 * @param {object} search normalised v2 search import
 * @param {object} cfg config (cfg.marketing.search, cfg.marketing.brandRules, cfg.marketing.targetMarkets)
 * @param {{products?: object[], sessionCountries?: {non_target_share: number|null}|null}} ctx
 */
export function buildSearchVisibility(search, cfg, { products = [], sessionNonTargetShare = null } = {}) {
  const sc = cfg.marketing.search;
  const brandRules = cfg.marketing.brandRules;
  const productByHandle = new Map(products.filter((p) => p.handle).map((p) => [p.handle, p]));
  const prov = (fields, extra = {}) => provenance({
    source_system: search.source_system, fields, window: search.window, filters: search.filters,
    limitations: [...LIMITS, ...(extra.limitations ?? [])], completeness: extra.completeness ?? 'PARTIAL', evidence_kind: extra.evidence_kind ?? 'observed',
  });
  const gate = (ok, reasons) => (ok ? { status: 'OPEN' } : { status: 'GATED', reasons });

  // ---- coverage: reported site totals vs what the query / page tables actually contain ----
  const qTot = totals(search.rows);
  const qOm = search.query_rows_omitted;
  const listedQ = { clicks: qTot.clicks + (qOm?.clicks ?? 0), impressions: qTot.impressions + (qOm?.impressions ?? 0) };
  const rep = search.reported_totals;
  const anonymised = rep && (search.query_rows_complete || qOm)
    ? { clicks: Math.max(0, rep.clicks - listedQ.clicks), impressions: Math.max(0, rep.impressions - listedQ.impressions), share_of_clicks: share(Math.max(0, rep.clicks - listedQ.clicks), rep.clicks), share_of_impressions: share(Math.max(0, rep.impressions - listedQ.impressions), rep.impressions) }
    : null;
  const coverage = {
    reported_totals: rep, reported_ctr: rep ? share(rep.clicks, rep.impressions) : null,
    query_rows: { detailed_rows: qTot.queries, detailed_clicks: qTot.clicks, detailed_impressions: qTot.impressions, omitted_tail: qOm, complete: search.query_rows_complete },
    query_table_covers: rep ? { clicks_share: share(listedQ.clicks, rep.clicks), impressions_share: share(listedQ.impressions, rep.impressions) } : null,
    anonymised_queries: anonymised,
    page_table: { detailed_rows: search.page_rows.length, omitted_tail: search.page_rows_omitted, complete: search.page_rows_complete, additive_with_site_totals: false },
    provenance: prov(['reported_totals', 'query_rows', 'page_rows'], { evidence_kind: 'derived', limitations: ['ANONYMISED_QUERIES_ARE_NOT_INCLUDED_BY_SEARCH_PLATFORMS', 'PAGE_ROWS_OVERLAP_SO_THEY_DO_NOT_SUM_TO_SITE_TOTALS'] }),
  };
  const coverageOk = anonymised ? anonymised.share_of_clicks <= 1 - sc.minQueryCoverage : false;
  const queryGate = gate(search.rows.length > 0, ['NO_QUERY_ROWS']);

  // ---- query facts ----
  const queries = aggregate(search.rows, (r) => r.query.toLowerCase()).map((q) => {
    const intent = classifyIntent(q.key, sc);
    return { query: q.key, class: classifyQuery(q.key, brandRules), intent: intent.intent, intents: intent.intents, local_intent: intent.intents.includes('local'), impressions: q.impressions, clicks: q.clicks, ctr: q.ctr, avg_position: q.avg_position };
  }).sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query));

  const classSplit = {};
  for (const k of ['branded', 'non_branded', 'unclassified']) classSplit[k] = totals(search.rows.filter((r) => classifyQuery(r.query, brandRules) === k));
  const intentSplit = {};
  for (const r of search.rows) {
    const i = classifyIntent(r.query, sc).intent;
    (intentSplit[i] ??= []).push(r);
  }
  const intentTotals = Object.fromEntries(Object.entries(intentSplit).map(([k, rs]) => [k, totals(rs)]));
  const intentConfigured = classifyIntent('', sc).configured;
  const localRows = search.rows.filter((r) => classifyIntent(r.query, sc).intents.includes('local'));

  // Brand share is over the query table only (anonymised queries cannot be classified) - stated in the fact.
  const brandTotal = classSplit.branded.clicks + classSplit.non_branded.clicks;
  const brandShare = brandRules.length > 0 ? {
    basis: 'classified query rows only (anonymised and omitted-tail queries are not classifiable)',
    branded_share_of_classified_clicks: share(classSplit.branded.clicks, brandTotal), non_branded_share_of_classified_clicks: share(classSplit.non_branded.clicks, brandTotal),
    branded_share_of_classified_impressions: share(classSplit.branded.impressions, classSplit.branded.impressions + classSplit.non_branded.impressions),
    share_of_all_site_clicks: rep ? { branded: share(classSplit.branded.clicks, rep.clicks), non_branded_visible: share(classSplit.non_branded.clicks, rep.clicks), not_classifiable: share(Math.max(0, rep.clicks - brandTotal), rep.clicks) } : null,
  } : null;

  // ---- page facts ----
  const pageSource = search.page_rows.length ? search.page_rows : null;
  const pageAgg = pageSource ? aggregate(pageSource.map((p) => ({ ...p, query: p.page })), (r) => pagePath(r.page)) : [];
  const queriesByPage = new Map();
  for (const r of search.query_page_rows) {
    const p = pagePath(r.page);
    if (!queriesByPage.has(p)) queriesByPage.set(p, []);
    queriesByPage.get(p).push(r);
  }
  const pages = pageAgg.map((p) => {
    const parsed = parseLandingPath(p.key);
    const product = parsed.productHandle ? productByHandle.get(parsed.productHandle) ?? null : null;
    const qs = queriesByPage.get(p.key) ?? [];
    return {
      page: p.key, page_type: parsed.type, product_handle: parsed.productHandle, product_id: product?.shopify_id ?? product?.id ?? null, product_title: product?.title ?? null,
      impressions: p.impressions, clicks: p.clicks, ctr: p.ctr, avg_position: p.avg_position,
      queries_observed: qs.length ? new Set(qs.map((q) => q.query.toLowerCase())).size : null,
      query_count_status: qs.length ? 'PARTIAL_ONLY_QUERIES_IN_THE_IMPORTED_QUERY_PAGE_ROWS' : 'UNAVAILABLE',
    };
  }).sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page));

  const queryPagePairs = aggregate(search.query_page_rows.map((r) => ({ ...r, query: `${r.query.toLowerCase()} ${pagePath(r.page)}` })), (r) => r.query)
    .map((p) => { const [query, page] = p.key.split(' '); return { query, page, class: classifyQuery(query, brandRules), impressions: p.impressions, clicks: p.clicks, ctr: p.ctr, avg_position: p.avg_position }; })
    .sort((a, b) => b.impressions - a.impressions);

  // ---- geography and device ----
  const countryFacts = aggregate(search.country_rows.map((r) => ({ ...r, query: r.country })), (r) => r.query).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  const deviceFacts = aggregate(search.device_rows.map((r) => ({ ...r, query: r.device })), (r) => r.query).sort((a, b) => b.clicks - a.clicks);
  const targets = new Set((cfg.marketing.targetMarkets ?? []).map((t) => t.toLowerCase()));
  const cTotal = countryFacts.reduce((a, c) => a + c.clicks, 0);
  const geography = {
    countries: countryFacts.map(({ key, ...rest }) => ({ country: key, ...rest })),
    target_market_share_of_clicks: targets.size && cTotal > 0 ? round4(countryFacts.filter((c) => targets.has(c.key.toLowerCase())).reduce((a, c) => a + c.clicks, 0) / cTotal) : null,
    target_markets: targets.size ? [...targets] : null,
    target_market_status: targets.size ? 'CONFIGURED_BY_MERCHANT' : 'TARGET_MARKETS_NOT_CONFIGURED',
    search_non_target_share_of_clicks: targets.size && cTotal > 0 ? round4(1 - countryFacts.filter((c) => targets.has(c.key.toLowerCase())).reduce((a, c) => a + c.clicks, 0) / cTotal) : null,
    session_non_target_share: sessionNonTargetShare,
    provenance: prov(['country_rows'], { evidence_kind: 'observed' }),
  };
  const devices = { devices: deviceFacts.map(({ key, ...rest }) => ({ device: key, ...rest })), provenance: prov(['device_rows'], { evidence_kind: 'observed' }) };

  // ---- rule-based opportunity signals (facts + the thresholds that fired; not recommendations) ----
  const o = sc.opportunity;
  const brandKnown = brandRules.length > 0;
  const excluded = (q) => o.excludeBranded && brandKnown && q.class === 'branded';
  const sig = (code, subject, evidence, thresholds) => ({ signal: code, ...subject, evidence, thresholds, evidence_kind: 'derived', recommendation: null });
  const signalGates = {};
  const signals = [];
  const eligibleQ = queries.filter((q) => !excluded(q));
  const skipBrand = o.excludeBranded && !brandKnown; // cannot separate brand -> the whole non-brand set is gated

  signalGates.HIGH_IMPRESSIONS_LOW_CTR = gate(!skipBrand, ['NO_BRAND_RULES_CONFIGURED_SO_BRAND_QUERIES_CANNOT_BE_EXCLUDED']);
  signalGates.POSITION_BAND_MEANINGFUL_IMPRESSIONS = gate(!skipBrand, ['NO_BRAND_RULES_CONFIGURED_SO_BRAND_QUERIES_CANNOT_BE_EXCLUDED']);
  signalGates.NON_BRAND_QUERY_WITH_CLICKS = gate(brandKnown, ['NO_BRAND_RULES_CONFIGURED']);
  signalGates.PRODUCT_PAGE_VISIBLE_WEAK_CTR = gate(pages.length > 0, ['NO_PAGE_ROWS']);
  if (!skipBrand) {
    for (const q of eligibleQ) {
      if (q.impressions >= o.minImpressions && q.ctr !== null && q.ctr < o.lowCtr) signals.push(sig('HIGH_IMPRESSIONS_LOW_CTR', { query: q.query }, { impressions: q.impressions, clicks: q.clicks, ctr: q.ctr, avg_position: q.avg_position }, { minImpressions: o.minImpressions, lowCtr: o.lowCtr }));
      if (q.avg_position !== null && q.avg_position >= o.positionBand.from && q.avg_position <= o.positionBand.to && q.impressions >= o.minImpressionsPositionBand) signals.push(sig('POSITION_BAND_MEANINGFUL_IMPRESSIONS', { query: q.query }, { impressions: q.impressions, clicks: q.clicks, avg_position: q.avg_position }, { positionBand: o.positionBand, minImpressions: o.minImpressionsPositionBand }));
    }
  }
  if (brandKnown) for (const q of queries) if (q.class === 'non_branded' && q.clicks > 0) signals.push(sig('NON_BRAND_QUERY_WITH_CLICKS', { query: q.query }, { impressions: q.impressions, clicks: q.clicks, ctr: q.ctr, avg_position: q.avg_position }, { minClicks: 1 }));
  for (const p of pages) if (p.page_type === 'product' && p.impressions >= o.minPageImpressions && p.ctr !== null && p.ctr < o.lowCtr) signals.push(sig('PRODUCT_PAGE_VISIBLE_WEAK_CTR', { page: p.page, product_handle: p.product_handle, product_id: p.product_id }, { impressions: p.impressions, clicks: p.clicks, ctr: p.ctr, avg_position: p.avg_position }, { minPageImpressions: o.minPageImpressions, lowCtr: o.lowCtr }));

  const concQueries = concentration(queries, sc.concentrationTopN, 'clicks');
  const concQueriesImpr = concentration(queries, sc.concentrationTopN, 'impressions');
  const concPages = concentration(pages, sc.concentrationTopN, 'clicks');
  const concNote = 'Over the imported rows only (omitted tail and anonymised queries excluded); page rows overlap so page shares are relative to the page table.';

  return {
    window: search.window, filters: search.filters,
    coverage,
    gates: {
      query_facts: queryGate, page_facts: gate(pages.length > 0, ['NO_PAGE_ROWS']),
      branded_split: gate(brandKnown, ['NO_BRAND_RULES_CONFIGURED']),
      intent_split: gate(intentConfigured, ['NO_INTENT_RULES_CONFIGURED']),
      local_intent: gate(intentConfigured && (sc.intentRules.local ?? []).length > 0, ['NO_LOCAL_INTENT_RULES_CONFIGURED']),
      query_coverage_sufficient: gate(anonymised ? coverageOk : false, [anonymised ? 'MOST_CLICKS_COME_FROM_ANONYMISED_QUERIES' : 'QUERY_COVERAGE_UNKNOWN']),
      geography: gate(search.country_rows.length > 0, ['NO_COUNTRY_ROWS']),
      opportunity_signals: signalGates,
    },
    queries: { rows: queries.slice(0, 50), total_rows: queries.length, provenance: prov(['query_rows'], { evidence_kind: 'observed', limitations: ['CLASSIFICATION_IS_EXPLICIT_RULES_ONLY', 'CTR_RECOMPUTED_FROM_CLICKS_OVER_IMPRESSIONS'] }) },
    by_class: { totals: classSplit, brand_share: brandShare, provenance: prov(['query_rows', 'brandRules'], { evidence_kind: 'derived', limitations: ['ONLY_QUERIES_LISTED_IN_THE_QUERY_TABLE_ARE_CLASSIFIABLE'] }) },
    by_intent: { configured: intentConfigured, totals: intentTotals, local_intent: { queries: new Set(localRows.map((r) => r.query.toLowerCase())).size, ...totals(localRows) }, rules_only: true, provenance: prov(['query_rows', 'intentRules'], { evidence_kind: 'derived', limitations: ['INTENT_IS_EXPLICIT_MERCHANT_RULES_ONLY_NO_INFERENCE'] }) },
    pages: { rows: pages.slice(0, 50), total_rows: pages.length, omitted_tail: search.page_rows_omitted, provenance: prov(['page_rows', 'query_page_rows'], { evidence_kind: 'observed', limitations: ['PAGE_ROWS_OVERLAP_SO_THEY_DO_NOT_SUM_TO_SITE_TOTALS', 'PAGE_QUERY_COUNT_IS_PARTIAL'] }) },
    query_page_pairs: { rows: queryPagePairs.slice(0, 50), total_rows: queryPagePairs.length, provenance: prov(['query_page_rows'], { evidence_kind: 'observed', limitations: ['ONLY_PAGES_THAT_WERE_PULLED_ARE_PRESENT', 'PAIRS_ARE_NOT_ADDITIVE_WITH_THE_QUERY_TABLE'] }) },
    geography, devices,
    opportunity_signals: { signals, count: signals.length, note: 'Rule-based facts with the thresholds that fired. Not recommendations.', provenance: prov(['query_rows', 'page_rows', 'search.opportunity thresholds'], { evidence_kind: 'derived', limitations: ['SIGNALS_ARE_NOT_RECOMMENDATIONS'] }) },
    concentration: { note: concNote, queries_by_clicks: concQueries, queries_by_impressions: concQueriesImpr, pages_by_clicks: concPages, provenance: prov(['query_rows', 'page_rows'], { evidence_kind: 'derived', limitations: [concNote] }) },
  };
}
