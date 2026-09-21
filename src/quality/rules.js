// Deterministic data-quality rules. Pure: raw rows in, flag candidates out.
// Each flag: rule_code, entity_type, entity_id, severity, details. Rules only
// fire on conditions that affect a metric or a decision - harmless conditions
// (a never-sold, out-of-stock variant without cost) produce no flag.

import { COST_STATUS, resolveUnitCost } from '../metrics/costs.js';

export const RULE_CODES = [
  'MISSING_COST',
  'DUPLICATE_SKU_OBSERVATION',
  'SUSPICIOUS_FINANCIAL_VALUE',
  'UNMATCHED_HISTORICAL_VARIANT',
  'REFUND_WITHOUT_EXPECTED_MAPPING',
  'STALE_INVENTORY_SNAPSHOT',
];

const HOUR_MS = 60 * 60 * 1000;
const flag = (rule_code, entity_type, entity_id, severity, details) => ({ rule_code, entity_type, entity_id, severity, details });

/**
 * @param {object} data raw rows: variants, orders, orderLines, refunds, refundLines, costs
 * @param {object} ledger from buildLedger (stock per variant, cost lookups)
 * @param {{merchantId: string, now: Date, config: object}} ctx
 */
export function detectQualityFlags(data, ledger, { merchantId, now, config }) {
  const flags = [];
  const soldUnits = new Map();
  for (const l of ledger.lineFacts) {
    if (l.variantId) soldUnits.set(l.variantId, (soldUnits.get(l.variantId) ?? 0) + l.qty);
  }

  // MISSING_COST: only variants that were sold or hold stock.
  for (const v of data.variants) {
    const sold = soldUnits.get(v.id) ?? 0;
    const stock = ledger.stockByVariant.get(v.id)?.units ?? 0;
    if (sold === 0 && stock <= 0) continue;
    const cost = resolveUnitCost(ledger.costsByVariant.get(v.id), now, ledger.currency);
    if (cost.status !== COST_STATUS.MISSING) continue;
    flags.push(flag('MISSING_COST', 'variant', v.id, sold > 0 ? 'warning' : 'info', {
      sku: v.sku ?? null, reason: cost.reason, units_sold_in_history: sold, stock_units: stock,
    }));
  }

  // DUPLICATE_SKU_OBSERVATION: one flag per SKU string shared by >1 variant.
  const bySku = new Map();
  for (const v of data.variants) {
    const sku = v.sku?.trim();
    if (!sku) continue;
    if (!bySku.has(sku)) bySku.set(sku, []);
    bySku.get(sku).push(v);
  }
  for (const [sku, group] of bySku) {
    if (group.length < 2) continue;
    const ids = group.map((v) => v.id).sort();
    const anySold = ids.some((id) => (soldUnits.get(id) ?? 0) > 0);
    flags.push(flag('DUPLICATE_SKU_OBSERVATION', 'variant', ids[0], anySold ? 'warning' : 'info', {
      sku, variant_count: ids.length, variant_ids: ids, distinct_products: new Set(group.map((v) => v.product_id)).size,
    }));
  }

  // SUSPICIOUS_FINANCIAL_VALUE: negative amounts, non-positive quantity, discount above gross, zero price, non-positive cost.
  for (const l of data.orderLines) {
    const qty = Number(l.quantity);
    const price = Number(l.unit_price);
    const discount = Number(l.discount_amount);
    const tax = Number(l.tax_amount);
    const problems = [];
    if (price < 0) problems.push('NEGATIVE_UNIT_PRICE');
    if (qty <= 0) problems.push('NON_POSITIVE_QUANTITY');
    if (discount < 0) problems.push('NEGATIVE_DISCOUNT');
    if (tax < 0) problems.push('NEGATIVE_TAX');
    if (price >= 0 && discount > qty * price + 0.005) problems.push('DISCOUNT_EXCEEDS_GROSS');
    const severity = problems.length > 0 ? 'warning' : null;
    if (severity) flags.push(flag('SUSPICIOUS_FINANCIAL_VALUE', 'order_line', l.id, severity, { problems, quantity: qty, unit_price: price, discount_amount: discount, tax_amount: tax }));
    else if (price === 0) flags.push(flag('SUSPICIOUS_FINANCIAL_VALUE', 'order_line', l.id, 'info', { problems: ['ZERO_UNIT_PRICE'], quantity: qty, unit_price: price }));
  }
  for (const c of data.costs) {
    if (Number(c.unit_cost) <= 0) {
      flags.push(flag('SUSPICIOUS_FINANCIAL_VALUE', 'variant', c.variant_id, 'warning', { problems: ['NON_POSITIVE_COST'], unit_cost: Number(c.unit_cost) }));
    }
  }

  // UNMATCHED_HISTORICAL_VARIANT: a sold line that no longer maps to a catalog variant.
  for (const l of data.orderLines) {
    if (l.variant_id) continue;
    flags.push(flag('UNMATCHED_HISTORICAL_VARIANT', 'order_line', l.id, 'warning', {
      title_snapshot: l.title_snapshot, sku_snapshot: l.sku_snapshot ?? null, quantity: Number(l.quantity),
    }));
  }

  // REFUND_WITHOUT_EXPECTED_MAPPING: a refund with money but no product line attached.
  const linesPerRefund = new Map();
  for (const rl of data.refundLines) linesPerRefund.set(rl.refund_id, (linesPerRefund.get(rl.refund_id) ?? 0) + 1);
  for (const r of data.refunds) {
    if (Number(r.amount) > 0 && !linesPerRefund.get(r.id)) {
      flags.push(flag('REFUND_WITHOUT_EXPECTED_MAPPING', 'refund', r.id, 'warning', { amount: Number(r.amount), refunded_at: r.refunded_at }));
    }
  }

  // STALE_INVENTORY_SNAPSHOT: merchant-level, so one stale sync is one flag - not one per variant.
  const latest = [...ledger.stockByVariant.values()].reduce((m, s) => (s.snapshotAt && (!m || s.snapshotAt > m) ? s.snapshotAt : m), null);
  const maxAgeMs = config.quality.staleInventoryHours * HOUR_MS;
  if (!latest) {
    flags.push(flag('STALE_INVENTORY_SNAPSHOT', 'merchant', merchantId, 'critical', { reason: 'NO_SNAPSHOT_EXISTS' }));
  } else if (now - latest > maxAgeMs) {
    flags.push(flag('STALE_INVENTORY_SNAPSHOT', 'merchant', merchantId, 'warning', {
      latest_snapshot_at: latest.toISOString(), age_hours: Math.round((now - latest) / HOUR_MS), max_age_hours: config.quality.staleInventoryHours,
    }));
  }

  return flags;
}
