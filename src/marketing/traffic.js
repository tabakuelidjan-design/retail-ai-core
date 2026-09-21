// Traffic (sessions) import contract and conversion gate. Sessions come from a different
// system than orders, so a conversion rate is only computed when the two are demonstrably
// compatible: same window, same scope (online store), a market-valid denominator and enough
// volume. Otherwise sessions and orders are still shown - separately, as observations.
//
// Contract (an adapter or a manual export produces this; nothing here knows the platform):
// { source_system, method: 'api'|'manual_export', scope: 'online_store'|'all_channels',
//   window: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' /* exclusive */ }, retrieved_at,
//   dimensions: [{ dimension: 'channel'|'landing_page'|'country', complete: boolean,
//                  rows: [{ key, sessions, cart_sessions?, checkout_sessions?, completed_checkout_sessions? }] }] }

import { provenance } from './provenance.js';
import { parseLandingPath } from './channel-facts.js';

const DIMENSIONS = ['channel', 'landing_page', 'country'];
const DAY_MS = 24 * 60 * 60 * 1000;
const round4 = (x) => Math.round(x * 10000) / 10000;
const dateMs = (s) => Date.parse(`${s}T00:00:00Z`);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

export function normalizeTraffic(raw) {
  const errors = [];
  const issues = [];
  if (!raw || typeof raw !== 'object') return { traffic: null, errors: ['traffic file must be a JSON object'], issues };
  if (!raw.source_system) errors.push('source_system: required');
  if (!['online_store', 'all_channels'].includes(raw.scope)) errors.push('scope: online_store or all_channels');
  if (!['api', 'manual_export'].includes(raw.method)) errors.push('method: api or manual_export');
  const w = raw.window;
  if (!w || Number.isNaN(dateMs(w.start)) || Number.isNaN(dateMs(w.end)) || dateMs(w.end) <= dateMs(w.start)) errors.push('window: { start, end } as YYYY-MM-DD with end after start (end exclusive)');
  const dims = {};
  for (const d of Array.isArray(raw.dimensions) ? raw.dimensions : []) {
    if (!DIMENSIONS.includes(d.dimension)) { errors.push(`dimension "${d.dimension}" not supported (${DIMENSIONS.join(', ')})`); continue; }
    const rows = [];
    const seen = new Set();
    for (const r of d.rows ?? []) {
      if (typeof r.key !== 'string' || r.key.trim() === '' || !isNum(r.sessions)) { errors.push(`${d.dimension}: row needs a key and non-negative sessions`); continue; }
      const key = d.dimension === 'landing_page' ? r.key : r.key.trim();
      if (seen.has(key)) issues.push({ code: 'DUPLICATE_TRAFFIC_KEY', dimension: d.dimension, key });
      seen.add(key);
      rows.push({ key, sessions: r.sessions, cart_sessions: r.cart_sessions ?? null, checkout_sessions: r.checkout_sessions ?? null, completed_checkout_sessions: r.completed_checkout_sessions ?? null });
    }
    dims[d.dimension] = { complete: d.complete === true, rows, sessions: rows.reduce((a, r) => a + r.sessions, 0) };
  }
  if (errors.length) return { traffic: null, errors, issues };
  const sums = Object.values(dims).map((d) => d.sessions);
  if (new Set(sums).size > 1) issues.push({ code: 'DIMENSION_TOTALS_DISAGREE', sessions_by_dimension: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, v.sessions])) });
  const total = dims.channel?.complete ? dims.channel.sessions : dims.country?.complete ? dims.country.sessions : null;
  return {
    traffic: { source_system: raw.source_system, method: raw.method, scope: raw.scope, window: { start: w.start, end: w.end }, retrieved_at: raw.retrieved_at ?? null, dimensions: dims, total_sessions: total ?? Math.max(0, ...sums), total_sessions_from_complete_dimension: total !== null },
    errors, issues,
  };
}

/** channel key like "search/google" -> generic channel. Approximate by nature: the traffic system classifies visits differently from the order attribution. */
export function mapTrafficChannel(key, cfg) {
  const t = cfg.marketing.taxonomy;
  const [kind, name = ''] = key.toLowerCase().split('/');
  const hay = `${kind}/${name}`;
  if (kind === 'direct') return 'direct';
  if (t.aiAssistantHosts.some((p) => hay.includes(p.replace(/\.$/, '')))) return 'ai_assistant';
  if (kind === 'search') return 'organic_search';
  if (kind === 'social') return 'organic_social';
  if (kind === 'email') return 'email';
  if (kind === 'paid') return 'paid_other';
  return 'unknown';
}

/** Which generic channel an order-side channel belongs to, so orders and sessions can be compared. */
const shareOf = (part, whole) => (whole > 0 ? round4(part / whole) : null);

/**
 * Decides whether sessions can be a denominator for the merchant's online orders.
 * @param {object} ctx { orderHistoryStart: Date|null, timeZone }
 */
export function assessTraffic(traffic, ctx, cfg) {
  const reasons = [];
  const caveats = [];
  const m = cfg.marketing;
  const tol = m.windowToleranceDays * DAY_MS;

  if (traffic.scope !== 'online_store') reasons.push('TRAFFIC_SCOPE_NOT_ONLINE_STORE');
  if (ctx.orderHistoryStart) {
    const startMs = dateMs(traffic.window.start);
    if (startMs + tol < ctx.orderHistoryStart.getTime() - DAY_MS) reasons.push('TRAFFIC_WINDOW_STARTS_BEFORE_ORDER_HISTORY');
  } else reasons.push('NO_ORDER_HISTORY');

  const country = traffic.dimensions.country;
  let market = { status: 'NOT_PROVIDED' };
  if (country) {
    if (!country.complete) caveats.push('COUNTRY_DIMENSION_INCOMPLETE');
    if (m.targetMarkets.length === 0) { market = { status: 'TARGET_MARKETS_NOT_CONFIGURED' }; reasons.push('TARGET_MARKETS_NOT_CONFIGURED'); }
    else {
      const targets = new Set(m.targetMarkets.map((x) => x.toLowerCase()));
      const inTarget = country.rows.filter((r) => targets.has(r.key.toLowerCase())).reduce((a, r) => a + r.sessions, 0);
      const nonTargetShare = country.sessions > 0 ? round4(1 - inTarget / country.sessions) : null;
      market = { status: nonTargetShare !== null && nonTargetShare > m.maxNonTargetSessionShare ? 'NON_TARGET_TRAFFIC_DOMINATES' : 'OK', non_target_share: nonTargetShare, threshold: m.maxNonTargetSessionShare, target_markets: m.targetMarkets,
        top_countries: [...country.rows].sort((a, b) => b.sessions - a.sessions).slice(0, 5).map((r) => ({ country: r.key, sessions: r.sessions })) };
      if (market.status === 'NON_TARGET_TRAFFIC_DOMINATES') reasons.push('NON_TARGET_TRAFFIC_DOMINATES');
    }
  } else caveats.push('TRAFFIC_GEOGRAPHY_NOT_PROVIDED_NON_TARGET_TRAFFIC_UNCHECKED');

  if (traffic.total_sessions < m.minSessionsForConversion) reasons.push('TOO_FEW_SESSIONS');
  if (!traffic.total_sessions_from_complete_dimension) caveats.push('TOTAL_SESSIONS_FROM_INCOMPLETE_DIMENSION');
  return { status: reasons.length ? 'GATED' : 'OPEN', reasons, caveats, market };
}

/**
 * Sessions and orders side by side (always), and conversion only when the gate is open.
 * @param {object} onlineOrders { orders: number, byChannel: Map<channel, number>, completed_checkouts?: number }
 */
export function buildTrafficFacts(traffic, gate, onlineOrders, cfg) {
  const m = cfg.marketing;
  const chan = traffic.dimensions.channel;
  const sessionsByGeneric = {};
  for (const r of chan?.rows ?? []) {
    const g = mapTrafficChannel(r.key, cfg);
    sessionsByGeneric[g] = (sessionsByGeneric[g] ?? 0) + r.sessions;
  }
  const completedCheckouts = chan ? chan.rows.reduce((a, r) => a + (r.completed_checkout_sessions ?? 0), 0) : null;
  let crossCheck = null;
  if (completedCheckouts !== null && chan.rows.some((r) => r.completed_checkout_sessions != null)) {
    // Totals can agree while the two systems disagree about WHICH channel the buyers came from.
    const checkoutsByChannel = {};
    for (const r of chan.rows) {
      const g = mapTrafficChannel(r.key, cfg);
      checkoutsByChannel[g] = (checkoutsByChannel[g] ?? 0) + (r.completed_checkout_sessions ?? 0);
    }
    const channels = new Set([...Object.keys(checkoutsByChannel), ...onlineOrders.byChannel.keys()]);
    const channelMismatches = [...channels].map((channel) => ({ channel, orders_attributed: onlineOrders.byChannel.get(channel) ?? 0, completed_checkouts_in_traffic_system: checkoutsByChannel[channel] ?? 0 }))
      .filter((c) => c.orders_attributed !== c.completed_checkouts_in_traffic_system);
    crossCheck = { completed_checkout_sessions: completedCheckouts, online_orders: onlineOrders.orders, matches: completedCheckouts === onlineOrders.orders, channel_mismatches: channelMismatches };
  }

  const open = gate.status === 'OPEN';
  const overall = { sessions: traffic.total_sessions, online_orders: onlineOrders.orders, conversion_rate: open ? round4(onlineOrders.orders / traffic.total_sessions) : null, status: gate.status, reasons: gate.reasons };
  const byChannel = Object.entries(sessionsByGeneric).map(([channel, sessions]) => {
    const orders = onlineOrders.byChannel.get(channel) ?? 0;
    const enough = sessions >= m.minSessionsForConversion;
    const ok = open && enough;
    return { channel, sessions, orders, conversion_rate: ok ? round4(orders / sessions) : null, status: ok ? 'OPEN' : 'GATED', reasons: ok ? [] : [...gate.reasons, ...(!enough ? ['TOO_FEW_SESSIONS_IN_CHANNEL'] : [])], mapping: 'approximate: traffic and order systems classify visits differently' };
  }).sort((a, b) => b.sessions - a.sessions);

  return {
    window: traffic.window, scope: traffic.scope, overall, by_channel: byChannel, order_vs_checkout_cross_check: crossCheck, market: gate.market,
    provenance: provenance({
      source_system: traffic.source_system, attribution_model: null, fields: ['sessions (imported)', 'orders (shopify, online channels only)'], window: traffic.window,
      limitations: [...gate.caveats, ...(traffic.method === 'manual_export' ? ['MANUAL_EXPORT_NOT_A_LIVE_CONNECTOR'] : []), 'SESSIONS_AND_ORDERS_COME_FROM_DIFFERENT_SYSTEMS'],
      completeness: traffic.total_sessions_from_complete_dimension ? 'PARTIAL' : 'PARTIAL', evidence_kind: 'observed',
    }),
  };
}

/** Landing-page sessions vs buyers' landing pages; absence is only meaningful when the export is complete. */
export function buildLandingTrafficFacts(traffic, landingOrdersByPath, productByHandle, gate, cfg) {
  const dim = traffic.dimensions.landing_page;
  if (!dim) return { status: 'UNAVAILABLE', reason: 'NO_LANDING_PAGE_DIMENSION' };
  const min = cfg.marketing.minSessionsForLandingSignal ?? 10;
  const sessions = new Map();
  for (const r of dim.rows) {
    const p = parseLandingPath(r.key);
    if (!p.normalized) continue;
    const cur = sessions.get(p.normalized) ?? { sessions: 0, type: p.type, productHandle: p.productHandle };
    cur.sessions += r.sessions;
    sessions.set(p.normalized, cur);
  }
  const rows = [...sessions.entries()].map(([path, s]) => {
    const orders = landingOrdersByPath.get(path) ?? 0;
    return { landing_page: path, type: s.type, sessions: s.sessions, orders_from_this_landing: orders, conversion_rate: gate.status === 'OPEN' ? round4(orders / s.sessions) : null, product_key: s.productHandle ? (productByHandle.get(s.productHandle)?.id ?? null) : null };
  }).sort((a, b) => b.sessions - a.sessions);
  const productRows = rows.filter((r) => r.type === 'product');
  return {
    complete_export: dim.complete, conversion_status: gate.status,
    products_with_sessions_but_no_orders: productRows.filter((r) => r.sessions >= min && r.orders_from_this_landing === 0).map((r) => ({ landing_page: r.landing_page, sessions: r.sessions })),
    products_with_orders_but_no_observed_sessions: dim.complete
      ? [...landingOrdersByPath.entries()].filter(([p, n]) => n > 0 && p.startsWith('/products/') && !sessions.has(p)).map(([p, n]) => ({ landing_page: p, orders: n }))
      : { status: 'UNAVAILABLE', reason: 'LANDING_PAGE_EXPORT_IS_TRUNCATED_ABSENCE_IS_NOT_ZERO_TRAFFIC' },
    landing_pages: rows.slice(0, 50),
    provenance: provenance({
      source_system: traffic.source_system, fields: ['sessions by landing_page (imported)', 'order_attribution.landing_path'], window: traffic.window,
      limitations: ['SESSIONS_INCLUDE_NON_TARGET_TRAFFIC_UNLESS_GATE_OPEN', ...(dim.complete ? [] : ['EXPORT_IS_TRUNCATED'])], completeness: dim.complete ? 'PARTIAL' : 'PARTIAL', evidence_kind: 'observed',
    }),
    shares: { sessions_on_home: shareOf(rows.filter((r) => r.type === 'home').reduce((a, r) => a + r.sessions, 0), dim.sessions), sessions_on_password_page: shareOf(rows.filter((r) => r.type === 'password').reduce((a, r) => a + r.sessions, 0), dim.sessions) },
  };
}
