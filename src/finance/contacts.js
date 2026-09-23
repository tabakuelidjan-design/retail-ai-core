// Unified Contact domain (Phase 1 foundation). fin_companies is the ONE canonical store for both roles -
// this file never creates a second contacts table and never persists isCustomer/isSupplier as columns.
// Everything here is a pure, in-memory projection over already-loaded documents/supplier invoices, so a
// contacts list never costs a per-contact query (see buildContacts: one pass over pre-fetched arrays).
//
// Role definition (documented once, here, since the mandate asks that ambiguous definitions not be
// invented ad hoc elsewhere):
//   isCustomer = the company has at least one NON-CANCELLED, ISSUED sales document (quote, invoice or
//                credit note) linked via doc.customer.companyId. A draft alone does not establish the
//                relationship - "activité de vente réelle" is read as "something was actually issued",
//                the same bar `revenue` uses elsewhere in overview() (doc.lockedAt && status !== CANCELLED).
//   isSupplier = the company has at least one supplier invoice linked via supplierCompanyId (any status -
//                even a RECEIVED, not-yet-reviewed document is a real, if unconfirmed, supplier relationship).
//   amountReceivable = sum of settlement(doc, payments, creditNotes).remainingCents over that company's
//                OPEN invoices (ISSUED/SENT/PARTIALLY_PAID) - the exact definition receivables.js already
//                uses for "outstanding", not a new parallel one.
//   amountPayable = sum of grossCents over that company's supplier invoices with status = 'TO_PAY' - the
//                exact definition already used for the Purchases "to pay" figure (inbox.js counts()/TO_PAY).
//   lastActivityAt = max(issueDate of linked issued sales docs, receivedAt of linked supplier invoices).

import { effectiveStatus, settlement } from './document.js';

/** VAT normalisation for MATCHING only - never written back to a document or a company. Keeps the country
 * prefix (letters), strips presentation punctuation/whitespace, uppercases. "BE 0123.456.789" -> "BE0123456789". */
export function normalizeVat(v) {
  if (!v) return null;
  const s = String(v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s || null;
}

/** Name normalisation for MATCHING only - case/whitespace/trivial-punctuation only, never fuzzy. "Tyeso srl"
 * and "TYESO SRL" normalise equal; "Tyeso" and "Tyeso Europe" deliberately do not. */
export function normalizeName(n) {
  if (!n) return null;
  const s = String(n).trim().toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
  return s || null;
}

/**
 * Deterministic, side-effect-free supplier-to-contact matching (the Phase 1 backfill algorithm).
 * VAT first (exact match on the normalised form only); name second, only when VAT gave nothing usable.
 * Never fuzzy, never "first occurrence", never partial-address or email-domain matching - an ambiguous or
 * absent match always leaves the invoice unlinked rather than guessing.
 * @param {Array} supplierInvoices merchant-scoped, already includes supplierCompanyId
 * @param {Array} companies merchant-scoped fin_companies rows
 * @returns {{links: Array<{invoiceId,contactId,matchedBy}>, ambiguousVat: string[], ambiguousName: string[], unmatched: string[], alreadyLinked: string[]}}
 */
export function matchSupplierInvoicesToContacts(supplierInvoices, companies) {
  const byVat = new Map(); const byName = new Map();
  for (const c of companies) {
    const v = normalizeVat(c.vatNumber); if (v) { if (!byVat.has(v)) byVat.set(v, []); byVat.get(v).push(c); }
    const n = normalizeName(c.name); if (n) { if (!byName.has(n)) byName.set(n, []); byName.get(n).push(c); }
  }
  const result = { links: [], ambiguousVat: [], ambiguousName: [], unmatched: [], alreadyLinked: [] };
  for (const inv of supplierInvoices) {
    if (inv.supplierCompanyId) { result.alreadyLinked.push(inv.id); continue; }
    const vNorm = normalizeVat(inv.supplierVatNumber);
    if (vNorm) {
      const matches = byVat.get(vNorm) ?? [];
      if (matches.length === 1) { result.links.push({ invoiceId: inv.id, contactId: matches[0].id, matchedBy: 'vat' }); continue; }
      if (matches.length > 1) { result.ambiguousVat.push(inv.id); continue; }
      // 0 VAT matches: fall through to name matching below (per the mandate's step order).
    }
    const nNorm = normalizeName(inv.supplierName);
    if (nNorm) {
      const matches = byName.get(nNorm) ?? [];
      if (matches.length === 1) { result.links.push({ invoiceId: inv.id, contactId: matches[0].id, matchedBy: 'name' }); continue; }
      if (matches.length > 1) { result.ambiguousName.push(inv.id); continue; }
    }
    result.unmatched.push(inv.id);
  }
  return result;
}

/** One row of the /api/contacts projection. Pure - no I/O, everything is pre-fetched by the caller. */
function projectContact(company, { salesByCompany, supplierByCompany, lang, m }) {
  const sales = salesByCompany.get(company.id) ?? { count: 0, receivableCents: 0, lastActivity: null };
  const supplier = supplierByCompany.get(company.id) ?? { count: 0, payableCents: 0, lastActivity: null };
  const lastActivityAt = [sales.lastActivity, supplier.lastActivity].filter(Boolean).sort().at(-1) ?? null;
  return {
    id: company.id, kind: company.kind, displayName: company.name, vatNumber: company.vatNumber,
    isCustomer: sales.count > 0, isSupplier: supplier.count > 0,
    customerDocumentCount: sales.count, supplierDocumentCount: supplier.count,
    amountReceivableCents: sales.receivableCents, amountPayableCents: supplier.payableCents,
    amountReceivable: m(sales.receivableCents), amountPayable: m(supplier.payableCents),
    lastActivityAt,
  };
}

/**
 * Builds the full Contacts projection in one pass over pre-fetched, merchant-scoped data - no per-contact
 * query. `salesDocs` is the loadDocsForReports() shape ({doc,payments,creditNotes}[]); `supplierInvoices`
 * is listSupplierInvoices() output; `companies` is listCompanies() output. `m` formats cents for display
 * (money() from pdf.js), matching every other finance projection in this codebase.
 */
export function buildContacts({ companies, salesDocs, supplierInvoices, m }) {
  const salesByCompany = new Map();
  for (const { doc, payments, creditNotes } of salesDocs) {
    const cid = doc.customer?.companyId; if (!cid) continue;
    if (!doc.lockedAt || doc.status === 'CANCELLED') continue; // a draft alone is not "real" sales activity
    const cur = salesByCompany.get(cid) ?? { count: 0, receivableCents: 0, lastActivity: null };
    cur.count += 1;
    cur.lastActivity = [cur.lastActivity, doc.issueDate].filter(Boolean).sort().at(-1) ?? null;
    if (doc.type === 'invoice') {
      const s = settlement(doc, payments, creditNotes);
      if (['ISSUED', 'SENT', 'PARTIALLY_PAID'].includes(doc.status) && s.remainingCents > 0) cur.receivableCents += s.remainingCents;
    }
    salesByCompany.set(cid, cur);
  }
  const supplierByCompany = new Map();
  for (const inv of supplierInvoices) {
    const cid = inv.supplierCompanyId; if (!cid) continue;
    const cur = supplierByCompany.get(cid) ?? { count: 0, payableCents: 0, lastActivity: null };
    cur.count += 1;
    cur.lastActivity = [cur.lastActivity, inv.receivedAt?.slice(0, 10), inv.issueDate].filter(Boolean).sort().at(-1) ?? null;
    if (inv.status === 'TO_PAY') cur.payableCents += inv.grossCents ?? 0;
    supplierByCompany.set(cid, cur);
  }
  return companies.map((c) => projectContact(c, { salesByCompany, supplierByCompany, m }));
}

/** Detail projection for a single contact: identity + role-scoped document lists + amounts. No transaction
 * list unless a real link exists (Phase 1 has no bank<->contact relation yet, so it is always empty here -
 * left as an empty array rather than omitted, so the Phase 2 UI has a stable shape to read). */
export function contactDetail(company, { salesDocs, supplierInvoices, m, today }) {
  const linkedSales = salesDocs.filter(({ doc }) => doc.customer?.companyId === company.id && doc.lockedAt && doc.status !== 'CANCELLED');
  const linkedSupplier = supplierInvoices.filter((inv) => inv.supplierCompanyId === company.id);
  const salesRows = linkedSales.map(({ doc, payments, creditNotes }) => {
    const s = doc.type === 'invoice' ? settlement(doc, payments, creditNotes) : null;
    return { id: doc.id, type: doc.type, number: doc.number, issueDate: doc.issueDate, status: s ? effectiveStatus(doc, s, today) : doc.status, gross: m(doc.totals?.grossCents ?? 0), remaining: s ? m(s.remainingCents) : null };
  });
  const supplierRows = linkedSupplier.map((inv) => ({ id: inv.id, invoiceNumber: inv.invoiceNumber, issueDate: inv.issueDate, status: inv.status, gross: m(inv.grossCents ?? 0) }));
  const receivableCents = linkedSales.filter(({ doc }) => doc.type === 'invoice' && ['ISSUED', 'SENT', 'PARTIALLY_PAID'].includes(doc.status)).reduce((a, { doc, payments, creditNotes }) => a + settlement(doc, payments, creditNotes).remainingCents, 0);
  const payableCents = linkedSupplier.filter((inv) => inv.status === 'TO_PAY').reduce((a, inv) => a + (inv.grossCents ?? 0), 0);
  return {
    id: company.id, kind: company.kind, displayName: company.name, vatNumber: company.vatNumber, enterpriseNumber: company.enterpriseNumber,
    address: { street: company.street, postalCode: company.postalCode, city: company.city, countryCode: company.countryCode },
    isCustomer: salesRows.length > 0, isSupplier: supplierRows.length > 0,
    amountReceivable: m(receivableCents), amountPayable: m(payableCents),
    salesDocuments: salesRows, supplierDocuments: supplierRows,
    transactions: [], // no bank<->contact relation exists yet (Phase 1 scope) - kept explicit, never fabricated
  };
}
