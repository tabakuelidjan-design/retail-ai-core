// Nordla sales semantics - the two timelines of a refund. Every Growth page computes sales through this module, so the same
// window always gives the same net sales on every page (owner decision 2026-09-28, Growth deep audit P1-1).
//
// A. NET SALES (commercial performance: sales, products, store, customers, comparisons between periods)
//    A sale belongs to the date of its ORDER. Every refund of that order's lines reduces THAT order's net, whatever the refund
//    date. A refund of an old order therefore never creates a "negative sale" in the current period: it lowers the old period.
//    -> orderNetFacts() / netSalesInWindow() / netSalesByProduct()
//
// B. REFUND ACTIVITY (explicit analyses of refunds: refunds issued during a period, refund events, refund trends)
//    A refund belongs to the date it was ISSUED, whatever the order date.
//    -> refundActivity()
//
// Never mix A and B in one figure. Note: Analytics' Explorer (frozen module) reports window revenue with refunds dated by the
// refund (B inside A); Growth does not reuse that convention for sales figures.
//
// Pure: ledger in (metrics/ledger.js), plain facts out. Amounts are ex tax, rounded to the cent.

import { aggregate } from './sales.js';
import { productKeyOf } from './products.js';

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const inWindow = (t, w) => t >= w.start && t < w.end;

/**
 * A. One entry per order of the ledger: its date, its net sales ex tax after ALL refunds of its lines, its units.
 * @returns {Map<string, { orderId, orderedAt: Date, net: number, units: number, unitsRefunded: number,
 *   lines: Array<{ orderLineId, productId, productKey, units, unitsRefunded, net }> }>}
 */
export function orderNetFacts(ledger, config) {
  const refundsByLine = new Map();
  for (const r of ledger.refundFacts) (refundsByLine.get(r.orderLineId) ?? refundsByLine.set(r.orderLineId, []).get(r.orderLineId)).push(r);
  const byOrder = new Map(ledger.orders.map((o) => [o.id, { orderId: o.id, orderedAt: o.orderedAt, net: 0, units: 0, unitsRefunded: 0, lines: [] }]));
  for (const l of ledger.lineFacts) {
    const o = byOrder.get(l.orderId);
    if (!o) continue;
    const a = aggregate([l], refundsByLine.get(l.orderLineId) ?? [], config);
    o.lines.push({ orderLineId: l.orderLineId, productId: l.productId ?? null, productKey: productKeyOf(l), units: a.units_sold, unitsRefunded: a.units_refunded, net: a.net_sales_ex_tax });
    o.net += a.net_sales_ex_tax; o.units += a.units_sold; o.unitsRefunded += a.units_refunded;
  }
  for (const o of byOrder.values()) o.net = round2(o.net);
  return byOrder;
}

/** A. Orders placed in [window.start, window.end) - optionally filtered - with their order-dated net sales. */
export function netSalesInWindow(orderFacts, window, keep = () => true) {
  let net = 0; let orders = 0; let units = 0; let unitsRefunded = 0;
  for (const o of orderFacts.values()) {
    if (!inWindow(o.orderedAt, window) || !keep(o)) continue;
    net += o.net; orders += 1; units += o.units; unitsRefunded += o.unitsRefunded;
  }
  return { net: round2(net), orders, units, unitsRefunded };
}

/**
 * A. Per product (key = productKeyOf: the catalog product id, or the unmatched item's key) for the orders placed in the window.
 * @returns {Map<string, { net: number, units: number, unitsRefunded: number, orders: number }>}
 */
export function netSalesByProduct(orderFacts, window, keep = () => true) {
  const m = new Map();
  for (const o of orderFacts.values()) {
    if (!inWindow(o.orderedAt, window) || !keep(o)) continue;
    const seen = new Set();
    for (const l of o.lines) {
      const x = m.get(l.productKey) ?? { net: 0, units: 0, unitsRefunded: 0, orders: 0 };
      x.net += l.net; x.units += l.units; x.unitsRefunded += l.unitsRefunded;
      if (!seen.has(l.productKey)) { x.orders += 1; seen.add(l.productKey); }
      m.set(l.productKey, x);
    }
  }
  for (const x of m.values()) x.net = round2(x.net);
  return m;
}

/** B. Refunds ISSUED in [window.start, window.end), whatever the order date: count, units, amount ex tax. */
export function refundActivity(ledger, window) {
  const rs = ledger.refundFacts.filter((r) => inWindow(r.refundedAt, window));
  return { refundLines: rs.length, units: rs.reduce((a, r) => a + r.qty, 0), amountExTax: round2(rs.reduce((a, r) => a + r.exTax, 0)) };
}
