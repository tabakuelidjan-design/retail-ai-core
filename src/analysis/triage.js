// Economic-data triage: how much of the economics can be trusted, and which
// manual corrections matter most. Pure and deterministic, facts only. It never
// estimates a missing value; where something cannot be computed it says why.

import { COST_STATUS, resolveUnitCost } from '../metrics/costs.js';
import { windowFacts } from '../metrics/sales.js';

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 10000 : null);
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

/** Priority of a variant with no usable cost. Shared by triage and the MISSING_COST flag. */
export function missingCostPriority({ unitsSold, stockUnits }, config) {
  if (unitsSold > 0) return 'P0'; // sold inside the available order window
  if (stockUnits >= config.triage.minMeaningfulStock) return 'P1';
  return 'P2';
}

/**
 * P0: missing cost + sold in the window. P1: missing cost + meaningful stock, not sold.
 * P2: missing cost + neither. Impact is revenue (P0) and units (P1); stock value at cost
 * is UNAVAILABLE by definition (no cost), and a retail value needs prices we do not store.
 */
export function buildCostTriage(ledger, window, now) {
  const { lines } = windowFacts(ledger, window);
  const soldByVariant = new Map();
  for (const l of lines) {
    if (!l.variantId) continue;
    const cur = soldByVariant.get(l.variantId) ?? { units: 0, revenue: 0 };
    cur.units += l.qty;
    cur.revenue += l.exTaxBeforeRefund;
    soldByVariant.set(l.variantId, cur);
  }

  const groups = { P0: [], P1: [], P2: [] };
  const reasons = {};
  for (const v of ledger.variantById.values()) {
    const cost = resolveUnitCost(ledger.costsByVariant.get(v.id), now, ledger.currency);
    if (cost.status !== COST_STATUS.MISSING) continue;
    const sold = soldByVariant.get(v.id) ?? { units: 0, revenue: 0 };
    const stockUnits = Math.max(0, ledger.stockByVariant.get(v.id)?.units ?? 0);
    reasons[cost.reason] = (reasons[cost.reason] ?? 0) + 1;
    groups[missingCostPriority({ unitsSold: sold.units, stockUnits }, ledger.config)].push({
      variant_id: v.id, product_id: v.product_id, product_title: ledger.productById.get(v.product_id)?.title ?? null,
      variant_title: v.title ?? null, reason: cost.reason, units_sold: sold.units,
      revenue_ex_tax: round2(sold.revenue), stock_units: stockUnits,
    });
  }

  const summarise = (items) => ({
    variants: items.length,
    products: new Set(items.map((i) => i.product_id)).size,
    units_sold: sum(items, (i) => i.units_sold),
    revenue_ex_tax: round2(sum(items, (i) => i.revenue_ex_tax)),
    stock_units: sum(items, (i) => i.stock_units),
    items: items.sort((a, b) => b.revenue_ex_tax - a.revenue_ex_tax || b.stock_units - a.stock_units),
  });

  const unmatched = lines.filter((l) => !l.variantId);
  return {
    window: window.key,
    rule: 'P0 sold in window; P1 not sold but stock >= triage.minMeaningfulStock; P2 neither',
    P0: summarise(groups.P0),
    P1: { ...summarise(groups.P1), stock_value_at_cost: 'UNAVAILABLE_NO_COST' },
    P2: summarise(groups.P2),
    unmatched_sold_lines: { lines: unmatched.length, revenue_ex_tax: round2(sum(unmatched, (l) => l.exTaxBeforeRefund)) },
    reasons,
  };
}

/** Where the window's revenue (ex tax, before refunds) stands on cost trust. */
export function buildProfitUncertainty(ledger, window) {
  const { lines } = windowFacts(ledger, window);
  const total = sum(lines, (l) => l.exTaxBeforeRefund);
  const by = (pred) => round2(sum(lines.filter(pred), (l) => l.exTaxBeforeRefund));
  const revenue = {
    total_ex_tax: round2(total),
    cost_verified: by((l) => l.cost.status === COST_STATUS.VERIFIED),
    cost_unverified: by((l) => l.cost.status === COST_STATUS.UNVERIFIED),
    cost_estimated_or_stale: by((l) => [COST_STATUS.ESTIMATED, COST_STATUS.STALE].includes(l.cost.status)),
    cost_missing: by((l) => l.cost.status === COST_STATUS.MISSING),
  };
  const costed = round2(total - revenue.cost_missing);
  return {
    window: window.key,
    revenue_ex_tax: revenue,
    shares: {
      cost_verified: pct(revenue.cost_verified, total),
      cost_unverified: pct(revenue.cost_unverified, total),
      cost_missing: pct(revenue.cost_missing, total),
    },
    cost_applied_to_history_revenue_ex_tax: by((l) => l.cost.status !== COST_STATUS.MISSING && l.cost.basis === 'CURRENT_COST_APPLIED_TO_HISTORY'),
    production_cost: {
      modelled: false,
      revenue_potentially_affected_ex_tax: costed,
      identifiable_subset: null,
      why_not_identifiable: 'product_costs holds one purchased unit cost per variant; no production-cost component is stored, and the synced data carries no product type, tag or "personalised" flag that says which products need one. Every costed line is therefore potentially affected; the exact subset needs merchant configuration.',
    },
  };
}

/** Largest stock positions by value at cost, for physical-count verification. Round quantity is a descriptive fact, not a verdict. */
export function buildLargestStockPositions(ledger, now, config) {
  const rows = [];
  for (const v of ledger.variantById.values()) {
    const units = ledger.stockByVariant.get(v.id)?.units ?? 0;
    if (units <= 0) continue;
    const cost = resolveUnitCost(ledger.costsByVariant.get(v.id), now, ledger.currency);
    rows.push({
      variant_id: v.id, product_title: ledger.productById.get(v.product_id)?.title ?? null, variant_title: v.title ?? null,
      stock_units: units, unit_cost: cost.unit_cost, cost_status: cost.status,
      value_at_cost: cost.unit_cost === null ? null : round2(units * cost.unit_cost),
      round_quantity: units >= 100 && units % 50 === 0,
    });
  }
  const valued = rows.filter((r) => r.value_at_cost !== null);
  return {
    total_stock_units: sum(rows, (r) => r.stock_units),
    total_value_at_cost: round2(sum(valued, (r) => r.value_at_cost)),
    units_without_cost: sum(rows.filter((r) => r.value_at_cost === null), (r) => r.stock_units),
    round_quantity_units: sum(rows.filter((r) => r.round_quantity), (r) => r.stock_units),
    round_quantity_rule: 'stock_units >= 100 and a multiple of 50',
    largest: valued.sort((a, b) => b.value_at_cost - a.value_at_cost).slice(0, config.triage.largestStockPositions),
  };
}
