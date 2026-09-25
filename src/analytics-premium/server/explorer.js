// Explorer page data: reads the latest generated report and hands over its `explorer.last_30_days` block
// (built in src/report/explorer.js - all business calculations live there, this is a read layer only).
// The report covers a FIXED window (last 30 days vs the 30 before); there is no custom date-range query yet.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPORT_NAME = /^report-(\d{4}-\d{2}-\d{2})\.json$/;

export async function loadExplorer(reportsDir) {
  reportsDir = reportsDir instanceof URL ? fileURLToPath(reportsDir) : reportsDir;
  const entries = await readdir(reportsDir).catch(() => []);
  const dated = entries.map((f) => ({ f, m: f.match(REPORT_NAME) })).filter((x) => x.m).sort((a, b) => (a.m[1] < b.m[1] ? 1 : -1));
  if (!dated.length) return null;
  const report = JSON.parse(await readFile(path.join(reportsDir, dated[0].f), 'utf8'));
  const e = report.explorer?.last_30_days;
  if (!e) return { generatedAt: report.generated_at, currency: report.currency ?? 'EUR', period: { key: 'last_30_days' }, available: false };
  return {
    available: true,
    generatedAt: report.generated_at,
    currency: report.currency ?? 'EUR',
    period: { key: 'last_30_days', previous: report.sales?.last_30_days?.comparison?.previous_window ?? null },
    ...e,
  };
}
