// Nordla Tool Layer - the Analytics tools (Phase 1).
//
// EVERY figure comes from the existing engine: `periodReport` builds the report of the requested window with buildExplorer / buildProductsWorkspace /
// buildCustomersWorkspace / computeSalesMetrics (the same functions and the same dataset snapshot as the Explorer, Produits and Clients pages), and the
// read layers explorer.js / products.js / customers.js hand over exactly what those pages show. A tool only SELECTS and RESHAPES those values into the
// common contract (contract.js). The only arithmetic here is compare_sales's difference between two engine outputs, done with the engine's own `pct` /
// `absDelta` so the convention (ratio, null without a positive baseline) is identical to the Explorer's comparison.

import { MAX_SPAN_DAYS, PERIODS, periodReport } from '../period-engine.js';
import { loadExplorer } from '../explorer.js';
import { loadProducts, loadProductDetail, PRODUCT_ID } from '../products.js';
import { loadCustomers, loadCustomerDetail, CUSTOMER_ID } from '../customers.js';
import { absDelta, pct } from '../../../report/explorer.js';
import { completenessOf, fact, fail } from './contract.js';

const PERIOD_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'A period: a preset (last_n_days needs `days`; custom needs `from` and `to`, YYYY-MM-DD). The previous period is always the immediately preceding window of the same length.',
  properties: {
    period: { type: 'string', enum: PERIODS },
    days: { type: 'integer', minimum: 1, maximum: MAX_SPAN_DAYS },
    from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
};
const LIMIT_SCHEMA = { type: 'integer', minimum: 1, maximum: 20 };
const DEFAULT_PERIOD = { period: 'last_30_days' };
const TOP_SORTS = ['revenue', 'units', 'growth', 'decline'];

const ERROR_MAP = { DATASET_UNAVAILABLE: 'DATA_UNAVAILABLE', INVALID_PERIOD: 'INVALID_PERIOD', INVALID_DATE: 'INVALID_PERIOD', PERIOD_ORDER: 'INVALID_PERIOD', PERIOD_TOO_LONG: 'PERIOD_TOO_LONG', PERIOD_IN_FUTURE: 'PERIOD_IN_FUTURE' };
const ERROR_TEXT = {
  DATA_UNAVAILABLE: 'The analytics dataset is not available yet.', INVALID_PERIOD: 'The period is not valid.', PERIOD_TOO_LONG: 'The period is longer than the maximum supported span.',
  PERIOD_IN_FUTURE: 'The period ends in the future.', INSUFFICIENT_HISTORY: 'The business history does not reach back to this period.', NO_DATA: 'There is no data for this request.', NOT_FOUND: 'Not found among the items of this period.',
};

// ---------- period + shared reshaping ----------

/** Resolve a period argument through the SAME period engine as the pages. */
async function loadPeriod(ctx, tool, args, periodArg) {
  const q = periodArg ?? DEFAULT_PERIOD;
  const r = await periodReport(ctx.reportsDir, { period: q.period, days: q.days, from: q.from, to: q.to }, { now: ctx.now });
  if (!r.ok) { const code = ERROR_MAP[r.code] ?? 'INTERNAL_ERROR'; return { error: fail(tool, args, code, ERROR_TEXT[code] ?? r.code, { engineCode: r.code }) }; }
  const info = r.report.period_info;
  const historyStart = info.coverage?.history_start ?? null;
  if (historyStart && info.end < historyStart) return { error: fail(tool, args, 'INSUFFICIENT_HISTORY', ERROR_TEXT.INSUFFICIENT_HISTORY, { period: periodOf(info), historyStart }) };
  return { report: r.report, info, historyStart };
}

const periodOf = (info) => ({ key: info.key, from: info.start, to: info.end, days: info.days, includesToday: info.includesToday, timeZone: info.timeZone });

/** Reasons that apply to ANY answer for this period. */
function baseReasons(info, historyStart) {
  const reasons = [];
  if (info.includesToday) reasons.push({ code: 'PERIOD_INCLUDES_TODAY', detail: 'The period includes today, which is not finished.' });
  if (historyStart && info.start < historyStart) reasons.push({ code: 'PERIOD_STARTS_BEFORE_HISTORY', detail: { historyStart } });
  return reasons;
}

/** The engine's own previous-equivalent window and its history coverage - present in every result that is compared. */
function previousOf(info) {
  const cov = info.coverage ?? null;
  return { period: info.previous ? { from: info.previous.start, to: info.previous.end } : null, coverage: cov, sufficient: !!cov?.sufficient };
}

function success(ctx, tool, args, report, info, historyStart, body) {
  const reasons = [...baseReasons(info, historyStart), ...(body.reasons ?? [])];
  return {
    ok: true, tool, args, period: periodOf(info),
    values: body.values ?? [], ...(body.items ? { items: body.items } : {}), comparison: body.comparison ?? null,
    completeness: completenessOf(reasons, body.missing ?? []),
    source: { engine: 'nordla-analytics', view: body.view, datasetGeneratedAt: report.generated_at ?? null, metricsVersion: report.sales?.last_30_days?.metrics_version ?? null },
    freshness: ctx.freshness(report.generated_at, info.includesToday),
    currency: report.currency ?? 'EUR',
  };
}

const eur = (report) => report.currency ?? 'EUR';

/** Comparison of the period with the engine's previous-equivalent window (present only when the history really covers it). */
function engineComparison(info, kpis, currency) {
  const prev = previousOf(info);
  if (!prev.sufficient || !kpis) return { comparison: null, reasons: [{ code: 'COMPARISON_HISTORY_INSUFFICIENT', detail: prev.coverage }] };
  const unitOf = (k) => (k === 'order_count' || k === 'units_sold' ? 'count' : currency);
  return { comparison: { reference: prev.period, coverage: prev.coverage, basis: 'previous_equivalent_period', rows: kpis.map((k) => ({ key: k.key, unit: unitOf(k.key), current: k.current, previous: k.previous, delta_abs: k.delta_abs, delta_pct: k.delta_pct, delta_pct_unit: 'ratio' })) }, reasons: [] };
}

// ---------- get_sales_metrics ----------

const SALES_KEYS = [['net_sales_ex_tax', 'money'], ['gross_sales', 'money'], ['discounts', 'money'], ['refunds', 'money'], ['order_count', 'count'], ['units_sold', 'count'], ['aov_ex_tax', 'money']];

function salesValues(report) {
  const s = report.sales.last_30_days; const cur = eur(report);
  return SALES_KEYS.map(([k, u]) => fact(k, s[k], u === 'money' ? cur : 'count'));
}

async function getSalesMetrics(ctx, args) {
  const p = await loadPeriod(ctx, 'get_sales_metrics', args, args.period); if (p.error) return p.error;
  const { report, info, historyStart } = p;
  const s = report.sales.last_30_days; const cur = eur(report);
  const values = salesValues(report); const reasons = []; const missing = [];
  // Gross profit is the engine's figure with the engine's own status and caveats; when the engine has no value the fact is reported missing, never estimated.
  const gp = s.gross_profit;
  if (gp && gp.value != null && gp.status !== 'UNAVAILABLE') {
    values.push(fact('gross_profit', gp.value, cur), fact('gross_margin', gp.margin_pct, 'ratio'));
    if (gp.status !== 'COMPLETE' || gp.certain === false) reasons.push({ code: 'COSTS_PARTIAL', affects: ['gross_profit', 'gross_margin'], detail: { status: gp.status, costConfidence: gp.cost_confidence, caveats: gp.caveats ?? [], costCoverage: s.cost_coverage_pct ?? null } });
  } else missing.push('gross_profit', 'gross_margin');
  const ex = await loadExplorer(ctx.reportsDir, report);
  const cmp = engineComparison(info, ex?.comparison_view?.kpis, cur);
  return success(ctx, 'get_sales_metrics', args, report, info, historyStart, { view: 'sales', values, comparison: cmp.comparison, reasons: [...reasons, ...cmp.reasons], missing });
}

// ---------- compare_sales ----------

const COMPARE_KEYS = [['net_sales_ex_tax', 'money'], ['order_count', 'count'], ['units_sold', 'count'], ['aov_ex_tax', 'money'], ['refunds', 'money']];

async function compareSales(ctx, args) {
  const a = await loadPeriod(ctx, 'compare_sales', args, args.periodA); if (a.error) return { ...a.error, which: 'periodA' };
  const b = await loadPeriod(ctx, 'compare_sales', args, args.periodB); if (b.error) return { ...b.error, which: 'periodB' };
  const cur = eur(a.report); const sa = a.report.sales.last_30_days; const sb = b.report.sales.last_30_days;
  const rows = COMPARE_KEYS.map(([k, u]) => ({ key: k, unit: u === 'money' ? cur : 'count', current: sa[k], previous: sb[k], delta_abs: absDelta(sa[k], sb[k]), delta_pct: sa[k] != null && sb[k] != null ? pct(sa[k], sb[k]) : null, delta_pct_unit: 'ratio' }));
  const reasons = baseReasons(b.info, b.historyStart).map((r) => ({ ...r, scope: 'periodB' }));
  return success(ctx, 'compare_sales', args, a.report, a.info, a.historyStart, {
    view: 'sales', values: salesValues(a.report).filter((f) => COMPARE_KEYS.some(([k]) => k === f.key)), reasons,
    comparison: { reference: { key: b.info.key, from: b.info.start, to: b.info.end, days: b.info.days, includesToday: b.info.includesToday }, basis: 'periodB', coverage: null, rows },
  });
}

// ---------- products ----------

const productItem = (r) => ({
  ref: r.id ?? null, label: r.title,
  values: [fact('net_sales_ex_tax', r.net_sales_ex_tax, r.__cur), ...(r.units_sold != null ? [fact('units_sold', r.units_sold, 'count')] : []), ...(r.share != null ? [fact('share', r.share, 'ratio')] : []),
    fact('previous_net_sales_ex_tax', r.previous_net_sales_ex_tax ?? null, r.__cur), fact('delta_abs', r.delta ?? null, r.__cur), fact('delta_pct', r.delta_pct ?? null, 'ratio')],
  ...(r.status ? { status: r.status } : {}), ...(r.flags ? { flags: r.flags } : {}),
});

async function getTopProducts(ctx, args) {
  const p = await loadPeriod(ctx, 'get_top_products', args, args.period); if (p.error) return p.error;
  const { report, info, historyStart } = p; const cur = eur(report);
  const limit = args.limit ?? 5; const sort = args.sort ?? 'revenue';
  const data = await loadProducts(ctx.reportsDir, report);
  if (!data?.available) return fail('get_top_products', args, 'DATA_UNAVAILABLE', ERROR_TEXT.DATA_UNAVAILABLE);
  // The Produits list also carries catalogue products that did not sell in the period: they are not "top" anything, so they are left out (selection only).
  const sold = (r) => (r.units_sold ?? 0) !== 0 || (r.net_sales_ex_tax ?? 0) !== 0;
  let rows;
  if (sort === 'growth') rows = data.growth; else if (sort === 'decline') rows = data.decline;
  else if (sort === 'units') rows = data.list.filter(sold).map((r, i) => [r, i]).sort((x, y) => (y[0].units_sold - x[0].units_sold) || (x[1] - y[1])).map((x) => x[0]);
  else rows = data.list.filter(sold);
  const reasons = []; const prev = previousOf(info);
  if ((sort === 'growth' || sort === 'decline') && !prev.sufficient) reasons.push({ code: 'COMPARISON_HISTORY_INSUFFICIENT', detail: prev.coverage });
  if (!rows.length) return fail('get_top_products', args, 'NO_DATA', ERROR_TEXT.NO_DATA, { period: periodOf(info), sort, reasons });
  const items = rows.slice(0, limit).map((r) => productItem({ ...r, __cur: cur }));
  return success(ctx, 'get_top_products', args, report, info, historyStart, {
    view: 'products', items, values: [fact('products_sold', data.kpis?.products_sold ?? null, 'count'), fact('items_returned', items.length, 'count')], reasons,
    comparison: prev.sufficient ? { reference: prev.period, coverage: prev.coverage, basis: 'previous_equivalent_period', rows: [] } : null,
  });
}

async function getProductMetrics(ctx, args) {
  const p = await loadPeriod(ctx, 'get_product_metrics', args, args.period); if (p.error) return p.error;
  const { report, info, historyStart } = p; const cur = eur(report);
  const d = await loadProductDetail(ctx.reportsDir, args.productId, report);
  if (d.error) return fail('get_product_metrics', args, 'NOT_FOUND', ERROR_TEXT.NOT_FOUND, { period: periodOf(info), detail: 'No sales for this product in the period, or the id is unknown.' });
  const x = d.product; const prev = previousOf(info);
  const values = [fact('net_sales_ex_tax', x.net_sales_ex_tax, cur), fact('units_sold', x.units_sold, 'count'), fact('share', x.share, 'ratio'),
    fact('previous_net_sales_ex_tax', x.previous_net_sales_ex_tax ?? null, cur), fact('previous_units_sold', x.previous_units_sold ?? null, 'count'),
    fact('delta_abs', x.delta ?? null, cur), fact('delta_pct', x.delta_pct ?? null, 'ratio'), fact('revenue_per_unit', x.revenue_per_unit ?? null, cur),
    fact('sale_days', x.sale_days ?? null, 'days'), fact('last_sale_date', x.last_sale_date ?? null, 'date'), fact('days_since_last_sale', x.days_since_last_sale ?? null, 'days')];
  const reasons = [];
  if (!prev.sufficient) reasons.push({ code: 'COMPARISON_HISTORY_INSUFFICIENT', detail: prev.coverage });
  if (x.flags?.partial) reasons.push({ code: 'PRODUCT_PARTIAL', detail: x.status });
  return success(ctx, 'get_product_metrics', args, report, info, historyStart, {
    view: 'products', values, reasons,
    items: [{ ref: x.id, label: x.title, values: [], status: x.status, flags: x.flags }],
    comparison: prev.sufficient ? { reference: prev.period, coverage: prev.coverage, basis: 'previous_equivalent_period', rows: [] } : null,
  });
}

// ---------- customers (pseudonymous ids only) ----------

async function getCustomers(ctx, args) {
  const p = await loadPeriod(ctx, 'get_customers', args, args.period); if (p.error) return p.error;
  const { report, info, historyStart } = p; const cur = eur(report); const limit = args.limit ?? 5;
  const data = await loadCustomers(ctx.reportsDir, report);
  if (!data?.available) return fail('get_customers', args, 'DATA_UNAVAILABLE', ERROR_TEXT.DATA_UNAVAILABLE);
  const active = data.list.filter((c) => c.active);
  if (!active.length) return fail('get_customers', args, 'NO_DATA', ERROR_TEXT.NO_DATA, { period: periodOf(info) });
  const rows = active.map((c, i) => [c, i]).sort((x, y) => (y[0].net_sales_ex_tax - x[0].net_sales_ex_tax) || (x[1] - y[1])).map((x) => x[0]);
  const items = rows.slice(0, limit).map((c) => ({ ref: c.id, label: c.label, values: [fact('net_sales_ex_tax', c.net_sales_ex_tax, cur), fact('order_count', c.order_count, 'count'), fact('aov_ex_tax', c.aov_ex_tax ?? null, cur), fact('previous_net_sales_ex_tax', c.previous_net_sales_ex_tax ?? null, cur), fact('delta_pct', c.evolution?.delta_pct ?? null, 'ratio')], status: c.period_status }));
  const k = data.kpis ?? {}; const share = data.coverage?.identified_share ?? null; const prev = previousOf(info); const reasons = [];
  if (share != null && share < 1) reasons.push({ code: 'CUSTOMERS_PARTIALLY_IDENTIFIED', detail: { identifiedShare: share, identifiedOrders: data.coverage?.identified_orders ?? null, orders: data.coverage?.orders ?? null } });
  return success(ctx, 'get_customers', args, report, info, historyStart, {
    view: 'customers', items, reasons,
    values: [fact('active_customers', k.active ?? null, 'count'), fact('new_customers', k.new ?? null, 'count'), fact('returning_customers', k.returning ?? null, 'count'), fact('identified_share', share, 'ratio'), fact('items_returned', items.length, 'count')],
    comparison: prev.sufficient ? { reference: prev.period, coverage: prev.coverage, basis: 'previous_equivalent_period', rows: [] } : null,
  });
}

async function getCustomerMetrics(ctx, args) {
  const p = await loadPeriod(ctx, 'get_customer_metrics', args, args.period); if (p.error) return p.error;
  const { report, info, historyStart } = p; const cur = eur(report);
  const d = await loadCustomerDetail(ctx.reportsDir, args.customerId, report);
  if (d.error) return fail('get_customer_metrics', args, 'NOT_FOUND', ERROR_TEXT.NOT_FOUND, { period: periodOf(info), detail: 'This pseudonymous customer has no orders in the period, or the id is unknown.' });
  const c = d.customer; const prev = previousOf(info);
  const values = [fact('net_sales_ex_tax', c.net_sales_ex_tax, cur), fact('order_count', c.order_count, 'count'), fact('aov_ex_tax', c.aov_ex_tax ?? null, cur),
    fact('previous_net_sales_ex_tax', c.previous_net_sales_ex_tax ?? null, cur), fact('previous_order_count', c.previous_order_count ?? null, 'count'), fact('delta_pct', c.evolution?.delta_pct ?? null, 'ratio'),
    fact('first_order_date', c.first_order_date ?? null, 'date'), fact('last_order_date', c.last_order_date ?? null, 'date'), fact('recency_days', c.recency_days ?? null, 'days'), fact('recency_bucket', c.recency_bucket ?? null, 'text')];
  const reasons = [];
  if (!prev.sufficient) reasons.push({ code: 'COMPARISON_HISTORY_INSUFFICIENT', detail: prev.coverage });
  return success(ctx, 'get_customer_metrics', args, report, info, historyStart, {
    view: 'customers', values, reasons, items: [{ ref: c.id, label: c.label, values: [], status: c.period_status }],
    comparison: prev.sufficient ? { reference: prev.period, coverage: prev.coverage, basis: 'previous_equivalent_period', rows: [] } : null,
  });
}

// ---------- channels / categories (Explorer's own lists) ----------

async function listFromExplorer(ctx, tool, args, key, mapRow) {
  const p = await loadPeriod(ctx, tool, args, args.period); if (p.error) return p.error;
  const { report, info, historyStart } = p; const cur = eur(report);
  const ex = await loadExplorer(ctx.reportsDir, report);
  const rows = ex?.available ? ex[key] : null;
  if (!rows) return fail(tool, args, 'DATA_UNAVAILABLE', ERROR_TEXT.DATA_UNAVAILABLE);
  if (!rows.length) return fail(tool, args, 'NO_DATA', ERROR_TEXT.NO_DATA, { period: periodOf(info) });
  return success(ctx, tool, args, report, info, historyStart, { view: 'explorer', items: rows.map((r) => mapRow(r, cur)), values: [fact('items_returned', rows.length, 'count')] });
}

const getChannels = (ctx, args) => listFromExplorer(ctx, 'get_channels', args, 'channels', (r, cur) => ({ ref: r.name, label: r.name, values: [fact('net_sales_ex_tax', r.net_sales_ex_tax, cur), fact('order_count', r.order_count, 'count'), fact('share', r.share, 'ratio')] }));
const getCategories = (ctx, args) => listFromExplorer(ctx, 'get_categories', args, 'categories', (r, cur) => ({ ref: r.name ?? null, label: r.name ?? null, values: [fact('net_sales_ex_tax', r.net_sales_ex_tax, cur), fact('units_sold', r.units_sold, 'count'), fact('share', r.share, 'ratio')], ...(r.name == null ? { flags: { uncategorised: true } } : {}) }));

// ---------- catalog ----------

const periodProp = { period: PERIOD_SCHEMA };
export const ANALYTICS_TOOLS = [
  { name: 'get_sales_metrics', description: 'Sales figures for one period (net sales excl. VAT, gross sales, discounts, refunds, orders, units, average basket, gross profit when costs exist) with the engine\'s comparison to the previous equivalent period.',
    inputSchema: { type: 'object', additionalProperties: false, properties: periodProp }, run: getSalesMetrics },
  { name: 'compare_sales', description: 'Compare the sales of periodA (current) with periodB (reference): both sets of figures and the absolute and relative differences.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['periodA', 'periodB'], properties: { periodA: PERIOD_SCHEMA, periodB: PERIOD_SCHEMA } }, run: compareSales },
  { name: 'get_top_products', description: 'The best products of a period, by revenue (default), units, growth or decline.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...periodProp, limit: LIMIT_SCHEMA, sort: { type: 'string', enum: TOP_SORTS } } }, run: getTopProducts },
  { name: 'get_product_metrics', description: 'Figures of one product for a period (productId comes from get_top_products).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['productId'], properties: { productId: { type: 'string', pattern: PRODUCT_ID.source }, ...periodProp } }, run: getProductMetrics },
  { name: 'get_customers', description: 'The customers who bought in a period, ranked by net sales, as pseudonymous labels (never names or contact details), with counts of active, new and returning customers.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...periodProp, limit: LIMIT_SCHEMA } }, run: getCustomers },
  { name: 'get_customer_metrics', description: 'Figures of one pseudonymous customer for a period (customerId comes from get_customers).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['customerId'], properties: { customerId: { type: 'string', pattern: CUSTOMER_ID.source }, ...periodProp } }, run: getCustomerMetrics },
  { name: 'get_channels', description: 'Net sales, orders and share by sales channel for a period.',
    inputSchema: { type: 'object', additionalProperties: false, properties: periodProp }, run: getChannels },
  { name: 'get_categories', description: 'Net sales, units and share by product category for a period.',
    inputSchema: { type: 'object', additionalProperties: false, properties: periodProp }, run: getCategories },
];
