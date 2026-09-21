// Shopify/POS linkage and double-counting protection.
// Retail Core is the ONLY source of revenue for orders it already knows. An invoice therefore declares a revenue basis:
//   linked_source_order  documents an existing shop/POS sale: never additive to revenue
//   standalone_b2b       a new sale outside the shop: additive
// This module derives order totals from the validated ledger (never a second definition of sales) and applies
// deterministic checks. Hard failures block issuance; anomalies are reported in the accountant pack.

const cents = (x) => Math.round(x * 100 + Number.EPSILON);
const DAY = 86400000;

/** Order totals incl. tax, in cents, from the Phase 2A ledger line facts (gross - discount [+ tax when prices exclude tax]). */
export function orderTotalsFromLedger(ledger) {
  const m = new Map(ledger.orders.map((o) => [o.id, { orderId: o.id, at: o.orderedAt, grossCents: 0, refundedCents: 0 }]));
  for (const l of ledger.lineFacts) {
    const t = m.get(l.orderId);
    if (t) t.grossCents += cents(l.gross - l.discount + (l.taxesIncluded ? 0 : l.tax));
  }
  const orderOfLine = new Map(ledger.lineFacts.map((l) => [l.orderLineId, l.orderId]));
  for (const r of ledger.refundFacts) { const t = m.get(orderOfLine.get(r.orderLineId)); if (t) t.refundedCents += cents(r.amount); }
  return m;
}

/**
 * @param {object} doc invoice or credit note
 * @param {{orderTotals: Map|null, invoices: object[], dupWindowDays: number, toleranceCents: number}} ctx
 * @returns {{errors: string[], warnings: string[], checks: object}}
 */
export function checkLinkage(doc, { orderTotals, invoices, dupWindowDays = 3, toleranceCents = 1 }) {
  const errors = [];
  const warnings = [];
  const checks = { source_order_verified: 'not_applicable', duplicate_scan: 'not_run' };
  if (doc.type === 'quote') return { errors, warnings, checks };

  if (doc.revenueBasis === 'linked_source_order') {
    const t = orderTotals?.get(doc.sourceOrderId);
    if (!orderTotals) { errors.push('SOURCE_ORDER_UNVERIFIABLE_NO_RETAIL_DATA'); checks.source_order_verified = 'not_run'; }
    else if (!t) { errors.push('SOURCE_ORDER_NOT_FOUND_IN_RETAIL_CORE'); checks.source_order_verified = 'failed'; }
    else {
      checks.source_order_verified = 'ok';
      if (doc.type === 'invoice' && Math.abs(t.grossCents - (doc.totals.grossCents + (doc.totals.roundingCents ?? 0))) > toleranceCents) warnings.push(`LINKED_AMOUNT_DIFFERS_FROM_SOURCE_ORDER (invoice ${(doc.totals.grossCents + (doc.totals.roundingCents ?? 0))}, order ${t.grossCents} cents)`);
    }
    if (doc.type === 'invoice') {
      const other = invoices.filter((i) => i.type === 'invoice' && i.id !== doc.id && i.sourceOrderId === doc.sourceOrderId && i.status !== 'CANCELLED');
      if (other.length) errors.push('SOURCE_ORDER_ALREADY_INVOICED');
    }
  }

  if (doc.type === 'invoice' && doc.revenueBasis === 'standalone_b2b') {
    if (!orderTotals) { checks.duplicate_scan = 'not_run'; warnings.push('DUPLICATE_SCAN_SKIPPED_NO_RETAIL_DATA'); }
    else {
      checks.duplicate_scan = 'ok';
      const linked = new Set(invoices.filter((i) => i.type === 'invoice' && i.sourceOrderId && i.status !== 'CANCELLED').map((i) => i.sourceOrderId));
      const at = Date.parse(`${doc.issueDate}T00:00:00Z`);
      const suspects = [...orderTotals.values()].filter((t) => !linked.has(t.orderId) && Math.abs(t.grossCents - (doc.totals.grossCents + (doc.totals.roundingCents ?? 0))) <= toleranceCents && Math.abs(t.at - at) <= dupWindowDays * DAY);
      if (suspects.length) {
        checks.duplicate_scan = 'suspected';
        if (!doc.acknowledgedNotDuplicate) errors.push(`POSSIBLE_DUPLICATE_OF_SHOP_SALE (${suspects.length} unlinked order(s) with the same total within ${dupWindowDays} days): link it, or acknowledge it is a separate sale`);
        else warnings.push('POSSIBLE_DUPLICATE_ACKNOWLEDGED_BY_MERCHANT');
      }
    }
  }
  return { errors, warnings, checks };
}

/** Is this document additive to revenue on top of Retail Core? Only issued standalone invoices/credit notes are. */
export function isAdditiveRevenue(doc) {
  return doc.type !== 'quote' && doc.revenueBasis === 'standalone_b2b' && ['ISSUED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'CREDITED'].includes(doc.status);
}
