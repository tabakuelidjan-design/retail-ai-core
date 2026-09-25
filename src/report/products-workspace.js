// Main "Produits" workspace data (Analytics Premium). Pure and deterministic: same rows + same `now` => same output.
// This is the OPERATIONAL product list (what sells now, what changed, what needs a look); the analytical deep dive stays in
// Explorer > Produits (src/report/explorer.js > buildProductsBlock), whose ranking, growth/decline lists, categories and
// concentration the server reuses as-is.
//
// Built only from buildProductPerformance (the same per-product figures as Explorer, every other report block and the
// rankings), windowFacts/aggregate, and Explorer's own evolution rule (productEvolutionStatus). No new business rule.
//
// Scopes, never mixed:
//   current   the locked window (last 30 days)        previous   the 30 days before it
//   history   the loaded order history (available window) - only used for "last known sale" and recent sales
//
// Product statuses (facts only):
//   compared         sold now, previous revenue > 0            -> real % change
//   new              sold now, no previous revenue, product created inside the current window
//   not_sold_before  sold now, no previous revenue, product already existed
//   absent           previous revenue > 0, nothing sold now     -> "Plus de vente sur la période"
//   no_previous      there is no previous window at all
// Flags (independent of the status): uncategorised (catalogue product_type empty), partial (the sold item no longer maps to a
// catalogue product: no stable identity, image or category), negative (refunds exceed sales in the current window).
//
// Deliberately absent: margin per product (cost coverage is partial / unverified), stock, price, and any judgement
// (best seller, weak product, at risk, to delete...).

import { createHash } from 'node:crypto';
import { aggregate, windowFacts } from '../metrics/sales.js';
import { buildProductPerformance, productKeyOf } from '../metrics/products.js';
import { buildDayBuckets, inWindow, localDateString, previousEquivalentWindow } from '../metrics/windows.js';
import { productEvolutionStatus } from './explorer.js';

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
export const RECENT_SALES = 8; // how many of the latest order lines the detail lists
// Display density only (not a business rule): below this many days with a sale in the 30-day window, a daily line is
// mostly zeros with isolated spikes, so the detail lists the real recent sales instead of drawing it.
export const MIN_TREND_SALE_DAYS = 7;

/** Stable lookup id: the catalogue product id, or for an item that no longer maps to the catalogue a short hash of its title. */
export function productIdOf(key) {
  return key.startsWith('unmatched:') ? `u-${createHash('sha256').update(key).digest('hex').slice(0, 10)}` : key;
}

export function buildProductsWorkspace({ ledger, data, windows, now, config, timeZone }) {
  const win = windows.last_30_days;
  const prevWin = previousEquivalentWindow(win);
  const tz = timeZone || win.timeZone || 'UTC';
  const catalogue = new Map(data.products.map((p) => [p.id, p]));
  const rawOrder = new Map(data.orders.map((o) => [o.id, o]));

  const cur = buildProductPerformance(ledger, win, now);
  const prev = prevWin ? buildProductPerformance(ledger, prevWin, now) : null;
  const curByKey = new Map(cur.map((r) => [r.product_key, r]));
  const prevByKey = prev ? new Map(prev.map((r) => [r.product_key, r])) : null;
  const sold = (r) => r && r.units_sold > 0;

  // Same totals as Explorer > Produits: the current revenue of products that sold at least one unit.
  const soldNow = cur.filter(sold);
  const totalRevenue = round2(soldNow.reduce((a, r) => a + r.net_sales_ex_tax, 0));
  const totalUnits = soldNow.reduce((a, r) => a + r.units_sold, 0);
  const prevSold = prev ? prev.filter(sold) : [];
  const prevTotal = prev ? round2(prevSold.reduce((a, r) => a + r.net_sales_ex_tax, 0)) : null;

  // The list: every product that sold now, sold before, or carries current-window refunds.
  const keys = new Set([...soldNow.map((r) => r.product_key), ...prevSold.map((r) => r.product_key), ...cur.filter((r) => r.net_sales_ex_tax < 0).map((r) => r.product_key)]);

  const rows = []; const keyOfId = new Map();
  for (const key of keys) {
    const c = curByKey.get(key); const p = prevByKey ? prevByKey.get(key) : null;
    const src = sold(c) ? c : p ?? c;
    const product = catalogue.get(key) ?? null;
    const now_ = c?.net_sales_ex_tax ?? 0; const units = c?.units_sold ?? 0;
    const before = prevByKey ? (p?.net_sales_ex_tax ?? 0) : null;
    let status;
    if (sold(c)) status = productEvolutionStatus(before, product?.source_created_at ?? null, win.start);
    else status = before != null && before > 0 ? 'absent' : 'no_previous';
    const delta = before != null ? round2(now_ - before) : null;
    const lastSale = c?.last_sale_at ?? p?.last_sale_at ?? null;
    keyOfId.set(productIdOf(key), key);
    rows.push({
      id: productIdOf(key),
      title: src.title,
      handle: product?.handle ?? null,
      image_url: src.image_url ?? null,
      matched: src.matched,
      category: product ? ((product.product_type ?? '').trim() || null) : null,
      net_sales_ex_tax: now_, units_sold: units,
      share: totalRevenue > 0 && sold(c) ? round4(now_ / totalRevenue) : null,
      previous_net_sales_ex_tax: before, previous_units_sold: prevByKey ? (p?.units_sold ?? 0) : null,
      delta, delta_pct: before != null && before > 0 ? round4((now_ - before) / before) : null,
      direction: delta == null || !(before > 0) ? null : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
      status,
      flags: { uncategorised: Boolean(product) && !((product.product_type ?? '').trim()), partial: !src.matched, negative: now_ < 0 },
      last_sale_date: lastSale ? localDateString(new Date(lastSale), tz) : null,
      days_since_last_sale: c?.days_since_last_sale ?? p?.days_since_last_sale ?? null,
    });
  }
  rows.sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax || b.units_sold - a.units_sold || (b.previous_net_sales_ex_tax ?? 0) - (a.previous_net_sales_ex_tax ?? 0) || String(a.title).localeCompare(String(b.title)));

  // ---- KPIs (the current value + a real previous value only where the same measure exists for both windows) ----
  const top = rows.find((r) => r.units_sold > 0) ?? null;
  const shareOfTop = (list, total, n) => (total > 0 && list.length ? round4([...list].sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax).slice(0, n).reduce((a, r) => a + r.net_sales_ex_tax, 0) / total) : null);
  const kpis = {
    products_sold: soldNow.length,
    previous_products_sold: prev ? prevSold.length : null,
    products_sold_pct: prev && prevSold.length > 0 ? round4((soldNow.length - prevSold.length) / prevSold.length) : null,
    top_product: top ? { id: top.id, title: top.title, matched: top.matched, image_url: top.image_url, net_sales_ex_tax: top.net_sales_ex_tax, share: top.share, status: top.status, delta_pct: top.delta_pct } : null,
    // Concentration, not performance: the previous value is shown for context in percentage points, never coloured.
    top3_share: shareOfTop(soldNow, totalRevenue, 3),
    previous_top3_share: prev ? shareOfTop(prevSold, prevTotal, 3) : null,
    declining: rows.filter((r) => r.direction === 'down').length,
    declining_absent: rows.filter((r) => r.status === 'absent').length,
    comparison_available: Boolean(prev),
  };

  // ---- watch: factual situations only ----
  const pick = (r) => ({ id: r.id, title: r.title, matched: r.matched, image_url: r.image_url, net_sales_ex_tax: r.net_sales_ex_tax, previous_net_sales_ex_tax: r.previous_net_sales_ex_tax, delta: r.delta, last_sale_date: r.last_sale_date });
  const partialRevenue = round2(rows.filter((r) => r.flags.partial && r.units_sold > 0).reduce((a, r) => a + r.net_sales_ex_tax, 0));
  const uncatRevenue = round2(rows.filter((r) => r.flags.uncategorised && r.units_sold > 0).reduce((a, r) => a + r.net_sales_ex_tax, 0));
  const watch = {
    absent: rows.filter((r) => r.status === 'absent').sort((a, b) => a.delta - b.delta).map(pick),
    lower: rows.filter((r) => r.status === 'compared' && r.direction === 'down').sort((a, b) => a.delta - b.delta).map(pick),
    negative: rows.filter((r) => r.flags.negative).map(pick),
    catalogue: {
      uncategorised_products: rows.filter((r) => r.flags.uncategorised && r.units_sold > 0).length,
      uncategorised_share: totalRevenue > 0 ? round4(uncatRevenue / totalRevenue) : null,
      unmatched_products: rows.filter((r) => r.flags.partial && r.units_sold > 0).length,
      unmatched_share: totalRevenue > 0 ? round4(partialRevenue / totalRevenue) : null,
    },
  };
  const newProducts = rows.filter((r) => r.status === 'new').map(pick);

  // ---- per-product detail (served one at a time): daily series of the current window + the latest sales ----
  const { lines: winLines, refunds: winRefunds } = windowFacts(ledger, win);
  const days = buildDayBuckets(now, tz, 30);
  const refundsByLine = new Map();
  for (const r of ledger.refundFacts) { if (!refundsByLine.has(r.orderLineId)) refundsByLine.set(r.orderLineId, []); refundsByLine.get(r.orderLineId).push(r); }
  const linesByKey = new Map(); const winLinesByKey = new Map(); const winRefundsByKey = new Map();
  for (const l of ledger.lineFacts) { const k = productKeyOf(l); if (!linesByKey.has(k)) linesByKey.set(k, []); linesByKey.get(k).push(l); }
  for (const l of winLines) { const k = productKeyOf(l); if (!winLinesByKey.has(k)) winLinesByKey.set(k, []); winLinesByKey.get(k).push(l); }
  const lineById = new Map(ledger.lineFacts.map((l) => [l.orderLineId, l]));
  for (const r of winRefunds) { const l = lineById.get(r.orderLineId); const k = r.productId ?? (l ? productKeyOf(l) : null); if (!k) continue; if (!winRefundsByKey.has(k)) winRefundsByKey.set(k, []); winRefundsByKey.get(k).push(r); }

  const totalDelta = prev ? round2(totalRevenue - prevTotal) : null;
  const details = {};
  for (const r of rows) {
    const key = keyOfId.get(r.id);
    const wl = winLinesByKey.get(key) ?? []; const wr = winRefundsByKey.get(key) ?? [];
    const daily = days.map((d) => {
      const a = aggregate(wl.filter((l) => inWindow(l.orderedAt, d)), wr.filter((x) => inWindow(x.refundedAt, d)), config);
      return { date: d.localStart, net_sales_ex_tax: a.net_sales_ex_tax, units_sold: a.units_sold };
    });
    const recent = [...(linesByKey.get(key) ?? [])].sort((a, b) => b.orderedAt - a.orderedAt).slice(0, RECENT_SALES).map((l) => {
      const refunds = refundsByLine.get(l.orderLineId) ?? [];
      return { date: localDateString(l.orderedAt, tz), units: l.qty, net_sales_ex_tax: aggregate([l], refunds, config).net_sales_ex_tax, refunded_units: refunds.reduce((a, x) => a + x.qty, 0), channel: rawOrder.get(l.orderId)?.channel_name ?? null, in_period: inWindow(l.orderedAt, win) };
    });
    details[r.id] = {
      ...r,
      revenue_per_unit: r.units_sold > 0 && r.net_sales_ex_tax > 0 ? round2(r.net_sales_ex_tax / r.units_sold) : null,
      contribution: totalDelta == null || r.delta == null ? null : { delta: r.delta, total_delta: totalDelta },
      daily, sale_days: daily.filter((d) => d.units_sold > 0).length, min_trend_sale_days: MIN_TREND_SALE_DAYS,
      recent_sales: recent,
    };
  }

  return {
    period: { start: win.localStart, end: win.localEnd, previous_start: prevWin?.localStart ?? null, previous_end: prevWin?.localEnd ?? null },
    totals: { net_sales_ex_tax: totalRevenue, units_sold: totalUnits, previous_net_sales_ex_tax: prevTotal, delta: totalDelta },
    kpis, list: rows, new_products: newProducts, watch, details,
  };
}
