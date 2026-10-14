// Nordla Tool Layer - the Phase 5 Analytics tools: get_discounts, get_refunds, get_shipping, get_vat, find_product.
//
// Same rules as the first tools: every figure is copied from the report of the period engine (`sales.<window>` = computeSalesMetrics: discounts, refunds,
// refunds_breakdown, shipping, totals_with_shipping, tax), nothing is computed here. The only arithmetic is the optional `compareTo` difference between two
// engine outputs, done with the engine's own `pct` / `absDelta` (ratio, null without a positive baseline). find_product is a catalogue search (no figure):
// the figures it returns for a product come from the Produits read layer.

import { datasetCatalog } from '../period-engine.js';
import { loadProducts } from '../products.js';
import { absDelta, pct } from '../../../report/explorer.js';
import { LIMIT_SCHEMA, PERIOD_SCHEMA, baseReasons, ERROR_TEXT, eur, loadPeriod, periodOf, success } from './analytics-tools.js';
import { fact, fail } from './contract.js';

// ---------- the four money tools: one shape ----------

/** The facts of one period, straight from `sales`. `null` values are simply absent (never estimated). */
const facts = {
  get_discounts: (s, cur) => [fact('discounts', s.discounts, cur), fact('gross_sales', s.gross_sales, cur), fact('net_sales_ex_tax', s.net_sales_ex_tax, cur)],
  get_refunds: (s, cur) => [fact('refunds_products', s.refunds_breakdown?.product ?? s.refunds, cur), fact('refunds_shipping', s.refunds_breakdown?.shipping, cur), fact('refunds_other', s.refunds_breakdown?.other, cur),
    fact('refunds_total', s.refunds_breakdown?.total, cur), fact('units_refunded', s.units_refunded, 'count')],
  get_shipping: (s, cur) => { const x = s.shipping ?? {}; return [fact('shipping_orders', x.orders_with_shipping, 'count'), fact('shipping_charged_incl_tax', x.charged_incl_tax, cur), fact('shipping_net_ex_tax', x.net_ex_tax, cur),
    fact('shipping_refunds_incl_tax', x.refunds_incl_tax, cur), fact('shipping_net_ex_tax_after_refunds', x.net_ex_tax_after_refunds, cur), fact('shipping_tax_after_refunds', x.tax_after_refunds, cur), fact('shipping_orders_without_data', x.orders_without_shipping_data, 'count')]; },
  get_vat: (s, cur) => [fact('vat_products', s.tax, cur), fact('vat_shipping', s.shipping?.tax_after_refunds, cur), fact('vat_total', s.totals_with_shipping?.tax, cur),
    fact('net_sales_ex_tax_with_shipping', s.totals_with_shipping?.net_sales_ex_tax, cur), fact('net_sales_incl_tax_with_shipping', s.totals_with_shipping?.net_sales_incl_tax, cur)],
};
// The shipping figures are only as complete as the shipping data of the orders: the engine says so, the tool passes it on.
const needsShippingCoverage = new Set(['get_shipping', 'get_vat']);

function shippingReasons(tool, s) {
  if (!needsShippingCoverage.has(tool) || !s.shipping) return [];
  const partial = s.shipping.coverage === 'PARTIAL' || (s.shipping.orders_without_shipping_data ?? 0) > 0;
  return partial ? [{ code: 'SHIPPING_DATA_PARTIAL', detail: { ordersWithoutShippingData: s.shipping.orders_without_shipping_data ?? null } }] : [];
}

function moneyTool(name, description) {
  return {
    name, description,
    inputSchema: { type: 'object', additionalProperties: false, properties: { period: PERIOD_SCHEMA, compareTo: { ...PERIOD_SCHEMA, description: 'Optional reference period: the figures of both periods and their differences are returned.' } } },
    async run(ctx, args) {
      const a = await loadPeriod(ctx, name, args, args.period); if (a.error) return a.error;
      const cur = eur(a.report); const sa = a.report.sales.last_30_days;
      const values = facts[name](sa, cur).filter((f) => f.value != null);
      const reasons = shippingReasons(name, sa); let comparison = null;
      if (args.compareTo) {
        const b = await loadPeriod(ctx, name, args, args.compareTo); if (b.error) return { ...b.error, which: 'compareTo' };
        const before = new Map(facts[name](b.report.sales.last_30_days, cur).map((f) => [f.key, f.value]));
        comparison = {
          reference: { key: b.info.key, from: b.info.start, to: b.info.end, days: b.info.days, includesToday: b.info.includesToday }, basis: 'compareTo', coverage: null,
          rows: values.filter((f) => before.get(f.key) != null).map((f) => ({ key: f.key, unit: f.unit, current: f.value, previous: before.get(f.key), delta_abs: absDelta(f.value, before.get(f.key)), delta_pct: pct(f.value, before.get(f.key)), delta_pct_unit: 'ratio' })),
        };
        reasons.push(...baseReasons(b.info, b.historyStart).map((r) => ({ ...r, scope: 'compareTo' })), ...shippingReasons(name, b.report.sales.last_30_days).map((r) => ({ ...r, scope: 'compareTo' })));
      }
      return success(ctx, name, args, a.report, a.info, a.historyStart, { view: 'sales', values, comparison, reasons });
    },
  };
}

// ---------- find_product ----------

const norm = (x) => String(x ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Catalogue search: every word of the query must appear in the title or the handle; exact title, then title prefix, then all words in the title, then handle only. */
export function searchCatalog(products, query) {
  const q = norm(query); const words = q.split(' ').filter(Boolean);
  if (!words.length) return [];
  return products.map((p) => {
    const title = norm(p.title); const handle = norm(p.handle);
    if (!words.every((w) => title.includes(w) || handle.includes(w))) return null;
    const rank = title === q ? 0 : title.startsWith(q) ? 1 : words.every((w) => title.includes(w)) ? 2 : 3;
    return { p, rank };
  }).filter(Boolean).sort((x, y) => x.rank - y.rank || String(x.p.title).localeCompare(String(y.p.title))).map((x) => x.p);
}

const findProduct = {
  name: 'find_product',
  description: 'Find a product by name (words of its title) and say for each match whether it sold in the period. Distinguishes "no such product in the catalogue" from "the product exists but has no sale in the period".',
  inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 2, maxLength: 80 }, period: PERIOD_SCHEMA, limit: LIMIT_SCHEMA } },
  async run(ctx, args) {
    const p = await loadPeriod(ctx, 'find_product', args, args.period); if (p.error) return p.error;
    const { report, info, historyStart } = p; const cur = eur(report); const limit = args.limit ?? 5;
    const catalog = await datasetCatalog(ctx.reportsDir);
    if (!catalog) return fail('find_product', args, 'DATA_UNAVAILABLE', ERROR_TEXT.DATA_UNAVAILABLE);
    const matches = searchCatalog(catalog.products, args.query);
    if (!matches.length) return fail('find_product', args, 'NOT_FOUND', 'No product with this name in the catalogue.', { period: periodOf(info), reason: 'NOT_IN_CATALOG' });
    const data = await loadProducts(ctx.reportsDir, report);
    if (!data?.available) return fail('find_product', args, 'DATA_UNAVAILABLE', ERROR_TEXT.DATA_UNAVAILABLE);
    const sold = new Map(data.list.filter((r) => (r.units_sold ?? 0) !== 0 || (r.net_sales_ex_tax ?? 0) !== 0).map((r) => [r.id, r]));
    const items = matches.slice(0, limit).map((m) => {
      const r = sold.get(m.id);
      return r
        ? { ref: m.id, label: m.title, status: 'SOLD_IN_PERIOD', values: [fact('net_sales_ex_tax', r.net_sales_ex_tax, cur), fact('units_sold', r.units_sold, 'count')] }
        : { ref: m.id, label: m.title, status: 'NO_SALES_IN_PERIOD', values: [] };
    });
    const unsold = items.filter((i) => i.status === 'NO_SALES_IN_PERIOD').length;
    return success(ctx, 'find_product', args, report, info, historyStart, {
      view: 'products', items, reasons: unsold ? [{ code: 'PRODUCT_HAS_NO_SALES_IN_PERIOD', detail: { count: unsold } }] : [],
      values: [fact('matches', matches.length, 'count'), fact('items_returned', items.length, 'count'), fact('items_sold_in_period', items.length - unsold, 'count')], comparison: null,
    });
  },
};

export const EXTRA_ANALYTICS_TOOLS = [
  moneyTool('get_discounts', 'Discounts granted in a period (with gross and net sales alongside), optionally compared with another period (compareTo).'),
  moneyTool('get_refunds', 'Refunds in a period: products, shipping, other and total, and the units refunded; optionally compared with another period (compareTo).'),
  moneyTool('get_shipping', 'Shipping charged, refunded and net in a period, and how many orders lack shipping data; optionally compared with another period (compareTo).'),
  moneyTool('get_vat', 'VAT collected on the sales of a period (products, shipping, total; after refunds) with net sales excl. and incl. VAT; an overview of the sales, not a VAT return; optionally compared with another period (compareTo).'),
  findProduct,
];
