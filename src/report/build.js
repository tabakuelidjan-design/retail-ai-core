// Assembles the full Sales + Profit report from a ledger. Pure and deterministic:
// same rows + same `now` => byte-identical output. Facts only - no narrative,
// no recommendations, no LLM.

import { METRICS_VERSION } from '../metrics/config.js';
import { buildProductPerformance, buildRankings, buildSegments, buildVariantPerformance } from '../metrics/products.js';
import { computeSalesMetrics } from '../metrics/sales.js';
import { buildDayBuckets, buildWindows, comparisonCoverage, localDateString, previousEquivalentWindow } from '../metrics/windows.js';
import { detectCashRisks } from '../signals/cash-risk.js';
import { detectCommercialCandidates } from '../signals/commercial.js';
import { buildExplorer } from './explorer.js';
import { buildCustomersWorkspace } from './customers-workspace.js';
import { buildProductsWorkspace } from './products-workspace.js';

const DETAIL_WINDOWS = ['last_30_days', 'available_window'];

export function buildReport({ ledger, now, timeZone, config, data }) {
  const historyStart = data?.firstOrderAt ? localDateString(new Date(data.firstOrderAt), timeZone) : null;
  const windows = buildWindows(now, timeZone, { historyStart });
  const report = {
    metrics_version: METRICS_VERSION,
    generated_at: now.toISOString(),
    merchant_timezone: timeZone,
    currency: ledger.currency,
    order_history: {
      first_order_at: ledger.orders.length ? new Date(Math.min(...ledger.orders.map((o) => o.orderedAt))).toISOString() : null,
      last_order_at: ledger.orders.length ? new Date(Math.max(...ledger.orders.map((o) => o.orderedAt))).toISOString() : null,
      orders_excluded: ledger.excluded,
    },
    sales: {},
    products: {},
  };

  for (const w of Object.values(windows)) report.sales[w.key] = computeSalesMetrics(ledger, w);

  // Real day-by-day series for the last 30 days, for a sparkline that plots actual daily totals -
  // never interpolated or fabricated. Same computeSalesMetrics() used for every other window, just
  // called once per single-day bucket.
  report.sales.last_30_days.daily_series = buildDayBuckets(now, timeZone, 30).map((day) => {
    const m = computeSalesMetrics(ledger, day);
    return {
      date: day.localStart,
      net_sales_ex_tax: m.net_sales_ex_tax,
      order_count: m.order_count,
      aov_ex_tax: m.aov_ex_tax,
      gross_margin_pct: m.gross_profit.margin_pct,
    };
  });

  let last30Rows = null;
  for (const key of DETAIL_WINDOWS) {
    const w = windows[key];
    const rows = buildProductPerformance(ledger, w, now);
    if (key === 'last_30_days') last30Rows = rows;
    report.products[key] = {
      rankings: buildRankings(rows, 10),
      segments: buildSegments(rows, config),
      commercial_candidates: detectCommercialCandidates(rows, config, w),
      cash_risks: detectCashRisks(rows, config, w),
    };
  }

  // Real period-over-period comparison for last_30_days vs the immediately preceding 30 days -
  // previousEquivalentWindow() and computeSalesMetrics() are the same pure, already-tested functions
  // used everywhere else; nothing here is estimated or interpolated. `available: false` (no prior
  // window, e.g. a brand-new store) means callers must show an honest "not available" state, never a
  // fabricated verdict.
  const prevWindow = previousEquivalentWindow(windows.last_30_days);
  const cur = report.sales.last_30_days;
  if (prevWindow) {
    const prev = computeSalesMetrics(ledger, prevWindow);
    const pct = (a, b) => (b ? (a - b) / b : null);
    report.sales.last_30_days.comparison = {
      available: true,
      previous_window: { localStart: prevWindow.localStart, localEnd: prevWindow.localEnd },
      previous: { net_sales_ex_tax: prev.net_sales_ex_tax, order_count: prev.order_count, aov_ex_tax: prev.aov_ex_tax, gross_margin_pct: prev.gross_profit.margin_pct },
      delta: {
        net_sales_ex_tax: Math.round((cur.net_sales_ex_tax - prev.net_sales_ex_tax) * 100) / 100,
        net_sales_ex_tax_pct: pct(cur.net_sales_ex_tax, prev.net_sales_ex_tax),
        order_count: cur.order_count - prev.order_count,
        order_count_pct: pct(cur.order_count, prev.order_count),
        aov_ex_tax_pct: cur.aov_ex_tax != null && prev.aov_ex_tax ? pct(cur.aov_ex_tax, prev.aov_ex_tax) : null,
        gross_margin_pp: cur.gross_profit.margin_pct != null && prev.gross_profit.margin_pct != null
          ? Math.round((cur.gross_profit.margin_pct - prev.gross_profit.margin_pct) * 10000) / 10000 : null,
      },
    };

    // Per-product real movers: same product performance function, called on the previous window,
    // diffed by product_key. A product with no sales in one of the two windows simply has 0 there -
    // real fact (no sales), not a fabricated one.
    const prevRows = buildProductPerformance(ledger, prevWindow, now);
    const prevByKey = new Map(prevRows.map((r) => [r.product_key, r.net_sales_ex_tax]));
    const movers = (last30Rows ?? [])
      .filter((r) => r.matched) // unmatched historical items have no stable identity across windows
      .map((r) => ({
        product_key: r.product_key, title: r.title, image_url: r.image_url,
        net_sales_ex_tax: r.net_sales_ex_tax,
        previous_net_sales_ex_tax: prevByKey.get(r.product_key) ?? 0,
        delta: Math.round((r.net_sales_ex_tax - (prevByKey.get(r.product_key) ?? 0)) * 100) / 100,
      }))
      .filter((m) => m.net_sales_ex_tax > 0 || m.previous_net_sales_ex_tax > 0);
    report.products.last_30_days.rankings.biggest_decline = [...movers].filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3);
    report.products.last_30_days.rankings.biggest_growth = [...movers].filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 3);
    report.products.last_30_days.active_product_count = (last30Rows ?? []).filter((r) => r.units_sold > 0).length;
    report.products.last_30_days.active_product_count_previous = prevRows.filter((r) => r.units_sold > 0).length;
  } else {
    // Either there is no earlier period, or the earlier period is not fully inside the business history (for example the first sale
    // was inside it): the raw coverage is kept so the page can say so factually instead of showing a meaningless percentage.
    const coverage = comparisonCoverage(windows.last_30_days);
    report.sales.last_30_days.comparison = coverage && !coverage.sufficient ? { available: false, reason: 'INSUFFICIENT_HISTORY', coverage } : { available: false };
  }

  report.variants = { available_window_top_revenue: buildVariantPerformance(ledger, windows.available_window)
    .sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax).slice(0, 10) };
  // Explorer page (Analytics Premium): needs the raw rows (customer_key, product_type), so it is only built when `data` is given.
  if (data) report.explorer = { last_30_days: buildExplorer({ ledger, data, windows, now, config, dailySeries: report.sales.last_30_days.daily_series, timeZone }) };
  // Main Clients workspace (Analytics Premium): per-customer list + detail, pseudonymous labels only (customers-workspace.js).
  if (data) report.customers_workspace = { last_30_days: buildCustomersWorkspace({ ledger, data, windows, now, config, timeZone }) };
  // Main Produits workspace (Analytics Premium): per-product list + detail (products-workspace.js).
  if (data) report.products_workspace = { last_30_days: buildProductsWorkspace({ ledger, data, windows, now, config, timeZone }) };
  return { report, windows };
}
