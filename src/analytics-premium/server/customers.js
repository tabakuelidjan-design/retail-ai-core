// Main "Clients" page data: a read/reshape layer over the latest reports/report-*.json - never computes a metric.
//   - KPIs, coverage, segments and the customer-value sample gate are Explorer > Clients' own figures
//     (report.explorer.last_30_days.customers), reused as-is so both pages always agree.
//   - The customer list, top customers, recency and watch facts come from report.customers_workspace
//     (src/report/customers-workspace.js).
// The list endpoint never ships per-customer order histories; a customer's detail is fetched on selection
// (loadCustomerDetail), so the page does not grow with the number of customers' histories.
// Only pseudonymous labels/ids ("#A4B7") exist in these payloads - never the underlying customer key.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPORT_NAME = /^report-(\d{4}-\d{2}-\d{2})\.json$/;
export const CUSTOMER_ID = /^[A-F0-9]{4,12}$/;

async function latestReport(reportsDir) {
  reportsDir = reportsDir instanceof URL ? fileURLToPath(reportsDir) : reportsDir;
  const entries = await readdir(reportsDir).catch(() => []);
  const dated = entries.map((f) => ({ f, m: f.match(REPORT_NAME) })).filter((x) => x.m).sort((a, b) => (a.m[1] < b.m[1] ? 1 : -1));
  if (!dated.length) return null;
  return JSON.parse(await readFile(path.join(reportsDir, dated[0].f), 'utf8'));
}

export async function loadCustomers(reportsDir) {
  const report = await latestReport(reportsDir);
  if (!report) return null;
  const base = { generatedAt: report.generated_at, currency: report.currency ?? 'EUR', period: { key: 'last_30_days' } };
  const ex = report.explorer?.last_30_days?.customers;
  const ws = report.customers_workspace?.last_30_days;
  if (!ex || !ws) return { ...base, available: false };
  const { details, ...workspace } = ws;
  return {
    ...base,
    available: true,
    coverage: ex.coverage,
    kpis: ex.kpis,
    segments: ex.segments,
    value: { gated: ex.value.gated, min_customers: ex.value.min_customers, identified_customers: ex.value.identified_customers },
    ...workspace,
  };
}

export async function loadCustomerDetail(reportsDir, id) {
  if (typeof id !== 'string' || !CUSTOMER_ID.test(id)) return { error: 'INVALID_CUSTOMER_ID' };
  const report = await latestReport(reportsDir);
  const detail = report?.customers_workspace?.last_30_days?.details?.[id];
  if (!detail) return { error: 'CUSTOMER_NOT_FOUND' };
  return { generatedAt: report.generated_at, currency: report.currency ?? 'EUR', customer: detail };
}
