// Main "Produits" page data: a read/reshape layer over the latest reports/report-*.json - never computes a metric.
//   - Growth / decline lists, categories and concentration are Explorer > Produits' own figures
//     (report.explorer.last_30_days), reused as-is so both pages always agree.
//   - The product list, KPIs, watch facts and per-product details come from report.products_workspace
//     (src/report/products-workspace.js).
// The list endpoint never ships per-product series or recent sales; a product's detail is fetched on selection.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productIdOf } from '../../report/products-workspace.js';

const REPORT_NAME = /^report-(\d{4}-\d{2}-\d{2})\.json$/;
export const PRODUCT_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|u-[0-9a-f]{10})$/;

async function latestReport(reportsDir) {
  reportsDir = reportsDir instanceof URL ? fileURLToPath(reportsDir) : reportsDir;
  const entries = await readdir(reportsDir).catch(() => []);
  const dated = entries.map((f) => ({ f, m: f.match(REPORT_NAME) })).filter((x) => x.m).sort((a, b) => (a.m[1] < b.m[1] ? 1 : -1));
  if (!dated.length) return null;
  return JSON.parse(await readFile(path.join(reportsDir, dated[0].f), 'utf8'));
}

export async function loadProducts(reportsDir) {
  const report = await latestReport(reportsDir);
  if (!report) return null;
  const base = { generatedAt: report.generated_at, currency: report.currency ?? 'EUR', period: { key: 'last_30_days' } };
  const ex = report.explorer?.last_30_days;
  const ws = report.products_workspace?.last_30_days;
  if (!ex?.products || !ws) return { ...base, available: false };
  const { details, ...workspace } = ws;
  // Explorer's movers carry the product key; the workspace id lets the page open the same product's detail.
  const listed = new Set(ws.list.map((r) => r.id));
  const withId = (m) => { const id = productIdOf(m.product_key); return { ...m, id: listed.has(id) ? id : null }; };
  return {
    ...base,
    available: true,
    ...workspace,
    growth: (ex.products.growth ?? []).map(withId),
    decline: (ex.products.decline ?? []).map(withId),
    categories: ex.categories ?? [],
    concentration: ex.products.concentration,
    margin: ex.products.margin,
  };
}

export async function loadProductDetail(reportsDir, id) {
  if (typeof id !== 'string' || !PRODUCT_ID.test(id)) return { error: 'INVALID_PRODUCT_ID' };
  const report = await latestReport(reportsDir);
  const detail = report?.products_workspace?.last_30_days?.details?.[id];
  if (!detail) return { error: 'PRODUCT_NOT_FOUND' };
  return { generatedAt: report.generated_at, currency: report.currency ?? 'EUR', product: detail };
}
