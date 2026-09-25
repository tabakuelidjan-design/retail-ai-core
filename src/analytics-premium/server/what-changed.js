// "Ce qui a changé" (What Changed) page data: reads the same latest reports/report-*.json snapshot
// as brief.js and reshapes only real, already-computed fields. Never invents a metric here.
//
// report.sales.last_30_days.comparison (added in src/report/build.js, via previousEquivalentWindow()
// + computeSalesMetrics() - both pure, already-tested functions) is a real period-over-period
// comparison: last 30 days vs the immediately preceding 30 days. `comparison.available === false`
// means there is no prior window yet (e.g. a brand-new store) - the UI must show an honest
// "not available" state, never assume a direction.
//
// report.products.last_30_days.rankings.biggest_decline/biggest_growth (added alongside comparison)
// are real per-product deltas between the same two windows - never derived from a single day, never
// interpolated. Only one of the two lists is meaningful depending on the real overall direction, and
// that direction is decided here from the real sign of the total net-revenue delta, not assumed.
//
// Known gaps (documented, not silently faked):
//   - no dormant-customer metric exists yet in customer-facts
//   - marketing/channel attribution completeness is not computed anywhere yet
//   - the comparison window is fixed at 30-vs-30 days, not an arbitrary custom range

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

function mover(m, currency) {
  return { key: m.product_key, title: m.title, imageUrl: m.image_url ?? null, netSalesExTax: m.net_sales_ex_tax, previousNetSalesExTax: m.previous_net_sales_ex_tax, delta: m.delta, currency };
}

export async function loadWhatChanged(reportsDir) {
  const file = await latestReportPath(reportsDir);
  if (!file) return null;
  const report = JSON.parse(await readFile(file, 'utf8'));
  const s = report.sales?.last_30_days;
  const currency = report.currency ?? 'EUR';
  if (!s) return { generatedAt: report.generated_at, currency, comparisonAvailable: false, insight: null, watch: [], otherChanges: [] };

  const cmp = s.comparison;
  const comparisonAvailable = !!cmp?.available;
  const p = report.products?.last_30_days;

  let insight = null;
  if (comparisonAvailable) {
    const deltaCents = cmp.delta.net_sales_ex_tax;
    const direction = deltaCents > 0 ? 'up' : deltaCents < 0 ? 'down' : 'flat';
    const movers = (direction === 'down' ? p?.rankings?.biggest_decline : p?.rankings?.biggest_growth) ?? [];
    // Reconciled summary in euros. The top gainers and top losers are two separate lists that partly offset each
    // other (and other products move too), so their sum is NOT a share of the net change and no percentage is derived.
    const up = p?.rankings?.biggest_growth ?? []; const down = p?.rankings?.biggest_decline ?? [];
    const sumAbs = (list) => Math.round(list.reduce((a, m) => a + Math.abs(m.delta), 0) * 100) / 100;
    insight = {
      direction,
      netRevenue: s.net_sales_ex_tax,
      previousNetRevenue: cmp.previous.net_sales_ex_tax,
      deltaAbs: Math.abs(deltaCents),
      deltaPct: cmp.delta.net_sales_ex_tax_pct,
      contributors: movers.map((m) => mover(m, currency)),
      gains: { count: up.length, total: sumAbs(up) },
      losses: { count: down.length, total: sumAbs(down) },
      previousWindow: cmp.previous_window,
      costStatus: s.gross_profit?.status ?? null,
      // Same real daily net-revenue series already used on the Brief page's KPI sparkline (never a
      // second/fabricated series) - reused here for the bigger trend chart in the right-hand panel.
      series: (s.daily_series ?? []).map((d) => d.net_sales_ex_tax),
      seriesDates: (s.daily_series ?? []).map((d) => d.date),
    };
  }

  const watch = [];
  if (comparisonAvailable && cmp.delta.aov_ex_tax_pct != null) {
    watch.push({ kind: 'aov', pct: cmp.delta.aov_ex_tax_pct, value: s.aov_ex_tax, previousValue: cmp.previous.aov_ex_tax, currency });
  }
  const declineCount = p?.rankings?.biggest_decline?.length ?? 0;
  const growthCount = p?.rankings?.biggest_growth?.length ?? 0;
  if (comparisonAvailable && (declineCount || growthCount)) {
    watch.push({ kind: 'movers', declineCount, growthCount });
  }
  if (s.cost_coverage_pct != null) {
    watch.push({ kind: 'costCoverage', pct: s.cost_coverage_pct });
  }

  const otherChanges = [];
  if (comparisonAvailable) {
    otherChanges.push({ kind: 'orders', value: s.order_count, previousValue: cmp.previous.order_count, delta: cmp.delta.order_count, pct: cmp.delta.order_count_pct });
    if (cmp.delta.gross_margin_pp != null) {
      // costCertain is true only when the margin rests on verified costs; otherwise the UI must present it as partial and neutral.
      otherChanges.push({ kind: 'grossMargin', value: s.gross_profit?.margin_pct ?? null, previousValue: cmp.previous.gross_margin_pct, deltaPp: cmp.delta.gross_margin_pp, costCertain: s.gross_profit?.certain === true, costCoverage: s.cost_coverage_pct ?? null, verifiedCostCoverage: s.verified_cost_coverage_pct ?? null });
    }
    if (p?.active_product_count != null && p?.active_product_count_previous != null) {
      otherChanges.push({ kind: 'activeProducts', value: p.active_product_count, previousValue: p.active_product_count_previous, delta: p.active_product_count - p.active_product_count_previous });
    }
  }

  return {
    generatedAt: report.generated_at,
    currency,
    period: { key: 'last_30_days', label: 'Last 30 days' },
    comparisonAvailable,
    insight,
    watch,
    otherChanges,
    // Same real daily AOV series used by the Brief page's AOV KPI sparkline - reused for the AOV
    // watch card's mini chart, not a second/fabricated series.
    aovSeries: (s.daily_series ?? []).map((d) => d.aov_ex_tax),
    seriesDates: (s.daily_series ?? []).map((d) => d.date),
  };
}
