// Hierarchical sales analytics — source-agnostic. Groups and drills through product / variant / subcategory /
// category / product group / universe / collection / sales channel, all on top of the existing deterministic
// ledger and aggregate() (sales.js): no arithmetic is reinvented here, so this can never disagree with the
// totals in sales.js / products.js. A source system becomes usable by implementing a SalesDataAdapter
// (sales-data-adapter.js) that produces `enrichment` below; this file never reads a Shopify-specific field.
//
//   enrichment = {
//     categoryPathByProduct: Map<productId, string[]>   broadest -> narrowest, e.g. ['Tech','Audio','Earbuds']
//     collectionsByProduct:  Map<productId, {id, title}[]>   many-valued: a product can be in several
//     channelByOrder:        Map<orderId, {id, title}>
//   }
//
// Drill-down is a `filter` object narrowed one level at a time, e.g. for "Tech -> Earbuds -> Product -> Variant":
//   analyzeDimension(ledger, enrichment, { dimension: 'category', window, filter: { universe: 'Tech' } })
//   analyzeDimension(ledger, enrichment, { dimension: 'subcategory', window, filter: { universe: 'Tech', category: 'Earbuds' } })
//   analyzeDimension(ledger, enrichment, { dimension: 'product', window, filter: { universe: 'Tech', category: 'Earbuds' } })
//   analyzeDimension(ledger, enrichment, { dimension: 'variant', window, filter: { productId: '<the chosen product>' } })

import { HIERARCHY_VERSION } from './config.js';
import { buildProductPerformance, productKeyOf, stockValue } from './products.js';
import { aggregate } from './sales.js';
import { buildMonthBuckets, inWindow, previousEquivalentWindow } from './windows.js';

export { HIERARCHY_VERSION };
export const HIERARCHY_LEVELS = ['universe', 'product_group', 'category', 'subcategory'];
export const DIMENSIONS = [...HIERARCHY_LEVELS, 'product', 'variant', 'collection', 'channel'];
export const UNCLASSIFIED = 'Unclassified';
export const DEFAULT_HIERARCHY_CONFIG = { aovMinOrders: 3, monthsOfTrend: 6, topN: 10 };

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };

const pathOf = (productId, enrichment) => enrichment.categoryPathByProduct?.get(productId) ?? [];
const levelValue = (productId, levelIndex, enrichment) => pathOf(productId, enrichment)[levelIndex] ?? UNCLASSIFIED;
const collectionsOf = (productId, enrichment) => enrichment.collectionsByProduct?.get(productId) ?? [];
const channelOf = (orderId, enrichment) => enrichment.channelByOrder?.get(orderId) ?? null;

/** True when a lineFact/refundFact (carrying productId, orderId) is inside the given drill-down scope. */
export function matchesFilter(fact, filter, enrichment) {
  if (!filter) return true;
  for (let i = 0; i < HIERARCHY_LEVELS.length; i += 1) {
    const level = HIERARCHY_LEVELS[i];
    if (filter[level] !== undefined && levelValue(fact.productId, i, enrichment) !== filter[level]) return false;
  }
  if (filter.collectionId !== undefined && !collectionsOf(fact.productId, enrichment).some((c) => c.id === filter.collectionId)) return false;
  if (filter.channelId !== undefined && (channelOf(fact.orderId, enrichment)?.id ?? UNCLASSIFIED) !== filter.channelId) return false;
  if (filter.productId !== undefined && fact.productId !== filter.productId) return false;
  if (filter.variantId !== undefined && fact.variantId !== filter.variantId) return false;
  return true;
}

/** The dimension key(s) a fact contributes to. Collections are many-valued (a product can be in several); every other dimension is single-valued (Unclassified when unknown, never silently dropped). */
export function keysFor(fact, dimension, enrichment) {
  if (dimension === 'product') return [productKeyOf(fact)];
  if (dimension === 'variant') return [fact.variantId ?? `unmatched:${fact.title ?? 'unknown'}`];
  if (dimension === 'collection') { const cs = collectionsOf(fact.productId, enrichment); return cs.length ? cs.map((c) => c.id) : [UNCLASSIFIED]; }
  if (dimension === 'channel') { const c = channelOf(fact.orderId, enrichment); return [c ? c.id : UNCLASSIFIED]; }
  const idx = HIERARCHY_LEVELS.indexOf(dimension);
  if (idx < 0) throw new Error(`unknown dimension: ${dimension}`);
  return [levelValue(fact.productId, idx, enrichment)];
}

/**
 * Catalog membership for a dimension key, independent of whether the product has ever sold — so a category's
 * "no recent sales" list can include a product that has sat in stock with zero sales in the entire order
 * history (it would otherwise never appear in any fact-derived key and be silently dropped). Only meaningful
 * for dimensions a product belongs to regardless of transactions (hierarchy levels, collection); `null` for
 * transaction-only dimensions (channel), where "which products belong to this channel" has no catalog answer.
 */
function catalogProductIdsForKey(ledger, enrichment, dimension, key, filter) {
  const idx = HIERARCHY_LEVELS.indexOf(dimension);
  if (idx < 0 && dimension !== 'collection') return null;
  const ids = [];
  for (const productId of ledger.productById.keys()) {
    if (filter) {
      let ok = true;
      for (let i = 0; i < HIERARCHY_LEVELS.length && ok; i += 1) {
        const level = HIERARCHY_LEVELS[i];
        if (filter[level] !== undefined && levelValue(productId, i, enrichment) !== filter[level]) ok = false;
      }
      if (ok && filter.collectionId !== undefined && !collectionsOf(productId, enrichment).some((c) => c.id === filter.collectionId)) ok = false;
      if (ok && filter.productId !== undefined && productId !== filter.productId) ok = false;
      if (!ok) continue;
    }
    const belongs = idx >= 0 ? levelValue(productId, idx, enrichment) === key : collectionsOf(productId, enrichment).some((c) => c.id === key);
    if (belongs) ids.push(productId);
  }
  return ids;
}

function buildLabelIndex(ledger, enrichment) {
  const collectionTitle = new Map(); for (const cs of enrichment.collectionsByProduct?.values() ?? []) for (const c of cs) collectionTitle.set(c.id, c.title);
  const channelTitle = new Map(); for (const c of enrichment.channelByOrder?.values() ?? []) channelTitle.set(c.id, c.title);
  return (key, dimension) => {
    if (key === UNCLASSIFIED) return UNCLASSIFIED;
    if (dimension === 'collection') return collectionTitle.get(key) ?? key;
    if (dimension === 'channel') return channelTitle.get(key) ?? key;
    if (dimension === 'product') return ledger.productById.get(key)?.title ?? key.replace(/^unmatched:/, '');
    if (dimension === 'variant') return ledger.variantById.get(key)?.title ?? key.replace(/^unmatched:/, '');
    return key; // hierarchy levels: the path segment itself is the label
  };
}

/** Top-N products, declining products (units down vs the previous equivalent period) and stocked-but-unsold products, scoped to one node's products. Reuses buildProductPerformance (products.js) so figures never disagree with the product-level report. */
function productBreakdownForNode(ledger, window, now, nodeProductKeys, topN) {
  if (nodeProductKeys.size === 0) return { top_products: [], declining_products: [], no_recent_sales: [] };
  const cmpWindow = previousEquivalentWindow(window);
  const rows = buildProductPerformance(ledger, window, now).filter((r) => nodeProductKeys.has(r.product_key));
  const prevByKey = cmpWindow ? new Map(buildProductPerformance(ledger, cmpWindow, now).map((r) => [r.product_key, r])) : new Map();
  const top_products = rows.filter((r) => r.units_sold > 0).sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax || b.units_sold - a.units_sold)
    .slice(0, topN).map((r) => ({ product_key: r.product_key, title: r.title, net_sales_ex_tax: r.net_sales_ex_tax, units_sold: r.units_sold }));
  const declining_products = rows.map((r) => ({ r, prev: prevByKey.get(r.product_key) }))
    .filter(({ r, prev }) => prev && prev.units_sold > 0 && r.units_sold < prev.units_sold)
    .map(({ r, prev }) => ({ product_key: r.product_key, title: r.title, units_sold: r.units_sold, previous_units_sold: prev.units_sold, units_change_pct: round4((r.units_sold - prev.units_sold) / prev.units_sold) }))
    .sort((a, b) => a.units_change_pct - b.units_change_pct).slice(0, topN);
  const no_recent_sales = rows.filter((r) => r.matched && r.units_sold === 0 && r.stock_units > 0)
    .sort((a, b) => b.stock_units - a.stock_units).slice(0, topN)
    .map((r) => ({ product_key: r.product_key, title: r.title, stock_units: r.stock_units, days_since_last_sale: r.days_since_last_sale }));
  return { top_products, declining_products, no_recent_sales, comparison_window: cmpWindow ? { key: cmpWindow.key, start: cmpWindow.start.toISOString(), end: cmpWindow.end.toISOString() } : null };
}

/**
 * One row per distinct value of `dimension` found in `filter`'s scope, with sales, margin, refunds, AOV, stock,
 * velocity, a month-by-month trend and a comparison with the previous equivalent period. Rows for a coarser
 * dimension (anything above product/variant) also carry top/declining/no-recent-sales products.
 * @param {{dimension: string, window: object, filter?: object|null, now?: Date, timeZone?: string, config?: object}} opts
 */
export function analyzeDimension(ledger, enrichment, opts) {
  const { dimension, window, filter = null, now = new Date(), timeZone = 'UTC' } = opts;
  if (!DIMENSIONS.includes(dimension)) throw new Error(`unknown dimension: ${dimension}`);
  const cfg = { ...DEFAULT_HIERARCHY_CONFIG, ...(ledger.config?.hierarchy ?? {}), ...(opts.config ?? {}) };
  const label = buildLabelIndex(ledger, enrichment);

  // Scope once, unbounded by any window, then slice per window below - avoids re-filtering the whole ledger per bucket.
  const scopedLines = ledger.lineFacts.filter((l) => matchesFilter(l, filter, enrichment));
  const scopedRefunds = ledger.refundFacts.filter((r) => matchesFilter(r, filter, enrichment));
  const linesByKey = new Map(); const refundsByKey = new Map();
  for (const l of scopedLines) for (const k of keysFor(l, dimension, enrichment)) push(linesByKey, k, l);
  for (const r of scopedRefunds) for (const k of keysFor(r, dimension, enrichment)) push(refundsByKey, k, r);
  const keys = new Set([...linesByKey.keys(), ...refundsByKey.keys()]);

  const cmpWindow = previousEquivalentWindow(window);
  const monthBuckets = buildMonthBuckets(now, timeZone, cfg.monthsOfTrend);
  const windowDays = Math.max(1, (window.end - window.start) / DAY_MS);
  const isCoarse = !['product', 'variant'].includes(dimension);

  const rows = [...keys].map((key) => {
    const kLines = linesByKey.get(key) ?? []; const kRefunds = refundsByKey.get(key) ?? [];
    const inWin = (f, at) => inWindow(at(f), window);
    const wLines = kLines.filter((l) => inWin(l, (x) => x.orderedAt));
    const wRefunds = kRefunds.filter((r) => inWin(r, (x) => x.refundedAt));
    const agg = aggregate(wLines, wRefunds, ledger.config);

    const variantIds = [...new Set(kLines.map((l) => l.variantId).filter(Boolean))];
    const productIds = [...new Set(kLines.map((l) => l.productId).filter(Boolean))];
    const stock = stockValue(ledger, variantIds, now);
    const orderCount = new Set(wLines.map((l) => l.orderId)).size;

    const cLines = cmpWindow ? kLines.filter((l) => inWindow(l.orderedAt, cmpWindow)) : [];
    const cRefunds = cmpWindow ? kRefunds.filter((r) => inWindow(r.refundedAt, cmpWindow)) : [];
    const cAgg = aggregate(cLines, cRefunds, ledger.config);

    const monthly_trend = monthBuckets.map((b) => {
      const bLines = kLines.filter((l) => inWindow(l.orderedAt, b));
      const bRefunds = kRefunds.filter((r) => inWindow(r.refundedAt, b));
      const bAgg = aggregate(bLines, bRefunds, ledger.config);
      return { month: b.key, partial: b.partial, net_sales_ex_tax: bAgg.net_sales_ex_tax, units_sold: bAgg.units_sold };
    });

    let breakdown = null;
    if (isCoarse) {
      const soldKeys = productIds.length ? productIds : kLines.map((l) => productKeyOf(l));
      const catalogIds = catalogProductIdsForKey(ledger, enrichment, dimension, key, filter);
      const nodeProductKeys = new Set(catalogIds ? [...soldKeys, ...catalogIds] : soldKeys);
      breakdown = productBreakdownForNode(ledger, window, now, nodeProductKeys, cfg.topN);
    }

    return {
      dimension, key, label: label(key, dimension),
      window: { key: window.key, start: window.start.toISOString(), end: window.end.toISOString() },
      net_sales_ex_tax: agg.net_sales_ex_tax, units_sold: agg.units_sold, units_refunded: agg.units_refunded, refunds: agg.refunds,
      gross_profit: agg.gross_profit,
      order_count: orderCount, aov: orderCount > 0 ? round2(agg.net_sales / orderCount) : null, aov_meaningful: orderCount >= cfg.aovMinOrders,
      stock_units: stock.units, inventory_value_at_cost: stock.inventory_value_at_cost,
      sales_velocity_units_per_day: round2(agg.units_sold / windowDays),
      product_count: new Set(productIds).size, variant_count: new Set(variantIds).size,
      comparison_previous_period: {
        window: cmpWindow ? { key: cmpWindow.key, start: cmpWindow.start.toISOString(), end: cmpWindow.end.toISOString() } : null,
        net_sales_ex_tax: cmpWindow ? cAgg.net_sales_ex_tax : null, units_sold: cmpWindow ? cAgg.units_sold : null,
        net_sales_change_pct: cmpWindow && cAgg.net_sales_ex_tax > 0 ? round4((agg.net_sales_ex_tax - cAgg.net_sales_ex_tax) / cAgg.net_sales_ex_tax) : null,
        units_change_pct: cmpWindow && cAgg.units_sold > 0 ? round4((agg.units_sold - cAgg.units_sold) / cAgg.units_sold) : null,
      },
      monthly_trend,
      ...(breakdown ? { top_products: breakdown.top_products, declining_products: breakdown.declining_products, no_recent_sales: breakdown.no_recent_sales } : {}),
    };
  });
  rows.sort((a, b) => b.net_sales_ex_tax - a.net_sales_ex_tax || a.label.localeCompare(b.label));
  return { hierarchy_version: HIERARCHY_VERSION, dimension, filter, rows };
}

/** Convenience for a known drill path, e.g. drillDown(ledger, enrichment, { window, path: [['universe','Tech'],['category','Earbuds']], into: 'product' }). */
export function drillDown(ledger, enrichment, { window, path = [], into, now, timeZone, config }) {
  const filter = Object.fromEntries(path);
  return analyzeDimension(ledger, enrichment, { dimension: into, window, filter, now, timeZone, config });
}
