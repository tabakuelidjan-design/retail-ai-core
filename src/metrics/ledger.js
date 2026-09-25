// Joins raw synced rows into flat, typed "facts" that every metric reads.
// Pure: no I/O, no clock (now is passed in). All money stays in the order's
// own pricing basis; nothing is FX-converted and no tax rate is ever assumed -
// the real per-line tax amounts captured from the source are used.

import { COST_STATUS, resolveUnitCost } from './costs.js';

const num = (x) => Number(x);

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * @param {object} data rows as stored: orders, orderLines, refunds, refundLines, variants, products, costs, snapshots
 * @param {{config: object, currency?: string}} opts
 */
export function buildLedger(data, { config, currency } = {}) {
  const ledgerCurrency = currency ?? mostCommon(data.orders.map((o) => o.currency));
  const variantById = new Map(data.variants.map((v) => [v.id, v]));
  const productById = new Map(data.products.map((p) => [p.id, p]));

  const costsByVariant = new Map();
  for (const c of data.costs) {
    if (!costsByVariant.has(c.variant_id)) costsByVariant.set(c.variant_id, []);
    costsByVariant.get(c.variant_id).push(c);
  }

  const excluded = { test: 0, status: 0, otherCurrency: 0 };
  const orders = [];
  const orderById = new Map();
  for (const o of data.orders) {
    if (o.is_test) { excluded.test += 1; continue; }
    if (config.excludedOrderStatuses.includes(o.status)) { excluded.status += 1; continue; }
    if (o.currency !== ledgerCurrency) { excluded.otherCurrency += 1; continue; }
    const order = { id: o.id, name: o.order_name ?? null, orderedAt: new Date(o.ordered_at), status: o.status, taxesIncluded: o.taxes_included };
    orders.push(order);
    orderById.set(o.id, order);
  }

  const lineFacts = [];
  const lineFactById = new Map();
  for (const l of data.orderLines) {
    const order = orderById.get(l.order_id);
    if (!order) continue;
    const qty = num(l.quantity);
    const gross = qty * num(l.unit_price);
    const discount = num(l.discount_amount);
    const tax = num(l.tax_amount);
    const variant = l.variant_id ? variantById.get(l.variant_id) : null;
    const cost = l.variant_id
      ? resolveUnitCost(costsByVariant.get(l.variant_id), order.orderedAt, ledgerCurrency)
      : { status: COST_STATUS.MISSING, unit_cost: null, currency: null, source: null, basis: 'NONE', reason: 'NO_VARIANT' };
    const fact = {
      orderLineId: l.id, orderId: l.order_id, orderedAt: order.orderedAt, taxesIncluded: order.taxesIncluded,
      variantId: l.variant_id ?? null, productId: variant?.product_id ?? null,
      title: l.title_snapshot, sku: l.sku_snapshot ?? variant?.sku ?? null,
      qty, gross, discount, tax, taxRateBp: l.tax_rate_bp ?? null, // VAT rate as reported by the source (finance VAT-by-rate); not used by any metric formula
      exTaxBeforeRefund: order.taxesIncluded ? gross - discount - tax : gross - discount,
      cost,
    };
    lineFacts.push(fact);
    lineFactById.set(l.id, fact);
  }

  // Shipping charged per order, exactly as the source reported it. NULL columns = not captured (counted, never treated as zero).
  const shippingFacts = [];
  const shippingCoverage = { orders: 0, captured: 0, uncaptured: 0 };
  for (const o of data.orders) {
    const order = orderById.get(o.id);
    if (!order) continue;
    shippingCoverage.orders += 1;
    if (o.shipping_price === null || o.shipping_price === undefined) { shippingCoverage.uncaptured += 1; continue; }
    shippingCoverage.captured += 1;
    const gross = num(o.shipping_price); const discount = num(o.shipping_discount); const tax = num(o.shipping_tax);
    const charged = gross - discount;
    shippingFacts.push({
      orderId: o.id, orderName: order.name, orderedAt: order.orderedAt, taxesIncluded: order.taxesIncluded,
      gross, discount, tax, taxRateBp: o.shipping_tax_rate_bp ?? null, charged,
      // same convention as product lines: with taxes included the price contains the VAT, otherwise it is added on top
      exTax: order.taxesIncluded ? charged - tax : charged,
      inclTax: order.taxesIncluded ? charged : charged + tax,
    });
  }

  const refundById = new Map(data.refunds.map((r) => [r.id, r]));
  const refundFacts = [];
  const linesByRefund = new Map();
  for (const rl of data.refundLines) {
    const refund = refundById.get(rl.refund_id);
    const line = lineFactById.get(rl.order_line_id);
    if (!refund || !line) continue;
    const amount = num(rl.amount);
    const tax = num(rl.tax_amount);
    const fact = {
      refundId: rl.refund_id, orderLineId: rl.order_line_id, refundedAt: new Date(refund.refunded_at),
      variantId: line.variantId, productId: line.productId, qty: num(rl.quantity), amount, tax,
      exTax: line.taxesIncluded ? amount - tax : amount,
      cost: line.cost,
    };
    refundFacts.push(fact);
    if (!linesByRefund.has(rl.refund_id)) linesByRefund.set(rl.refund_id, []);
    linesByRefund.get(rl.refund_id).push({ fact, line });
  }

  // Refund money beyond the mapped product lines (shipping, manual adjustments):
  // reported, but not part of product net sales.
  const refundTotals = [];
  const shippingRefundFacts = [];
  for (const r of data.refunds) {
    if (!orderById.has(r.order_id)) continue;
    const mapped = (linesByRefund.get(r.id) ?? []).reduce(
      (a, { fact, line }) => a + fact.amount + (line.taxesIncluded ? 0 : fact.tax), 0);
    const shippingCaptured = r.shipping_subtotal !== null && r.shipping_subtotal !== undefined;
    const shipSub = shippingCaptured ? num(r.shipping_subtotal) : 0;
    const shipTax = shippingCaptured ? num(r.shipping_tax) : 0;
    const shippingAmount = shipSub + shipTax; // shipping refunded, incl. VAT
    if (shippingCaptured && (shipSub !== 0 || shipTax !== 0)) {
      shippingRefundFacts.push({ refundId: r.id, orderId: r.order_id, orderName: orderById.get(r.order_id).name, refundedAt: new Date(r.refunded_at), subtotal: shipSub, tax: shipTax, exTax: shipSub, inclTax: shippingAmount });
    }
    refundTotals.push({
      refundId: r.id, orderId: r.order_id, orderName: orderById.get(r.order_id).name, refundedAt: new Date(r.refunded_at),
      amount: num(r.amount), productAmount: mapped, shippingAmount, shippingCaptured,
      // refund money that is neither a mapped product line nor (captured) shipping: manual adjustments and, when shipping was not captured, shipping
      otherAmount: num(r.amount) - mapped - shippingAmount, lineCount: (linesByRefund.get(r.id) ?? []).length,
    });
  }

  // Latest snapshot per (variant, location); stock = sum across locations.
  const latest = new Map();
  for (const s of data.snapshots) {
    const key = `${s.variant_id}|${s.location_id}`;
    const prev = latest.get(key);
    if (!prev || new Date(s.synced_at) > new Date(prev.synced_at)) latest.set(key, s);
  }
  const stockByVariant = new Map();
  for (const s of latest.values()) {
    const cur = stockByVariant.get(s.variant_id) ?? { units: 0, snapshotAt: null };
    cur.units += num(s.quantity);
    const at = new Date(s.synced_at);
    if (!cur.snapshotAt || at > cur.snapshotAt) cur.snapshotAt = at;
    stockByVariant.set(s.variant_id, cur);
  }

  return {
    currency: ledgerCurrency, config, orders, lineFacts, refundFacts, refundTotals, shippingFacts, shippingRefundFacts, shippingCoverage,
    variantById, productById, costsByVariant, stockByVariant, excluded,
  };
}
