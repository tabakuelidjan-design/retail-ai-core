// Paid-acquisition import contract (ad platform facts) and the gates in front of spend-based
// metrics. No platform is assumed: an adapter or export produces this shape.
//
// { source_system, platform, account_ref?, currency, window: { start, end /* exclusive */ }, retrieved_at,
//   rows: [{ date?, campaign_id, campaign_name?, ad_group_id?, ad_group_name?, search_term?,
//            impressions, clicks, cost, conversions?, conversion_value? }] }
//
// CPC/CTR are simple ratios of observed fields. ROAS, CAC and profit are GATED: they open only when
// spend is complete for the window, campaign identifiers are clean, currency matches, attribution is
// complete enough, enough attributed orders exist, and paid orders can be linked to ad campaigns.
// Even then they are attributed figures, never proof of cause.

import { provenance } from './provenance.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
const dateMs = (s) => Date.parse(`${s}T00:00:00Z`);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const norm = (s) => (s == null ? null : String(s).trim().toLowerCase());

export function normalizeAds(raw) {
  const errors = [];
  const issues = [];
  if (!raw || typeof raw !== 'object') return { ads: null, errors: ['ads file must be a JSON object'], issues };
  for (const k of ['source_system', 'platform', 'currency']) if (!raw[k]) errors.push(`${k}: required`);
  const w = raw.window;
  if (!w || Number.isNaN(dateMs(w.start)) || Number.isNaN(dateMs(w.end)) || dateMs(w.end) <= dateMs(w.start)) errors.push('window: { start, end } as YYYY-MM-DD, end exclusive');
  const rows = [];
  const seen = new Map();
  for (const r of Array.isArray(raw.rows) ? raw.rows : []) {
    if (r.campaign_id == null || String(r.campaign_id).trim() === '') { errors.push('row: campaign_id required'); continue; }
    if (num(r.impressions) === null || num(r.clicks) === null || r.impressions < 0 || r.clicks < 0) { errors.push(`row ${r.campaign_id}: impressions and clicks must be non-negative numbers`); continue; }
    const row = {
      date: r.date ?? null, campaign_id: String(r.campaign_id).trim(), campaign_name: r.campaign_name ?? null, ad_group_id: r.ad_group_id ?? null, ad_group_name: r.ad_group_name ?? null,
      search_term: r.search_term ?? null, impressions: r.impressions, clicks: r.clicks, cost: num(r.cost), conversions: num(r.conversions), conversion_value: num(r.conversion_value),
    };
    const key = [row.date, row.campaign_id, row.ad_group_id, row.search_term].join('|');
    if (seen.has(key)) issues.push({ code: 'DUPLICATE_AD_ROW', key });
    seen.set(key, true);
    rows.push(row);
  }
  if (errors.length) return { ads: null, errors, issues };
  const namesById = new Map();
  for (const r of rows) { if (!namesById.has(r.campaign_id)) namesById.set(r.campaign_id, new Set()); if (r.campaign_name) namesById.get(r.campaign_id).add(r.campaign_name); }
  for (const [id, names] of namesById) if (names.size > 1) issues.push({ code: 'CAMPAIGN_ID_WITH_MULTIPLE_NAMES', campaign_id: id, names: [...names] });
  for (const r of rows) if (r.clicks > 0 && (r.cost === null || r.cost === 0)) { issues.push({ code: 'CLICKS_WITHOUT_SPEND', campaign_id: r.campaign_id, date: r.date }); }
  return { ads: { source_system: raw.source_system, platform: raw.platform, account_ref: raw.account_ref ?? null, currency: raw.currency, window: { start: w.start, end: w.end }, retrieved_at: raw.retrieved_at ?? null, rows }, errors, issues };
}

export function summarizeAds(ads) {
  const by = new Map();
  for (const r of ads.rows) {
    if (!by.has(r.campaign_id)) by.set(r.campaign_id, { campaign_id: r.campaign_id, campaign_name: r.campaign_name, impressions: 0, clicks: 0, cost: 0, cost_known: true, conversions: 0, conversion_value: 0, conv_reported: false });
    const c = by.get(r.campaign_id);
    c.impressions += r.impressions; c.clicks += r.clicks;
    if (r.cost === null) c.cost_known = false; else c.cost += r.cost;
    if (r.conversions !== null) { c.conversions += r.conversions; c.conv_reported = true; }
    if (r.conversion_value !== null) c.conversion_value += r.conversion_value;
  }
  return [...by.values()].map((c) => ({
    campaign_id: c.campaign_id, campaign_name: c.campaign_name, impressions: c.impressions, clicks: c.clicks, ctr: c.impressions > 0 ? round4(c.clicks / c.impressions) : null,
    cost: c.cost_known ? round2(c.cost) : null, cpc: c.cost_known && c.clicks > 0 ? round2(c.cost / c.clicks) : null,
    platform_reported: { conversions: c.conv_reported ? c.conversions : null, conversion_value: c.conv_reported ? round2(c.conversion_value) : null },
  })).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
}

/**
 * @param {object} ctx { paidOrders: [{campaign}], paidNetSalesExTax, newPaidOrders, unknownNewPaidOrders, unattributedOnlineShare, merchantCurrency, marginGateOpen }
 */
export function paidReadiness(ads, issues, ctx, cfg) {
  const m = cfg.marketing;
  const reasons = { cpc: [], roas: [], cac: [], profit: [] };
  if (!ads) return { gates: Object.fromEntries(Object.keys(reasons).map((k) => [k, { status: 'GATED', reasons: ['NO_AD_FACTS'] }])), values: {} };

  const days = Math.round((dateMs(ads.window.end) - dateMs(ads.window.start)) / DAY_MS);
  const dated = ads.rows.filter((r) => r.date);
  const coveredDays = new Set(dated.map((r) => r.date)).size;
  const coverage = dated.length === 0 ? null : round4(coveredDays / days);
  const spendRows = ads.rows.filter((r) => r.cost !== null && r.cost > 0);
  const totalCost = spendRows.reduce((a, r) => a + r.cost, 0);
  const hasDup = issues.some((i) => i.code === 'DUPLICATE_AD_ROW');
  const missingSpend = issues.some((i) => i.code === 'CLICKS_WITHOUT_SPEND');
  const multiName = issues.some((i) => i.code === 'CAMPAIGN_ID_WITH_MULTIPLE_NAMES');

  if (spendRows.length === 0) reasons.cpc.push('NO_SPEND_ROWS');
  if (missingSpend) reasons.cpc.push('CLICKS_WITHOUT_SPEND');

  for (const k of ['roas', 'cac', 'profit']) {
    if (coverage === null) reasons[k].push('SPEND_ROWS_HAVE_NO_DATES_COVERAGE_UNVERIFIABLE');
    else if (coverage < m.minSpendCoverage) reasons[k].push('SPEND_COVERAGE_BELOW_MIN');
    if (hasDup) reasons[k].push('DUPLICATE_AD_ROWS');
    if (multiName) reasons[k].push('CAMPAIGN_ID_WITH_MULTIPLE_NAMES');
    if (missingSpend) reasons[k].push('CLICKS_WITHOUT_SPEND');
    if (ads.currency !== ctx.merchantCurrency) reasons[k].push('AD_CURRENCY_DIFFERS_FROM_MERCHANT_CURRENCY');
    if (totalCost <= 0) reasons[k].push('NO_SPEND');
  }
  const idsAndNames = new Set(ads.rows.flatMap((r) => [norm(r.campaign_id), norm(r.campaign_name)]).filter(Boolean));
  const linked = ctx.paidOrders.filter((o) => o.campaign && idsAndNames.has(norm(o.campaign))).length;
  const linkage = ctx.paidOrders.length ? round4(linked / ctx.paidOrders.length) : null;
  for (const k of ['roas', 'cac', 'profit']) {
    if (ctx.paidOrders.length < m.minAttributedOrdersForPaidMetrics) reasons[k].push('TOO_FEW_ATTRIBUTED_PAID_ORDERS');
    if (ctx.unattributedOnlineShare !== null && ctx.unattributedOnlineShare > m.maxUnattributedOnlineShare) reasons[k].push('ONLINE_ATTRIBUTION_TOO_INCOMPLETE');
    if (linkage === null || linkage < m.minCampaignLinkage) reasons[k].push('PAID_ORDERS_NOT_LINKED_TO_AD_CAMPAIGNS');
  }
  if (ctx.unknownNewPaidOrders > 0 && ctx.newPaidOrders === 0) reasons.cac.push('NEW_CUSTOMER_STATUS_UNKNOWN');
  if (ctx.newPaidOrders === 0) reasons.cac.push('NO_NEW_CUSTOMER_PAID_ORDERS');
  if (!ctx.marginGateOpen) reasons.profit.push('MARGIN_GATE_NOT_OPEN');

  const gates = Object.fromEntries(Object.entries(reasons).map(([k, r]) => [k, { status: r.length ? 'GATED' : 'OPEN', reasons: [...new Set(r)] }]));
  const values = {
    spend: round2(totalCost), spend_coverage: coverage, currency: ads.currency,
    cpc: gates.cpc.status === 'OPEN' ? round2(totalCost / spendRows.reduce((a, r) => a + r.clicks, 0)) : null,
    platform_reported_roas: gates.roas.status === 'OPEN' && ads.rows.some((r) => r.conversion_value !== null) ? round2(ads.rows.reduce((a, r) => a + (r.conversion_value ?? 0), 0) / totalCost) : null,
    attributed_roas: gates.roas.status === 'OPEN' ? round2(ctx.paidNetSalesExTax / totalCost) : null,
    cac: gates.cac.status === 'OPEN' ? round2(totalCost / ctx.newPaidOrders) : null,
    campaign_linkage: linkage,
  };
  return { gates, values };
}

export function adsProvenance(ads, gates) {
  return provenance({
    source_system: ads.source_system, attribution_model: 'platform_reported_and_last_recorded_visit', fields: ['ad rows (imported)', 'order_attribution.utm_campaign'], window: ads.window,
    limitations: ['PLATFORM_CONVERSIONS_ARE_PLATFORM_REPORTED_NOT_VERIFIED', 'ATTRIBUTED_ROAS_USES_LAST_RECORDED_VISIT', ...(Object.values(gates).some((g) => g.status === 'GATED') ? ['SOME_SPEND_METRICS_GATED'] : [])],
    completeness: Object.values(gates).every((g) => g.status === 'OPEN') ? 'COMPLETE' : 'PARTIAL', evidence_kind: 'observed',
  });
}
