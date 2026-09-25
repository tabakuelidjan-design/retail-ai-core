// Main "Clients" workspace data (Analytics Premium). Pure and deterministic: same rows + same `now` => same output.
// This is the OPERATIONAL customer list (who, how much, when, what changed); the analytical deep dive stays in
// Explorer > Clients (src/report/explorer.js > buildCustomersBlock), whose KPIs/coverage/segments the server reuses as-is.
//
// Built only from the shared ledger primitives (windowFacts, aggregate) and Explorer's own status rule
// (classifyCustomerOrders) - no new business definition is introduced here.
//
// Two scopes, never mixed:
//   period   the locked current window (last 30 days) - and, for evolution, the 30 days before it
//   history  every order in the loaded order history (the available window, see buildWindows); NOT the customer's
//            lifetime: when the source's customer order index says earlier orders exist, that is reported as a fact.
//
// Privacy: customers are pseudonymous (orders.customer_key, a keyed hash). Only a short label ("#A4B7") ever leaves this
// module - the full key never does. The label is the shortest upper-case key prefix (min 4 chars) that is unique among
// the merchant's identified customers, so it can also serve as the lookup id of the customer detail.
//
// Deliberately absent (no approved definition in Nordla): loyalty, risk, churn, dormancy, CLV / predicted value, cohorts.

import { aggregate, windowFacts } from '../metrics/sales.js';
import { productKeyOf } from '../metrics/products.js';
import { inWindow, localDateString, previousEquivalentWindow } from '../metrics/windows.js';
import { classifyCustomerOrders } from './explorer.js';

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
const DAY = 86400000;
export const LABEL_MIN_CHARS = 4;
const LABEL_MAX_CHARS = 12;
// Factual recency buckets (days since the last known order) - the same cut-offs as Explorer > Clients. Not a judgement.
export const RECENCY_BUCKETS = [
  { key: 'd0_30', max: 30 }, { key: 'd31_60', max: 60 }, { key: 'd61_90', max: 90 }, { key: 'd90_plus', max: Infinity },
];
const recencyBucket = (days) => RECENCY_BUCKETS.find((b) => days <= b.max).key;

/** Shortest unique upper-case prefix (>= LABEL_MIN_CHARS) per key. Returns Map(key -> id). */
export function safeCustomerIds(keys) {
  const out = new Map();
  const list = [...new Set(keys)];
  for (const k of list) {
    let n = LABEL_MIN_CHARS;
    while (n < LABEL_MAX_CHARS && list.some((o) => o !== k && o.slice(0, n).toUpperCase() === k.slice(0, n).toUpperCase())) n += 1;
    out.set(k, k.slice(0, n).toUpperCase());
  }
  return out;
}

export function buildCustomersWorkspace({ ledger, data, windows, now, config, timeZone }) {
  const win = windows.last_30_days;
  const prevWin = previousEquivalentWindow(win);
  const hist = windows.available_window;
  const tz = timeZone || win.timeZone || 'UTC';
  const rawOrder = new Map(data.orders.map((o) => [o.id, o]));
  const keyOf = (orderId) => rawOrder.get(orderId)?.customer_key || null;
  const idxOf = (raw) => (raw?.journey_ready === true && Number.isFinite(Number(raw.customer_order_index)) ? Number(raw.customer_order_index) : null);
  const lineById = new Map(ledger.lineFacts.map((l) => [l.orderLineId, l]));
  const linesByOrder = new Map();
  for (const l of ledger.lineFacts) { if (!linesByOrder.has(l.orderId)) linesByOrder.set(l.orderId, []); linesByOrder.get(l.orderId).push(l); }
  const refundsByLine = new Map();
  for (const r of ledger.refundFacts) { if (!refundsByLine.has(r.orderLineId)) refundsByLine.set(r.orderLineId, []); refundsByLine.get(r.orderLineId).push(r); }

  // ---- every identified order of the loaded history, per customer ----
  const byKey = new Map();
  for (const o of ledger.orders) {
    const k = keyOf(o.id); if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(o);
  }
  const ids = safeCustomerIds([...byKey.keys()]);

  // ---- period revenue per customer: exactly Explorer's rule (window lines + refunds dated in the window) ----
  function perCustomer(window) {
    if (!window) return null;
    const { orders, lines, refunds } = windowFacts(ledger, window);
    const m = new Map();
    const slot = (k) => { if (!m.has(k)) m.set(k, { orders: [], lines: [], refunds: [] }); return m.get(k); };
    for (const o of orders) { const k = keyOf(o.id); if (k) slot(k).orders.push(o); }
    for (const l of lines) { const k = keyOf(l.orderId); if (k) slot(k).lines.push(l); }
    for (const r of refunds) { const l = lineById.get(r.orderLineId); const k = l ? keyOf(l.orderId) : null; if (k) slot(k).refunds.push(r); }
    const out = new Map();
    for (const [k, g] of m) {
      const net = aggregate(g.lines, g.refunds, config).net_sales_ex_tax;
      out.set(k, { orders: g.orders, net_sales_ex_tax: net, order_count: g.orders.length, status: g.orders.length ? classifyCustomerOrders(g.orders.map((o) => ({ idx: idxOf(rawOrder.get(o.id)) }))) : null });
    }
    return out;
  }
  const cur = perCustomer(win);
  const prev = perCustomer(prevWin);

  const localDate = (d) => localDateString(d, tz);
  const orderNet = (orderId) => {
    const lines = linesByOrder.get(orderId) ?? [];
    const refunds = lines.flatMap((l) => refundsByLine.get(l.orderLineId) ?? []);
    return { net: aggregate(lines, refunds, config).net_sales_ex_tax, refunded: refunds.length > 0 };
  };

  const rows = []; const details = {};
  for (const [k, orders] of byKey) {
    const id = ids.get(k);
    const sorted = [...orders].sort((a, b) => a.orderedAt - b.orderedAt);
    const first = sorted[0]; const last = sorted[sorted.length - 1];
    const c = cur.get(k); const p = prev ? prev.get(k) : null;
    const periodNet = c?.net_sales_ex_tax ?? 0; const periodOrders = c?.order_count ?? 0;
    const prevNet = prev ? (p?.net_sales_ex_tax ?? 0) : null; const prevOrders = prev ? (p?.order_count ?? 0) : null;
    // Evolution only when the previous period has a real base; otherwise a status, never a +infinity.
    let evolution;
    if (!prev) evolution = { status: 'no_previous_window', delta_pct: null };
    else if (prevNet > 0) evolution = { status: periodOrders ? 'compared' : 'no_current_purchase', delta_pct: round4((periodNet - prevNet) / prevNet) };
    else evolution = { status: periodOrders ? 'no_previous_purchase' : 'none', delta_pct: null };
    const recencyDays = Math.floor((now - last.orderedAt) / DAY);
    const history = sorted.map((o) => { const n = orderNet(o.id); const raw = rawOrder.get(o.id); return { date: localDate(o.orderedAt), net_sales_ex_tax: n.net, refunded: n.refunded, channel: raw?.channel_name ?? null, order_index: idxOf(raw), in_period: inWindow(o.orderedAt, win) }; });
    const knownNet = round2(history.reduce((a, o) => a + o.net_sales_ex_tax, 0));
    // Orders before the first KNOWN one, only as stated by the source's trusted order index (never estimated).
    const firstIdx = idxOf(rawOrder.get(first.id));
    const earlier = firstIdx == null ? { status: 'unknown', orders_before: null } : firstIdx === 1 ? { status: 'none', orders_before: 0 } : { status: 'outside_history', orders_before: firstIdx - 1 };

    const row = {
      id, label: `#${id}`,
      active: periodOrders > 0,
      period_status: c ? c.status : null,
      net_sales_ex_tax: periodNet, order_count: periodOrders,
      aov_ex_tax: periodOrders ? round2(periodNet / periodOrders) : null,
      previous_net_sales_ex_tax: prevNet, previous_order_count: prevOrders, evolution,
      known_orders: sorted.length, known_net_sales_ex_tax: knownNet,
      first_order_date: localDate(first.orderedAt), last_order_date: localDate(last.orderedAt),
      recency_days: recencyDays, recency_bucket: recencyBucket(recencyDays),
    };
    rows.push(row);

    // ---- products bought (real order line -> product link; units as recorded, refunded units reported apart) ----
    const byProduct = new Map();
    for (const o of sorted) for (const l of linesByOrder.get(o.id) ?? []) {
      const pk = productKeyOf(l);
      if (!byProduct.has(pk)) { const prod = ledger.productById.get(l.productId); byProduct.set(pk, { title: prod?.title ?? l.title ?? null, image_url: prod?.image_url ?? null, matched: Boolean(prod), units: 0, refunded_units: 0 }); }
      const g = byProduct.get(pk); g.units += l.qty;
      for (const r of refundsByLine.get(l.orderLineId) ?? []) g.refunded_units += r.qty;
    }
    const products = [...byProduct.values()].filter((x) => x.title).sort((a, b) => b.units - a.units || String(a.title).localeCompare(String(b.title)));

    details[id] = { ...row, earlier_history: earlier, orders: history.reverse(), products };
  }

  // Default order: latest activity first (most recent last known order), then period revenue.
  rows.sort((a, b) => (a.last_order_date < b.last_order_date ? 1 : a.last_order_date > b.last_order_date ? -1 : b.net_sales_ex_tax - a.net_sales_ex_tax || a.id.localeCompare(b.id)));

  // ---- history scope: coverage of identified orders over the whole loaded history ----
  const histOrders = ledger.orders.filter((o) => inWindow(o.orderedAt, hist));
  const histIdentified = histOrders.filter((o) => keyOf(o.id)).length;
  const firstOrder = ledger.orders.length ? new Date(Math.min(...ledger.orders.map((o) => o.orderedAt))) : null;
  const history = {
    start: hist.localStart, end: localDate(now),
    first_order_date: firstOrder ? localDate(firstOrder) : null,
    days: firstOrder ? Math.round((now - firstOrder) / DAY) : 0,
    orders: histOrders.length, identified_orders: histIdentified,
    identified_share: histOrders.length ? round4(histIdentified / histOrders.length) : null,
    identified_customers: rows.length,
  };

  // ---- watch: factual situations only ----
  const lapsed = rows.filter((r) => !r.active && r.previous_order_count > 0)
    .sort((a, b) => b.previous_net_sales_ex_tax - a.previous_net_sales_ex_tax || a.id.localeCompare(b.id))
    .map((r) => ({ id: r.id, label: r.label, previous_net_sales_ex_tax: r.previous_net_sales_ex_tax, previous_order_count: r.previous_order_count, last_order_date: r.last_order_date, recency_days: r.recency_days }));
  const bothPeriods = rows.filter((r) => r.evolution.status === 'compared')
    .sort((a, b) => Math.abs(b.evolution.delta_pct) - Math.abs(a.evolution.delta_pct) || a.id.localeCompare(b.id))
    .map((r) => ({ id: r.id, label: r.label, net_sales_ex_tax: r.net_sales_ex_tax, previous_net_sales_ex_tax: r.previous_net_sales_ex_tax, delta_pct: r.evolution.delta_pct }));
  // A customer's "own rhythm" needs observed gaps between their orders. The approved sample gate for time-between-purchases
  // is config.customers.minIntervals; below it nothing is judged. Even above it, Nordla has no approved rule for an
  // "unusually long" gap, so this block only ever reports the evidence available.
  const intervals = rows.reduce((a, r) => a + Math.max(0, r.known_orders - 1), 0);
  const ownRhythm = { status: intervals < config.customers.minIntervals ? 'insufficient' : 'no_approved_rule', intervals, required_intervals: config.customers.minIntervals };

  const top = [...rows].filter((r) => r.active).sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax || b.order_count - a.order_count || a.id.localeCompare(b.id)).slice(0, 5)
    .map((r) => ({ id: r.id, label: r.label, net_sales_ex_tax: r.net_sales_ex_tax, order_count: r.order_count, last_order_date: r.last_order_date }));

  const recency = Object.fromEntries(RECENCY_BUCKETS.map((b) => [b.key, rows.filter((r) => r.recency_bucket === b.key).length]));

  return {
    period: { start: win.localStart, end: win.localEnd, previous_start: prevWin?.localStart ?? null, previous_end: prevWin?.localEnd ?? null },
    history, list: rows, top, recency,
    watch: { lapsed, both_periods: bothPeriods, own_rhythm: ownRhythm },
    details,
  };
}
