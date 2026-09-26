// Explorer page data: reads the latest generated report and hands over its `explorer.last_30_days` block
// (built in src/report/explorer.js - all business calculations live there, this is a read layer only).
// The report covers a FIXED window (last 30 days vs the 30 before); there is no custom date-range query yet.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPORT_NAME = /^report-(\d{4}-\d{2}-\d{2})\.json$/;

/** @param {object|null} given a report-shaped object for ONE period built by the period engine (default: the latest generated report, fixed 30 days) */
export async function loadExplorer(reportsDir, given = null) {
  reportsDir = reportsDir instanceof URL ? fileURLToPath(reportsDir) : reportsDir;
  let report = given;
  if (!report) {
    const entries = await readdir(reportsDir).catch(() => []);
    const dated = entries.map((f) => ({ f, m: f.match(REPORT_NAME) })).filter((x) => x.m).sort((a, b) => (a.m[1] < b.m[1] ? 1 : -1));
    if (!dated.length) return null;
    report = JSON.parse(await readFile(path.join(reportsDir, dated[0].f), 'utf8'));
  }
  const e = report.explorer?.last_30_days;
  if (!e) return { generatedAt: report.generated_at, currency: report.currency ?? 'EUR', period: { key: 'last_30_days' }, available: false };
  return {
    available: true,
    generatedAt: report.generated_at,
    currency: report.currency ?? 'EUR',
    period: report.period_info ?? { key: 'last_30_days', previous: report.sales?.last_30_days?.comparison?.previous_window ?? null },
    ...e,
  };
}
