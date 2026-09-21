// Supabase-backed finance store: same interface as the in-memory store. The database triggers and unique indexes in
// migration 20260921200000 are the last line of defence; errors they raise are translated into FinanceError codes.

import { randomUUID } from 'node:crypto';
import { FinanceError } from './document.js';

const BODY_KEYS = ['language', 'validUntil', 'paymentTermsDays', 'paymentTerms', 'notes', 'customer', 'seller', 'lines', 'vat', 'acknowledgedNotDuplicate', 'creditReason', 'totals'];

export function docToRow(doc) {
  return {
    id: doc.id, merchant_id: doc.merchantId, doc_type: doc.type, status: doc.status, number: doc.number, currency: doc.currency,
    issue_date: doc.issueDate, due_date: doc.dueDate, net_cents: doc.totals?.netCents ?? null, vat_cents: doc.totals?.vatCents ?? null, gross_cents: doc.totals?.grossCents ?? null,
    revenue_basis: doc.revenueBasis, source_order_id: doc.sourceOrderId, related_document_id: doc.relatedDocumentId, converted_invoice_id: doc.convertedInvoiceId,
    customer_company_id: doc.customer?.companyId ?? null, locked_at: doc.lockedAt, snapshot_hash: doc.snapshotHash, version: doc.version,
    body: Object.fromEntries(BODY_KEYS.map((k) => [k, doc[k] ?? null])),
  };
}

export function rowToDoc(r) {
  const b = r.body ?? {};
  return {
    id: r.id, merchantId: r.merchant_id, type: r.doc_type, status: r.status, number: r.number, currency: r.currency, language: b.language ?? 'fr',
    issueDate: r.issue_date, dueDate: r.due_date, validUntil: b.validUntil ?? null, paymentTermsDays: b.paymentTermsDays ?? null, paymentTerms: b.paymentTerms ?? null, notes: b.notes ?? null,
    customer: b.customer ?? {}, seller: b.seller ?? null, lines: b.lines ?? [], vat: b.vat ?? { regime: null, confirmed: false, mention: null },
    revenueBasis: r.revenue_basis, sourceOrderId: r.source_order_id, acknowledgedNotDuplicate: b.acknowledgedNotDuplicate === true,
    relatedDocumentId: r.related_document_id, creditReason: b.creditReason ?? null, convertedInvoiceId: r.converted_invoice_id,
    lockedAt: r.locked_at, snapshotHash: r.snapshot_hash, totals: b.totals ?? null, version: r.version,
  };
}

/** Translate a database error into a domain error the service and CLI understand. */
export function translateDbError(err) {
  const m = String(err?.message ?? err);
  if (m.includes('fin_documents_number_uq')) return new FinanceError('DUPLICATE_DOCUMENT_NUMBER');
  if (m.includes('fin_documents_one_invoice_per_order_uq')) return new FinanceError('SOURCE_ORDER_ALREADY_INVOICED');
  if (m.includes('FIN_CONCURRENT_MODIFICATION')) return new FinanceError('CONCURRENT_MODIFICATION', 'document changed or was already issued');
  if (m.includes('FIN_NOT_FOUND')) return new FinanceError('DOCUMENT_NOT_FOUND');
  if (m.includes('is immutable') || m.includes('cannot be deleted')) return new FinanceError('LOCKED_DOCUMENT_CANNOT_CHANGE', 'refused by the database');
  if (m.includes('append-only')) return new FinanceError('APPEND_ONLY_TABLE', 'refused by the database');
  return err;
}

export function createSupabaseFinanceStore(supabase, { merchantId }) {
  const guard = async (fn) => { try { return await fn(); } catch (e) { throw translateDbError(e); } };
  const eq = (v) => `eq.${v}`;

  return {
    newId: () => randomUUID(),

    async getDocument(id) {
      const rows = await supabase.select('fin_documents', { select: '*', id: eq(id), merchant_id: eq(merchantId) });
      return rows[0] ? rowToDoc(rows[0]) : null;
    },

    async saveDocument(doc, expectedVersion = null) {
      return guard(async () => {
        const row = docToRow(doc);
        if (expectedVersion === null) { const [saved] = await supabase.insert('fin_documents', [row]); return rowToDoc(saved); }
        const rows = await supabase.update('fin_documents', { id: eq(doc.id), merchant_id: eq(merchantId), version: eq(expectedVersion) }, row);
        if (!rows?.length) throw new FinanceError('CONCURRENT_MODIFICATION', `document ${doc.id} changed since it was read`);
        return rowToDoc(rows[0]);
      });
    },

    async deleteDocument(id) { return guard(() => supabase.delete('fin_documents', { id: eq(id), merchant_id: eq(merchantId) })); },

    async listDocuments(f = {}) {
      const p = { select: '*', merchant_id: eq(merchantId) };
      if (f.type) p.doc_type = eq(f.type);
      if (f.status) p.status = eq(f.status);
      if (f.sourceOrderId !== undefined) p.source_order_id = f.sourceOrderId === null ? 'is.null' : eq(f.sourceOrderId);
      if (f.relatedDocumentId !== undefined) p.related_document_id = f.relatedDocumentId === null ? 'is.null' : eq(f.relatedDocumentId);
      return (await supabase.selectAll('fin_documents', p)).map(rowToDoc);
    },

    async appendEvent(e) {
      await guard(() => supabase.insert('fin_events', [{ merchant_id: e.merchantId ?? merchantId, document_id: e.documentId, at: e.at, actor: e.actor, action: e.action, from_status: e.fromStatus ?? null, to_status: e.toStatus ?? null, detail: e.detail ?? null }]));
    },
    async listEvents(documentId) {
      const rows = await supabase.select('fin_events', { select: '*', document_id: eq(documentId), order: 'at.asc,id.asc' });
      return rows.map((r) => ({ id: r.id, documentId: r.document_id, merchantId: r.merchant_id, at: r.at, actor: r.actor, action: r.action, fromStatus: r.from_status, toStatus: r.to_status, detail: r.detail }));
    },

    async addPayment(p) {
      const [r] = await guard(() => supabase.insert('fin_payments', [{ merchant_id: p.merchantId ?? merchantId, document_id: p.documentId, amount_cents: p.amountCents, paid_on: p.paidOn, method: p.method, reference: p.reference ?? null, actor: p.actor ?? null }]));
      return { id: r.id, documentId: r.document_id, merchantId: r.merchant_id, amountCents: Number(r.amount_cents), paidOn: r.paid_on, method: r.method, reference: r.reference };
    },
    async listPayments(documentId) {
      const rows = await supabase.select('fin_payments', { select: '*', document_id: eq(documentId), order: 'paid_on.asc,created_at.asc' });
      return rows.map((r) => ({ id: r.id, documentId: r.document_id, merchantId: r.merchant_id, amountCents: Number(r.amount_cents), paidOn: r.paid_on, method: r.method, reference: r.reference }));
    },
    async listPaymentsForMerchant() {
      const rows = await supabase.selectAll('fin_payments', { select: '*', merchant_id: eq(merchantId) });
      return rows.map((r) => ({ id: r.id, documentId: r.document_id, merchantId: r.merchant_id, amountCents: Number(r.amount_cents), paidOn: r.paid_on, method: r.method, reference: r.reference }));
    },

    /** ATOMIC issue through the fin_issue_document() RPC: number allocation, lock, hash and audit event in one DB transaction. */
    async issueDocument({ docId, expectedVersion, newStatus, numbering, year, canonical, placeholder, lockedAt, event }) {
      const row = await guard(() => supabase.rpc('fin_issue_document', {
        p_merchant: merchantId, p_doc_id: docId, p_expected_version: expectedVersion, p_new_status: newStatus,
        p_prefix: numbering.prefix, p_pad: numbering.pad, p_format: numbering.format, p_year: year,
        p_canonical: canonical, p_placeholder: placeholder, p_locked_at: lockedAt, p_event: event,
      }));
      return rowToDoc(row);
    },
    async peekNextNumber(_merchantId, type, year) {
      const r = (await supabase.select('fin_number_sequences', { select: 'last_number', merchant_id: eq(merchantId), doc_type: eq(type), year: eq(year) }))[0];
      return (r ? Number(r.last_number) : 0) + 1;
    },

    async allocateNumber(_merchantId, type, year) { return Number(await supabase.rpc('fin_next_number', { p_merchant: merchantId, p_type: type, p_year: year })); },

    async saveCompany(c) {
      const row = { merchant_id: merchantId, kind: c.kind ?? 'business', name: c.name, enterprise_number: c.enterpriseNumber ?? null, vat_number: c.vatNumber ?? null, legal_form: c.legalForm ?? null,
        street: c.address?.street ?? null, postal_code: c.address?.postalCode ?? null, city: c.address?.city ?? null, country_code: c.address?.countryCode ?? null, contact_email: c.email ?? null, peppol_id: c.peppolId ?? null, source: c.source ?? 'manual', verified_at: c.verifiedAt ?? null };
      const [r] = await guard(() => supabase.insert('fin_companies', [row]));
      return companyFromRow(r);
    },
    async listCompanies() { return (await supabase.selectAll('fin_companies', { select: '*', merchant_id: eq(merchantId) })).map(companyFromRow); },
    async updateCompany(id, c) {
      const row = { kind: c.kind ?? 'business', name: c.name, enterprise_number: c.enterpriseNumber ?? null, vat_number: c.vatNumber ?? null, legal_form: c.legalForm ?? null,
        street: c.address?.street ?? null, postal_code: c.address?.postalCode ?? null, city: c.address?.city ?? null, country_code: c.address?.countryCode ?? null, contact_email: c.email ?? null, peppol_id: c.peppolId ?? null };
      const rows = await guard(() => supabase.update('fin_companies', { id: eq(id), merchant_id: eq(merchantId) }, row));
      return rows?.[0] ? companyFromRow(rows[0]) : null;
    },
    async getCompany(id) { const r = (await supabase.select('fin_companies', { select: '*', id: eq(id), merchant_id: eq(merchantId) }))[0]; return r ? companyFromRow(r) : null; },
    async findCompany(_m, { vatNumber, enterpriseNumber }) {
      const p = { select: '*', merchant_id: eq(merchantId) };
      if (vatNumber) p.vat_number = eq(vatNumber); else if (enterpriseNumber) p.enterprise_number = eq(enterpriseNumber); else return null;
      const r = (await supabase.select('fin_companies', p))[0];
      return r ? companyFromRow(r) : null;
    },
    async saveSupplierInvoice(s) {
      const [r] = await guard(() => supabase.insert('fin_supplier_invoices', [{ merchant_id: merchantId, supplier_name: s.supplierName, supplier_vat_number: s.supplierVatNumber, invoice_number: s.invoiceNumber, issue_date: s.issueDate, due_date: s.dueDate, net_cents: s.netCents, vat_cents: s.vatCents, gross_cents: s.grossCents, currency: s.currency, payment_status: s.paymentStatus, source: s.source, attachment_ref: s.attachmentRef }]));
      return r;
    },
    async listSupplierInvoices() { return supabase.selectAll('fin_supplier_invoices', { select: '*', merchant_id: eq(merchantId) }); },
  };
}

const companyFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, kind: r.kind, name: r.name, enterpriseNumber: r.enterprise_number, vatNumber: r.vat_number, legalForm: r.legal_form,
  address: { street: r.street, postalCode: r.postal_code, city: r.city, countryCode: r.country_code }, email: r.contact_email, peppolId: r.peppol_id, source: r.source, verifiedAt: r.verified_at });
