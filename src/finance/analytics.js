// Sales/Purchases analytics (unified Finance module, 2026-09-24). Pure, side-effect-free aggregation
// over already-loaded documents/supplier invoices - same discipline as contacts.js/receivables.js: no I/O,
// no per-row query, everything pre-fetched by the caller.
//
// IMPORTANT, real limitation of this data model (never worked around, never fabricated):
//   - A sales document line carries a real product identity ONLY when it was picked from the Retail Core
//     catalogue (line.catalog: {productId, variantId, productTitle, sku}) or has a manually-entered `sku`.
//     There is NO product category/collection field anywhere in a Finance document line - Retail Core's own
//     collections are not denormalised here. Category/collection-level analytics are therefore NOT built;
//     byProduct is the finest real grouping available.
//   - A supplier invoice has no line items at all (fin_supplier_invoices stores one net/vat/gross total per
//     document) - so Achats analytics can only ever be supplier/status/period level, never per-product.
// Both limits are surfaced explicitly in the returned shape (`productDataAvailable`, `note`) rather than
// silently omitted, so the UI can show an honest message instead of an empty-looking screen.

const inRange = (dateStr, from, to) => (!dateStr ? false : (!from || dateStr >= from) && (!to || dateStr <= to));

/**
 * @param {Array} salesDocs loadDocsForReports() shape: [{doc, payments, creditNotes}]
 * @param {{from?: string, to?: string, q?: string, m: (cents:number)=>string}} opts
 */
export function buildSalesAnalytics(salesDocs, { from, to, q, m }) {
  const qNorm = (q || '').trim().toLowerCase();
  const byKey = new Map(); // productKey -> { name, sku, qtyMilli, netCents, docIds:Set }
  let unattributedNetCents = 0; let unattributedQtyMilli = 0;
  let salesNetCents = 0; let creditNetCents = 0; let documentsCount = 0;
  const matchedDocIds = new Set();
  for (const { doc } of salesDocs) {
    if (!doc.lockedAt || doc.status === 'CANCELLED') continue;
    if (doc.type !== 'invoice' && doc.type !== 'credit_note') continue;
    if (!inRange(doc.issueDate, from, to)) continue;
    documentsCount += 1;
    const sign = doc.type === 'credit_note' ? -1 : 1;
    if (sign > 0) salesNetCents += doc.totals?.netCents ?? 0; else creditNetCents += doc.totals?.netCents ?? 0;
    for (const l of doc.totals?.lines ?? []) {
      const sku = l.catalog?.sku || l.sku || null;
      const name = l.catalog?.productTitle || l.description || 'Unlabelled line';
      const hasProduct = !!(l.catalog?.productId || sku);
      const netCents = (l.netCents ?? 0) * sign; const qtyMilli = (l.qtyMilli ?? 0) * sign;
      if (!hasProduct) { unattributedNetCents += netCents; unattributedQtyMilli += qtyMilli; continue; }
      const key = l.catalog?.productId ? `p:${l.catalog.productId}${l.catalog.variantId ? `:${l.catalog.variantId}` : ''}` : `sku:${sku}`;
      if (qNorm && !`${name} ${sku ?? ''}`.toLowerCase().includes(qNorm)) continue;
      const cur = byKey.get(key) ?? { name, sku, qtyMilli: 0, netCents: 0, docIds: new Set() };
      cur.qtyMilli += qtyMilli; cur.netCents += netCents; cur.docIds.add(doc.id);
      byKey.set(key, cur); matchedDocIds.add(doc.id);
    }
  }
  const byProduct = [...byKey.values()].map((p) => ({ name: p.name, sku: p.sku, qty: p.qtyMilli / 1000, revenueCents: p.netCents, revenue: m(p.netCents), docIds: [...p.docIds] })).sort((a, b) => b.revenueCents - a.revenueCents);
  return {
    from: from ?? null, to: to ?? null, documentsCount,
    salesNetCents, salesNet: m(salesNetCents), creditNetCents, creditNet: m(creditNetCents),
    netAfterCreditsCents: salesNetCents - creditNetCents, netAfterCredits: m(salesNetCents - creditNetCents),
    byProduct, unattributedNetCents, unattributedNet: m(unattributedNetCents), unattributedQty: unattributedQtyMilli / 1000,
    productDataAvailable: true,
    matchedDocIds: q ? [...matchedDocIds] : null,
  };
}

/**
 * Achats: supplier/status/period only - fin_supplier_invoices has no line items (see module note above).
 * @param {Array} supplierInvoices listSupplierInvoices() output
 */
export function buildPurchaseAnalytics(supplierInvoices, { from, to, q, m }) {
  const qNorm = (q || '').trim().toLowerCase();
  const bySupplier = new Map();
  let totalCents = 0; let documentsCount = 0;
  const STATUS_COUNTS = { RECEIVED: 0, TO_REVIEW: 0, VALIDATED: 0, TO_PAY: 0, PAID: 0, REJECTED: 0 };
  for (const inv of supplierInvoices) {
    if (!inRange(inv.issueDate, from, to)) continue;
    if (qNorm && !(inv.supplierName ?? '').toLowerCase().includes(qNorm)) continue;
    documentsCount += 1;
    if (inv.status in STATUS_COUNTS) STATUS_COUNTS[inv.status] += 1;
    if (inv.status !== 'REJECTED') {
      totalCents += inv.grossCents ?? 0;
      const cur = bySupplier.get(inv.supplierName) ?? { name: inv.supplierName, grossCents: 0, count: 0, docIds: [] };
      cur.grossCents += inv.grossCents ?? 0; cur.count += 1; cur.docIds.push(inv.id);
      bySupplier.set(inv.supplierName, cur);
    }
  }
  const bySupplierRows = [...bySupplier.values()].map((s) => ({ ...s, gross: m(s.grossCents) })).sort((a, b) => b.grossCents - a.grossCents);
  return {
    from: from ?? null, to: to ?? null, documentsCount, totalCents, total: m(totalCents),
    statusCounts: STATUS_COUNTS, bySupplier: bySupplierRows,
    productDataAvailable: false,
    note: 'Supplier invoices are stored as one total per document (net/VAT/gross) - there is no per-product line detail to break down.',
  };
}

/** Period reporting (Sales / Purchases / Credit notes / Net / doc counts) for a selected range - a compact,
 * ad hoc window (any from/to, not just a fiscal quarter). It complements, and deliberately does not
 * replace, the existing Accountant Pack (/api/pack, viewPack()), which remains the authoritative per-rate
 * VAT breakdown and export for closing a real fiscal period; the VAT figure here is the document-level
 * vat_cents already computed and stored by the finance engine, not a second computation. */
export function buildPeriodReport(salesDocs, supplierInvoices, { from, to }) {
  let invoicesCents = 0; let invoicesCount = 0; let creditCents = 0; let creditCount = 0; let vatCents = 0;
  for (const { doc } of salesDocs) {
    if (!doc.lockedAt || doc.status === 'CANCELLED' || !inRange(doc.issueDate, from, to)) continue;
    if (doc.type === 'invoice') { invoicesCents += doc.totals?.grossCents ?? 0; invoicesCount += 1; vatCents += doc.totals?.vatCents ?? 0; }
    else if (doc.type === 'credit_note') { creditCents += doc.totals?.grossCents ?? 0; creditCount += 1; vatCents -= doc.totals?.vatCents ?? 0; }
  }
  const purchases = supplierInvoices.filter((s) => s.status !== 'REJECTED' && inRange(s.issueDate, from, to));
  const purchasesCents = purchases.reduce((a, s) => a + (s.grossCents ?? 0), 0);
  return {
    from, to,
    sales: { grossCents: invoicesCents, count: invoicesCount },
    creditNotes: { grossCents: creditCents, count: creditCount },
    purchases: { grossCents: purchasesCents, count: purchases.length },
    netSalesAfterCreditsCents: invoicesCents - creditCents,
    vatCents,
  };
}
