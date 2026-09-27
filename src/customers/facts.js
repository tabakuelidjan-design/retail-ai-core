// Phase 2E - Customer Intelligence Lite. Deterministic behaviour facts.
// Order-level facts use each order's recorded position in its customer's history (customer_order_index) and its lines.
// Customer-level facts (see customer-level.js) use ONLY the pseudonymous orders.customer_key (a keyed hash); when no
// order carries one those metrics are BLOCKED, never approximated. No identity leaves the database or enters a report.

import { aggregate } from '../metrics/sales.js';
import { buildCustomerLevel } from './customer-level.js';
import { customerProvenance } from './provenance.js';
import { isOnlineChannel, isPosChannel } from '../metrics/channels.js';

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
const share = (a, b) => (b > 0 ? round4(a / b) : null);
const DAY = 86400000;

export const BLOCKED_CUSTOMER_LEVEL = {
  status: 'BLOCKED',
  reasons: ['NO_CUSTOMER_KEY_IN_SYNCED_DATA', 'REQUIRES_read_customers_SCOPE_AND_LOCAL_CUSTOMER_HASH_KEY'],
  blocked_metrics: ['customers_with_1_2_3plus_orders', 'customer_repeat_purchase_rate', 'time_between_purchases', 'revenue_per_customer', 'orders_per_customer', 'units_per_customer', 'top_customer_revenue_share', 'customer_concentration_risk'],
  note: 'These need the pseudonymous customer key (orders.customer_key). They are not estimated from order-level data.',
};

/** Group an order by what its recorded customer index can PROVE. */
export function orderGroup(order, { online, pos }) {
  const idx = order.customer_order_index;
  if (order.journey_ready !== true || idx == null) return 'unknown';
  if (idx > 1) return 'returning'; // an earlier order exists: provable on any channel
  if (online) return 'new'; // online orders always have a customer session/record
  if (pos) return 'first_recorded_pos'; // POS is often anonymous: index 1 does not prove a new customer
  return 'unknown';
}

export function buildCustomerFacts({ ledger, data, now, config }) {
  const c = config.customers;
  const rawById = new Map(data.orders.map((o) => [o.id, o]));
  const orders = ledger.orders.map((o) => ({ ...o, raw: rawById.get(o.id) })).filter((o) => o.raw);
  const first = orders.length ? new Date(Math.min(...orders.map((o) => o.orderedAt))) : null;
  const spanDays = first ? Math.round((now - first) / DAY) : 0;
  const window = first ? { start: first.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) } : null;
  const historyLimitations = [
    ...(spanDays < c.shortHistoryDays ? ['SHORT_HISTORY'] : []),
    'ORDER_HISTORY_LIMITED_TO_THE_SOURCE_READ_WINDOW',
    'CUSTOMER_INDEX_COUNTS_LIFETIME_ORDERS_BUT_EARLIER_ORDERS_ARE_NOT_IN_THIS_DATASET',
  ];
  const spanFact = { history_days: spanDays, first_order_date: window?.start ?? null, orders_in_scope: orders.length };

  // Channel spellings with the same meaning (e.g. pos / point_of_sale) are compared normalized (metrics/channels.js).
  const groupOf = (o) => orderGroup(o.raw, { online: isOnlineChannel(o.raw.channel_handle, config), pos: isPosChannel(o.raw.channel_handle, config) });
  const groupByOrder = new Map(orders.map((o) => [o.id, groupOf(o)]));
  const groupOfLine = new Map(ledger.lineFacts.map((l) => [l.orderLineId, groupByOrder.get(l.orderId)]));

  // ---- new vs returning ----
  const names = ['new', 'returning', 'first_recorded_pos', 'unknown'];
  const groups = Object.fromEntries(names.map((g) => {
    const lines = ledger.lineFacts.filter((l) => groupByOrder.get(l.orderId) === g);
    const refunds = ledger.refundFacts.filter((r) => groupOfLine.get(r.orderLineId) === g);
    const n = orders.filter((o) => groupByOrder.get(o.id) === g).length;
    const a = aggregate(lines, refunds, config);
    return [g, { orders: n, units: a.units_sold, net_sales: a.net_sales, net_sales_ex_tax: a.net_sales_ex_tax, aov: n ? round2(a.net_sales / n) : null }];
  }));
  const totalOrders = orders.length;
  const totalNet = names.reduce((s, g) => s + groups[g].net_sales_ex_tax, 0);
  for (const g of names) { groups[g].order_share = share(groups[g].orders, totalOrders); groups[g].revenue_share = share(groups[g].net_sales_ex_tax, totalNet); }
  const compared = ['new', 'returning'];
  const smallGroups = compared.filter((g) => groups[g].orders < c.minOrdersPerGroup);
  const newVsReturning = {
    groups,
    group_definitions: {
      new: 'online order whose recorded index is 1',
      returning: 'any order whose recorded index is above 1 (an earlier order provably exists)',
      first_recorded_pos: 'POS order with index 1: may be an anonymous or new customer, NOT counted as new',
      unknown: 'no recorded index',
    },
    returning_is_lower_bound: true,
    provenance: customerProvenance({
      window, sample: { orders: totalOrders, ...Object.fromEntries(names.map((g) => [`${g}_orders`, groups[g].orders])) },
      completeness: 'PARTIAL', historyLimitations, limitations: ['POS_NEW_CUSTOMERS_CANNOT_BE_PROVEN', 'RETURNING_IS_A_LOWER_BOUND'],
      safe: smallGroups.length === 0 && totalOrders > 0,
      unsafeReasons: smallGroups.map((g) => `GROUP_${g.toUpperCase()}_BELOW_${c.minOrdersPerGroup}_ORDERS`),
    }),
  };

  // ---- repeat behaviour (order level) ----
  const known = groups.new.orders + groups.returning.orders + groups.first_recorded_pos.orders;
  const repeat = {
    repeat_orders: groups.returning.orders, orders_with_known_index: known,
    repeat_order_share_lower_bound: share(groups.returning.orders, known),
    customer_level: BLOCKED_CUSTOMER_LEVEL,
    provenance: customerProvenance({
      window, sample: { orders_with_known_index: known }, completeness: 'PARTIAL', historyLimitations, limitations: ['ORDER_SHARE_IS_NOT_CUSTOMER_REPEAT_RATE'],
      safe: false, unsafeReasons: [...(spanDays < c.shortHistoryDays ? ['SHORT_HISTORY'] : []), 'CUSTOMER_LEVEL_REPEAT_METRICS_BLOCKED'],
    }),
  };

  // ---- customer value / concentration: blocked ----
  const customerValue = { ...BLOCKED_CUSTOMER_LEVEL, provenance: customerProvenance({ window, sample: null, completeness: 'UNAVAILABLE', historyLimitations, evidence_kind: 'unavailable', safe: false, unsafeReasons: BLOCKED_CUSTOMER_LEVEL.reasons }) };

  // ---- basket behaviour (order level, internal product ids only) ----
  const productById = new Map(data.products.map((p) => [p.id, p]));
  const basketByOrder = new Map();
  for (const l of ledger.lineFacts) {
    if (!basketByOrder.has(l.orderId)) basketByOrder.set(l.orderId, { lines: 0, units: 0, products: new Set() });
    const b = basketByOrder.get(l.orderId);
    b.lines += 1; b.units += l.qty;
    if (l.productId) b.products.add(l.productId);
  }
  const baskets = [...basketByOrder.values()];
  const multi = baskets.filter((b) => b.products.size >= 2);
  const sizeDist = {};
  for (const b of baskets) sizeDist[b.lines] = (sizeDist[b.lines] ?? 0) + 1;
  const pairCount = (keyOf) => {
    const m = new Map();
    for (const b of multi) {
      const keys = [...new Set([...b.products].map(keyOf).filter(Boolean))].sort();
      for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) m.set(`${keys[i]}\u0001${keys[j]}`, (m.get(`${keys[i]}\u0001${keys[j]}`) ?? 0) + 1);
    }
    return m;
  };
  const pairsOpen = baskets.length >= c.basket.minOrders;
  const listPairs = (m, label) => (pairsOpen
    ? [...m.entries()].filter(([, n]) => n >= c.basket.minPairSupport).sort((a, b) => b[1] - a[1]).slice(0, c.basket.maxPairs).map(([k, n]) => { const [x, y] = k.split('\u0001'); return { a: label(x), b: label(y), orders_together: n, share_of_orders: share(n, baskets.length) }; })
    : []);
  const pProd = pairCount((id) => id);
  const pCat = pairCount((id) => productById.get(id)?.product_type || null);
  const productPairs = listPairs(pProd, (id) => ({ product_id: id, title: productById.get(id)?.title ?? null }));
  const categoryPairs = listPairs(pCat, (t) => t);
  const basketReasons = [...(pairsOpen ? [] : [`ONLY_${baskets.length}_ORDERS_BELOW_${c.basket.minOrders}`]), ...(pairsOpen && productPairs.length + categoryPairs.length === 0 ? [`NO_PAIR_REACHES_${c.basket.minPairSupport}_ORDERS`] : [])];
  const basket = {
    orders: baskets.length, multi_product_orders: multi.length, multi_product_share: share(multi.length, baskets.length),
    lines_per_order_distribution: sizeDist, avg_units_per_order: baskets.length ? round2(baskets.reduce((s, b) => s + b.units, 0) / baskets.length) : null,
    distinct_product_pairs_observed: pProd.size, distinct_category_pairs_observed: pCat.size,
    pair_gate: pairsOpen ? { status: 'OPEN', min_orders: c.basket.minOrders, min_pair_support: c.basket.minPairSupport } : { status: 'GATED', reasons: [`ONLY_${baskets.length}_ORDERS_BELOW_${c.basket.minOrders}`], min_orders: c.basket.minOrders },
    product_pairs: productPairs,
    category_pairs: categoryPairs,
    provenance: customerProvenance({
      window, sample: { orders: baskets.length, multi_product_orders: multi.length }, completeness: 'PARTIAL', historyLimitations,
      limitations: ['CO_PURCHASE_IS_NOT_A_RECOMMENDATION', 'PAIRS_LISTED_ONLY_ABOVE_SAMPLE_THRESHOLDS'], safe: basketReasons.length === 0,
      unsafeReasons: basketReasons,
    }),
  };

  const level = buildCustomerLevel(orders, ledger, config, { window, historyLimitations, spanDays });
  return {
    version: '2E.2', generated_at: now.toISOString(), history: spanFact,
    privacy: { customer_identity_stored: false, customer_key_stored: level !== null, customer_identity_in_report: false, customer_key_in_report: false, note: 'Aggregates only. The customer key is a keyed hash (HMAC-SHA256) held in the database and never printed; product ids are internal catalogue ids.' },
    new_vs_returning: newVsReturning,
    new_vs_returning_customers: level?.newVsReturning ?? { ...BLOCKED_CUSTOMER_LEVEL, provenance: customerValue.provenance },
    repeat_behaviour: level ? { ...repeat, customer_level: level.repeat, provenance: level.repeat.provenance } : repeat,
    customer_value: level?.value ?? customerValue,
    customer_concentration: level?.concentration ?? customerValue,
    basket,
  };
}
