import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearch } from '../src/marketing/search.js';
import { buildSearchVisibility } from '../src/marketing/search-visibility.js';
import { classifyIntent, classifyQuery } from '../src/marketing/taxonomy.js';
import { detectMarketingIssues, MARKETING_RULE_CODES } from '../src/marketing/quality.js';
import { phase3Inputs } from '../src/marketing/phase3-contract.js';
import { buildMarketingFacts } from '../src/marketing/build.js';
import { NOW, TZ, config, ledgerOf, makeMarketingData } from './fixtures/marketing-sample.js';

const rule = (value, type = 'contains') => ({ type, value });
const RULED = { brandRules: [rule('acme')], search: { intentRules: { local: [rule('near me'), rule('springfield')], product: [rule('case'), rule('bottle')], informational: [rule('how to')] } } };
const products = [{ id: 'p1', shopify_id: 'gid://p1', title: 'Widget', handle: 'widget' }];

const raw = (over = {}) => ({
  source_system: 'search_console', method: 'manual_export', window: { start: '2026-08-01', end: '2026-09-01' },
  filters: { search_type: 'web', country: null, device: null },
  reported_totals: { clicks: 100, impressions: 5000 },
  query_rows: [
    { query: 'acme', impressions: 100, clicks: 30, position: 1.2 },
    { query: 'acme springfield', impressions: 50, clicks: 10, position: 1.5 },
    { query: 'phone case', impressions: 400, clicks: 2, position: 12 },
    { query: 'water bottle springfield', impressions: 60, clicks: 3, position: 6 },
    { query: 'how to print', impressions: 30, clicks: 0, position: 30 },
  ],
  query_rows_omitted: { count: 50, clicks: 5, impressions: 200 },
  page_rows: [
    { page: 'https://s.example/', impressions: 800, clicks: 60, position: 4 },
    { page: 'https://s.example/products/widget?utm=x', impressions: 300, clicks: 1, position: 9 },
    { page: 'https://s.example/en/products/widget', impressions: 100, clicks: 0, position: 11 },
    { page: 'https://s.example/collections/cases', impressions: 20, clicks: 0, position: 8 },
  ],
  query_page_rows: [{ query: 'phone case', page: 'https://s.example/collections/cases', impressions: 15, clicks: 0, position: 8 }],
  country_rows: [{ country: 'Belgium', impressions: 400, clicks: 60, position: 5 }, { country: 'United States', impressions: 300, clicks: 3, position: 9 }],
  device_rows: [{ device: 'mobile', impressions: 500, clicks: 50, position: 6 }],
  ...over,
});
const vis = (over, cfgOver = RULED, ctx = {}) => {
  const n = normalizeSearch(raw(over));
  assert.deepEqual(n.errors, []);
  return buildSearchVisibility(n.search, config(cfgOver), { products, ...ctx });
};

test('contract accepts the v1 rows shape and rejects impossible rows', () => {
  const r = { source_system: 's', window: { start: '2026-09-01', end: '2026-09-02' }, rows: [{ query: 'q', impressions: 5, clicks: 1, position: 2 }] };
  assert.equal(normalizeSearch(r).search.rows.length, 1);
  assert.ok(normalizeSearch({ ...r, rows: [{ query: 'q', impressions: 5, clicks: 9 }] }).errors.length);
  assert.ok(normalizeSearch({ ...r, query_page_rows: [{ query: 'q', impressions: 5, clicks: 1 }] }).errors.length);
  assert.ok(normalizeSearch(r).issues.some((i) => i.code === 'FILTERS_NOT_STATED'));
});

test('classification is explicit rules only: no rules = unclassified, never guessed', () => {
  assert.equal(classifyQuery('acme', []), 'unclassified');
  assert.equal(classifyIntent('phone case near me', { intentRules: {} }).intent, 'unclassified');
  assert.equal(classifyIntent('phone case near me', { intentRules: {} }).configured, false);
  const v = vis({}, { brandRules: [] });
  assert.equal(v.gates.branded_split.status, 'GATED');
  assert.equal(v.gates.intent_split.status, 'GATED');
  assert.ok(v.queries.rows.every((q) => q.class === 'unclassified' && q.intent === 'unclassified'));
  assert.equal(v.by_class.brand_share, null);
});

test('branded / intent / local classification follows configured rules and precedence', () => {
  const v = vis();
  const q = (s) => v.queries.rows.find((r) => r.query === s);
  assert.equal(q('acme').class, 'branded');
  assert.equal(q('phone case').class, 'non_branded');
  assert.equal(q('acme springfield').intent, 'local');
  assert.equal([...q('water bottle springfield').intents].sort().join(), 'local,product');
  assert.equal(q('water bottle springfield').intent, 'local');
  assert.equal(q('phone case').intent, 'product');
  assert.equal(q('how to print').intent, 'informational');
  assert.equal(v.by_intent.local_intent.queries, 2);
  assert.equal(v.by_class.brand_share.branded_share_of_classified_clicks, 0.8889);
});

test('coverage: anonymised share is computed against the source totals; page rows are marked non-additive', () => {
  const c = vis().coverage;
  assert.equal(c.anonymised_queries.clicks, 50);
  assert.equal(c.anonymised_queries.share_of_clicks, 0.5);
  assert.equal(c.page_table.additive_with_site_totals, false);
  assert.equal(vis({ query_rows_omitted: undefined }).coverage.anonymised_queries, null);
});

test('page facts normalise paths, merge variants, map products by handle and never invent query counts', () => {
  const v = vis();
  const w = v.pages.rows.find((p) => p.page === '/products/widget');
  assert.equal(w.impressions, 400);
  assert.equal(w.clicks, 1);
  assert.equal(w.ctr, 0.0025);
  assert.equal(w.product_id, 'gid://p1');
  assert.equal(w.queries_observed, null);
  assert.equal(w.query_count_status, 'UNAVAILABLE');
  const cases = v.pages.rows.find((p) => p.page === '/collections/cases');
  assert.equal(cases.queries_observed, 1);
  assert.match(cases.query_count_status, /PARTIAL/);
});

test('opportunity signals: each fires from thresholds and carries them; none is a recommendation', () => {
  const v = vis();
  const by = (code) => v.opportunity_signals.signals.filter((s) => s.signal === code);
  assert.deepEqual(by('HIGH_IMPRESSIONS_LOW_CTR').map((s) => s.query), ['phone case']);
  assert.deepEqual(by('POSITION_BAND_MEANINGFUL_IMPRESSIONS').map((s) => s.query).sort(), ['phone case', 'water bottle springfield']);
  assert.deepEqual(by('NON_BRAND_QUERY_WITH_CLICKS').map((s) => s.query).sort(), ['phone case', 'water bottle springfield']);
  assert.deepEqual(by('PRODUCT_PAGE_VISIBLE_WEAK_CTR').map((s) => s.page), ['/products/widget']);
  assert.equal(by('HIGH_IMPRESSIONS_LOW_CTR')[0].thresholds.lowCtr, 0.02);
  assert.ok(v.opportunity_signals.signals.every((s) => s.recommendation === null && s.evidence_kind === 'derived'));
});

test('without brand rules, brand-sensitive signals are gated instead of guessed', () => {
  const v = vis({}, { brandRules: [] });
  assert.equal(v.gates.opportunity_signals.HIGH_IMPRESSIONS_LOW_CTR.status, 'GATED');
  assert.equal(v.gates.opportunity_signals.NON_BRAND_QUERY_WITH_CLICKS.status, 'GATED');
  assert.ok(!v.opportunity_signals.signals.some((s) => ['HIGH_IMPRESSIONS_LOW_CTR', 'POSITION_BAND_MEANINGFUL_IMPRESSIONS', 'NON_BRAND_QUERY_WITH_CLICKS'].includes(s.signal)));
  assert.equal(v.gates.opportunity_signals.PRODUCT_PAGE_VISIBLE_WEAK_CTR.status, 'OPEN');
});

test('concentration reports top shares and HHI over the imported rows', () => {
  const c = vis().concentration;
  assert.equal(c.queries_by_clicks.top1.key, 'acme');
  assert.equal(c.queries_by_clicks.top1.share, 0.6667);
  assert.equal(c.pages_by_clicks.status, 'OK');
  assert.ok(c.queries_by_clicks.hhi > 0);
});

test('geography: target-market share, and the session-vs-search disagreement is carried', () => {
  const v = vis({}, RULED, { sessionNonTargetShare: 0.8 });
  assert.equal(v.geography.target_market_share_of_clicks, 0.9524);
  assert.equal(v.geography.session_non_target_share, 0.8);
});

test('every fact block carries provenance with source, window, filters and evidence kind', () => {
  const v = vis();
  for (const b of [v.coverage, v.queries, v.by_class, v.by_intent, v.pages, v.query_page_pairs, v.geography, v.devices, v.opportunity_signals, v.concentration]) {
    assert.equal(b.provenance.source_system, 'search_console');
    assert.equal(b.provenance.window.start, '2026-08-01');
    assert.deepEqual(b.provenance.filters, { search_type: 'web', country: null, device: null });
    assert.ok(['observed', 'derived'].includes(b.provenance.evidence_kind));
    assert.equal(b.provenance.causal_claim, false);
    assert.ok(b.provenance.limitations.includes('SEARCH_VISIBILITY_IS_NOT_SALES'));
  }
  assert.equal(v.opportunity_signals.provenance.evidence_kind, 'derived');
  assert.equal(v.queries.provenance.evidence_kind, 'observed');
});

test('data-quality: low query coverage and geography disagreement are flagged', () => {
  assert.ok(MARKETING_RULE_CODES.includes('MKT_SEARCH_QUERY_COVERAGE_LOW') && MARKETING_RULE_CODES.includes('MKT_SEARCH_GEOGRAPHY_DISAGREES_WITH_SESSIONS'));
  const cfg = config(RULED);
  const v = vis({}, RULED, { sessionNonTargetShare: 0.8 });
  const withCoverage = { ...v, coverage: { ...v.coverage, anonymised_queries: { ...v.coverage.anonymised_queries, share_of_clicks: 0.6 } } };
  const issues = detectMarketingIssues({ classified: new Map(), windowOrderIds: new Set(), traffic: null, ads: null, search: { search: {}, issues: [] }, cfg, visibility: withCoverage });
  assert.ok(issues.some((i) => i.rule_code === 'MKT_SEARCH_QUERY_COVERAGE_LOW' && i.severity === 'warning'));
  assert.ok(issues.some((i) => i.rule_code === 'MKT_SEARCH_GEOGRAPHY_DISAGREES_WITH_SESSIONS'));
});

test('Phase 3 contract: conversion stays gated without an open traffic gate; search is observation-only', () => {
  const data = makeMarketingData();
  const cfg = config(RULED);
  const search = normalizeSearch(raw());
  const facts = buildMarketingFacts({ ledger: ledgerOf(data, cfg), data, traffic: null, ads: null, search, now: NOW, timeZone: TZ, config: cfg, merchantId: 'm1' });
  const p3 = phase3Inputs(facts);
  assert.equal(p3.conversion.status, 'GATED');
  assert.equal(p3.conversion.traffic, null);
  assert.equal(p3.search.not_a_conversion_input, true);
  assert.equal(p3.causal_claims, false);
  assert.equal(facts.search.visibility.gates.query_facts.status, 'OPEN');
  assert.equal(phase3Inputs({ gates: {}, search: {} }).search.status, 'ABSENT');
});
