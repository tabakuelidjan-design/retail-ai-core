// Marketing data-quality detection. Aggregated at merchant level (one issue per rule, with counts
// and evidence) so it does not flood the flag table. Deterministic; nothing is auto-corrected.

export const MARKETING_RULE_CODES = [
  'MKT_UNATTRIBUTED_ONLINE_ORDERS', 'MKT_MISSING_UTM', 'MKT_SOURCE_MISMATCH', 'MKT_TRAFFIC_WINDOW_INCOMPATIBLE',
  'MKT_TRAFFIC_MARKET_MISMATCH', 'MKT_DUPLICATE_CAMPAIGN_ID', 'MKT_MISSING_SPEND', 'MKT_PARTIAL_CONNECTOR_COVERAGE',
  'MKT_SEARCH_QUERY_COVERAGE_LOW', 'MKT_SEARCH_GEOGRAPHY_DISAGREES_WITH_SESSIONS',
];

const issue = (rule_code, severity, summary, evidence) => ({ rule_code, severity, summary, evidence });
const isOnline = (c) => c.channel !== 'pos' && c.channel !== 'other_channel';
const round4 = (x) => Math.round(x * 10000) / 10000;

/**
 * @param {object} p { classified: Map, windowOrderIds: Set, traffic: {traffic,issues,gate,crossCheck}|null, ads: {ads,issues}|null, search: {search,issues}|null, cfg }
 */
export function detectMarketingIssues({ classified, windowOrderIds, traffic, ads, search, cfg, visibility = null }) {
  const out = [];
  const m = cfg.marketing;
  const inWin = [...classified.entries()].filter(([id]) => windowOrderIds.has(id)).map(([, c]) => c);
  const online = inWin.filter((c) => isOnline(c.classification));
  const unattributed = online.filter((c) => ['unattributed', 'unknown'].includes(c.classification.channel));

  if (unattributed.length > 0) {
    const share = round4(unattributed.length / online.length);
    out.push(issue('MKT_UNATTRIBUTED_ONLINE_ORDERS', share > m.maxUnattributedOnlineShare ? 'warning' : 'info',
      `${unattributed.length} of ${online.length} online orders have no recorded visit (they cannot be assigned to a channel).`, { unattributed_online_orders: unattributed.length, online_orders: online.length, share, threshold: m.maxUnattributedOnlineShare }));
  }

  const incompleteUtm = online.filter((c) => c.classification.issues.includes('UTM_INCOMPLETE'));
  if (incompleteUtm.length > 0) {
    out.push(issue('MKT_MISSING_UTM', 'info', `${incompleteUtm.length} online orders carry a utm_source but no utm_medium and/or utm_campaign, so the traffic cannot be classified as paid/organic or grouped by campaign.`,
      { orders: incompleteUtm.length, missing: { medium: incompleteUtm.filter((c) => !c.touches.last_visit.utm_medium).length, campaign: incompleteUtm.filter((c) => !c.touches.last_visit.utm_campaign).length } }));
  }

  const mismatches = inWin.flatMap((c) => c.classification.issues.filter((i) => i === 'POS_ORDER_HAS_VISIT_DATA' || i === 'PAID_MEDIUM_BUT_SEO_SOURCE_TYPE'));
  const cross = traffic?.crossCheck;
  const crossMismatch = cross && (cross.matches === false || cross.channel_mismatches.length > 0);
  if (mismatches.length > 0 || crossMismatch) {
    out.push(issue('MKT_SOURCE_MISMATCH', 'warning', crossMismatch ? 'The traffic system and the order attribution disagree about which channel buyers came from.' : 'Order fields contradict each other.', {
      contradictory_order_fields: mismatches.length ? [...new Set(mismatches)] : undefined, count: mismatches.length || undefined,
      completed_checkouts_vs_online_orders: crossMismatch ? cross : undefined,
    }));
  }

  if (traffic) {
    const reasons = traffic.gate.reasons;
    if (reasons.includes('TRAFFIC_WINDOW_STARTS_BEFORE_ORDER_HISTORY') || reasons.includes('NO_ORDER_HISTORY')) {
      out.push(issue('MKT_TRAFFIC_WINDOW_INCOMPATIBLE', 'warning', 'The traffic window is not covered by the order history, so sessions and orders do not describe the same period.', { reasons, traffic_window: traffic.traffic.window }));
    }
    if (reasons.includes('NON_TARGET_TRAFFIC_DOMINATES')) {
      out.push(issue('MKT_TRAFFIC_MARKET_MISMATCH', traffic.gate.market.non_target_share >= 0.5 ? 'critical' : 'warning',
        `${Math.round(traffic.gate.market.non_target_share * 100)}% of sessions come from outside the merchant's target markets: sessions are not a valid denominator for its orders.`, traffic.gate.market));
    } else if (reasons.includes('TARGET_MARKETS_NOT_CONFIGURED')) {
      out.push(issue('MKT_TRAFFIC_MARKET_MISMATCH', 'info', 'Traffic geography is available but target markets are not configured, so non-target traffic cannot be judged.', { top_countries: traffic.gate.market.top_countries }));
    }
    for (const i of traffic.issues) if (i.code === 'DIMENSION_TOTALS_DISAGREE') out.push(issue('MKT_PARTIAL_CONNECTOR_COVERAGE', 'info', 'Traffic dimensions report different session totals (truncated or differently filtered exports).', i));
  }

  if (ads) {
    const dup = ads.issues.filter((i) => i.code === 'DUPLICATE_AD_ROW' || i.code === 'CAMPAIGN_ID_WITH_MULTIPLE_NAMES');
    if (dup.length) out.push(issue('MKT_DUPLICATE_CAMPAIGN_ID', 'warning', 'Ad facts contain duplicated rows or campaign ids that map to more than one name.', { count: dup.length, examples: dup.slice(0, 5) }));
    const noSpend = ads.issues.filter((i) => i.code === 'CLICKS_WITHOUT_SPEND');
    if (noSpend.length) out.push(issue('MKT_MISSING_SPEND', 'warning', 'Ad rows report clicks but no spend.', { count: noSpend.length, examples: noSpend.slice(0, 5) }));
  }

  // The same UTM campaign string used with different source/medium pairs is ambiguous for campaign reporting.
  const campaignPairs = new Map();
  for (const c of online) {
    const v = c.touches.last_visit;
    if (!v?.utm_campaign) continue;
    const k = v.utm_campaign.toLowerCase();
    if (!campaignPairs.has(k)) campaignPairs.set(k, new Set());
    campaignPairs.get(k).add(`${v.utm_source ?? ''}|${v.utm_medium ?? ''}`);
  }
  const ambiguous = [...campaignPairs.entries()].filter(([, s]) => s.size > 1);
  if (ambiguous.length) out.push(issue('MKT_DUPLICATE_CAMPAIGN_ID', 'info', 'The same utm_campaign appears under different source/medium combinations.', { campaigns: ambiguous.map(([c, s]) => ({ campaign: c, combinations: [...s] })) }));

  const paidOrders = online.filter((c) => c.classification.channel.startsWith('paid_')).length;
  if (paidOrders > 0 && !ads) out.push(issue('MKT_MISSING_SPEND', 'warning', `${paidOrders} orders are attributed to paid channels but no ad spend data exists.`, { paid_attributed_orders: paidOrders }));

  if (visibility) {
    const a = visibility.coverage.anonymised_queries;
    if (a && a.share_of_clicks > 1 - cfg.marketing.search.minQueryCoverage) {
      out.push(issue('MKT_SEARCH_QUERY_COVERAGE_LOW', 'warning', `${Math.round(a.share_of_clicks * 100)}% of search clicks come from queries the source does not list (anonymised): query-level facts describe the minority.`, { anonymised_share_of_clicks: a.share_of_clicks, anonymised_share_of_impressions: a.share_of_impressions, min_query_coverage: cfg.marketing.search.minQueryCoverage }));
    } else if (!a) {
      out.push(issue('MKT_SEARCH_QUERY_COVERAGE_LOW', 'info', 'Query-table coverage of the site totals cannot be computed (no reported totals or no omitted-tail summary).', { reported_totals: visibility.coverage.reported_totals !== null }));
    }
    const g = visibility.geography;
    if (g.search_non_target_share_of_clicks !== null && g.session_non_target_share !== null && Math.abs(g.session_non_target_share - g.search_non_target_share_of_clicks) > cfg.marketing.search.maxTargetMarketGap) {
      out.push(issue('MKT_SEARCH_GEOGRAPHY_DISAGREES_WITH_SESSIONS', 'warning', 'Search clicks are mostly from target markets while store sessions are not (or vice versa): session traffic includes visits search does not explain.', { search_non_target_share_of_clicks: g.search_non_target_share_of_clicks, session_non_target_share: g.session_non_target_share, max_gap: cfg.marketing.search.maxTargetMarketGap }));
    }
  }

  const absent = [!traffic && 'traffic', !ads && 'ads', !search && 'search'].filter(Boolean);
  if (absent.length) {
    out.push(issue('MKT_PARTIAL_CONNECTOR_COVERAGE', absent.includes('ads') && paidOrders > 0 ? 'warning' : 'info',
      `No ${absent.join(', ')} data is connected or imported: only order-side marketing facts exist.`, { absent, present: ['orders', ...(traffic ? ['traffic'] : []), ...(ads ? ['ads'] : []), ...(search ? ['search'] : [])] }));
  }
  return out;
}

const SEVERITY_ORDER = { info: 0, warning: 1, critical: 2 };

/** Merchant-level flags for the existing data_quality_flags table (one row per rule). */
export function toQualityFlags(issues, merchantId) {
  const byRule = new Map();
  for (const i of issues) {
    const cur = byRule.get(i.rule_code);
    if (!cur || SEVERITY_ORDER[i.severity] > SEVERITY_ORDER[cur.severity]) byRule.set(i.rule_code, { ...i, all: [...(cur?.all ?? []), i] });
    else cur.all.push(i);
  }
  return [...byRule.values()].map((i) => ({ rule_code: i.rule_code, entity_type: 'merchant', entity_id: merchantId, severity: i.severity, details: { summary: i.summary, evidence: i.evidence, issues_in_rule: i.all.length } }));
}
