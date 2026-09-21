// Assembles the full Sales + Profit report from a ledger. Pure and deterministic:
// same rows + same `now` => byte-identical output. Facts only - no narrative,
// no recommendations, no LLM.

import { METRICS_VERSION } from '../metrics/config.js';
import { buildProductPerformance, buildRankings, buildSegments, buildVariantPerformance } from '../metrics/products.js';
import { computeSalesMetrics } from '../metrics/sales.js';
import { buildWindows } from '../metrics/windows.js';
import { detectCashRisks } from '../signals/cash-risk.js';
import { detectCommercialCandidates } from '../signals/commercial.js';

const DETAIL_WINDOWS = ['last_30_days', 'available_window'];

export function buildReport({ ledger, now, timeZone, config }) {
  const windows = buildWindows(now, timeZone);
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

  for (const key of DETAIL_WINDOWS) {
    const w = windows[key];
    const rows = buildProductPerformance(ledger, w, now);
    report.products[key] = {
      rankings: buildRankings(rows, 10),
      segments: buildSegments(rows, config),
      commercial_candidates: detectCommercialCandidates(rows, config, w),
      cash_risks: detectCashRisks(rows, config, w),
    };
  }
  report.variants = { available_window_top_revenue: buildVariantPerformance(ledger, windows.available_window)
    .sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax).slice(0, 10) };
  return { report, windows };
}
