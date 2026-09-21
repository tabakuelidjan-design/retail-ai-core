// Assembles the Phase 2D.1 marketing measurement document. Pure and deterministic: same rows +
// same `now` => same output. Facts and gates only - no recommendations, no causal claims.

import { MARKETING_VERSION } from '../metrics/config.js';
import { windowFacts } from '../metrics/sales.js';
import { buildWindows, localMidnight } from '../metrics/windows.js';
import { buildCampaignFacts, buildChannelFacts, buildLandingFacts, buildProductMarketingFacts, classifyOrders, parseLandingPath } from './channel-facts.js';
import { adsProvenance, paidReadiness, summarizeAds } from './paid.js';
import { detectMarketingIssues } from './quality.js';
import { NOT_CAUSAL } from './provenance.js';
import { summarizeSearch } from './search.js';
import { buildSearchVisibility } from './search-visibility.js';
import { assessTraffic, buildLandingTrafficFacts, buildTrafficFacts } from './traffic.js';

const isOnline = (c) => c.channel !== 'pos' && c.channel !== 'other_channel';

function ordersInRange(classified, ledger, start, end) {
  return ledger.orders.filter((o) => o.orderedAt >= start && o.orderedAt < end).map((o) => ({ id: o.id, c: classified.get(o.id) })).filter((x) => x.c);
}

export function buildMarketingFacts({ ledger, data, traffic, ads, search, now, timeZone, config, merchantId, marginGateOpen = false }) {
  const windows = buildWindows(now, timeZone);
  const classified = classifyOrders(data, ledger, config);
  const cfg = config;
  const avail = windows.available_window;

  const channelsByWindow = {};
  for (const w of Object.values(windows)) channelsByWindow[w.key] = buildChannelFacts(ledger, classified, w, cfg);
  const landing = buildLandingFacts(ledger, classified, data.products, avail, cfg);
  const productMarketing = buildProductMarketingFacts(ledger, classified, data, avail, cfg);
  const campaigns = buildCampaignFacts(classified, ledger, avail);
  const firstOrder = ledger.orders.length ? new Date(Math.min(...ledger.orders.map((o) => o.orderedAt))) : null;

  const gates = {
    channel_facts: { status: 'OPEN', note: 'Order-side facts; online attribution coverage reported per window. Attributed, never causal.' },
  };

  // ---- traffic ----
  let trafficBlock = { status: 'ABSENT', reason: 'No traffic file supplied: the app cannot read sessions at runtime (needs a scope + protected-data approval or an import).' };
  let trafficCtx = null;
  if (traffic) {
    const gate = assessTraffic(traffic.traffic, { orderHistoryStart: firstOrder, timeZone }, cfg);
    const start = localMidnight(traffic.traffic.window.start, timeZone);
    const end = localMidnight(traffic.traffic.window.end, timeZone);
    const inRange = ordersInRange(classified, ledger, start, end);
    const onlineIn = inRange.filter((x) => isOnline(x.c.classification));
    const byChannel = new Map();
    for (const x of onlineIn) byChannel.set(x.c.classification.channel, (byChannel.get(x.c.classification.channel) ?? 0) + 1);
    const facts = buildTrafficFacts(traffic.traffic, gate, { orders: onlineIn.length, byChannel }, cfg);
    const landingOrders = new Map();
    for (const x of onlineIn) {
      const p = parseLandingPath(x.c.touches.last_visit?.landing_path);
      if (p.normalized) landingOrders.set(p.normalized, (landingOrders.get(p.normalized) ?? 0) + 1);
    }
    const productByHandle = new Map(data.products.filter((p) => p.handle).map((p) => [p.handle, p]));
    trafficBlock = { ...facts, landing: buildLandingTrafficFacts(traffic.traffic, landingOrders, productByHandle, gate, cfg) };
    trafficCtx = { gate, crossCheck: facts.order_vs_checkout_cross_check, issues: traffic.issues, traffic: traffic.traffic };
    gates.traffic_conversion = { status: gate.status, reasons: gate.reasons };
  } else gates.traffic_conversion = { status: 'GATED', reasons: ['NO_TRAFFIC_FACTS'] };

  // ---- ads ----
  let adsBlock = { status: 'ABSENT', reason: 'No ad platform data supplied.' };
  let adsCtx = null;
  if (ads) {
    const start = localMidnight(ads.ads.window.start, timeZone);
    const end = localMidnight(ads.ads.window.end, timeZone);
    const inRange = ordersInRange(classified, ledger, start, end).filter((x) => isOnline(x.c.classification));
    const paid = inRange.filter((x) => x.c.classification.channel.startsWith('paid_'));
    const paidIds = new Set(paid.map((x) => x.id));
    const paidNet = ledger.lineFacts.filter((l) => paidIds.has(l.orderId)).reduce((a, l) => a + l.exTaxBeforeRefund, 0);
    const known = paid.filter((x) => x.c.order.journey_ready === true && x.c.order.customer_order_index != null);
    const unattrShare = inRange.length ? inRange.filter((x) => ['unattributed', 'unknown'].includes(x.c.classification.channel)).length / inRange.length : null;
    const readiness = paidReadiness(ads.ads, ads.issues, {
      paidOrders: paid.map((x) => ({ campaign: x.c.classification.campaign })), paidNetSalesExTax: paidNet,
      newPaidOrders: known.filter((x) => x.c.order.customer_order_index === 1).length, unknownNewPaidOrders: paid.length - known.length,
      unattributedOnlineShare: unattrShare, merchantCurrency: ledger.currency, marginGateOpen,
    }, cfg);
    adsBlock = { window: ads.ads.window, platform: ads.ads.platform, campaigns: summarizeAds(ads.ads), values: readiness.values, gates: readiness.gates, provenance: adsProvenance(ads.ads, readiness.gates) };
    adsCtx = { ads: ads.ads, issues: ads.issues };
    for (const [k, g] of Object.entries(readiness.gates)) gates[`paid_${k}`] = g;
  } else for (const k of ['cpc', 'roas', 'cac', 'profit']) gates[`paid_${k}`] = { status: 'GATED', reasons: ['NO_AD_FACTS'] };

  // ---- search ----
  let searchBlock = { status: 'ABSENT', reason: 'No search-visibility data supplied.' };
  if (search) {
    searchBlock = summarizeSearch(search.search, cfg);
    gates.search_branded_split = searchBlock.branded_split_gate;
    const sessionNonTargetShare = trafficBlock?.market?.non_target_share ?? trafficBlock?.gate?.market?.non_target_share ?? null;
    searchBlock.visibility = buildSearchVisibility(search.search, cfg, { products: data.products, sessionNonTargetShare });
    gates.search_visibility = searchBlock.visibility.gates.query_facts;
  }
  else gates.search_branded_split = { status: 'GATED', reasons: ['NO_SEARCH_FACTS'] };

  const windowOrderIds = new Set(windowFacts(ledger, avail).orders.map((o) => o.id));
  const issues = detectMarketingIssues({ classified, windowOrderIds, traffic: trafficCtx, ads: adsCtx, search: search ? { search: search.search, issues: search.issues } : null, cfg, visibility: searchBlock.visibility ?? null });

  const cov = channelsByWindow.available_window.attribution_coverage;
  return {
    schema_version: MARKETING_VERSION, generated_at: now.toISOString(), merchant_timezone: timeZone, currency: ledger.currency, merchant_id: merchantId ?? null,
    causal_claims: false, attribution_statement: NOT_CAUSAL,
    attribution_model: { name: 'last_recorded_visit', description: "Each online order is assigned to the last visit the source recorded before it. POS orders are assigned by their sales channel. Orders with no recorded visit stay 'unattributed'.", first_visit_recorded: true },
    windows: Object.fromEntries(Object.values(windows).map((w) => [w.key, { start: w.start.toISOString(), end: w.end.toISOString() }])),
    attribution_coverage: cov,
    channels: channelsByWindow, landing, products: productMarketing, campaigns,
    traffic: trafficBlock, paid: adsBlock, search: searchBlock,
    data_quality: { issues, connectors: { orders: 'shopify (read-only)', traffic: traffic ? traffic.traffic.method : 'absent', ads: ads ? ads.ads.platform : 'absent', search: search ? search.search.source_system : 'absent' } },
    gates,
  };
}
