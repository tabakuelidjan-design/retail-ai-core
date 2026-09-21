import test from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, normalizeOrderAttribution, normalizeOrderChannel, pathOf } from '../src/marketing/adapters/shopify.js';
import { buildMarketingFacts } from '../src/marketing/build.js';
import { parseLandingPath } from '../src/marketing/channel-facts.js';
import { normalizeAds, paidReadiness } from '../src/marketing/paid.js';
import { detectMarketingIssues, MARKETING_RULE_CODES, toQualityFlags } from '../src/marketing/quality.js';
import { normalizeSearch, summarizeSearch } from '../src/marketing/search.js';
import { classifyOrder, classifyQuery } from '../src/marketing/taxonomy.js';
import { assessTraffic, normalizeTraffic } from '../src/marketing/traffic.js';
import { EVIDENCE_KINDS, NOT_CAUSAL, provenance } from '../src/marketing/provenance.js';
import { syncQualityFlags } from '../src/quality/flags.js';
import { createFakeSupabase } from './fixtures/fake-supabase.js';
import { NOW, TZ, cleanTrafficRaw, config, ledgerOf, makeMarketingData } from './fixtures/marketing-sample.js';

const build = ({ data = makeMarketingData(), cfg = config(), traffic = null, ads = null, search = null, marginGateOpen = false } = {}) =>
  buildMarketingFacts({ ledger: ledgerOf(data, cfg), data, traffic, ads, search, now: NOW, timeZone: TZ, config: cfg, merchantId: 'm1', marginGateOpen });
const chan = (f, name, w = 'available_window') => f.channels[w].channels.find((c) => c.channel === name);
const trafficOf = (raw) => normalizeTraffic(raw);

// ---------- Adapter (the only Shopify-specific code) ----------

test('adapter keeps host and path only, never query strings, fragments or customer identity', () => {
  assert.equal(hostOf('https://www.Google.com/search?q=private+words'), 'www.google.com');
  assert.equal(pathOf('https://shop.example/en/products/x?email=a%40b.c&gclid=1#frag'), '/en/products/x');
  assert.equal(pathOf('/collections/y?z=1'), '/collections/y');
  const node = {
    sourceName: 'web', channelInformation: { channelDefinition: { handle: 'web', channelName: 'Online Store', subChannelName: 'Online Store' } },
    customerJourneySummary: { ready: true, customerOrderIndex: 2, daysToConversion: 1.5, firstVisit: null,
      lastVisit: { source: 'Google', sourceType: 'SEO', referrerUrl: 'https://www.google.com/?q=x', landingPage: 'https://s.example/?gclid=abc', utmParameters: { source: null, medium: null, campaign: null, content: null, term: null } } },
  };
  const rows = normalizeOrderAttribution(node, 'o', 'm');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].landing_path, '/');
  assert.ok(!JSON.stringify(rows).includes('gclid'));
  assert.equal(normalizeOrderChannel(node).customer_order_index, 2);
  assert.deepEqual(normalizeOrderAttribution({ customerJourneySummary: { firstVisit: null, lastVisit: { source: null, referrerUrl: null, landingPage: null, utmParameters: {} } } }, 'o', 'm'), []); // an empty visit is no visit
});

// ---------- Classification ----------

test('classification precedence: sales channel first, then explicit UTM medium, then source type, then host lists; every result names its rule and evidence', () => {
  const cfg = config({ ownHosts: ['shop.example'] });
  const cls = (order, last) => classifyOrder(order, last ? { last_visit: last } : {}, cfg);
  assert.deepEqual([cls({ channel_handle: 'pos' }).channel, cls({ channel_handle: 'pos' }).evidence_kind], ['pos', 'observed']);
  assert.equal(cls({ channel_handle: 'draft_orders' }).channel, 'other_channel');
  const noVisit = cls({ channel_handle: 'web' });
  assert.deepEqual([noVisit.channel, noVisit.evidence_kind], ['unattributed', 'unavailable']); // never guessed
  assert.equal(cls({ channel_handle: 'web' }, { utm_medium: 'CPC', utm_source: 'google' }).channel, 'paid_search'); // case-insensitive
  const email = cls({ channel_handle: 'web' }, { utm_medium: 'email', utm_source: 'news', utm_campaign: 'c' });
  assert.deepEqual([email.channel, email.rule, email.evidence_kind, email.campaign], ['email', 'utm_medium', 'attributed', 'c']);
  assert.equal(cls({ channel_handle: 'web' }, { source_type: 'SEO', source: 'Google' }).channel, 'organic_search');
  assert.equal(cls({ channel_handle: 'web' }, { utm_source: 'chatgpt.com' }).channel, 'ai_assistant');
  assert.equal(cls({ channel_handle: 'web' }, { referrer_host: 'l.instagram.com' }).channel, 'organic_social');
  const own = cls({ channel_handle: 'web' }, { source: 'direct', referrer_host: 'shop.example' });
  assert.deepEqual([own.channel, own.rule], ['direct', 'own_host_referrer']);
  assert.equal(cls({ channel_handle: 'web' }, { source: 'direct' }).rule, 'recorded_direct');
  assert.equal(cls({ channel_handle: 'web' }, { referrer_host: 'some-blog.example' }).channel, 'referral');
  assert.equal(cls({ channel_handle: 'web' }, { utm_source: 'mystery' }).channel, 'campaign_unclassified');
  assert.ok(cls({ channel_handle: 'web' }, { utm_source: 'mystery' }).issues.includes('UTM_INCOMPLETE'));
  assert.ok(cls({ channel_handle: 'pos' }, { source: 'x' }).issues.includes('POS_ORDER_HAS_VISIT_DATA'));
  assert.ok(cls({ channel_handle: 'web' }, { utm_medium: 'cpc', utm_source: 'g', utm_campaign: 'c', source_type: 'SEO' }).issues.includes('PAID_MEDIUM_BUT_SEO_SOURCE_TYPE'));
});

test('classification rules are configuration: a merchant can change them without touching code', () => {
  const cfg = config({ taxonomy: { ...config().marketing.taxonomy, mediumMap: { partner: 'affiliate' } } });
  assert.equal(classifyOrder({ channel_handle: 'web' }, { last_visit: { utm_medium: 'partner', utm_source: 'p', utm_campaign: 'x' } }, cfg).channel, 'affiliate');
  assert.equal(classifyOrder({ channel_handle: 'web' }, { last_visit: { utm_medium: 'cpc', utm_source: 'g', utm_campaign: 'x' } }, cfg).channel, 'campaign_unclassified'); // cpc no longer mapped
});

// ---------- Channel facts ----------

test('channel facts: orders, units, gross, discounts, refunds, net sales ex tax and AOV per channel; refunds follow the order\'s channel', () => {
  const f = build();
  const pos = chan(f, 'pos');
  assert.deepEqual([pos.orders, pos.units_sold, pos.gross_sales, pos.discounts, pos.net_sales_ex_tax], [2, 3, 70, 5, 53.72]);
  const seo = chan(f, 'organic_search'); // o2: sold 20.00, 1 unit refunded on the 15th
  assert.deepEqual([seo.orders, seo.gross_sales, seo.refunds, seo.net_sales, seo.net_sales_ex_tax], [1, 20, 20, 0, 0]);
  const email = chan(f, 'email');
  assert.deepEqual([email.net_sales_ex_tax, email.aov], [8.26, 10]);
  assert.equal(f.channels.available_window.total.net_sales_ex_tax, 111.56);
  const shares = f.channels.available_window.channels.reduce((a, c) => a + c.revenue_share, 0);
  assert.ok(Math.abs(shares - 1) < 0.001);
  assert.equal(chan(f, 'email').revenue_share, 0.0740);
});

test('attribution coverage: unattributed online orders are counted and never assigned; POS is outside the coverage denominator', () => {
  const c = build().attribution_coverage;
  assert.deepEqual([c.online_orders, c.attributed_online_orders, c.unattributed_online_orders], [6, 5, 1]);
  assert.equal(c.coverage_of_online_orders, 0.8333);
  assert.equal(c.unattributed_share_of_online_net_sales, 0.2858); // 16.53 of 57.84
  assert.equal(c.pos_share_of_orders, 0.25);
  assert.equal(chan(build(), 'unattributed').provenance.evidence_kind, 'unavailable');
});

test('new vs returning exists only for online orders with a recorded customer order index; POS is explicitly unavailable', () => {
  const f = build();
  assert.deepEqual([chan(f, 'email').new_vs_returning.new_orders, chan(f, 'email').new_vs_returning.returning_orders], [0, 1]); // o3 has index 2
  assert.equal(chan(f, 'organic_search').new_vs_returning.new_orders, 1);
  assert.equal(chan(f, 'pos').new_vs_returning.status, 'UNAVAILABLE');
  const data = makeMarketingData();
  data.orders.find((o) => o.id === 'o2').journey_ready = false;
  assert.equal(chan(build({ data }), 'organic_search').new_vs_returning.unknown, 1); // not ready -> unknown, not "new"
});

test('windows: yesterday / 7 / 30 / available are timezone-aware and counts add up', () => {
  const f = build();
  assert.equal(f.channels.yesterday.total.orders, 0);
  assert.equal(f.channels.last_7_days.total.orders, 5); // 14th-18th: o4, o5, o6, o7 online + o8 POS
  assert.equal(f.channels.last_7_days.total.online_orders, 4);
  assert.equal(f.channels.last_30_days.total.orders, 8);
});

// ---------- Landing pages, products, campaigns ----------

test('landing paths: locale prefixes dropped, nested collection/product resolved, home/page/cart typed', () => {
  assert.deepEqual(parseLandingPath('/en/products/x'), { type: 'product', handle: 'x', normalized: '/products/x', productHandle: 'x' });
  assert.equal(parseLandingPath('/nl').normalized, '/');
  assert.equal(parseLandingPath('/nl/collections/naissance').normalized, '/collections/naissance');
  assert.equal(parseLandingPath('/collections/all/products/x').normalized, '/products/x');
  assert.equal(parseLandingPath('/pages/contact').type, 'page');
  assert.equal(parseLandingPath('/password').type, 'password');
  assert.equal(parseLandingPath(null).type, 'unknown');
});

test('landing facts map product landings to products by handle and report whether buyers bought the landing product', () => {
  const l = build().landing;
  assert.deepEqual(l.by_type, { product: 3, collection: 1, home: 1 });
  assert.deepEqual([l.product_landings.orders, l.product_landings.bought_the_landing_product, l.product_landings.share], [3, 3, 1]);
  const widget = l.landing_pages.find((p) => p.landing_page === '/products/widget');
  assert.equal(widget.orders, 2);
  assert.equal(widget.product_key, 'p1');
  assert.equal(l.landing_pages.find((p) => p.landing_page === '/products/gadget').orders, 1); // '/en/' prefix normalised
  assert.ok(l.provenance.limitations.includes('ORDERS_ONLY_NO_TRAFFIC_DENOMINATOR'));
});

test('product and category marketing facts split POS vs online and show the share with no observed digital journey', () => {
  const f = build();
  const widget = f.products.products.find((p) => p.key === 'p1');
  assert.deepEqual([widget.orders, widget.orders_pos, widget.orders_online, widget.orders_online_attributed], [5, 2, 3, 2]); // o1,o8 POS; o2,o4,o6 online (o4 unattributed)
  assert.equal(widget.share_without_observed_digital_journey, 0.6); // 3 of 5
  assert.ok(f.products.product_types.find((t) => t.label === 'Alpha'));
  assert.equal(f.products.collections[0].overlapping, true);
  assert.ok(f.products.provenance.limitations.includes('NO_TRAFFIC_DENOMINATOR_SO_NO_PRODUCT_CONVERSION'));
});

test('campaign concentration counts tagged and untagged separately and never invents a campaign', () => {
  const c = build().campaigns;
  assert.deepEqual([c.attributed_online_orders, c.tagged_orders, c.untagged_orders], [5, 2, 3]);
  assert.equal(c.concentration.top_campaign_share_of_tagged, 0.5);
  assert.equal(c.concentration.hhi_of_tagged, 0.5);
  assert.equal(c.campaigns.find((r) => r.campaign === '(untagged)').orders, 3);
});

// ---------- Provenance ----------

test('every marketing fact group carries provenance with a valid evidence kind; attributed and inferred facts carry the not-causal limitation', () => {
  const f = build({ traffic: trafficOf(cleanTrafficRaw()) });
  const groups = [...f.channels.available_window.channels, f.landing, f.products, f.campaigns, f.traffic];
  for (const g of groups) {
    assert.ok(g.provenance, 'missing provenance');
    assert.ok(EVIDENCE_KINDS.includes(g.provenance.evidence_kind));
    assert.equal(g.provenance.causal_claim, false);
    assert.ok(g.provenance.source_system && ['COMPLETE', 'PARTIAL', 'UNAVAILABLE'].includes(g.provenance.completeness));
    assert.ok(g.provenance.window || g.window || g.provenance.source_fields.length);
    if (['attributed', 'inferred'].includes(g.provenance.evidence_kind)) assert.ok(g.provenance.limitations.includes(NOT_CAUSAL));
  }
  assert.equal(f.causal_claims, false);
  assert.equal(chan(f, 'pos').provenance.evidence_kind, 'observed');
  assert.equal(chan(f, 'ai_assistant').provenance.evidence_kind, 'inferred'); // host-list rule
  assert.equal(f.traffic.provenance.evidence_kind, 'observed');
  assert.throws(() => provenance({ source_system: 's', completeness: 'PARTIAL', evidence_kind: 'proven' }));
});

// ---------- Traffic contract and conversion gate ----------

test('traffic contract: malformed files are rejected; duplicate keys and disagreeing dimension totals are reported', () => {
  assert.ok(normalizeTraffic({ source_system: 'x', method: 'guess', scope: 'online_store', window: { start: '2026-09-10', end: '2026-09-01' } }).errors.length >= 2);
  const dup = normalizeTraffic(cleanTrafficRaw({ dimensions: [{ dimension: 'channel', complete: true, rows: [{ key: 'direct/', sessions: 5 }, { key: 'direct/', sessions: 5 }] }] }));
  assert.ok(dup.issues.some((i) => i.code === 'DUPLICATE_TRAFFIC_KEY'));
  assert.equal(normalizeTraffic(cleanTrafficRaw()).issues.length, 0); // consistent dimensions: nothing to report
  const raw = cleanTrafficRaw();
  raw.dimensions[1].rows[0].sessions = 850; // country sums to 950 while channel sums to 1000
  const disagree = normalizeTraffic(raw);
  assert.ok(disagree.issues.some((i) => i.code === 'DIMENSION_TOTALS_DISAGREE'));
  assert.equal(disagree.traffic.total_sessions, 1000); // total comes from the complete channel dimension
});

test('conversion is computed only when orders and sessions are compatible; sessions and orders are always shown separately', () => {
  const open = build({ traffic: trafficOf(cleanTrafficRaw()) }).traffic;
  assert.equal(open.overall.status, 'OPEN');
  assert.equal(open.overall.conversion_rate, 0.006); // 6 online orders / 1000 sessions
  assert.equal(open.by_channel.find((c) => c.channel === 'direct').conversion_rate, 0.0017); // 1 / 600
  assert.deepEqual([open.by_channel.find((c) => c.channel === 'organic_social').status, open.by_channel.find((c) => c.channel === 'organic_social').conversion_rate], ['OPEN', 0]); // 100 sessions meets the minimum; 0 orders is a real zero
});

test('conversion stays gated with the reason: non-target traffic, wrong scope, too few sessions, window before order history, markets unconfigured', () => {
  const gate = (raw, cfg = config()) => assessTraffic(trafficOf(raw).traffic, { orderHistoryStart: new Date('2026-09-10T10:00:00Z'), timeZone: TZ }, cfg);
  const us = gate(cleanTrafficRaw({ dimensions: [{ dimension: 'channel', complete: true, rows: [{ key: 'direct/', sessions: 1000 }] }, { dimension: 'country', complete: true, rows: [{ key: 'United States', sessions: 800 }, { key: 'Belgium', sessions: 200 }] }] }));
  assert.ok(us.reasons.includes('NON_TARGET_TRAFFIC_DOMINATES'));
  assert.equal(us.market.non_target_share, 0.8);
  assert.ok(gate(cleanTrafficRaw({ scope: 'all_channels' })).reasons.includes('TRAFFIC_SCOPE_NOT_ONLINE_STORE'));
  assert.ok(gate(cleanTrafficRaw({ dimensions: [{ dimension: 'channel', complete: true, rows: [{ key: 'direct/', sessions: 50 }] }] })).reasons.includes('TOO_FEW_SESSIONS'));
  assert.ok(gate(cleanTrafficRaw({ window: { start: '2026-07-01', end: '2026-09-21' } })).reasons.includes('TRAFFIC_WINDOW_STARTS_BEFORE_ORDER_HISTORY'));
  assert.ok(gate(cleanTrafficRaw(), config({ targetMarkets: [] })).reasons.includes('TARGET_MARKETS_NOT_CONFIGURED')); // unknown, not assumed fine
  assert.equal(gate(cleanTrafficRaw()).status, 'OPEN');
  const noGeo = gate(cleanTrafficRaw({ dimensions: [{ dimension: 'channel', complete: true, rows: [{ key: 'direct/', sessions: 500 }] }] }));
  assert.ok(noGeo.caveats.includes('TRAFFIC_GEOGRAPHY_NOT_PROVIDED_NON_TARGET_TRAFFIC_UNCHECKED'));
});

test('cross-check: totals can agree while channels disagree, and that is surfaced', () => {
  const f = build({ traffic: trafficOf(cleanTrafficRaw()) });
  const cc = f.traffic.order_vs_checkout_cross_check;
  assert.equal(cc.completed_checkout_sessions, 6);
  assert.equal(cc.matches, true);
  assert.ok(cc.channel_mismatches.some((m) => m.channel === 'ai_assistant' && m.orders_attributed === 1 && m.completed_checkouts_in_traffic_system === 0));
  assert.ok(f.data_quality.issues.some((i) => i.rule_code === 'MKT_SOURCE_MISMATCH'));
});

test('landing traffic: absence from a truncated export is never "no traffic"; from a complete export it is reported', () => {
  const partial = build({ traffic: trafficOf(cleanTrafficRaw()) }).traffic.landing;
  assert.equal(partial.complete_export, false);
  assert.equal(partial.products_with_orders_but_no_observed_sessions.status, 'UNAVAILABLE');
  assert.ok(partial.products_with_sessions_but_no_orders.some((p) => p.landing_page === '/products/widget') === false); // widget had orders
  const raw = cleanTrafficRaw();
  raw.dimensions[2] = { dimension: 'landing_page', complete: true, rows: [{ key: '/', sessions: 500 }, { key: '/products/other', sessions: 40 }] };
  const complete = build({ traffic: trafficOf(raw) }).traffic.landing;
  assert.deepEqual(complete.products_with_sessions_but_no_orders, [{ landing_page: '/products/other', sessions: 40 }]);
  assert.deepEqual(complete.products_with_orders_but_no_observed_sessions.map((p) => p.landing_page).sort(), ['/products/gadget', '/products/widget']);
});

// ---------- Paid acquisition readiness ----------

function paidWorld() {
  const data = makeMarketingData();
  const rows = [];
  for (let i = 0; i < 35; i += 1) {
    const day = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10); // 1 Aug ..
    const id = `p${i}`;
    data.orders.push({ id, ordered_at: `${day}T11:00:00Z`, status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false, source_name: 'web', channel_handle: 'web', customer_order_index: 1, journey_ready: true });
    data.orderLines.push({ id: `pl${i}`, order_id: id, variant_id: 'v1', title_snapshot: 'w', sku_snapshot: null, quantity: 1, unit_price: 20, discount_amount: 0, tax_amount: 3.47 });
    data.orderAttribution.push({ order_id: id, touch: 'last_visit', source: 'google', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'brand-search', landing_path: '/', source_type: null, referrer_host: null });
  }
  for (let i = 0; i < 46; i += 1) rows.push({ date: new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10), campaign_id: 'brand-search', campaign_name: 'brand-search', impressions: 100, clicks: 10, cost: 2, conversions: 0.8, conversion_value: 15 });
  return { data, ads: { source_system: 'test_ads', platform: 'test_platform', currency: 'EUR', window: { start: '2026-08-01', end: '2026-09-16' }, rows } };
}

test('paid readiness: CPC and CTR are simple; ROAS, CAC and profit stay gated until spend, attribution and linkage are sufficient', () => {
  const { data, ads } = paidWorld();
  const open = build({ data, ads: normalizeAds(ads) }).paid;
  assert.equal(open.values.cpc, 0.2); // 92 spend / 460 clicks
  assert.equal(open.gates.roas.status, 'OPEN');
  assert.equal(open.values.spend, 92);
  assert.equal(open.values.attributed_roas, 6.29); // 35 paid orders in the ads window x 16.53 ex tax / 92 (o6 on 16 Sep is outside the exclusive end)
  assert.equal(open.values.platform_reported_roas, 7.5); // 690 conversion value / 92
  assert.equal(open.values.cac, 2.63); // 92 / 35 new-customer paid orders
  assert.equal(open.gates.profit.status, 'GATED'); // margin gate not open
  assert.deepEqual(open.gates.profit.reasons, ['MARGIN_GATE_NOT_OPEN']);
  assert.equal(build({ data, ads: normalizeAds(ads), marginGateOpen: true }).paid.gates.profit.status, 'OPEN');
  assert.equal(open.provenance.evidence_kind, 'observed');
});

test('paid gates each close for a stated reason and no value is produced', () => {
  const { data, ads } = paidWorld();
  const run = (mut, d = data) => build({ data: d, ads: normalizeAds(mut(structuredClone(ads))) }).paid;
  const dup = run((a) => { a.rows.push(structuredClone(a.rows[0])); return a; });
  assert.ok(dup.gates.roas.reasons.includes('DUPLICATE_AD_ROWS'));
  assert.equal(dup.values.attributed_roas, null);
  assert.ok(run((a) => { a.rows = a.rows.slice(0, 20); return a; }).gates.roas.reasons.includes('SPEND_COVERAGE_BELOW_MIN'));
  assert.ok(run((a) => { a.rows.forEach((r) => { delete r.date; }); return a; }).gates.roas.reasons.includes('SPEND_ROWS_HAVE_NO_DATES_COVERAGE_UNVERIFIABLE'));
  assert.ok(run((a) => { a.currency = 'USD'; return a; }).gates.roas.reasons.includes('AD_CURRENCY_DIFFERS_FROM_MERCHANT_CURRENCY'));
  assert.ok(run((a) => { a.rows[3].cost = null; return a; }).gates.cpc.reasons.includes('CLICKS_WITHOUT_SPEND'));
  assert.ok(run((a) => { a.rows.forEach((r) => { r.campaign_id = 'other'; r.campaign_name = 'other'; }); return a; }).gates.roas.reasons.includes('PAID_ORDERS_NOT_LINKED_TO_AD_CAMPAIGNS'));
  const few = build({ data: makeMarketingData(), ads: normalizeAds({ ...ads, window: { start: '2026-09-10', end: '2026-09-20' }, rows: ads.rows.filter((r) => r.date >= '2026-09-10' && r.date < '2026-09-20') }) }).paid;
  assert.ok(few.gates.roas.reasons.includes('TOO_FEW_ATTRIBUTED_PAID_ORDERS'));
  assert.equal(few.gates.cpc.status, 'OPEN'); // simple ratios still fine
  const none = paidReadiness(null, [], {}, config());
  assert.ok(Object.values(none.gates).every((g) => g.reasons.includes('NO_AD_FACTS')));
});

test('ad contract: malformed rows are rejected; duplicate rows, multi-name campaign ids and clicks without spend are reported', () => {
  assert.ok(normalizeAds({ platform: 'p', currency: 'EUR', window: { start: '2026-09-01', end: '2026-09-02' }, rows: [] }).errors.some((e) => /source_system/.test(e)));
  assert.ok(normalizeAds({ source_system: 's', platform: 'p', currency: 'EUR', window: { start: '2026-09-01', end: '2026-09-02' }, rows: [{ campaign_id: 'c', impressions: -1, clicks: 0 }] }).errors.length > 0);
  const r = normalizeAds({ source_system: 's', platform: 'p', currency: 'EUR', window: { start: '2026-09-01', end: '2026-09-03' }, rows: [
    { date: '2026-09-01', campaign_id: 'c1', campaign_name: 'A', impressions: 10, clicks: 2, cost: 1 }, { date: '2026-09-01', campaign_id: 'c1', campaign_name: 'A', impressions: 10, clicks: 2, cost: 1 },
    { date: '2026-09-02', campaign_id: 'c1', campaign_name: 'B', impressions: 10, clicks: 3, cost: null }] });
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes('DUPLICATE_AD_ROW') && codes.includes('CAMPAIGN_ID_WITH_MULTIPLE_NAMES') && codes.includes('CLICKS_WITHOUT_SPEND'));
});

// ---------- Search intelligence ----------

test('search: CTR is recomputed, position is impression-weighted, and branded/non-branded exists only through explicit rules', () => {
  const raw = { source_system: 's', window: { start: '2026-09-01', end: '2026-09-08' }, rows: [
    { query: 'acme mugs', page: 'https://shop.example/products/mug', impressions: 100, clicks: 10, ctr: 0.1, position: 2 },
    { query: 'custom mug', page: 'https://shop.example/en/products/mug', impressions: 300, clicks: 3, ctr: 0.5, position: 8 }] };
  const n = normalizeSearch(raw);
  assert.ok(n.issues.some((i) => i.code === 'CTR_DISAGREES_WITH_CLICKS_OVER_IMPRESSIONS' && i.query === 'custom mug'));
  const none = summarizeSearch(n.search, config());
  assert.equal(none.totals.ctr, 0.0325); // 13 / 400, not the supplied figures
  assert.equal(none.totals.avg_position, 6.5); // (100x2 + 300x8) / 400, not the plain mean 5
  assert.equal(none.by_query_class.unclassified.impressions, 400);
  assert.equal(none.branded_split_gate.status, 'GATED');
  const rules = summarizeSearch(n.search, config({ brandRules: [{ type: 'contains', value: 'acme' }] }));
  assert.equal(rules.by_query_class.branded.clicks, 10);
  assert.equal(rules.by_query_class.non_branded.clicks, 3);
  assert.equal(rules.branded_split_gate.status, 'OPEN');
  assert.equal(rules.top_pages[0].page, '/products/mug'); // locale variants merge
  assert.equal(classifyQuery('Acme', [{ type: 'equals', value: 'acme' }]), 'branded');
  assert.equal(classifyQuery('acme', []), 'unclassified');
  assert.ok(normalizeSearch({ source_system: 's', window: { start: '2026-09-01', end: '2026-09-02' }, rows: [{ query: 'q', impressions: 5, clicks: 9 }] }).errors.length > 0);
});

// ---------- Data-quality gates ----------

const issuesOf = (o) => build(o).data_quality.issues;
const rules = (issues) => issues.map((i) => i.rule_code);

test('data-quality: unattributed orders, missing UTMs, source mismatches, partial connector coverage on order-only data', () => {
  const issues = issuesOf({});
  const codes = rules(issues);
  for (const c of ['MKT_UNATTRIBUTED_ONLINE_ORDERS', 'MKT_MISSING_UTM', 'MKT_SOURCE_MISMATCH', 'MKT_PARTIAL_CONNECTOR_COVERAGE']) assert.ok(codes.includes(c), c);
  assert.equal(issues.find((i) => i.rule_code === 'MKT_UNATTRIBUTED_ONLINE_ORDERS').severity, 'info'); // 1 of 6 = 17%, under the 20% threshold
  const more = makeMarketingData();
  more.orderAttribution = more.orderAttribution.filter((a) => a.order_id !== 'o3');
  assert.equal(issuesOf({ data: more }).find((i) => i.rule_code === 'MKT_UNATTRIBUTED_ONLINE_ORDERS').severity, 'warning'); // 2 of 6 = 33%
});

test('data-quality: market mismatch, incompatible window, duplicated campaign ids, missing spend', () => {
  const us = cleanTrafficRaw({ dimensions: [{ dimension: 'channel', complete: true, rows: [{ key: 'direct/', sessions: 1000 }] }, { dimension: 'country', complete: true, rows: [{ key: 'United States', sessions: 900 }, { key: 'Belgium', sessions: 100 }] }] });
  const market = issuesOf({ traffic: trafficOf(us) }).find((i) => i.rule_code === 'MKT_TRAFFIC_MARKET_MISMATCH');
  assert.equal(market.severity, 'critical'); // 90% outside target markets
  const early = issuesOf({ traffic: trafficOf(cleanTrafficRaw({ window: { start: '2026-07-01', end: '2026-09-21' } })) });
  assert.ok(rules(early).includes('MKT_TRAFFIC_WINDOW_INCOMPATIBLE'));
  const { data, ads } = paidWorld();
  const dupAds = structuredClone(ads);
  dupAds.rows.push(structuredClone(dupAds.rows[0]));
  dupAds.rows[5].cost = null;
  const withAds = issuesOf({ data, ads: normalizeAds(dupAds) });
  assert.ok(rules(withAds).includes('MKT_DUPLICATE_CAMPAIGN_ID'));
  assert.ok(rules(withAds).includes('MKT_MISSING_SPEND'));
  const paidNoAds = issuesOf({ data });
  assert.equal(paidNoAds.find((i) => i.rule_code === 'MKT_MISSING_SPEND').severity, 'warning'); // paid orders, no spend data
});

test('data-quality flags persist idempotently at merchant level, one per rule, and clear when the condition clears', async () => {
  const issues = build().data_quality.issues;
  const flags = toQualityFlags(issues, 'm1');
  assert.equal(new Set(flags.map((f) => f.rule_code)).size, flags.length); // one row per rule
  assert.ok(flags.every((f) => f.entity_type === 'merchant' && MARKETING_RULE_CODES.includes(f.rule_code)));
  const supabase = createFakeSupabase();
  const run = (detected) => syncQualityFlags({ supabase }, { merchantId: 'm1', detected, now: NOW, evaluatedRules: MARKETING_RULE_CODES });
  const first = await run(flags);
  assert.equal(first.created, flags.length);
  assert.equal((await run(flags)).created, 0);
  const cleared = await run(flags.filter((f) => f.rule_code !== 'MKT_MISSING_UTM'));
  assert.equal(cleared.resolved, 1);
});

// ---------- Generic architecture ----------

test('merchant-generic: no merchant, platform or region names in the marketing core; POS handles and own hosts are configuration', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const dir = 'src/marketing';
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.js'))) {
    const text = await readFile(`${dir}/${f}`, 'utf8');
    assert.ok(!/habb|yiwu|canton|china/i.test(text), `${f} names a merchant or region`);
  }
  const shopify = await readFile('src/marketing/adapters/shopify.js', 'utf8');
  assert.ok(/channelInformation|customerJourneySummary/.test(shopify)); // platform shapes live only in the adapter
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.js') && x !== 'index.js')) {
    const text = await readFile(`${dir}/${f}`, 'utf8');
    assert.ok(!/customerJourneySummary|channelInformation/.test(text), `${f} contains Shopify-specific shapes outside the adapter`);
  }
});

test('deterministic: same inputs give identical output', () => {
  assert.deepEqual(build({ traffic: trafficOf(cleanTrafficRaw()) }), build({ traffic: trafficOf(cleanTrafficRaw()) }));
});
