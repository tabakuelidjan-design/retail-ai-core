// Period engine for Analytics Premium (Explorer, Produits, Clients). The period is a PARAMETER of the existing deterministic report engine:
// the same buildExplorer / buildProductsWorkspace / buildCustomersWorkspace functions run over the SAME dataset snapshot written by the report
// command (reports/dataset.json), for whatever window is asked for. Nothing is computed twice or re-implemented here - this file only
//   1. turns a preset / custom range into an exact window in the merchant timezone,
//   2. rebuilds the ledger from the snapshot (cached) and runs the engine for that window,
//   3. hands the result to the existing read layers (explorer.js / products.js / customers.js) in the shape they already understand.
// The previous period is always the immediately preceding window of the SAME length (previousEquivalentWindow), and it is only used when the business
// history really covers it (comparisonCoverage) - otherwise the payload carries the factual coverage instead of a misleading percentage.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLedger } from '../../metrics/ledger.js';
import { mergeConfig } from '../../metrics/config.js';
import { addDays, buildWindows, dayBucketsOfWindow, localDateString, localMidnight, previousEquivalentWindow } from '../../metrics/windows.js';
import { computeSalesMetrics } from '../../metrics/sales.js';
import { buildExplorer } from '../../report/explorer.js';
import { buildProductsWorkspace } from '../../report/products-workspace.js';
import { buildCustomersWorkspace } from '../../report/customers-workspace.js';

// `yesterday` and `last_n_days` (with `days`) are used by the assistant; the selector menu offers the others.
export const PERIODS = ['yesterday', 'last_n_days', 'last_7_days', 'last_30_days', 'last_90_days', 'this_week', 'this_month', 'previous_month', 'this_year', 'custom'];
export const MAX_SPAN_DAYS = 1100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (d) => DATE.test(d ?? '') && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);
const mondayOf = (d) => { const t = new Date(`${d}T00:00:00Z`); return new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10); };

/**
 * Preset / custom range -> exact local calendar days [localStart, localEnd) in the merchant timezone (localEnd is exclusive).
 *   last_N_days   the N complete days before today (today's partial day is excluded, like every existing window)
 *   this_week     Monday of this week through today;  this_month / this_year: the 1st / January 1st through today (today included)
 *   previous_month the whole previous calendar month
 *   custom        from..to inclusive, real dates, from <= to, to not in the future, at most MAX_SPAN_DAYS days
 */
export function resolvePeriod({ period, from, to, days: nDays } = {}, { now = new Date(), timeZone = 'UTC' } = {}) {
  const key = period || 'last_30_days';
  if (!PERIODS.includes(key)) return { ok: false, code: 'INVALID_PERIOD' };
  const today = localDateString(now, timeZone);
  let localStart; let localEnd;
  if (key === 'yesterday') { localStart = addDays(today, -1); localEnd = today; }
  else if (key === 'last_n_days') { const n = Number(nDays); if (!Number.isInteger(n) || n < 1) return { ok: false, code: 'INVALID_PERIOD' }; localStart = addDays(today, -n); localEnd = today; }
  else if (key === 'last_7_days') { localStart = addDays(today, -7); localEnd = today; }
  else if (key === 'last_30_days') { localStart = addDays(today, -30); localEnd = today; }
  else if (key === 'last_90_days') { localStart = addDays(today, -90); localEnd = today; }
  else if (key === 'this_week') { localStart = mondayOf(today); localEnd = addDays(today, 1); }
  else if (key === 'this_month') { localStart = `${today.slice(0, 8)}01`; localEnd = addDays(today, 1); }
  else if (key === 'this_year') { localStart = `${today.slice(0, 4)}-01-01`; localEnd = addDays(today, 1); }
  else if (key === 'previous_month') {
    const first = `${today.slice(0, 8)}01`; const lastPrev = addDays(first, -1);
    localStart = `${lastPrev.slice(0, 8)}01`; localEnd = first;
  } else {
    if (!isRealDate(from) || !isRealDate(to)) return { ok: false, code: 'INVALID_DATE' };
    if (from > to) return { ok: false, code: 'PERIOD_ORDER' };
    if (to > today) return { ok: false, code: 'PERIOD_IN_FUTURE' };
    localStart = from; localEnd = addDays(to, 1);
  }
  const days = daysBetween(localStart, localEnd);
  if (days > MAX_SPAN_DAYS) return { ok: false, code: 'PERIOD_TOO_LONG', max: MAX_SPAN_DAYS };
  return { ok: true, key, localStart, localEnd, days, includesToday: localEnd > today, timeZone };
}

const cache = { mtime: null, snapshot: null, ledger: null, historyStart: null, results: new Map() };
const RESULT_CACHE_MAX = 12;

async function loadSnapshot(reportsDir) {
  reportsDir = reportsDir instanceof URL ? fileURLToPath(reportsDir) : reportsDir;
  const file = path.join(reportsDir, 'dataset.json');
  let st; try { st = await stat(file); } catch { return null; }
  if (cache.mtime === st.mtimeMs && cache.snapshot) return cache;
  let snapshot; try { snapshot = JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
  if (!snapshot?.data?.orders) return null;
  const config = mergeConfig();
  const ledger = buildLedger(snapshot.data, { config });
  const firstOrder = snapshot.data.firstOrderAt ?? (ledger.orders.length ? new Date(Math.min(...ledger.orders.map((o) => o.orderedAt))).toISOString() : null);
  Object.assign(cache, { mtime: st.mtimeMs, snapshot, ledger, config, historyStart: firstOrder ? localDateString(new Date(firstOrder), snapshot.time_zone ?? 'UTC') : null, results: new Map() });
  return cache;
}

/** The report-shaped object the existing read layers (explorer.js / products.js / customers.js) already understand, for one period. */
function buildForPeriod(c, r, now) {
  const { snapshot, ledger, config, historyStart } = c;
  const tz = snapshot.time_zone ?? 'UTC';
  const win = { key: 'last_30_days', label: r.key, timeZone: tz, start: localMidnight(r.localStart, tz), end: localMidnight(r.localEnd, tz), localStart: r.localStart, localEnd: r.localEnd, historyStart };
  const historyDays = historyStart ? Math.max(60, daysBetween(historyStart, localDateString(now, tz)) + 2) : 60;
  const windows = { ...buildWindows(now, tz, { availableDays: historyDays, historyStart }), last_30_days: win };
  const daily = dayBucketsOfWindow(win).map((day) => { const m = computeSalesMetrics(ledger, day); return { date: day.localStart, net_sales_ex_tax: m.net_sales_ex_tax, order_count: m.order_count, aov_ex_tax: m.aov_ex_tax }; });
  const args = { ledger, data: snapshot.data, windows, now, config, timeZone: tz };
  const explorer = buildExplorer({ ...args, dailySeries: daily });
  const products = buildProductsWorkspace(args);
  const customers = buildCustomersWorkspace(args);
  const prev = previousEquivalentWindow(win);
  const totals = computeSalesMetrics(ledger, win);
  return {
    generated_at: snapshot.generated_at, currency: snapshot.currency ?? 'EUR', merchant_timezone: tz,
    period_info: { key: r.key, start: r.localStart, end: addDays(r.localEnd, -1), days: r.days, includesToday: r.includesToday, timeZone: tz,
      previous: prev ? { start: prev.localStart, end: addDays(prev.localEnd, -1) } : null, coverage: explorer.comparison_coverage ?? null, dataAsOf: snapshot.generated_at },
    sales: { last_30_days: { ...totals, comparison: { previous_window: prev ? { localStart: prev.localStart, localEnd: prev.localEnd } : null } } },
    explorer: { last_30_days: explorer }, products_workspace: { last_30_days: products }, customers_workspace: { last_30_days: customers },
  };
}

/**
 * @returns {Promise<{ok: true, report: object} | {ok: false, status: number, code: string}>}
 * `now` is injectable so presets are testable; results are cached per (dataset version, exact window).
 */
export async function periodReport(reportsDir, query, { now = new Date() } = {}) {
  const c = await loadSnapshot(reportsDir);
  if (!c) return { ok: false, status: 404, code: 'DATASET_UNAVAILABLE' };
  const r = resolvePeriod(query, { now, timeZone: c.snapshot.time_zone ?? 'UTC' });
  if (!r.ok) return { ok: false, status: r.code === 'PERIOD_TOO_LONG' || r.code === 'PERIOD_IN_FUTURE' ? 422 : 400, code: r.code };
  const k = `${r.localStart}|${r.localEnd}|${r.includesToday ? localDateString(now, r.timeZone) : ''}`;
  if (!cache.results.has(k)) {
    if (cache.results.size >= RESULT_CACHE_MAX) cache.results.delete(cache.results.keys().next().value);
    cache.results.set(k, buildForPeriod(c, r, now));
  }
  const report = cache.results.get(k);
  return { ok: true, report: { ...report, period_info: { ...report.period_info, key: r.key } } };
}

/**
 * The product catalogue of the dataset snapshot (id, title, handle, type, status) - no figure. It lets a tool tell "no such product" from "a product with no
 * sale in the period", which the period reports alone cannot (they only list products that sold).
 */
export async function datasetCatalog(reportsDir) {
  const c = await loadSnapshot(reportsDir);
  if (!c) return null;
  return { generatedAt: c.snapshot.generated_at ?? null, products: (c.snapshot.data.products ?? []).map((p) => ({ id: p.id, title: p.title ?? null, handle: p.handle ?? null, productType: p.product_type ?? null, status: p.source_status ?? null })) };
}

export const resetPeriodCache = () => { cache.mtime = null; cache.snapshot = null; cache.results = new Map(); };
