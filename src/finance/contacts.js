// Unified Contact domain (Phase 1 foundation, extended for Contacts V1). fin_companies is the ONE canonical
// store for both roles - this file never creates a second contacts table and never persists isCustomer/
// isSupplier as columns. Everything here is a pure, in-memory projection over already-loaded documents/
// supplier invoices, so a contacts list never costs a per-contact query (see buildContacts: one pass over
// pre-fetched arrays).
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
//   amountOverdue = the subset of amountReceivable whose effectiveStatus() is OVERDUE - same authority
//                (document.js), never a second overdue calculation.
//   amountPayable = sum of grossCents over that company's supplier invoices with status = 'TO_PAY' - the
//                exact definition already used for the Purchases "to pay" figure (inbox.js counts()/TO_PAY).
//   lastActivityAt = max(issueDate of linked issued sales docs, receivedAt of linked supplier invoices).
//   incomplete (V1) = a BUSINESS contact that is not structurally ready for Peppol e-invoicing (see
//                peppolReadiness below) - individuals are never "incomplete" (Peppol does not apply to them,
//                the same rule validatePeppolReadiness() already enforces per document).
//   archived (V1) = company.archivedAt is set. Archiving never deletes the contact or its documents.

import { effectiveStatus, settlement } from './document.js';
import { endpointOf } from './peppol.js';

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

/** A business contact's structural readiness for Peppol e-invoicing. This is the SAME real check
 * validatePeppolReadiness() uses per document (peppol.js: endpointOf(), vatNumber) - just company-scoped,
 * without the per-document fields (buyerReference, IBAN, currency...) that only make sense once an actual
 * invoice exists. Individuals are never "incomplete": Peppol does not apply to them, mirroring
 * validatePeppolReadiness()'s own PEPPOL_NOT_APPLICABLE_TO_INDIVIDUAL_CUSTOMERS rule. Never simulated. */
export function peppolReadiness(company) {
  if ((company.kind ?? 'business') !== 'business') return { applicable: false, ready: true, missing: [] };
  const missing = [];
  if (!company.vatNumber) missing.push('VAT_NUMBER_MISSING');
  if (!endpointOf(company)) missing.push('PEPPOL_ID_MISSING');
  return { applicable: true, ready: missing.length === 0, missing };
}

/** Display name: an individual is "First Last" when a first name exists; a company is its legal name. */
export function contactDisplayName(company) {
  return company.kind === 'individual' && company.firstName ? `${company.firstName} ${company.name}` : company.name;
}

/** A contact's roles: declared by the merchant, derived from real documents, and the effective union shown everywhere. */
export function contactRoles(company, { customerDocuments = 0, supplierDocuments = 0 } = {}) {
  const declared = { customer: company.declaredRoles?.customer === true, supplier: company.declaredRoles?.supplier === true };
  const fromDocuments = { customer: customerDocuments > 0, supplier: supplierDocuments > 0 };
  return { declared, fromDocuments, isCustomer: declared.customer || fromDocuments.customer, isSupplier: declared.supplier || fromDocuments.supplier };
}

/**
 * Role change guard (pure). A role supported by real documents can never be removed: the merchant keeps both roles or archives the contact.
 * Returns the problems (empty = allowed). Counts are the same "real activity" definitions as buildContacts (issued sales documents, linked
 * supplier invoices).
 */
export function roleChangeProblems(requested, { customerDocuments = 0, supplierDocuments = 0 } = {}) {
  const problems = [];
  if (!requested?.customer && customerDocuments > 0) problems.push({ role: 'customer', code: 'ROLE_CUSTOMER_HAS_DOCUMENTS', documents: customerDocuments });
  if (!requested?.supplier && supplierDocuments > 0) problems.push({ role: 'supplier', code: 'ROLE_SUPPLIER_HAS_DOCUMENTS', documents: supplierDocuments });
  return problems;
}

/** Obvious duplicates when there is no VAT / enterprise number to tell them apart: same normalised display name, not archived. */
export function possibleNameDuplicate(candidate, companies, { excludeId = null } = {}) {
  const n = normalizeName(contactDisplayName(candidate)); if (!n) return null;
  return companies.find((c) => c.id !== excludeId && !c.archivedAt && normalizeName(contactDisplayName(c)) === n) ?? null;
}

/** Real activity counts per contact (issued, non-cancelled sales documents; linked supplier invoices) - the definitions used everywhere here. */
export function activityCounts(companyId, { salesDocs, supplierInvoices }) {
  return {
    customerDocuments: salesDocs.filter(({ doc }) => doc.customer?.companyId === companyId && doc.lockedAt && doc.status !== 'CANCELLED').length,
    supplierDocuments: supplierInvoices.filter((inv) => inv.supplierCompanyId === companyId).length,
  };
}

/** One row of the /api/contacts projection. Pure - no I/O, everything is pre-fetched by the caller. */
function projectContact(company, { salesByCompany, supplierByCompany, m }) {
  const sales = salesByCompany.get(company.id) ?? { count: 0, receivableCents: 0, overdueCents: 0, overdueCount: 0, lastActivity: null };
  const supplier = supplierByCompany.get(company.id) ?? { count: 0, payableCents: 0, lastActivity: null };
  const lastActivityAt = [sales.lastActivity, supplier.lastActivity].filter(Boolean).sort().at(-1) ?? null;
  const peppol = peppolReadiness(company);
  const roles = contactRoles(company, { customerDocuments: sales.count, supplierDocuments: supplier.count });
  return {
    id: company.id, kind: company.kind, displayName: contactDisplayName(company), vatNumber: company.vatNumber, email: company.email ?? null, phone: company.phone ?? null,
    isCustomer: roles.isCustomer, isSupplier: roles.isSupplier, roles: { declared: roles.declared, fromDocuments: roles.fromDocuments },
    customerDocumentCount: sales.count, supplierDocumentCount: supplier.count,
    amountReceivableCents: sales.receivableCents, amountPayableCents: supplier.payableCents, amountOverdueCents: sales.overdueCents,
    amountReceivable: m(sales.receivableCents), amountPayable: m(supplier.payableCents), amountOverdue: m(sales.overdueCents),
    overdueCount: sales.overdueCount,
    lastActivityAt,
    archived: !!company.archivedAt,
    incomplete: peppol.applicable && !peppol.ready,
  };
}

/**
 * Builds the full Contacts projection in one pass over pre-fetched, merchant-scoped data - no per-contact
 * query. `salesDocs` is the loadDocsForReports() shape ({doc,payments,creditNotes}[]); `supplierInvoices`
 * is listSupplierInvoices() output; `companies` is listCompanies() output. `m` formats cents for display
 * (money() from pdf.js), matching every other finance projection in this codebase. `today` (YYYY-MM-DD) is
 * required to derive the OVERDUE subset via the same effectiveStatus() every other page uses.
 */
export function buildContacts({ companies, salesDocs, supplierInvoices, m, today }) {
  const salesByCompany = new Map();
  for (const { doc, payments, creditNotes } of salesDocs) {
    const cid = doc.customer?.companyId; if (!cid) continue;
    if (!doc.lockedAt || doc.status === 'CANCELLED') continue; // a draft alone is not "real" sales activity
    const cur = salesByCompany.get(cid) ?? { count: 0, receivableCents: 0, overdueCents: 0, overdueCount: 0, lastActivity: null };
    cur.count += 1;
    cur.lastActivity = [cur.lastActivity, doc.issueDate].filter(Boolean).sort().at(-1) ?? null;
    if (doc.type === 'invoice') {
      const s = settlement(doc, payments, creditNotes);
      if (['ISSUED', 'SENT', 'PARTIALLY_PAID'].includes(doc.status) && s.remainingCents > 0) {
        cur.receivableCents += s.remainingCents;
        if (today && effectiveStatus(doc, s, today) === 'OVERDUE') { cur.overdueCents += s.remainingCents; cur.overdueCount += 1; }
      }
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
 * left as an empty array rather than omitted, so the UI has a stable shape to read). */
export function contactDetail(company, { salesDocs, supplierInvoices, m, today }) {
  const linkedSales = salesDocs.filter(({ doc }) => doc.customer?.companyId === company.id && doc.lockedAt && doc.status !== 'CANCELLED');
  const linkedSupplier = supplierInvoices.filter((inv) => inv.supplierCompanyId === company.id);
  const salesRows = linkedSales.map(({ doc, payments, creditNotes }) => {
    const s = doc.type === 'invoice' ? settlement(doc, payments, creditNotes) : null;
    return { id: doc.id, type: doc.type, number: doc.number, issueDate: doc.issueDate, status: s ? effectiveStatus(doc, s, today) : doc.status, gross: m(doc.totals?.grossCents ?? 0), remaining: s ? m(s.remainingCents) : null };
  });
  const supplierRows = linkedSupplier.map((inv) => ({ id: inv.id, invoiceNumber: inv.invoiceNumber, issueDate: inv.issueDate, status: inv.status, gross: m(inv.grossCents ?? 0) }));
  const openInvoices = linkedSales.filter(({ doc }) => doc.type === 'invoice' && ['ISSUED', 'SENT', 'PARTIALLY_PAID'].includes(doc.status));
  const receivableCents = openInvoices.reduce((a, { doc, payments, creditNotes }) => a + settlement(doc, payments, creditNotes).remainingCents, 0);
  const overdue = openInvoices.filter(({ doc, payments, creditNotes }) => effectiveStatus(doc, settlement(doc, payments, creditNotes), today) === 'OVERDUE');
  const overdueCents = overdue.reduce((a, { doc, payments, creditNotes }) => a + settlement(doc, payments, creditNotes).remainingCents, 0);
  const payableCents = linkedSupplier.filter((inv) => inv.status === 'TO_PAY').reduce((a, inv) => a + (inv.grossCents ?? 0), 0);
  const peppol = peppolReadiness(company);
  const roles = contactRoles(company, { customerDocuments: salesRows.length, supplierDocuments: supplierRows.length });
  return {
    id: company.id, kind: company.kind, displayName: contactDisplayName(company), firstName: company.firstName ?? null, name: company.name,
    vatNumber: company.vatNumber, enterpriseNumber: company.enterpriseNumber,
    email: company.email ?? null, phone: company.phone ?? null, iban: company.iban ?? null, address: company.address ?? { street: null, postalCode: null, city: null, countryCode: null },
    notes: company.notes ?? null, archived: !!company.archivedAt, source: company.source ?? 'manual',
    isCustomer: roles.isCustomer, isSupplier: roles.isSupplier, roles: { declared: roles.declared, fromDocuments: roles.fromDocuments },
    customerDocumentCount: salesRows.length, supplierDocumentCount: supplierRows.length,
    amountReceivable: m(receivableCents), amountPayable: m(payableCents), amountOverdue: m(overdueCents), overdueCount: overdue.length,
    peppol: { applicable: peppol.applicable, ready: peppol.ready, missing: peppol.missing },
    salesDocuments: salesRows, supplierDocuments: supplierRows,
    transactions: [], // no bank<->contact relation exists yet - kept explicit, never fabricated
  };
}

/** Contacts V1 import: deterministic, conservative matching - identical philosophy to
 * matchSupplierInvoicesToContacts (VAT first, name second, ambiguous or absent -> never guess). A row with a
 * stable contact `id` matching an existing contact of the SAME merchant always wins (that is what the export's
 * own id column is for); otherwise VAT, then exact normalised name. Pure - performs no writes; the caller
 * decides whether to actually apply `toCreate`/`toUpdate` (dry run vs commit). */
export function planImport(rows, companies) {
  const byId = new Map(companies.map((c) => [c.id, c]));
  const byVat = new Map(); const byName = new Map();
  for (const c of companies) {
    const v = normalizeVat(c.vatNumber); if (v) { if (!byVat.has(v)) byVat.set(v, []); byVat.get(v).push(c); }
    const n = normalizeName(c.name); if (n) { if (!byName.has(n)) byName.set(n, []); byName.get(n).push(c); }
  }
  const toCreate = []; const toUpdate = []; const ambiguous = []; const errors = [];
  rows.forEach((row, i) => {
    const line = i + 2; // header is line 1
    const name = String(row.name ?? '').trim();
    if (!name) { errors.push({ line, reason: 'NAME_REQUIRED' }); return; }
    const kind = String(row.kind ?? '').trim().toLowerCase() === 'individual' ? 'individual' : 'business';
    const payload = {
      kind, name,
      vatNumber: String(row.vatNumber ?? '').trim() || undefined,
      enterpriseNumber: String(row.enterpriseNumber ?? '').trim() || undefined,
      email: String(row.email ?? '').trim() || undefined,
      address: { street: String(row.street ?? '').trim() || null, postalCode: String(row.postalCode ?? '').trim() || null, city: String(row.city ?? '').trim() || null, countryCode: (String(row.countryCode ?? '').trim() || 'BE').toUpperCase() },
    };
    const rawId = String(row.id ?? '').trim();
    if (rawId && byId.has(rawId)) { toUpdate.push({ line, id: rawId, patch: payload, matchedBy: 'id' }); return; }
    if (rawId && !byId.has(rawId)) { errors.push({ line, reason: 'ID_NOT_FOUND', id: rawId }); return; }
    const vNorm = normalizeVat(payload.vatNumber);
    if (vNorm) {
      const matches = byVat.get(vNorm) ?? [];
      if (matches.length === 1) { toUpdate.push({ line, id: matches[0].id, patch: payload, matchedBy: 'vat' }); return; }
      if (matches.length > 1) { ambiguous.push({ line, reason: 'AMBIGUOUS_VAT', name }); return; }
    }
    const nNorm = normalizeName(name);
    if (nNorm) {
      const matches = byName.get(nNorm) ?? [];
      if (matches.length === 1 && !vNorm) { toUpdate.push({ line, id: matches[0].id, patch: payload, matchedBy: 'name' }); return; }
      if (matches.length > 1 && !vNorm) { ambiguous.push({ line, reason: 'AMBIGUOUS_NAME', name }); return; }
    }
    toCreate.push({ line, payload });
  });
  return { toCreate, toUpdate, ambiguous, errors };
}

/** One export row - the stable contact id lets a re-import (planImport, above) update instead of
 * duplicating. Only fields the merchant actually entered are exported; nothing is inferred. */
export function contactExportRow(contact, company) {
  return {
    id: company.id, kind: company.kind, name: company.name, vatNumber: company.vatNumber ?? '', enterpriseNumber: company.enterpriseNumber ?? '',
    email: company.email ?? '', street: company.address?.street ?? '', postalCode: company.address?.postalCode ?? '', city: company.address?.city ?? '', countryCode: company.address?.countryCode ?? '',
    isCustomer: contact.isCustomer ? 'yes' : 'no', isSupplier: contact.isSupplier ? 'yes' : 'no', archived: company.archivedAt ? 'yes' : 'no', source: company.source ?? 'manual',
  };
}
