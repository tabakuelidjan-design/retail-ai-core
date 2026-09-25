// Retail refunds as accounting rows. One row per source refund with EXPLICIT semantics - never a single ambiguous amount:
//   productAmount   money refunded on product lines (incl. VAT as presented by the source)
//   shippingAmount  shipping refunded (incl. VAT), from the source's refund shipping lines; null when the source data was not captured
//   otherAmount     anything else (manual adjustments; and shipping too when it was not captured)
//   amount          the TOTAL refund
// and the source order reference (for example "#1065"), so the accountant can find the order.

const num = (x) => Number(x ?? 0);
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const fmt = (x) => String(r2(x));

/** @param {{refunds?: object[], refundLines?: object[], orders?: object[]}} data raw retail rows @param {(isoDate: string) => boolean} inRange */
export function refundRows(data, inRange) {
  const orderById = new Map((data.orders ?? []).map((o) => [o.id, o]));
  const linesByRefund = new Map();
  for (const l of data.refundLines ?? []) (linesByRefund.get(l.refund_id) ?? linesByRefund.set(l.refund_id, []).get(l.refund_id)).push(l);
  return (data.refunds ?? []).filter((r) => inRange(String(r.refunded_at).slice(0, 10))).map((r) => {
    const order = orderById.get(r.order_id);
    const taxesIncluded = order ? order.taxes_included !== false : true;
    const product = (linesByRefund.get(r.id) ?? []).reduce((a, l) => a + num(l.amount) + (taxesIncluded ? 0 : num(l.tax_amount)), 0);
    const shippingCaptured = r.shipping_subtotal !== null && r.shipping_subtotal !== undefined;
    const shipping = shippingCaptured ? num(r.shipping_subtotal) + num(r.shipping_tax) : null;
    const total = num(r.amount);
    return {
      date: String(r.refunded_at).slice(0, 10), orderRef: order?.order_name ?? null,
      amount: fmt(total), productAmount: fmt(product), shippingAmount: shipping === null ? null : fmt(shipping), otherAmount: fmt(total - product - (shipping ?? 0)), shippingCaptured,
    };
  });
}

/** CSV columns shared by every export that lists refunds. */
export const REFUND_CSV_KEYS = ['date', 'commande', 'remboursement_produits', 'remboursement_livraison', 'remboursement_autre', 'remboursement_total', 'livraison_renseignee'];
export const refundCsvRows = (refunds) => refunds.map((r) => ({
  date: r.date, commande: r.orderRef ?? '', remboursement_produits: r.productAmount ?? '', remboursement_livraison: r.shippingAmount ?? '',
  remboursement_autre: r.otherAmount ?? '', remboursement_total: r.amount, livraison_renseignee: r.shippingCaptured === false ? 'non' : 'oui',
}));
