import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadWhatChanged } from '../src/analytics-premium/server/what-changed.js';
import { loadBrief } from '../src/analytics-premium/server/brief.js';

const UI = new URL('../src/analytics-premium/ui/', import.meta.url);

async function reportDir(mutate) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ap-report-'));
  const sales = {
    net_sales_ex_tax: 754.38, order_count: 28, aov_ex_tax: 26.94, cost_coverage_pct: 0.87, verified_cost_coverage_pct: 0,
    gross_profit: { margin_pct: 0.826, status: 'PARTIAL', certain: false },
    daily_series: [{ date: '2026-09-01', net_sales_ex_tax: 10, order_count: 1, aov_ex_tax: 10, gross_margin_pct: 0.8 }],
    comparison: { available: true, previous_window: { localStart: '2026-07-27', localEnd: '2026-08-26' }, previous: { net_sales_ex_tax: 636.93, order_count: 21, aov_ex_tax: 30.33, gross_margin_pct: 0.79 },
      delta: { net_sales_ex_tax: 117.45, net_sales_ex_tax_pct: 0.18, order_count: 7, order_count_pct: 0.33, aov_ex_tax_pct: -0.11, gross_margin_pp: 0.034 } },
  };
  const products = { rankings: {
    top_revenue: [], biggest_growth: [{ product_key: 'a', title: 'A', delta: 97.52 }, { product_key: 'b', title: 'B', delta: 61.98 }, { product_key: 'c', title: 'C', delta: 41.32 }],
    biggest_decline: [{ product_key: 'd', title: 'D', delta: -99.15 }, { product_key: 'e', title: 'E', delta: -69.18 }, { product_key: 'f', title: 'F', delta: -40.5 }] } };
  const report = { generated_at: '2026-09-25T10:00:00Z', currency: 'EUR', sales: { last_30_days: sales }, products: { last_30_days: products } };
  if (mutate) mutate(report);
  await writeFile(path.join(dir, 'report-2026-09-25.json'), JSON.stringify(report));
  return dir;
}

test('what changed: top gainers above the net change are never turned into a capped percentage', async () => {
  const w = await loadWhatChanged(await reportDir());
  assert.equal('shareOfChange' in w.insight, false);
  assert.equal(w.insight.gains.total, 200.82);
  assert.equal(w.insight.losses.total, 208.83);
  assert.ok(w.insight.gains.total > w.insight.deltaAbs); // the case that used to show "100 %"
});

test('what changed: the gross-margin change is flagged unverified when costs are not certain', async () => {
  const w = await loadWhatChanged(await reportDir());
  const m = w.otherChanges.find((c) => c.kind === 'grossMargin');
  assert.equal(m.costCertain, false);
  assert.equal(m.costCoverage, 0.87);
  assert.equal(m.verifiedCostCoverage, 0);
  const certain = await loadWhatChanged(await reportDir((r) => { r.sales.last_30_days.gross_profit.certain = true; }));
  assert.equal(certain.otherChanges.find((c) => c.kind === 'grossMargin').costCertain, true);
});

test('brief: margin carries its cost coverage, and the comparison is no longer reported as missing when it exists', async () => {
  const b = await loadBrief(await reportDir());
  assert.equal(b.kpis.grossMargin.costCertain, false);
  assert.equal(b.kpis.grossMargin.costCoverage, 0.87);
  assert.equal(b.kpis.grossMargin.verifiedCostCoverage, 0);
  assert.ok(!b.missingCapabilities.includes('PERIOD_OVER_PERIOD_COMPARISON'));
  assert.equal(b.aovComparison.previous, 30.33);
  const none = await loadBrief(await reportDir((r) => { r.sales.last_30_days.comparison = { available: false }; }));
  assert.ok(none.missingCapabilities.includes('PERIOD_OVER_PERIOD_COMPARISON'));
  assert.equal(none.aovComparison, null);
});

test('ui: no hardcoded personal name or initial, and the report label is not called a sync', async () => {
  const app = await readFile(new URL('app.js', UI), 'utf8');
  assert.ok(!/Elidjan/.test(app));
  assert.ok(!/class: 'avatar' \}, '[A-Za-z]'\)/.test(app));
  for (const l of ['fr', 'nl', 'en']) {
    const s = await readFile(new URL(`lang-${l}.js`, UI), 'utf8');
    const line = s.split('\n').find((x) => x.includes("'topbar.reportGenerated'"));
    assert.ok(line && !/synchro|synced|gesynchroniseerd/i.test(line));
  }
});

test('ui: the three language files define exactly the same keys', async () => {
  const keys = async (l) => new Set([...(await readFile(new URL(`lang-${l}.js`, UI), 'utf8')).matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
  const [fr, nl, en] = await Promise.all([keys('fr'), keys('nl'), keys('en')]);
  assert.deepEqual([...fr].filter((k) => !nl.has(k)), []);
  assert.deepEqual([...fr].filter((k) => !en.has(k)), []);
  assert.deepEqual([...nl].filter((k) => !fr.has(k)), []);
  assert.deepEqual([...en].filter((k) => !fr.has(k)), []);
});
