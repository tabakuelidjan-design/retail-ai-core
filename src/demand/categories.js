// Category / collection demand, portfolio concentration and stock exposure,
// aggregated from product facts. Categories are the "related products"
// dimension a future buying comparison will use for items with no history of
// their own. product_type is a partition; collections OVERLAP (a product can be
// in several), so collection totals can exceed 100% and are flagged as such.

import { demandBlock } from './facts.js';
import { median, round2 } from './classify.js';

const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 10000 : null);
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

function groupMembers(productFacts, dimension) {
  const groups = new Map();
  const add = (key, label, pf) => {
    if (!groups.has(key)) groups.set(key, { key, label, members: [] });
    groups.get(key).members.push(pf);
  };
  for (const pf of productFacts.filter((p) => p.matched)) {
    if (dimension === 'product_type') add(pf.category, pf.category, pf);
    else for (const c of pf.collections) add(c.source_id, c.title, pf);
  }
  return [...groups.values()];
}

export function buildCategoryFacts(ctx, productFacts, { dimension, salesReconciled, totals }) {
  const cfg = ctx.cfg;
  const out = groupMembers(productFacts, dimension).map(({ key, label, members }) => {
    const lines = members.flatMap((m) => ctx.linesByProduct.get(m.product_key) ?? []);
    const refunds = members.flatMap((m) => ctx.refundsByProduct.get(m.product_key) ?? []);
    const created = members.map((m) => m.source_created_at).filter(Boolean).sort()[0];
    const lastSales = members.map((m) => ctx.lastSaleByProduct.get(m.product_key)).filter(Boolean);
    const block = demandBlock(ctx, {
      lines, refunds, variantIds: members.flatMap((m) => ctx.variantsByProduct.get(m.product_key) ?? []),
      createdAt: created ? new Date(created) : null,
      lastSaleAt: lastSales.length ? new Date(Math.max(...lastSales)) : null, salesReconciled,
      partialUnits: sum(members, (m) => ctx.partialUnitsByProduct.get(m.product_key) ?? 0),
    });
    const selling = members.filter((m) => m.demand.units_8w > 0);
    const active = members.filter((m) => m.source_status === 'ACTIVE');
    const stockByClass = (cls) => sum(members.filter((m) => m.inventory.inventory_class === cls), (m) => m.inventory.stock_units);
    return {
      dimension, category_key: key, category: label, overlapping: dimension === 'collection',
      products_total: members.length, products_active: active.length, products_with_sales: selling.length,
      sell_rate: share(selling.length, active.length || members.length),
      revenue_share: share(block.demand.net_sales_ex_tax_8w, totals.net_sales_ex_tax),
      stock_value_share: share(block.inventory.stock_value_at_cost.value ?? 0, totals.stock_value),
      no_sale_stock_units: stockByClass('NO_SALE_IN_WINDOW'), slow_stock_units: stockByClass('SLOW_COVER'),
      no_sale_stock_share: share(stockByClass('NO_SALE_IN_WINDOW'), block.inventory.stock_units),
      benchmarks: {
        status: selling.length >= cfg.minPeersForBenchmark ? 'USABLE' : 'THIN',
        selling_products: selling.length, min_peers_required: cfg.minPeersForBenchmark,
        median_weekly_units_per_selling_product: median(selling.map((m) => m.demand.velocity_8w).filter((v) => v !== null)),
        median_units_per_order: median(selling.map((m) => m.demand.units_per_order?.median).filter((v) => v != null)),
        median_net_unit_price_ex_tax: median(selling.map((m) => m.demand.avg_net_unit_price_ex_tax).filter((v) => v != null)),
      },
      ...block,
    };
  });
  return out.sort((a, b) => b.demand.net_sales_ex_tax_8w - a.demand.net_sales_ex_tax_8w || a.category.localeCompare(b.category));
}

/** Concentration of a non-negative measure across items: top-N shares, Pareto counts, HHI. */
export function concentrationOf(items, measure) {
  const values = items.map(measure).filter((v) => v > 0).sort((a, b) => b - a);
  const total = sum(values, (v) => v);
  if (total <= 0) return { total: 0, items_with_value: 0, top_1: null, top_3: null, top_5: null, top_10: null, items_for_50pct: null, items_for_80pct: null, hhi: null };
  const top = (n) => share(sum(values.slice(0, n), (v) => v), total);
  const countFor = (target) => {
    let acc = 0;
    for (let i = 0; i < values.length; i += 1) { acc += values[i]; if (acc / total >= target) return i + 1; }
    return values.length;
  };
  return {
    total: round2(total), items_with_value: values.length,
    top_1: top(1), top_3: top(3), top_5: top(5), top_10: top(10),
    items_for_50pct: countFor(0.5), items_for_80pct: countFor(0.8),
    hhi: Math.round(sum(values, (v) => (v / total) ** 2) * 10000) / 10000,
  };
}

/** Where stock sits, by inventory class and stock quality, with its cost provenance. */
export function buildStockExposure(productFacts) {
  const stocked = productFacts.filter((p) => p.matched && p.inventory.stock_units > 0);
  const valueOf = (p) => p.inventory.stock_value_at_cost.value ?? 0;
  const groupBy = (keyFn) => {
    const g = {};
    for (const p of stocked) {
      const k = keyFn(p);
      g[k] ??= { products: 0, units: 0, value_at_cost: 0, units_without_cost: 0 };
      g[k].products += 1;
      g[k].units += p.inventory.stock_units;
      g[k].value_at_cost = round2(g[k].value_at_cost + valueOf(p));
      g[k].units_without_cost += p.inventory.stock_value_at_cost.units_without_cost;
    }
    return g;
  };
  const units = sum(stocked, (p) => p.inventory.stock_units);
  const withoutCost = sum(stocked, (p) => p.inventory.stock_value_at_cost.units_without_cost);
  const value = round2(sum(stocked, valueOf));
  const costStatuses = new Set(stocked.map((p) => p.inventory.stock_value_at_cost.cost_confidence).filter((c) => c !== 'NONE'));
  return {
    products_with_stock: stocked.length, total_units: units, units_without_cost: withoutCost, value_at_cost: value,
    value_status: withoutCost > 0 ? 'PARTIAL' : 'CALCULATED',
    value_cost_confidence: costStatuses.size === 1 ? [...costStatuses][0] : (costStatuses.size ? 'MIXED' : 'NONE'),
    by_inventory_class: groupBy((p) => p.inventory.inventory_class),
    by_stock_quality: groupBy((p) => p.inventory.stock_quality),
    concentration_by_value: concentrationOf(stocked, valueOf),
    concentration_by_units: concentrationOf(stocked, (p) => p.inventory.stock_units),
  };
}
