// Brief page data: reads the latest generated reports/report-*.json snapshot (produced by
// `npm run metrics:report`) and reshapes only the real, already-computed fields the Brief page
// needs. Never computes a new metric here - this is a read/reshape layer, not an analytics engine.
//
// report.sales.last_30_days.daily_series (added in src/report/build.js, via buildDayBuckets()) is a
// real day-by-day breakdown - the same computeSalesMetrics() used for every other window, just
// called once per real calendar day. It is reshaped below into one plain number array per KPI so the
// UI can draw an honest sparkline (real daily totals, never interpolated/fabricated points).
//
// Known gaps in what the current report snapshot can support (documented, not silently faked):
//   - no previous-period figures are stored, so period-over-period deltas cannot be computed
//   - no automated decline/insight detection exists, so a "why did revenue drop" narrative
//     cannot be generated
//   - no dormant-customer metric exists yet in customer-facts
//   - the report is generated for fixed windows (yesterday / last_7_days / last_30_days), not an
//     arbitrary custom date range
// Each gap is reported in `missingCapabilities` so the UI can render an honest, clearly-scoped
// placeholder instead of inventing a number.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPORT_NAME = /^report-(\d{4}-\d{2}-\d{2})\.json$/;

async function latestReportPath(reportsDir) {
  reportsDir = reportsDir instanceof URL ? fileURLToPath(reportsDir) : reportsDir;
  const entries = await readdir(reportsDir).catch(() => []);
  const dated = entries.map((f) => ({ f, m: f.match(REPORT_NAME) })).filter((x) => x.m).sort((a, b) => (a.m[1] < b.m[1] ? 1 : -1));
  if (!dated.length) return null;
  return path.join(reportsDir, dated[0].f);
}

export async function loadBrief(reportsDir) {
  const file = await latestReportPath(reportsDir);
  if (!file) return null;
  const report = JSON.parse(await readFile(file, 'utf8'));
  const s = report.sales?.last_30_days;
  const p = report.products?.last_30_days?.rankings?.top_revenue ?? [];
  const daily = s?.daily_series ?? [];
  // Each series is a plain array of real daily values, oldest first - null days (no cost data that
  // day) stay null rather than being dropped or interpolated, so the UI can decide how to draw a gap.
  const series = daily.length ? {
    netRevenue: daily.map((d) => d.net_sales_ex_tax),
    orders: daily.map((d) => d.order_count),
    aov: daily.map((d) => d.aov_ex_tax),
    grossMargin: daily.map((d) => d.gross_margin_pct),
    dates: daily.map((d) => d.date),
  } : null;
  return {
    generatedAt: report.generated_at,
    currency: report.currency ?? 'EUR',
    period: { key: 'last_30_days', label: 'Last 30 days' },
    kpis: s ? {
      netRevenue: { value: s.net_sales_ex_tax },
      orders: { value: s.order_count },
      aov: { value: s.aov_ex_tax },
      grossMargin: { value: s.gross_profit?.margin_pct ?? null, costStatus: s.gross_profit?.status ?? null, costCertain: s.gross_profit?.certain === true, costCoverage: s.cost_coverage_pct ?? null, verifiedCostCoverage: s.verified_cost_coverage_pct ?? null },
    } : null,
    series,
    topProducts: p.slice(0, 3).map((x) => ({ key: x.product_key, title: x.title, netSalesExTax: x.net_sales_ex_tax, unitsSold: x.units_sold, costStatus: x.cost_status, imageUrl: x.image_url ?? null })),
    // Real previous-period AOV when the report holds a comparison (same figures as "Ce qui a changé").
    aovComparison: s?.comparison?.available && s.comparison.delta?.aov_ex_tax_pct != null ? { value: s.aov_ex_tax, previous: s.comparison.previous.aov_ex_tax, pct: s.comparison.delta.aov_ex_tax_pct } : null,
    missingCapabilities: [...(s?.comparison?.available ? [] : ['PERIOD_OVER_PERIOD_COMPARISON']), 'DECLINE_INSIGHT_DETECTION', 'DORMANT_CUSTOMER_METRIC', 'CUSTOM_DATE_RANGE_QUERY'],
  };
}
