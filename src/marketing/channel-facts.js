// Channel, landing-page, product/category and campaign facts from ORDERS. Deterministic and
// pure. Every block carries provenance. Revenue by channel is ATTRIBUTED (a recorded visit
// under a stated model), never proof of cause; POS orders are OBSERVED (the order's own
// sales channel); an online order with no recorded visit is UNATTRIBUTED, never guessed.

import { aggregate, windowFacts } from '../metrics/sales.js';
import { provenance, windowOf } from './provenance.js';
import { classifyOrder } from './taxonomy.js';

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
const share = (part, whole) => (whole > 0 ? round4(part / whole) : null);
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const ATTRIBUTION_MODEL = 'last_recorded_visit';
const ORDER_FIELDS = ['orders.channel_handle', 'orders.source_name', 'order_attribution(last_visit)'];

/** Classifies every countable order once. Returns Map orderId -> { classification, order, touches }. */
export function classifyOrders(data, ledger, cfg) {
  const rawById = new Map(data.orders.map((o) => [o.id, o]));
  const touchesByOrder = new Map();
  for (const a of data.orderAttribution ?? []) {
    if (!touchesByOrder.has(a.order_id)) touchesByOrder.set(a.order_id, {});
    touchesByOrder.get(a.order_id)[a.touch] = a;
  }
  const out = new Map();
  for (const o of ledger.orders) {
    const raw = rawById.get(o.id) ?? {};
    const touches = touchesByOrder.get(o.id) ?? {};
    out.set(o.id, { classification: classifyOrder(raw, touches, cfg), order: raw, touches, orderedAt: o.orderedAt });
  }
  return out;
}

const isOnline = (c) => c.channel !== 'pos' && c.channel !== 'other_channel';

/** Path -> { type, handle, normalized }. Locale prefixes are dropped; query strings never reach this far. */
export function parseLandingPath(path) {
  if (!path) return { type: 'unknown', handle: null, normalized: null, productHandle: null };
  let p = String(path).split(/[?#]/)[0] || '/';
  const locale = /^\/([a-z]{2}(?:-[a-z]{2})?)(?=\/|$)/i.exec(p);
  if (locale && !/^\/(products|collections|pages|cart|orders|blogs|account|password)(\/|$)/i.test(p)) p = p.slice(locale[0].length) || '/';
  const seg = p.split('/').filter(Boolean);
  if (seg.length === 0) return { type: 'home', handle: null, normalized: '/', productHandle: null };
  const [kind, handle, sub, sub2] = seg;
  if (kind === 'products' && handle) return { type: 'product', handle, normalized: `/products/${handle}`, productHandle: handle };
  if (kind === 'collections' && handle) {
    const nested = sub === 'products' && sub2 ? sub2 : null;
    return nested ? { type: 'product', handle: nested, normalized: `/products/${nested}`, productHandle: nested } : { type: 'collection', handle, normalized: `/collections/${handle}`, productHandle: null };
  }
  if (kind === 'pages') return { type: 'page', handle: handle ?? null, normalized: `/pages/${handle ?? ''}`, productHandle: null };
  if (kind === 'cart') return { type: 'cart', handle: null, normalized: '/cart', productHandle: null };
  if (kind === 'orders') return { type: 'order_status', handle: null, normalized: '/orders', productHandle: null };
  if (kind === 'password') return { type: 'password', handle: null, normalized: '/password', productHandle: null };
  return { type: 'other', handle: null, normalized: `/${kind}`, productHandle: null };
}

export function buildChannelFacts(ledger, classified, window, cfg) {
  const { orders, lines, refunds } = windowFacts(ledger, window);
  const chanOf = (orderId) => classified.get(orderId)?.classification.channel ?? 'unknown';
  const byChannel = new Map();
  const bucket = (ch) => {
    if (!byChannel.has(ch)) byChannel.set(ch, { orders: new Set(), lines: [], refunds: [], kinds: {}, rules: {}, newOrders: 0, returningOrders: 0, unknownIndex: 0 });
    return byChannel.get(ch);
  };
  for (const o of orders) {
    const c = classified.get(o.id);
    if (!c) continue;
    const b = bucket(c.classification.channel);
    b.orders.add(o.id);
    b.kinds[c.classification.evidence_kind] = (b.kinds[c.classification.evidence_kind] ?? 0) + 1;
    b.rules[c.classification.rule] = (b.rules[c.classification.rule] ?? 0) + 1;
    if (isOnline(c.classification)) {
      const idx = c.order.customer_order_index;
      if (c.order.journey_ready !== true || idx == null) b.unknownIndex += 1;
      else if (idx === 1) b.newOrders += 1;
      else b.returningOrders += 1;
    }
  }
  for (const l of lines) bucket(chanOf(l.orderId)).lines.push(l);
  const lineOrder = new Map(ledger.lineFacts.map((l) => [l.orderLineId, l.orderId]));
  for (const r of refunds) bucket(chanOf(lineOrder.get(r.orderLineId))).refunds.push(r);

  const totalNet = sum([...byChannel.values()], (b) => aggregate(b.lines, b.refunds, ledger.config).net_sales_ex_tax);
  const channels = [...byChannel.entries()].map(([channel, b]) => {
    const a = aggregate(b.lines, b.refunds, ledger.config);
    const online = channel !== 'pos' && channel !== 'other_channel';
    const kinds = Object.keys(b.kinds);
    return {
      channel, orders: b.orders.size, units_sold: a.units_sold, gross_sales: a.gross_sales, discounts: a.discounts, refunds: a.refunds,
      net_sales: a.net_sales, net_sales_ex_tax: a.net_sales_ex_tax, aov: b.orders.size ? round2(a.net_sales / b.orders.size) : null,
      revenue_share: share(a.net_sales_ex_tax, totalNet),
      new_vs_returning: online
        ? { new_orders: b.newOrders, returning_orders: b.returningOrders, unknown: b.unknownIndex, basis: 'customer_order_index of the order (online orders only)' }
        : { status: 'UNAVAILABLE', reason: channel === 'pos' ? 'POS orders usually carry no customer record; an index of 1 would not mean "new"' : 'not an online order' },
      rules_applied: b.rules,
      provenance: provenance({
        source_system: 'shopify', attribution_model: online && channel !== 'unattributed' ? ATTRIBUTION_MODEL : null, fields: ORDER_FIELDS, window: windowOf(window),
        limitations: [
          ...(channel === 'pos' ? ['POS_ORDERS_HAVE_NO_RECORDED_VISIT'] : []),
          ...(channel === 'unattributed' ? ['NO_RECORDED_VISIT_FOR_THESE_ONLINE_ORDERS'] : []),
          ...(online && channel !== 'unattributed' ? ['LAST_VISIT_MODEL_IGNORES_EARLIER_TOUCHES', 'SMALL_SAMPLES_ARE_NOISY'] : []),
        ],
        completeness: channel === 'unattributed' || channel === 'unknown' ? 'UNAVAILABLE' : kinds.includes('inferred') ? 'PARTIAL' : 'COMPLETE',
        evidence_kind: channel === 'pos' || channel === 'other_channel' ? 'observed' : channel === 'unattributed' || channel === 'unknown' ? 'unavailable' : kinds.includes('inferred') && !kinds.includes('attributed') ? 'inferred' : 'attributed',
      }),
    };
  }).sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax || a.channel.localeCompare(b.channel));

  const onlineChannels = channels.filter((c) => c.channel !== 'pos' && c.channel !== 'other_channel');
  const onlineOrders = sum(onlineChannels, (c) => c.orders);
  const unattributedOrders = sum(onlineChannels.filter((c) => ['unattributed', 'unknown'].includes(c.channel)), (c) => c.orders);
  const onlineNet = sum(onlineChannels, (c) => c.net_sales_ex_tax);
  const unattributedNet = sum(onlineChannels.filter((c) => ['unattributed', 'unknown'].includes(c.channel)), (c) => c.net_sales_ex_tax);
  return {
    window: windowOf(window),
    total: { orders: orders.length, net_sales_ex_tax: round2(totalNet), pos_orders: sum(channels.filter((c) => c.channel === 'pos'), (c) => c.orders), online_orders: onlineOrders },
    attribution_coverage: {
      online_orders: onlineOrders, attributed_online_orders: onlineOrders - unattributedOrders, unattributed_online_orders: unattributedOrders,
      coverage_of_online_orders: share(onlineOrders - unattributedOrders, onlineOrders),
      unattributed_share_of_online_net_sales: share(unattributedNet, onlineNet),
      pos_share_of_orders: share(sum(channels.filter((c) => c.channel === 'pos'), (c) => c.orders), orders.length),
      note: 'POS orders are excluded from attribution coverage: they have no online journey by nature.',
    },
    channels,
  };
}

/** Landing pages of attributed online orders, mapped to products by handle. Orders only: this is where BUYERS landed, not where all visitors landed. */
export function buildLandingFacts(ledger, classified, products, window, cfg) {
  const { orders, lines } = windowFacts(ledger, window);
  const productByHandle = new Map(products.filter((p) => p.handle).map((p) => [p.handle, p]));
  const linesByOrder = new Map();
  for (const l of lines) { if (!linesByOrder.has(l.orderId)) linesByOrder.set(l.orderId, []); linesByOrder.get(l.orderId).push(l); }

  const pages = new Map();
  let withLanding = 0;
  let matchedPurchase = 0;
  let productLandings = 0;
  for (const o of orders) {
    const c = classified.get(o.id);
    const visit = c?.touches.last_visit;
    if (!c || !isOnline(c.classification) || !visit?.landing_path) continue;
    withLanding += 1;
    const parsed = parseLandingPath(visit.landing_path);
    const key = parsed.normalized;
    if (!pages.has(key)) pages.set(key, { landing_page: key, type: parsed.type, handle: parsed.handle, product_key: null, orders: 0, net_sales_ex_tax: 0, channels: {}, purchased_landing_product: 0 });
    const page = pages.get(key);
    const oLines = linesByOrder.get(o.id) ?? [];
    page.orders += 1;
    page.net_sales_ex_tax = round2(page.net_sales_ex_tax + sum(oLines, (l) => l.exTaxBeforeRefund));
    page.channels[c.classification.channel] = (page.channels[c.classification.channel] ?? 0) + 1;
    if (parsed.productHandle) {
      productLandings += 1;
      const prod = productByHandle.get(parsed.productHandle);
      if (prod) {
        page.product_key = prod.id;
        if (oLines.some((l) => l.productId === prod.id)) { page.purchased_landing_product += 1; matchedPurchase += 1; }
      }
    }
  }
  const list = [...pages.values()].sort((a, b) => b.orders - a.orders || a.landing_page.localeCompare(b.landing_page));
  const byType = {};
  for (const p of list) byType[p.type] = (byType[p.type] ?? 0) + p.orders;
  return {
    window: windowOf(window),
    orders_with_landing_page: withLanding, by_type: byType, landing_pages: list,
    product_landings: { orders: productLandings, bought_the_landing_product: matchedPurchase, share: share(matchedPurchase, productLandings) },
    provenance: provenance({
      source_system: 'shopify', attribution_model: ATTRIBUTION_MODEL, fields: ['order_attribution.landing_path (path only, locale prefix normalised)', 'products.handle'], window: windowOf(window),
      limitations: ['ORDERS_ONLY_NO_TRAFFIC_DENOMINATOR', 'POS_ORDERS_EXCLUDED', 'SMALL_SAMPLES_ARE_NOISY'], completeness: withLanding > 0 ? 'PARTIAL' : 'UNAVAILABLE', evidence_kind: withLanding > 0 ? 'attributed' : 'unavailable',
    }),
  };
}

/** Orders/units/net sales by product and by category, split POS vs online, plus the share of each product's orders with no observed digital journey. */
export function buildProductMarketingFacts(ledger, classified, data, window, cfg) {
  const { lines } = windowFacts(ledger, window);
  const productRows = new Map(data.products.map((p) => [p.id, p]));
  const membership = new Map();
  for (const c of data.collections ?? []) { if (!membership.has(c.product_id)) membership.set(c.product_id, []); membership.get(c.product_id).push(c); }

  const acc = (map, key, label) => { if (!map.has(key)) map.set(key, { key, label, orders: { pos: new Set(), online: new Set(), online_attributed: new Set() }, units: 0, net: 0, channels: {} }); return map.get(key); };
  const products = new Map();
  const types = new Map();
  const collections = new Map();
  const add = (entry, l, c) => {
    const grp = isOnline(c.classification) ? 'online' : 'pos';
    entry.orders[grp].add(l.orderId);
    if (grp === 'online' && !['unattributed', 'unknown'].includes(c.classification.channel)) entry.orders.online_attributed.add(l.orderId);
    entry.units += l.qty;
    entry.net += l.exTaxBeforeRefund;
    entry.channels[c.classification.channel] = (entry.channels[c.classification.channel] ?? 0) + 1;
  };
  for (const l of lines) {
    const c = classified.get(l.orderId);
    if (!c || !l.productId) continue;
    const p = productRows.get(l.productId);
    add(acc(products, l.productId, p?.title ?? 'unknown'), l, c);
    add(acc(types, p?.product_type ?? 'UNCLASSIFIED', p?.product_type ?? 'UNCLASSIFIED'), l, c);
    for (const m of membership.get(l.productId) ?? []) add(acc(collections, m.source_id, m.title), l, c);
  }
  const render = (map) => [...map.values()].map((e) => {
    const total = new Set([...e.orders.pos, ...e.orders.online]).size;
    return {
      key: e.key, label: e.label, orders: total, orders_pos: e.orders.pos.size, orders_online: e.orders.online.size, orders_online_attributed: e.orders.online_attributed.size,
      units: e.units, net_sales_ex_tax: round2(e.net), channel_line_counts: e.channels,
      share_without_observed_digital_journey: share(total - e.orders.online_attributed.size, total),
    };
  }).sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax || String(a.label).localeCompare(String(b.label)));
  const prov = (extra = []) => provenance({
    source_system: 'shopify', attribution_model: ATTRIBUTION_MODEL, fields: ['order_lines', 'orders.channel_handle', 'order_attribution'], window: windowOf(window),
    limitations: ['NO_TRAFFIC_DENOMINATOR_SO_NO_PRODUCT_CONVERSION', 'POS_ORDERS_HAVE_NO_RECORDED_VISIT', ...extra], completeness: 'PARTIAL', evidence_kind: 'attributed',
  });
  return {
    window: windowOf(window),
    products: render(products), product_types: render(types), collections: render(collections).map((c) => ({ ...c, overlapping: true })),
    provenance: prov(['COLLECTIONS_OVERLAP_SO_TOTALS_ARE_NOT_ADDITIVE']),
  };
}

/** Concentration of attributed online orders by campaign tag (utm_campaign). Untagged orders are counted, never invented into a campaign. */
export function buildCampaignFacts(classified, ledger, window) {
  const inWin = new Set(windowFacts(ledger, window).orders.map((o) => o.id));
  const online = [...classified.entries()].filter(([id, c]) => inWin.has(id) && isOnline(c.classification) && !['unattributed', 'unknown'].includes(c.classification.channel));
  const byCampaign = new Map();
  let tagged = 0;
  for (const [, c] of online) {
    const key = c.classification.campaign ?? null;
    if (key) tagged += 1;
    const label = key ?? '(untagged)';
    byCampaign.set(label, (byCampaign.get(label) ?? 0) + 1);
  }
  const rows = [...byCampaign.entries()].map(([campaign, orders]) => ({ campaign, orders, share: share(orders, online.length) })).sort((a, b) => b.orders - a.orders || a.campaign.localeCompare(b.campaign));
  const named = rows.filter((r) => r.campaign !== '(untagged)');
  const hhi = named.length && tagged ? round4(sum(named, (r) => (r.orders / tagged) ** 2)) : null;
  return {
    window: windowOf(window), attributed_online_orders: online.length, tagged_orders: tagged, untagged_orders: online.length - tagged,
    campaigns: rows, concentration: { campaigns: named.length, top_campaign_share_of_tagged: named.length ? share(named[0].orders, tagged) : null, hhi_of_tagged: hhi },
    provenance: provenance({
      source_system: 'shopify', attribution_model: ATTRIBUTION_MODEL, fields: ['order_attribution.utm_campaign'], window: windowOf(window),
      limitations: ['CAMPAIGN_TAGS_ARE_MERCHANT_CHOSEN_STRINGS_NOT_VERIFIED_IDENTIFIERS', 'UNTAGGED_TRAFFIC_HAS_NO_CAMPAIGN'], completeness: tagged > 0 ? 'PARTIAL' : 'UNAVAILABLE', evidence_kind: tagged > 0 ? 'attributed' : 'unavailable',
    }),
  };
}
