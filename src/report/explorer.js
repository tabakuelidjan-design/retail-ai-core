// Explorer page data (Analytics Premium). Pure and deterministic: same rows + same `now` => same output.
// Everything is derived from the same ledger/aggregate functions as the rest of the report; nothing is estimated.
//
// Honesty rules baked in here (the UI only renders what this returns):
//  - Comparisons exist only when the immediately preceding window has data (previous > 0); otherwise the delta is null.
//  - Customers are PSEUDONYMOUS (orders.customer_key, a keyed hash). No name, email or phone is ever stored, so a
//    customer can only be labelled "#A1B2". Anonymous orders (mostly POS) carry no key and are excluded from
//    customer metrics - the share of orders that ARE identified is reported as `identified_share`.
//  - Categories are the catalogue's own `product_type`; an empty type is reported as name = null ("uncategorised").

import { aggregate, aggregateShipping, computeSalesMetrics, windowFacts } from '../metrics/sales.js';
import { buildProductPerformance, productKeyOf } from '../metrics/products.js';
import { buildDayBuckets, inWindow, comparisonCoverage, previousEquivalentWindow } from '../metrics/windows.js';

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
const pct = (now, before) => (before > 0 ? round4((now - before) / before) : null);
const DAY = 86400000;

function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - back * DAY).toISOString().slice(0, 10);
}

/** Weekly buckets summed from the real daily series (Monday-based weeks; `days` = how many days of that week are in the window). */
export function weeklySeries(daily) {
  const weeks = new Map();
  for (const d of daily) {
    const k = mondayOf(d.date);
    if (!weeks.has(k)) weeks.set(k, { week_start: k, days: 0, net_sales_ex_tax: 0, order_count: 0 });
    const w = weeks.get(k);
    w.days += 1; w.net_sales_ex_tax += d.net_sales_ex_tax ?? 0; w.order_count += d.order_count ?? 0;
  }
  return [...weeks.values()].map((w) => ({ ...w, net_sales_ex_tax: round2(w.net_sales_ex_tax) }));
}

export function buildExplorer({ ledger, data, windows, now, config, dailySeries, timeZone }) {
  const win = windows.last_30_days;
  const prevWin = previousEquivalentWindow(win);
  const createdAtOf = (key) => createdAtByProduct.get(key) ?? null;
  const createdAtByProduct = new Map(data.products.map((p) => [p.id, p.source_created_at ?? null]));
  const typeOfProduct = new Map(data.products.map((p) => [p.id, (p.product_type ?? '').trim() || null]));
  const rawOrder = new Map(data.orders.map((o) => [o.id, o]));
  const lineById = new Map(ledger.lineFacts.map((l) => [l.orderLineId, l]));

  function summarize(window) {
    const { orders, lines, refunds } = windowFacts(ledger, window);
    const total = aggregate(lines, refunds, config);
    const keyOfOrder = (id) => rawOrder.get(id)?.customer_key ?? null;
    const identified = orders.filter((o) => keyOfOrder(o.id));
    const customers = new Map();
    const slot = (k) => { if (!customers.has(k)) customers.set(k, { orders: new Set(), meta: [], lines: [], refunds: [] }); return customers.get(k); };
    for (const o of identified) {
      const raw = rawOrder.get(o.id); const c = slot(keyOfOrder(o.id));
      c.orders.add(o.id);
      // The order index is only trusted when the source marks the customer journey as ready (same rule as customers/facts.js).
      c.meta.push({ id: o.id, at: o.orderedAt, idx: raw.journey_ready === true && Number.isFinite(Number(raw.customer_order_index)) ? Number(raw.customer_order_index) : null });
    }
    for (const l of lines) { const k = keyOfOrder(l.orderId); if (k) slot(k).lines.push(l); }
    for (const r of refunds) { const l = lineById.get(r.orderLineId); const k = l ? keyOfOrder(l.orderId) : null; if (k) slot(k).refunds.push(r); }
    return { orders, lines, refunds, total, customers, identifiedOrderCount: identified.length };
  }

  const cur = summarize(win);
  const prev = prevWin ? summarize(prevWin) : null;

  // Shipping is reported beside the product KPIs, never folded into them (product KPIs intentionally represent product lines only).
  const curFacts = windowFacts(ledger, win);
  const shipping = aggregateShipping(curFacts.shipping, curFacts.shippingRefunds);
  const shippingUncaptured = ledger.shippingCoverage?.uncaptured ? cur.orders.length - curFacts.shipping.length : 0;

  const kpis = {
    net_sales_ex_tax: cur.total.net_sales_ex_tax,
    shipping: { ...shipping, orders_without_shipping_data: shippingUncaptured, coverage: shippingUncaptured > 0 ? 'PARTIAL' : 'COMPLETE' },
    total_net_sales_ex_tax_with_shipping: round2(cur.total.net_sales_ex_tax + shipping.net_ex_tax_after_refunds),
    order_count: cur.orders.length,
    units_sold: cur.total.units_sold,
    aov_ex_tax: cur.orders.length ? round2(cur.total.net_sales_ex_tax / cur.orders.length) : null,
    active_customers: cur.customers.size,
    identified_orders: cur.identifiedOrderCount,
    identified_share: cur.orders.length ? round4(cur.identifiedOrderCount / cur.orders.length) : null,
    previous: prev ? { net_sales_ex_tax: prev.total.net_sales_ex_tax, order_count: prev.orders.length, units_sold: prev.total.units_sold, aov_ex_tax: prev.orders.length ? round2(prev.total.net_sales_ex_tax / prev.orders.length) : null, active_customers: prev.customers.size } : null,
  };
  kpis.delta = prev ? {
    net_sales_ex_tax_pct: pct(kpis.net_sales_ex_tax, kpis.previous.net_sales_ex_tax),
    order_count_pct: pct(kpis.order_count, kpis.previous.order_count),
    units_sold_pct: pct(kpis.units_sold, kpis.previous.units_sold),
    aov_ex_tax_pct: kpis.aov_ex_tax != null && kpis.previous.aov_ex_tax != null ? pct(kpis.aov_ex_tax, kpis.previous.aov_ex_tax) : null,
    // Identified customers only (see identified_share): the comparison is the plain period-over-period change,
    // and is unavailable (null) when the previous period has no identified customer to compare with.
    active_customers_pct: pct(kpis.active_customers, kpis.previous.active_customers),
  } : null;

  // ---- categories (catalogue product_type) ----
  const byType = new Map();
  const typeOf = (productId) => (productId ? typeOfProduct.get(productId) ?? null : null);
  const group = (t) => { if (!byType.has(t)) byType.set(t, { lines: [], refunds: [] }); return byType.get(t); };
  for (const l of cur.lines) group(typeOf(l.productId)).lines.push(l);
  for (const r of cur.refunds) group(typeOf(r.productId)).refunds.push(r);
  const catRows = [...byType.entries()]
    .map(([name, g]) => { const a = aggregate(g.lines, g.refunds, config); return { name, net_sales_ex_tax: a.net_sales_ex_tax, units_sold: a.units_sold }; })
    .filter((c) => c.net_sales_ex_tax > 0)
    .sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax);
  const catTotal = catRows.reduce((s, c) => s + c.net_sales_ex_tax, 0);
  const categories = catRows.map((c) => ({ ...c, share: catTotal > 0 ? round4(c.net_sales_ex_tax / catTotal) : null }));

  // ---- top products (with the real previous-window revenue for the evolution) ----
  const curRows = buildProductPerformance(ledger, win, now).filter((r) => r.units_sold > 0);
  let _prevRowsAll = null;
  const prevRowsAll = () => { if (!_prevRowsAll) _prevRowsAll = buildProductPerformance(ledger, prevWin, now); return _prevRowsAll; };
  const prevByKey = prev ? new Map(prevRowsAll().map((r) => [r.product_key, r.net_sales_ex_tax])) : null;
  const top_products = curRows.sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax).slice(0, 5).map((r) => {
    const before = prevByKey ? prevByKey.get(r.product_key) ?? 0 : null;
    return { product_key: r.product_key, title: r.title, image_url: r.image_url, units_sold: r.units_sold, net_sales_ex_tax: r.net_sales_ex_tax, previous_net_sales_ex_tax: before, delta_pct: before != null ? pct(r.net_sales_ex_tax, before) : null };
  });

  // ---- top customers (pseudonymous labels only) ----
  const customerRows = [...cur.customers.entries()].map(([key, c]) => {
    const a = aggregate(c.lines, c.refunds, config);
    return { label: `#${key.slice(0, 4).toUpperCase()}`, net_sales_ex_tax: a.net_sales_ex_tax, order_count: c.orders.size };
  }).sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax || b.order_count - a.order_count).slice(0, 5);
  const top_customers = { status: cur.customers.size ? 'OK' : 'UNAVAILABLE', identified_share: kpis.identified_share, rows: customerRows };

  const daily = (dailySeries ?? []).map((d) => ({ date: d.date, net_sales_ex_tax: d.net_sales_ex_tax, order_count: d.order_count }));

  // ---- period comparison: the previous 30 days, day by day, aligned by position (day 1 of each period, day 2, ...) ----
  // Blocks of 7 days from the start of each period keep the chart readable; the last block may be shorter (`days`).
  let comparison = null;
  if (prev && timeZone) {
    const buckets = buildDayBuckets(now, timeZone, 60);
    const prevDays = buckets.slice(0, 30).map((b) => { const m = computeSalesMetrics(ledger, b); return { date: b.localStart, net_sales_ex_tax: m.net_sales_ex_tax, order_count: m.order_count }; });
    if (prevDays.length === daily.length && daily.length) {
      const blocks = [];
      for (let i = 0; i < daily.length; i += 7) {
        const c = daily.slice(i, i + 7); const p = prevDays.slice(i, i + 7);
        blocks.push({ start_date: c[0].date, end_date: c[c.length - 1].date, previous_start_date: p[0].date, days: c.length,
          current_net_sales_ex_tax: round2(c.reduce((a, d) => a + d.net_sales_ex_tax, 0)), previous_net_sales_ex_tax: round2(p.reduce((a, d) => a + d.net_sales_ex_tax, 0)),
          current_order_count: c.reduce((a, d) => a + d.order_count, 0), previous_order_count: p.reduce((a, d) => a + d.order_count, 0) });
      }
      comparison = { blocks };
    }
  }

  // ---- contribution to the revenue change, per product: only meaningful when the previous period had sales ----
  let contributions = null;
  if (prev && kpis.previous.net_sales_ex_tax > 0) {
    const allCur = new Map(curRows.map((r) => [r.product_key, r]));
    const prevList = prevRowsAll();
    const keys = new Set([...allCur.keys(), ...prevList.map((r) => r.product_key)]);
    const prevMap = new Map(prevList.map((r) => [r.product_key, r]));
    const movers = [...keys].map((k) => {
      const c = allCur.get(k); const p = prevMap.get(k);
      const title = c?.title ?? p?.title; const now_ = c?.net_sales_ex_tax ?? 0; const before = p?.net_sales_ex_tax ?? 0;
      return { product_key: k, title, delta: round2(now_ - before) };
    }).filter((m) => m.delta !== 0 && m.title);
    contributions = {
      total_delta: round2(kpis.net_sales_ex_tax - kpis.previous.net_sales_ex_tax),
      positive: movers.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 4),
      negative: movers.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 4),
    };
  }

  // ---- strongest / weakest day (real daily series). The weakest is taken among days WITH sales; days without any sale are counted apart. ----
  const dayRows = daily.filter((d) => d.net_sales_ex_tax != null);
  const withSales = dayRows.filter((d) => d.order_count > 0);
  const pick = (arr, better) => arr.reduce((best, d) => (best == null || better(d, best) ? d : best), null);
  const days = {
    best: pick(withSales, (d, b) => d.net_sales_ex_tax > b.net_sales_ex_tax),
    weakest: pick(withSales, (d, b) => d.net_sales_ex_tax < b.net_sales_ex_tax),
    days_without_sales: dayRows.filter((d) => d.order_count === 0).length,
    days_total: dayRows.length,
  };

  // ---- sales by channel: the source's own channel name on each order (never assumed); a missing name is reported as null ----
  const byChannel = new Map();
  for (const l of cur.lines) { const ch = rawOrder.get(l.orderId)?.channel_name ?? null; if (!byChannel.has(ch)) byChannel.set(ch, { lines: [], refunds: [], orders: new Set() }); byChannel.get(ch).lines.push(l); byChannel.get(ch).orders.add(l.orderId); }
  for (const r of cur.refunds) { const ln = lineById.get(r.orderLineId); const ch = ln ? rawOrder.get(ln.orderId)?.channel_name ?? null : null; if (byChannel.has(ch)) byChannel.get(ch).refunds.push(r); }
  const chRows = [...byChannel.entries()].map(([name, g]) => ({ name, net_sales_ex_tax: aggregate(g.lines, g.refunds, config).net_sales_ex_tax, order_count: g.orders.size })).filter((c) => c.net_sales_ex_tax > 0).sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax);
  const chTotal = chRows.reduce((a, c) => a + c.net_sales_ex_tax, 0);
  const channels = chRows.map((c) => ({ ...c, share: chTotal > 0 ? round4(c.net_sales_ex_tax / chTotal) : null }));

  const channelsBlock = buildChannelsBlock({ ledger, data, windows, now, config, timeZone, win, prevWin, rawOrder, lineById });
  const customersBlock = buildCustomersBlock({ ledger, data, windows, now, config, timeZone, cur, prev, win, prevWin, rawOrder });
  const products = buildProductsBlock({ cur, prev, curRows, prevRows: prev ? prevRowsAll() : null, win, typeOfProduct, createdAtOf, kpis, categories });
  return { kpis, series: { daily, weekly: weeklySeries(daily) }, comparison, contributions, days, channels, categories, top_products, top_customers, products, customers: customersBlock, channels_view: channelsBlock, geo_view: buildGeoBlock({ ledger, data, windows, win, rawOrder }), period_view: buildPeriodBlock({ ledger, config, win, daily, timeZone, rawOrder, lineById }),
    comparison_view: buildComparisonBlock({ ledger, config, now, timeZone, cur, prev, kpis, daily, comparison, typeOf, products, customers: customersBlock }),
    comparison_coverage: comparisonCoverage(win) };
}

/**
 * Products tab (Explorer). Product identity is the catalogue product id (so a renamed product keeps its history);
 * the shown title/image are the CURRENT ones, or the previous-period ones for a product that no longer sold.
 * Status of a product's evolution:
 *   compared          previous-period revenue > 0            -> real % change
 *   new               no previous revenue AND the product was created inside the current window -> "new in the period"
 *   not_sold_before   no previous revenue but the product already existed  -> no % (never +infinity)
 *   no_previous       there is no previous window at all
 */
/** Explorer's evolution status of a product SOLD in the current window (see the list above). `before` = previous-window
 * revenue (null when there is no previous window). Exported so the main Produits workspace applies the same rule. */
export function productEvolutionStatus(before, createdAt, windowStart) {
  if (before == null) return 'no_previous';
  if (before > 0) return 'compared';
  return createdAt && new Date(createdAt) >= windowStart ? 'new' : 'not_sold_before';
}

function buildProductsBlock({ cur, prev, curRows, prevRows, win, typeOfProduct, createdAtOf, kpis, categories }) {
  const prevByKey = prevRows ? new Map(prevRows.map((r) => [r.product_key, r])) : null;
  const sorted = [...curRows].sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax);
  const totalRevenue = sorted.reduce((a, r) => a + r.net_sales_ex_tax, 0);
  const totalUnits = sorted.reduce((a, r) => a + r.units_sold, 0);
  const statusOf = (r, before) => productEvolutionStatus(prevByKey ? before : null, createdAtOf(r.product_key), win.start);
  const evo = (r) => {
    const p = prevByKey ? prevByKey.get(r.product_key) : null;
    const before = prevByKey ? p?.net_sales_ex_tax ?? 0 : null;
    return { previous_net_sales_ex_tax: before, previous_units_sold: p?.units_sold ?? (prevByKey ? 0 : null), delta: before != null ? round2(r.net_sales_ex_tax - before) : null, delta_pct: before != null && before > 0 ? pct(r.net_sales_ex_tax, before) : null, status: statusOf(r, before) };
  };
  const base = (r) => ({ product_key: r.product_key, title: r.title, matched: r.matched, image_url: r.image_url, units_sold: r.units_sold, net_sales_ex_tax: r.net_sales_ex_tax });

  const ranking = sorted.slice(0, 10).map((r, i) => ({ rank: i + 1, ...base(r), share: totalRevenue > 0 ? round4(r.net_sales_ex_tax / totalRevenue) : null, units_share: totalUnits > 0 ? round4(r.units_sold / totalUnits) : null, ...evo(r) }));

  // Growth / decline: only products whose previous-period revenue is > 0 (a real base to compare with).
  // A product that sold before and not now is a decline of -100 %; its title/image come from the previous period.
  let growth = []; let decline = [];
  if (prevByKey) {
    const curByKey = new Map(sorted.map((r) => [r.product_key, r]));
    const keys = new Set([...curByKey.keys(), ...[...prevByKey.entries()].filter(([, r]) => r.net_sales_ex_tax > 0).map(([k]) => k)]);
    const movers = [];
    for (const k of keys) {
      const c = curByKey.get(k); const p = prevByKey.get(k);
      const before = p?.net_sales_ex_tax ?? 0;
      if (before <= 0) continue;
      const now_ = c?.net_sales_ex_tax ?? 0; const src = c ?? p;
      movers.push({ product_key: k, title: src.title, matched: src.matched, image_url: src.image_url, net_sales_ex_tax: now_, previous_net_sales_ex_tax: before, delta: round2(now_ - before), delta_pct: pct(now_, before) });
    }
    growth = movers.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 4);
    decline = movers.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 4);
  }

  const shareOfTop = (n) => (totalRevenue > 0 && sorted.length ? round4(sorted.slice(0, n).reduce((a, r) => a + r.net_sales_ex_tax, 0) / totalRevenue) : null);
  const concentration = { top1: shareOfTop(1), top3: shareOfTop(3), top5: shareOfTop(5), products_sold: sorted.length };

  // Units vs revenue: union of the 3 best sellers by revenue and by units (max 6), shares of the period totals.
  const byUnits = [...sorted].sort((a, b) => b.units_sold - a.units_sold || b.net_sales_ex_tax - a.net_sales_ex_tax);
  const rankOf = new Map(sorted.map((r, i) => [r.product_key, i + 1]));
  const picked = new Map();
  for (const r of [...sorted.slice(0, 3), ...byUnits.slice(0, 3)]) picked.set(r.product_key, r);
  const units_vs_revenue = [...picked.values()].sort((a, b) => rankOf.get(a.product_key) - rankOf.get(b.product_key))
    .map((r) => ({ rank: rankOf.get(r.product_key), ...base(r), units_share: totalUnits > 0 ? round4(r.units_sold / totalUnits) : null, revenue_share: totalRevenue > 0 ? round4(r.net_sales_ex_tax / totalRevenue) : null }));

  // Margin: never ranked per product here. Only the honest coverage figures of the period are exposed.
  const margin = { available: false, cost_coverage_pct: cur.total.cost_coverage_pct ?? null, verified_cost_coverage_pct: cur.total.verified_cost_coverage_pct ?? null };

  const topCategory = categories[0] ?? null;
  return { total_revenue: round2(totalRevenue), total_units: totalUnits, top_revenue_product: ranking[0] ?? null, top_category: topCategory, ranking, growth, decline, concentration, units_vs_revenue, margin };
}


/**
 * Clients tab (Explorer). Everything here is about IDENTIFIED customers only (orders carrying a pseudonymous
 * customer_key); anonymous orders (mostly POS) are never attributed to anyone, and the share of identified orders is
 * always exposed (`coverage`).
 *
 * Definitions (no threshold is invented here):
 *  - active customer     identified customer with >= 1 order in the window
 *  - new customer        active customer with an order in the window whose recorded customer order index is 1
 *                        (their first order in the source's customer history) - index only trusted when journey_ready
 *  - returning customer  active customer, not new, with an order whose index is > 1, or with 2+ orders in the window
 *  - unknown             active customer whose order index is not available (counted apart, never guessed)
 *  - customer revenue    net sales ex tax of the customer's window orders (product lines minus refunds), via aggregate()
 *  - orders per customer window orders / customers ; basket per customer = customer revenue / customer orders
 * Sample gate: averages / medians use the EXISTING approved gate config.customers.minCustomers (identified customers);
 * below it they are null with a reason. Counts are facts and are never gated.
 * Dormancy: NOT defined in Nordla, so no "dormant" metric. Only factual recency buckets (days since last known order).
 * Cohorts: not built - see `cohort` (history shorter than config.customers.shortHistoryDays, few repeat buyers).
 */
/** The Clients-tab status rule, over a customer's orders IN ONE WINDOW (`meta` = [{ idx }], idx = trusted order index or null).
 * Exported so the main Clients workspace (customers-workspace.js) applies exactly the same definition. */
export function classifyCustomerOrders(meta) {
  if (meta.some((m) => m.idx === 1)) return 'new';
  if (meta.some((m) => m.idx != null && m.idx > 1) || meta.length >= 2) return 'returning';
  return 'unknown';
}

function buildCustomersBlock({ ledger, data, windows, now, config, timeZone, cur, prev, win, prevWin, rawOrder }) {
  const c = config.customers;
  const classify = (cust) => classifyCustomerOrders(cust.meta);
  const mean = (arr) => (arr.length ? round2(arr.reduce((a, x) => a + x, 0) / arr.length) : null);
  const median = (arr) => { if (!arr.length) return null; const x = [...arr].sort((a, b) => a - b); const m = x.length >> 1; return round2(x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2); };

  function segments(sum) {
    const list = [...sum.customers.entries()].map(([key, cust]) => ({ key, cust, type: classify(cust) }));
    const group = (type) => {
      const rows = list.filter((x) => x.type === type);
      const lines = rows.flatMap((x) => x.cust.lines); const refunds = rows.flatMap((x) => x.cust.refunds);
      return { customers: rows.length, orders: rows.reduce((a, x) => a + x.cust.orders.size, 0), net_sales_ex_tax: aggregate(lines, refunds, config).net_sales_ex_tax };
    };
    const allLines = list.flatMap((x) => x.cust.lines); const allRefunds = list.flatMap((x) => x.cust.refunds);
    return {
      active: list.length,
      identified_orders: sum.identifiedOrderCount,
      order_count: sum.orders.length,
      identified_share: sum.orders.length ? round4(sum.identifiedOrderCount / sum.orders.length) : null,
      identified_net_sales_ex_tax: aggregate(allLines, allRefunds, config).net_sales_ex_tax,
      new: group('new'), returning: group('returning'), unknown: group('unknown'), list,
    };
  }
  const curSeg = segments(cur);
  const prevSeg = prev ? segments(prev) : null;

  const strip = (g) => ({ customers: g.customers, orders: g.orders, net_sales_ex_tax: g.net_sales_ex_tax });
  const previous = prevSeg ? { active: prevSeg.active, new: prevSeg.new.customers, returning: prevSeg.returning.customers, identified_net_sales_ex_tax: prevSeg.identified_net_sales_ex_tax, identified_share: prevSeg.identified_share } : null;
  const delta = previous ? {
    active_pct: pct(curSeg.active, previous.active), new_pct: pct(curSeg.new.customers, previous.new),
    returning_pct: pct(curSeg.returning.customers, previous.returning), identified_net_sales_ex_tax_pct: pct(curSeg.identified_net_sales_ex_tax, previous.identified_net_sales_ex_tax),
  } : null;

  const customerRows = curSeg.list.map((x) => {
    const a = aggregate(x.cust.lines, x.cust.refunds, config);
    const last = x.cust.meta.reduce((m, o) => (o.at > m ? o.at : m), x.cust.meta[0].at);
    return { label: `#${x.key.slice(0, 4).toUpperCase()}`, type: x.type, net_sales_ex_tax: a.net_sales_ex_tax, order_count: x.cust.orders.size, last_order_date: last.toISOString().slice(0, 10) };
  });
  const top = [...customerRows].sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax || b.order_count - a.order_count).slice(0, 5)
    .map((r) => ({ ...r, aov_ex_tax: r.order_count ? round2(r.net_sales_ex_tax / r.order_count) : null }));

  // ---- purchase frequency (window orders per identified customer) ----
  const dist = { one: 0, two: 0, three_plus: 0 };
  for (const r of customerRows) { if (r.order_count === 1) dist.one += 1; else if (r.order_count === 2) dist.two += 1; else dist.three_plus += 1; }

  // ---- customer value: averages need the approved sample gate ----
  const gated = curSeg.active < c.minCustomers;
  const value = {
    gated, min_customers: c.minCustomers, identified_customers: curSeg.active,
    avg_revenue_per_customer: gated ? null : mean(customerRows.map((r) => r.net_sales_ex_tax)),
    median_revenue_per_customer: gated ? null : median(customerRows.map((r) => r.net_sales_ex_tax)),
    avg_orders_per_customer: gated ? null : mean(customerRows.map((r) => r.order_count)),
    avg_basket_ex_tax: gated || !curSeg.identified_orders ? null : round2(curSeg.identified_net_sales_ex_tax / curSeg.identified_orders),
  };

  // ---- recency of the last known order (factual buckets over ALL identified customers in the available history) ----
  const lastByKey = new Map();
  for (const o of ledger.orders) {
    const k = rawOrder.get(o.id)?.customer_key; if (!k) continue;
    if (!lastByKey.has(k) || o.orderedAt > lastByKey.get(k)) lastByKey.set(k, o.orderedAt);
  }
  const rec = { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const at of lastByKey.values()) { const d = Math.floor((now - at) / DAY); if (d <= 30) rec.d0_30 += 1; else if (d <= 60) rec.d31_60 += 1; else if (d <= 90) rec.d61_90 += 1; else rec.d90_plus += 1; }
  const firstOrder = ledger.orders.length ? new Date(Math.min(...ledger.orders.map((o) => o.orderedAt))) : null;
  const historyDays = firstOrder ? Math.round((now - firstOrder) / DAY) : 0;
  const recency = { identified_customers: lastByKey.size, buckets: rec, history_days: historyDays, dormant_defined: false };

  // ---- weekly trend of identified customers over the current window (from the real day buckets) ----
  const dayBuckets = buildDayBuckets(now, timeZone, 30);
  const weeks = new Map();
  for (const b of dayBuckets) {
    const wk = mondayOf(b.localStart);
    if (!weeks.has(wk)) weeks.set(wk, { week_start: wk, days: 0, active: new Set(), fresh: new Set() });
    const w = weeks.get(wk); w.days += 1;
    for (const x of curSeg.list) for (const m of x.cust.meta) if (inWindow(m.at, b)) { w.active.add(x.key); if (m.idx === 1) w.fresh.add(x.key); }
  }
  const weekly = [...weeks.values()].map((w) => ({ week_start: w.week_start, days: w.days, active: w.active.size, new: w.fresh.size }));

  const cohort = {
    available: false,
    reasons: [...(historyDays < c.shortHistoryDays ? ['SHORT_HISTORY'] : []), ...(customerRows.filter((r) => r.type === 'returning').length < c.minCustomers ? ['TOO_FEW_RETURNING_CUSTOMERS'] : []), 'NO_APPROVED_COHORT_DEFINITION'],
    history_days: historyDays, required_history_days: c.shortHistoryDays,
  };

  return {
    coverage: { identified_orders: curSeg.identified_orders, orders: curSeg.order_count, identified_share: curSeg.identified_share, previous_identified_share: previous?.identified_share ?? null },
    kpis: { active: curSeg.active, new: curSeg.new.customers, returning: curSeg.returning.customers, unknown: curSeg.unknown.customers, identified_net_sales_ex_tax: curSeg.identified_net_sales_ex_tax, previous, delta },
    segments: { new: strip(curSeg.new), returning: strip(curSeg.returning), unknown: strip(curSeg.unknown) },
    top, frequency: dist, value, recency, weekly, cohort,
  };
}


/**
 * Channels tab (Explorer). A channel is the source's own `orders.channel_name`, unchanged (e.g. "Point of Sale",
 * "Online Store"); a missing name is reported as name = null. Nothing is renamed, merged or inferred here - only the
 * UI translates the DISPLAY label. Revenue = net sales ex tax (lines minus refunds) of the channel's orders.
 * Comparison with the previous 30 days:
 *   compared  previous revenue > 0        -> real % change
 *   new       no previous revenue, sales now   -> "new in the period" (no percentage, never +infinity)
 *   absent    previous revenue > 0, no sales now -> "no sales in the period"
 * Products and customers by channel come from the real order -> channel link (each order line/customer key belongs to one order).
 */
// ---- Période tab: temporal statistics over the current 30-day window ----
// Everything derives from the real daily series (which already includes days without sales, as zeros) and from the
// real order timestamps. No smoothing, no score: plain arithmetic (mean, median, population standard deviation).
const TIME_BUCKETS = [
  { key: 'night', from: 0, to: 6 },      // 00:00-05:59
  { key: 'morning', from: 6, to: 12 },   // 06:00-11:59
  { key: 'midday', from: 12, to: 14 },   // 12:00-13:59
  { key: 'afternoon', from: 14, to: 18 }, // 14:00-17:59
  { key: 'evening', from: 18, to: 24 },  // 18:00-23:59
];

function localHour(date, timeZone) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || 'UTC', hour: '2-digit', hourCycle: 'h23' }).format(date));
}

function buildPeriodBlock({ ledger, config, win, daily, timeZone, rawOrder, lineById }) {
  const n = daily.length;
  const values = daily.map((d) => d.net_sales_ex_tax ?? 0);
  const total = values.reduce((a, v) => a + v, 0);

  let stats = null;
  if (n >= 2) {
    const mean = total / n;
    const sorted = [...values].sort((a, b) => a - b);
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / n); // population sd over the days of the window
    stats = {
      days_total: n,
      active_days: daily.filter((d) => d.order_count > 0).length,
      days_without_sales: daily.filter((d) => !(d.order_count > 0)).length,
      mean_daily_net_sales_ex_tax: round2(mean),
      median_daily_net_sales_ex_tax: round2(median),
      std_dev_daily_net_sales_ex_tax: round2(sd),
      coefficient_of_variation: mean > 0 ? round4(sd / mean) : null,
      days_above_mean: values.filter((v) => v > mean).length,
      days_below_mean: values.filter((v) => v < mean).length,
      days_at_mean: values.filter((v) => v === mean).length,
    };
  }

  // Weekday averages are per OCCURRENCE (a weekday that appears 5 times is not compared on raw totals with one that appears 4).
  const weekday = Array.from({ length: 7 }, (_, i) => ({ weekday: i, occurrences: 0, net_sales_ex_tax: 0, order_count: 0 }));
  for (const d of daily) {
    const i = (new Date(`${d.date}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
    weekday[i].occurrences += 1; weekday[i].net_sales_ex_tax += d.net_sales_ex_tax ?? 0; weekday[i].order_count += d.order_count ?? 0;
  }
  const weekdays = weekday.map((w) => ({ ...w, net_sales_ex_tax: round2(w.net_sales_ex_tax), avg_net_sales_ex_tax: w.occurrences ? round2(w.net_sales_ex_tax / w.occurrences) : null, avg_order_count: w.occurrences ? round2(w.order_count / w.occurrences) : null }));

  // Weeks: share of the window's revenue; partial weeks (window edges) are flagged. Best/weakest are taken among
  // COMPLETE weeks with sales only (a 3-day edge week is not comparable) and need at least two of them.
  const weeks = weeklySeries(daily).map((w) => ({ ...w, share: total > 0 ? round4(w.net_sales_ex_tax / total) : null, partial: w.days < 7 }));
  const fullSold = weeks.filter((w) => !w.partial && w.order_count > 0);
  const best_week = fullSold.length >= 2 ? fullSold.reduce((b, w) => (w.net_sales_ex_tax > b.net_sales_ex_tax ? w : b)) : null;
  const weakest_week = fullSold.length >= 2 ? fullSold.reduce((b, w) => (w.net_sales_ex_tax < b.net_sales_ex_tax ? w : b)) : null;

  // Time of day, from the real order timestamps in the merchant's local time zone. Refunds follow their order's bucket.
  const { orders, lines, refunds } = windowFacts(ledger, win);
  const bucketOfOrder = new Map();
  const slots = new Map(TIME_BUCKETS.map((b) => [b.key, { lines: [], refunds: [], orders: 0 }]));
  for (const o of orders) {
    const at = new Date(o.orderedAt);
    if (Number.isNaN(at.getTime())) continue;
    const h = localHour(at, timeZone);
    const b = TIME_BUCKETS.find((x) => h >= x.from && h < x.to);
    if (!b) continue;
    bucketOfOrder.set(o.id, b.key); slots.get(b.key).orders += 1;
  }
  for (const l of lines) { const k = bucketOfOrder.get(l.orderId); if (k) slots.get(k).lines.push(l); }
  for (const r of refunds) { const ln = lineById.get(r.orderLineId); const k = ln ? bucketOfOrder.get(ln.orderId) : null; if (k) slots.get(k).refunds.push(r); }
  const timed = [...bucketOfOrder.keys()].length;
  const time_of_day = {
    time_zone: timeZone || 'UTC',
    timed_orders: timed,
    total_orders: orders.length,
    buckets: TIME_BUCKETS.map((b) => ({ key: b.key, from_hour: b.from, to_hour: b.to, order_count: slots.get(b.key).orders, net_sales_ex_tax: aggregate(slots.get(b.key).lines, slots.get(b.key).refunds, config).net_sales_ex_tax })),
  };

  return { stats, weekdays, weeks, best_week, weakest_week, time_of_day };
}

// ---- Comparaison tab: only the aggregations the other tabs do not already expose ----
// Reused as-is from the other tabs: kpis (+delta), comparison.blocks, contributions, products.growth/decline,
// channels_view, customers. Added here: absolute deltas, the day-index aligned series, the category comparison,
// an ADDITIVE waterfall (category partition: every line/refund belongs to exactly one category, "no category" included)
// and explicit comparability checks.
// No business threshold decides a comparability status here: statuses come from facts (equal day counts, any
// unidentified order, any revenue without category, costs not fully verified). The only limit is presentational:
export const CMP_WATERFALL_MAX_STEPS = 5; // display density only; the remainder is grouped as "other" so the waterfall still reconciles

function buildComparisonBlock({ ledger, config, now, timeZone, cur, prev, kpis, daily, comparison, typeOf, products, customers }) {
  const pv = kpis.previous;
  if (!pv || !timeZone) return null;

  const delta = (c, p) => (c == null || p == null ? null : round2(c - p));
  const kpi = (key, c, p) => ({ key, current: c, previous: p, delta_abs: delta(c, p), delta_pct: c != null && p != null ? pct(c, p) : null });
  const kpiRows = [
    kpi('net_sales_ex_tax', kpis.net_sales_ex_tax, pv.net_sales_ex_tax),
    kpi('order_count', kpis.order_count, pv.order_count),
    kpi('aov_ex_tax', kpis.aov_ex_tax, pv.aov_ex_tax),
    kpi('units_sold', kpis.units_sold, pv.units_sold),
  ];

  // day-index aligned series (Day 1..N of each period; calendar dates are NOT aligned)
  const buckets = buildDayBuckets(now, timeZone, 60);
  const prevBuckets = buckets.slice(0, 30);
  const prevDays = prevBuckets.map((b) => computeSalesMetrics(ledger, b).net_sales_ex_tax);
  const aligned = daily.length === prevDays.length
    ? daily.map((d, i) => ({ index: i + 1, date: d.date, previous_date: prevBuckets[i].localStart, current: d.net_sales_ex_tax ?? 0, previous: prevDays[i] ?? 0 }))
    : null;

  const blocks = comparison ? comparison.blocks.map((b, i) => {
    const pStart = b.previous_start_date; const pEnd = new Date(Date.parse(`${pStart}T00:00:00Z`) + (b.days - 1) * DAY).toISOString().slice(0, 10);
    return { index: i + 1, start_date: b.start_date, end_date: b.end_date, previous_start_date: pStart, previous_end_date: pEnd, days: b.days, partial: b.days < 7, current: b.current_net_sales_ex_tax, previous: b.previous_net_sales_ex_tax };
  }) : null;

  const periods = { current: { start: daily[0]?.date ?? null, end: daily[daily.length - 1]?.date ?? null, days: daily.length }, previous: { start: prevBuckets[0]?.localStart ?? null, end: prevBuckets[prevBuckets.length - 1]?.localStart ?? null, days: prevBuckets.length } };

  // categories (catalogue product_type; null = "no category", kept visible)
  const byCat = (win_) => {
    const m = new Map(); const slot = (k) => { if (!m.has(k)) m.set(k, { lines: [], refunds: [] }); return m.get(k); };
    for (const l of win_.lines) slot(typeOf(l.productId)).lines.push(l);
    for (const r of win_.refunds) slot(typeOf(r.productId)).refunds.push(r);
    return m;
  };
  const cc = byCat(cur); const pc = byCat(prev);
  const names = [...new Set([...cc.keys(), ...pc.keys()])];
  const rev = (m, k) => (m.has(k) ? aggregate(m.get(k).lines, m.get(k).refunds, config).net_sales_ex_tax : 0);
  const categories = names.map((name) => {
    const c = rev(cc, name); const p = rev(pc, name);
    return { name, current: c, previous: p, delta: round2(c - p), delta_pct: p > 0 ? round4((c - p) / p) : null, status: p > 0 && c > 0 ? 'compared' : p === 0 && c > 0 ? 'new' : p > 0 ? 'absent' : 'none' };
  }).filter((r) => r.status !== 'none').sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // additive waterfall over the category partition; any rounding residual goes to the largest step; must reconcile.
  let waterfall = null;
  const moving = categories.filter((r) => r.delta !== 0);
  if (moving.length) {
    const shown = moving.slice(0, CMP_WATERFALL_MAX_STEPS).map((r) => ({ name: r.name, delta: r.delta, other: false }));
    const rest = moving.slice(CMP_WATERFALL_MAX_STEPS);
    if (rest.length) shown.push({ name: null, delta: round2(rest.reduce((a, r) => a + r.delta, 0)), other: true, count: rest.length });
    const residual = round2(kpis.net_sales_ex_tax - pv.net_sales_ex_tax - shown.reduce((a, r) => a + r.delta, 0));
    if (Math.abs(residual) <= 0.02) {
      if (residual !== 0) { const big = shown.reduce((b, r) => (Math.abs(r.delta) > Math.abs(b.delta) ? r : b)); big.delta = round2(big.delta + residual); }
      waterfall = { dimension: 'category', previous_total: pv.net_sales_ex_tax, current_total: kpis.net_sales_ex_tax, steps: shown, reconciles: true };
    }
  }

  // comparability checks (explicit rules only; no overall score)
  const cov = customers?.coverage ?? {}; const covCur = cov.identified_share ?? null; const covPrev = cov.previous_identified_share ?? null;
  const gap = covCur != null && covPrev != null ? round4(Math.abs(covCur - covPrev)) : null;
  const lastBlock = blocks ? blocks[blocks.length - 1] : null;
  const uncat = categories.find((r) => r.name == null);
  const uncatShare = kpis.net_sales_ex_tax > 0 && uncat ? round4(uncat.current / kpis.net_sales_ex_tax) : 0;
  const costCov = products?.margin?.cost_coverage_pct ?? null;
  const checks = [
    { id: 'days', status: periods.current.days === periods.previous.days ? 'comparable' : 'caution', current: periods.current.days, previous: periods.previous.days },
    // Both periods are cut into the same blocks, so a short last block is compared with the same number of days: informational only.
    { id: 'last_block', status: 'comparable', days: lastBlock ? lastBlock.days : null },
    { id: 'customer_coverage', status: gap == null || covCur < 1 || covPrev < 1 ? 'partial' : 'comparable', current: covCur, previous: covPrev, gap },
    { id: 'categories', status: uncatShare > 0 ? 'partial' : 'comparable', uncategorised_share: uncatShare },
    { id: 'costs', status: costCov != null && costCov >= 1 && (products.margin.verified_cost_coverage_pct ?? 0) >= 1 ? 'comparable' : 'partial', cost_coverage: costCov, verified_cost_coverage: products?.margin?.verified_cost_coverage_pct ?? null },
  ];

  return { periods, kpis: kpiRows, blocks, aligned_days: aligned, categories, waterfall, checks };
}

// Geographic audit for the current window. The sync stores no shipping/billing address, so the only geographic
// signal is orders.location_id -> locations.name = the LOCATION OF SALE (a store), never the customer's location.
// A zone (city / postal code / province / country) is only usable when the location itself carries such a field;
// none exists in the schema today, so usable_orders is 0 and the page stays in its "insufficient data" state.
// Only counts per store name are exposed: no order id, no customer key, no address.
// A breakdown needs at least two zones (technical). Any minimum coverage is a business rule that has NOT been approved,
// so it is not applied here: the page reports the coverage and stays in its explanatory state.
function buildGeoBlock({ ledger, data, windows, win, rawOrder }) {
  const { orders } = windowFacts(ledger, win);
  const total = orders.length;
  const locById = new Map((data.locations ?? []).map((l) => [l.id, l]));
  const saleByName = new Map();
  let withLocation = 0; let usable = 0;
  const zones = new Set();
  for (const o of orders) {
    const loc = locById.get(rawOrder.get(o.id)?.location_id);
    if (!loc) continue;
    withLocation += 1;
    saleByName.set(loc.name, (saleByName.get(loc.name) ?? 0) + 1);
    const zone = loc.city ?? loc.postal_code ?? loc.province ?? loc.country_code ?? null;
    if (zone) { usable += 1; zones.add(zone); }
  }
  const cov = (n) => (total > 0 ? round4(n / total) : null);
  const coverage = cov(usable);
  const status = usable > 0 && zones.size >= 2 ? 'zones_available' : 'insufficient';
  return {
    status,
    total_orders: total,
    usable_orders: usable,
    usable_coverage: coverage,
    orders_with_sale_location: withLocation,
    sale_location_coverage: cov(withLocation),
    sale_locations: [...saleByName.entries()].map(([name, orders_]) => ({ name, orders: orders_ })).sort((a, b) => b.orders - a.orders),
    // fields the pipeline does not hold at all (never fetched from Shopify): reported as absent, not guessed
    absent_fields: ['shipping_city', 'shipping_postal_code', 'shipping_province', 'shipping_country', 'billing_address'],
  };
}

function buildChannelsBlock({ ledger, data, windows, now, config, timeZone, win, prevWin, rawOrder, lineById }) {
  const nameOf = (orderId) => rawOrder.get(orderId)?.channel_name ?? null;
  const summarize = (window) => {
    const { orders, lines, refunds } = windowFacts(ledger, window);
    const by = new Map();
    const slot = (ch) => { if (!by.has(ch)) by.set(ch, { orders: [], lines: [], refunds: [] }); return by.get(ch); };
    for (const o of orders) slot(nameOf(o.id)).orders.push(o);
    for (const l of lines) slot(nameOf(l.orderId)).lines.push(l);
    for (const r of refunds) { const ln = lineById.get(r.orderLineId); if (ln) slot(nameOf(ln.orderId)).refunds.push(r); }
    const out = new Map();
    for (const [ch, g] of by) { const a = aggregate(g.lines, g.refunds, config); out.set(ch, { name: ch, net_sales_ex_tax: a.net_sales_ex_tax, order_count: g.orders.length, aov_ex_tax: g.orders.length ? round2(a.net_sales_ex_tax / g.orders.length) : null, orders: g.orders, lines: g.lines, refunds: g.refunds }); }
    return out;
  };
  const cur = summarize(win);
  const prev = prevWin ? summarize(prevWin) : null;
  const names = [...new Set([...cur.keys(), ...(prev ? [...prev.keys()] : [])])];
  const curTotal = [...cur.values()].reduce((a, c) => a + c.net_sales_ex_tax, 0);
  const prevTotal = prev ? [...prev.values()].reduce((a, c) => a + c.net_sales_ex_tax, 0) : null;

  // weekly revenue per channel over the current window (from the real day buckets)
  const dayBuckets = buildDayBuckets(now, timeZone, 30);
  const weekOf = (b) => mondayOf(b.localStart);
  const weekKeys = []; for (const b of dayBuckets) { const w = weekOf(b); if (!weekKeys.includes(w)) weekKeys.push(w); }
  const daysInWeek = (w) => dayBuckets.filter((b) => weekOf(b) === w).length;
  const weeklyOf = (c) => weekKeys.map((w) => {
    const bs = dayBuckets.filter((b) => weekOf(b) === w);
    let net = 0; let n = 0;
    for (const b of bs) {
      const lines = c.lines.filter((l) => inWindow(l.orderedAt, b)); const refunds = c.refunds.filter((r) => inWindow(r.refundedAt, b));
      net += aggregate(lines, refunds, config).net_sales_ex_tax; n += c.orders.filter((o) => inWindow(o.orderedAt, b)).length;
    }
    return { week_start: w, days: daysInWeek(w), net_sales_ex_tax: round2(net), order_count: n };
  });

  // classification of identified customers (same definitions as the Clients tab)
  const classify = (meta) => (meta.some((m) => m.idx === 1) ? 'new' : meta.some((m) => m.idx != null && m.idx > 1) || meta.length >= 2 ? 'returning' : 'unknown');
  const customersOf = (c) => {
    const per = new Map();
    for (const o of c.orders) {
      const raw = rawOrder.get(o.id); const k = raw?.customer_key; if (!k) continue;
      if (!per.has(k)) per.set(k, []);
      per.get(k).push({ idx: raw.journey_ready === true && Number.isFinite(Number(raw.customer_order_index)) ? Number(raw.customer_order_index) : null });
    }
    const types = [...per.values()].map(classify);
    const identifiedOrders = c.orders.filter((o) => rawOrder.get(o.id)?.customer_key).length;
    return { identified_orders: identifiedOrders, identified_share: c.orders.length ? round4(identifiedOrders / c.orders.length) : null, customers: per.size, new: types.filter((x) => x === 'new').length, returning: types.filter((x) => x === 'returning').length, unknown: types.filter((x) => x === 'unknown').length };
  };

  const rows = names.map((name) => {
    const c = cur.get(name) ?? { name, net_sales_ex_tax: 0, order_count: 0, aov_ex_tax: null, orders: [], lines: [], refunds: [] };
    const p = prev ? prev.get(name) ?? { net_sales_ex_tax: 0, order_count: 0, aov_ex_tax: null } : null;
    const status = !p ? 'no_previous' : p.net_sales_ex_tax > 0 ? (c.net_sales_ex_tax > 0 ? 'compared' : 'absent') : (c.net_sales_ex_tax > 0 ? 'new' : 'absent');
    // top products of the channel (real order line -> order -> channel link)
    const byProduct = new Map();
    for (const l of c.lines) { const k = productKeyOf(l); if (!byProduct.has(k)) byProduct.set(k, { lines: [], refunds: [] }); byProduct.get(k).lines.push(l); }
    for (const r of c.refunds) { const k = r.productId ?? (lineById.get(r.orderLineId) ? productKeyOf(lineById.get(r.orderLineId)) : null); if (k && byProduct.has(k)) byProduct.get(k).refunds.push(r); }
    const top_products = [...byProduct.entries()].map(([k, g]) => { const a = aggregate(g.lines, g.refunds, config); const prod = ledger.productById.get(k); return { product_key: k, title: prod?.title ?? g.lines[0]?.title ?? null, matched: Boolean(prod), image_url: prod?.image_url ?? null, units_sold: a.units_sold, net_sales_ex_tax: a.net_sales_ex_tax }; })
      .filter((x) => x.units_sold > 0).sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax).slice(0, 3);
    return {
      name, net_sales_ex_tax: c.net_sales_ex_tax, order_count: c.order_count, aov_ex_tax: c.aov_ex_tax,
      share: curTotal > 0 ? round4(c.net_sales_ex_tax / curTotal) : null,
      previous: p ? { net_sales_ex_tax: p.net_sales_ex_tax, order_count: p.order_count, aov_ex_tax: p.aov_ex_tax, share: prevTotal > 0 ? round4(p.net_sales_ex_tax / prevTotal) : null } : null,
      delta: p ? { net_sales_ex_tax: round2(c.net_sales_ex_tax - p.net_sales_ex_tax), net_sales_ex_tax_pct: pct(c.net_sales_ex_tax, p.net_sales_ex_tax), order_count_pct: pct(c.order_count, p.order_count), aov_ex_tax_pct: c.aov_ex_tax != null && p.aov_ex_tax != null ? pct(c.aov_ex_tax, p.aov_ex_tax) : null } : null,
      status, weekly: weeklyOf(c), top_products, customers: customersOf(c),
    };
  }).sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax || String(a.name).localeCompare(String(b.name)));

  const active = rows.filter((r) => r.net_sales_ex_tax > 0);
  // factual comparison of the average basket between the two biggest channels (descriptive, no judgement)
  const [first, second] = active;
  const aov_gap = first && second && first.aov_ex_tax != null && second.aov_ex_tax != null && first.aov_ex_tax !== second.aov_ex_tax
    ? (first.aov_ex_tax > second.aov_ex_tax ? { higher: first.name, lower: second.name, diff: round2(first.aov_ex_tax - second.aov_ex_tax) } : { higher: second.name, lower: first.name, diff: round2(second.aov_ex_tax - first.aov_ex_tax) })
    : null;
  return {
    total_net_sales_ex_tax: round2(curTotal), previous_total_net_sales_ex_tax: prevTotal == null ? null : round2(prevTotal),
    total_delta: prevTotal == null ? null : round2(curTotal - prevTotal),
    active_channels: active.length, channels: rows, aov_gap,
    weeks: weekKeys.map((w) => ({ week_start: w, days: daysInWeek(w) })),
  };
}
