// Product / variant performance: deterministic aggregation, rankings and
// fact-based segments. Segments expose facts + the exact criteria used; they
// never label a product "good" or "bad".

import { COST_STATUS, resolveUnitCost, weakestStatus } from './costs.js';
import { aggregate, windowFacts } from './sales.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

function salesCostStatus(lines) {
  if (lines.length === 0) return 'NO_SALES';
  const known = lines.filter((l) => l.cost.status !== COST_STATUS.MISSING);
  if (known.length === 0) return COST_STATUS.MISSING;
  if (known.length < lines.length) return 'PARTIAL_MISSING';
  return weakestStatus(known.map((l) => l.cost.status));
}

export function stockValue(ledger, variantIds, now) {
  let units = 0;
  let value = 0;
  let unitsWithoutCost = 0;
  const statuses = [];
  for (const id of variantIds) {
    const stock = ledger.stockByVariant.get(id);
    if (!stock || stock.units <= 0) continue;
    units += stock.units;
    const cost = resolveUnitCost(ledger.costsByVariant.get(id), now, ledger.currency);
    if (cost.status === COST_STATUS.MISSING) { unitsWithoutCost += stock.units; continue; }
    value += stock.units * cost.unit_cost;
    statuses.push(cost.status);
  }
  let status = 'NO_STOCK';
  if (units > 0) {
    if (unitsWithoutCost === units) status = 'UNCLASSIFIED';
    else status = unitsWithoutCost > 0 ? 'PARTIAL' : 'CALCULATED';
  }
  return {
    units,
    inventory_value_at_cost: {
      value: status === 'UNCLASSIFIED' || status === 'NO_STOCK' ? null : round2(value),
      status,
      units_without_cost: unitsWithoutCost,
      cost_confidence: statuses.length ? weakestStatus(statuses) : 'NONE',
    },
  };
}

// A line with no catalog variant has no canonical identity. It is grouped by
// its title snapshot for display only. SKU is never an identity: it is nullable
// and shared across different products in real data.
function unmatchedKey(fact) {
  return `unmatched:${fact.title}`;
}

function productKeyOf(fact) {
  return fact.productId ?? unmatchedKey(fact);
}

/** One row per catalog product (including products with no sales) plus one row per unmatched historical item sold. */
export function buildProductPerformance(ledger, window, now) {
  const { lines, refunds } = windowFacts(ledger, window);
  const variantsByProduct = new Map();
  for (const v of ledger.variantById.values()) {
    if (!variantsByProduct.has(v.product_id)) variantsByProduct.set(v.product_id, []);
    variantsByProduct.get(v.product_id).push(v.id);
  }

  const linesByKey = new Map();
  const refundsByKey = new Map();
  const lastSale = new Map();
  for (const l of ledger.lineFacts) {
    const k = productKeyOf(l);
    if (!lastSale.has(k) || l.orderedAt > lastSale.get(k)) lastSale.set(k, l.orderedAt);
  }
  for (const l of lines) push(linesByKey, productKeyOf(l), l);
  for (const r of refunds) push(refundsByKey, r.productId ?? unmatchedKeyForRefund(ledger, r), r);

  const keys = new Set([...ledger.productById.keys(), ...linesByKey.keys(), ...refundsByKey.keys()]);
  const rows = [];
  for (const key of keys) {
    const product = ledger.productById.get(key);
    const pLines = linesByKey.get(key) ?? [];
    const pRefunds = refundsByKey.get(key) ?? [];
    const agg = aggregate(pLines, pRefunds, ledger.config);
    const stock = product ? stockValue(ledger, variantsByProduct.get(key) ?? [], now) : null;
    const last = lastSale.get(key) ?? null;
    rows.push({
      product_key: key,
      product_id: product ? key : null,
      title: product?.title ?? pLines[0]?.title ?? 'Unmatched historical item',
      matched: Boolean(product),
      ...agg,
      refund_rate: agg.units_sold > 0 ? Math.round((agg.units_refunded / agg.units_sold) * 10000) / 10000 : null,
      cost_status: salesCostStatus(pLines),
      stock_units: stock?.units ?? 0,
      inventory_value_at_cost: stock?.inventory_value_at_cost ?? null,
      last_sale_at: last ? last.toISOString() : null,
      days_since_last_sale: last ? Math.floor((now - last) / DAY_MS) : null,
    });
  }
  return rows;
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function unmatchedKeyForRefund(ledger, refundFact) {
  const line = ledger.lineFacts.find((l) => l.orderLineId === refundFact.orderLineId);
  return line ? productKeyOf(line) : 'unmatched:unknown';
}

export function buildVariantPerformance(ledger, window) {
  const { lines, refunds } = windowFacts(ledger, window);
  const byVariant = new Map();
  for (const l of lines) push(byVariant, l.variantId ?? unmatchedKey(l), { l });
  const refundsByVariant = new Map();
  for (const r of refunds) push(refundsByVariant, r.variantId ?? unmatchedKeyForRefund(ledger, r), r);
  return [...byVariant.entries()].map(([key, items]) => {
    const vLines = items.map((i) => i.l);
    const variant = ledger.variantById.get(key);
    return {
      variant_key: key, sku: variant?.sku ?? vLines[0].sku ?? null, title: variant?.title ?? vLines[0].title,
      ...aggregate(vLines, refundsByVariant.get(key) ?? [], ledger.config),
      cost_status: salesCostStatus(vLines),
    };
  });
}

const profitValue = (row, field) => row[field].value;

function entry(row, extra) {
  return {
    product_key: row.product_key, title: row.title, units_sold: row.units_sold,
    net_sales_ex_tax: row.net_sales_ex_tax, cost_status: row.cost_status,
    cost_confidence: row.contribution_margin_v0.cost_confidence,
    caveats: row.contribution_margin_v0.caveats, ...extra,
  };
}

/** Top-N lists. Profit rankings skip UNCLASSIFIED rows (reported separately as missing-cost facts). */
export function buildRankings(rows, n = 10) {
  const sold = rows.filter((r) => r.units_sold > 0);
  const top = (list, key) => list.sort((a, b) => key(b) - key(a) || a.title.localeCompare(b.title)).slice(0, n);
  const calculable = (field) => sold.filter((r) => profitValue(r, field) !== null);
  return {
    top_revenue: top([...sold], (r) => r.net_sales_ex_tax).map((r) => entry(r, {})),
    top_units: top([...sold], (r) => r.units_sold).map((r) => entry(r, {})),
    top_gross_profit: top(calculable('gross_profit'), (r) => profitValue(r, 'gross_profit'))
      .map((r) => entry(r, { gross_profit: r.gross_profit.value, gross_profit_status: r.gross_profit.status })),
    top_contribution_margin: top(calculable('contribution_margin_v0'), (r) => profitValue(r, 'contribution_margin_v0'))
      .map((r) => entry(r, {
        contribution_margin_v0: r.contribution_margin_v0.value, margin_pct: r.contribution_margin_v0.margin_pct,
        cm_status: r.contribution_margin_v0.status,
      })),
  };
}

/** Fact segments with their exact criteria echoed back. */
export function buildSegments(rows, config) {
  const s = config.segments;
  const cm = (r) => r.contribution_margin_v0.margin_pct;
  const brief = (r) => ({
    product_key: r.product_key, title: r.title, units_sold: r.units_sold, stock_units: r.stock_units,
    days_since_last_sale: r.days_since_last_sale, cost_status: r.cost_status,
    inventory_value_at_cost: r.inventory_value_at_cost, refund_rate: r.refund_rate, margin_pct: cm(r),
  });
  const catalog = rows.filter((r) => r.matched);
  return {
    low_selling_inventory: {
      criteria: `stock_units >= ${s.lowSelling.minStock} and 1 <= units_sold <= ${s.lowSelling.maxUnits} in window`,
      items: catalog.filter((r) => r.stock_units >= s.lowSelling.minStock && r.units_sold >= 1 && r.units_sold <= s.lowSelling.maxUnits).map(brief),
    },
    stock_with_no_recent_sales: {
      criteria: `stock_units >= ${s.noRecentSales.minStock} and units_sold = 0 in window`,
      items: catalog.filter((r) => r.stock_units >= s.noRecentSales.minStock && r.units_sold === 0).map(brief),
    },
    sales_with_missing_cost: {
      criteria: 'units_sold >= 1 in window and cost_status is MISSING or PARTIAL_MISSING',
      items: rows.filter((r) => r.units_sold >= 1 && (r.cost_status === 'MISSING' || r.cost_status === 'PARTIAL_MISSING')).map(brief),
    },
    high_refunds: {
      criteria: `units_sold >= ${s.highRefunds.minUnits} and refund_rate >= ${s.highRefunds.minRate} in window`,
      items: rows.filter((r) => r.units_sold >= s.highRefunds.minUnits && r.refund_rate !== null && r.refund_rate >= s.highRefunds.minRate).map(brief),
    },
    strong_sales_margin_stock: {
      criteria: `units_sold >= ${s.strong.minUnits}, contribution margin % >= ${s.strong.minMarginPct}, stock_units >= ${s.strong.minStock}, cost not MISSING`,
      items: catalog.filter((r) => r.units_sold >= s.strong.minUnits && cm(r) !== null && cm(r) >= s.strong.minMarginPct
        && r.stock_units >= s.strong.minStock && r.cost_status !== 'MISSING').map(brief),
    },
  };
}
