// Supabase-backed finance store: same interface as the in-memory store. The database triggers and unique indexes in
// migration 20260921200000 are the last line of defence; errors they raise are translated into FinanceError codes.

import { randomUUID } from 'node:crypto';
import { FinanceError } from './document.js';

const BODY_KEYS = ['language', 'validUntil', 'paymentTermsDays', 'paymentTerms', 'notes', 'customer', 'seller', 'lines', 'vat', 'acknowledgedNotDuplicate', 'creditReason', 'totals', 'stockReturn'];

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
    lockedAt: r.locked_at, snapshotHash: r.snapshot_hash, totals: b.totals ?? null, version: r.version, stockReturn: b.stockReturn ?? null,
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
      // merchant_id added as defense-in-depth (documentId is already a merchant-scoped handle in every
      // current caller, but this means a future caller can never read another tenant's events even by
      // passing the wrong id - see RLS proposal, query audit #3).
      const rows = await supabase.select('fin_events', { select: '*', document_id: eq(documentId), merchant_id: eq(merchantId), order: 'at.asc,id.asc' });
      return rows.map((r) => ({ id: r.id, documentId: r.document_id, merchantId: r.merchant_id, at: r.at, actor: r.actor, action: r.action, fromStatus: r.from_status, toStatus: r.to_status, detail: r.detail }));
    },
    /** Recent document lifecycle events across the whole merchant (dashboard "recent activity" feed) - read only, newest first. */
    async listEventsForMerchant({ limit = 20 } = {}) { // merchantId ignored (closured), kept in the call signature for parity with memory-store
      const rows = await supabase.select('fin_events', { select: '*', merchant_id: eq(merchantId), order: 'at.desc,id.desc', limit: String(limit) });
      return rows.map((r) => ({ id: r.id, documentId: r.document_id, merchantId: r.merchant_id, at: r.at, actor: r.actor, action: r.action, fromStatus: r.from_status, toStatus: r.to_status, detail: r.detail }));
    },

    async addPayment(p) {
      const [r] = await guard(() => supabase.insert('fin_payments', [{ merchant_id: p.merchantId ?? merchantId, document_id: p.documentId, amount_cents: p.amountCents, paid_on: p.paidOn, method: p.method, reference: p.reference ?? null, actor: p.actor ?? null }]));
      return { id: r.id, documentId: r.document_id, merchantId: r.merchant_id, amountCents: Number(r.amount_cents), paidOn: r.paid_on, method: r.method, reference: r.reference };
    },
    async listPayments(documentId) {
      // merchant_id added as defense-in-depth, same rationale as listEvents above.
      const rows = await supabase.select('fin_payments', { select: '*', document_id: eq(documentId), merchant_id: eq(merchantId), order: 'paid_on.asc,created_at.asc' });
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
        street: c.address?.street ?? null, postal_code: c.address?.postalCode ?? null, city: c.address?.city ?? null, country_code: c.address?.countryCode ?? null, contact_email: c.email ?? null, peppol_id: c.peppolId ?? null, source: c.source ?? 'manual', verified_at: c.verifiedAt ?? null, notes: c.notes ?? null };
      const [r] = await guard(() => supabase.insert('fin_companies', [row]));
      return companyFromRow(r);
    },
    async listCompanies() { return (await supabase.selectAll('fin_companies', { select: '*', merchant_id: eq(merchantId) })).map(companyFromRow); },
    async updateCompany(id, c) {
      // Deliberately does not touch archived_at: archiving/restoring is a separate, explicit action
      // (setCompanyArchived) so an ordinary "Edit" save can never silently resurrect an archived contact.
      const row = { kind: c.kind ?? 'business', name: c.name, enterprise_number: c.enterpriseNumber ?? null, vat_number: c.vatNumber ?? null, legal_form: c.legalForm ?? null,
        street: c.address?.street ?? null, postal_code: c.address?.postalCode ?? null, city: c.address?.city ?? null, country_code: c.address?.countryCode ?? null, contact_email: c.email ?? null, peppol_id: c.peppolId ?? null, notes: c.notes ?? null };
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
    /** Contacts V1: archive/restore a contact without touching any other field, and without ever deleting it
     * or its documents/relations. archivedAt=null restores; any ISO timestamp archives. */
    async setCompanyArchived(id, archivedAt) {
      const rows = await guard(() => supabase.update('fin_companies', { id: eq(id), merchant_id: eq(merchantId) }, { archived_at: archivedAt }));
      return rows?.[0] ? companyFromRow(rows[0]) : null;
    },
    async saveSupplierInvoice(s) {
      const [r] = await guard(() => supabase.insert('fin_supplier_invoices', [supplierToRow(s)]));
      return supplierFromRow(r);
    },
    async getSupplierInvoice(id) { const [r] = await supabase.select('fin_supplier_invoices', { select: '*', id: eq(id), merchant_id: eq(merchantId) }); return r ? supplierFromRow(r) : null; },
    async findSupplierInvoiceBySha(_m, sha) { const [r] = await supabase.select('fin_supplier_invoices', { select: '*', sha256: eq(sha), merchant_id: eq(merchantId) }); return r ? supplierFromRow(r) : null; },
    async updateSupplierInvoice(id, patch, expectedStatus) {
      const body = supplierToRow(patch, true);
      if ('status' in patch) body.payment_status = patch.status === 'PAID' ? 'paid' : 'unpaid';
      const r = await guard(() => supabase.update('fin_supplier_invoices', { id: eq(id), merchant_id: eq(merchantId), status: eq(expectedStatus) }, body));
      return r && r.length ? supplierFromRow(r[0]) : null;
    },
    /** Phase 1: link/unlink a supplier invoice to a fin_companies contact. Deliberately NOT gated by
     * status (unlike updateSupplierInvoice) - linking a contact is a separate concern from the review
     * workflow and must remain possible at any status, including after payment. contactId=null unlinks. */
    async setSupplierInvoiceContact(id, contactId) {
      const r = await guard(() => supabase.update('fin_supplier_invoices', { id: eq(id), merchant_id: eq(merchantId) }, { supplier_company_id: contactId }));
      return r && r.length ? supplierFromRow(r[0]) : null;
    },
    // ---- Bank & Treasury (read only) ----
    async saveBankConnection(c) {
      const row = { merchant_id: merchantId, provider: c.provider, token_ciphertext: c.tokenCipher, token_fingerprint: c.tokenFingerprint, scopes: c.scopes, account_ids: c.accountIds ?? [], granted_at: c.grantedAt, expires_at: c.expiresAt, revoked_at: null, last_used_at: null };
      await guard(() => supabase.delete('fin_bank_connections', { merchant_id: eq(merchantId) })); const [r] = await guard(() => supabase.insert('fin_bank_connections', [row])); return bankConnFromRow(r);
    },
    async getBankConnection() { const [r] = await supabase.select('fin_bank_connections', { select: '*', merchant_id: eq(merchantId) }); return r ? bankConnFromRow(r) : null; },
    async touchBankConnection(_m, at) { await supabase.update('fin_bank_connections', { merchant_id: eq(merchantId) }, { last_used_at: at }); },
    async revokeBankConnection(_m, at) { await supabase.update('fin_bank_connections', { merchant_id: eq(merchantId) }, { revoked_at: at, token_ciphertext: '' }); },
    async insertBankTransaction(t) {
      try { const [r] = await supabase.insert('fin_bank_transactions', [bankTxToRow(t)]); return { created: true, row: bankTxFromRow(r) }; } catch (e) {
        if (!/23505|duplicate key|unique/i.test(String(e.message))) throw translateDbError(e);
        const [ex] = await supabase.select('fin_bank_transactions', { select: '*', merchant_id: eq(merchantId), account_id: eq(t.accountId), provider_tx_id: eq(t.providerTxId) }); return { created: false, row: bankTxFromRow(ex) };
      }
    },
    async getBankTransaction(id) { const [r] = await supabase.select('fin_bank_transactions', { select: '*', id: eq(id), merchant_id: eq(merchantId) }); return r ? bankTxFromRow(r) : null; },
    async updateBankTransaction(id, patch, expectedStatus) {
      const map = { status: 'status', matchedKind: 'matched_kind', matchedDocumentId: 'matched_document_id', matchedPaymentId: 'matched_payment_id', matchedAmountCents: 'matched_amount_cents', matchedAt: 'matched_at' };
      const body = {}; for (const [k, v] of Object.entries(patch)) body[map[k]] = v;
      const r = await guard(() => supabase.update('fin_bank_transactions', { id: eq(id), merchant_id: eq(merchantId), status: eq(expectedStatus) }, body)); return r && r.length ? bankTxFromRow(r[0]) : null;
    },
    async listBankTransactions(f = {}) { const p = { select: '*', merchant_id: eq(merchantId) }; if (f.status) p.status = eq(f.status); return (await supabase.selectAll('fin_bank_transactions', p)).map(bankTxFromRow); },
    async upsertBankBalance(b) { await supabase.upsert('fin_bank_balances', [{ merchant_id: merchantId, account_id: b.accountId, iban: b.iban, balance_cents: b.balanceCents, currency: b.currency, as_of: b.asOf }], { onConflict: 'merchant_id,account_id' }); },
    // fin_bank_balances has no `id` column (its primary key is the composite merchant_id/account_id, by design -
    // one current balance row per account), so selectAll's default `order: 'id.asc'` pagination sort must be
    // overridden here or every call 400s with "column fin_bank_balances.id does not exist".
    async listBankBalances() { return (await supabase.selectAll('fin_bank_balances', { select: '*', merchant_id: eq(merchantId), order: 'account_id.asc' })).map((r) => ({ merchantId, accountId: r.account_id, iban: r.iban, balanceCents: Number(r.balance_cents), currency: r.currency, asOf: r.as_of })); },
    async insertCashCount(c) { const [r] = await guard(() => supabase.insert('fin_cash_counts', [{ merchant_id: merchantId, amount_cents: c.amountCents, counted_on: c.countedOn, note: c.note }])); return { id: r.id, merchantId, amountCents: Number(r.amount_cents), countedOn: r.counted_on, note: r.note, createdAt: r.created_at }; },
    async latestCashCount() { const [r] = await supabase.select('fin_cash_counts', { select: '*', merchant_id: eq(merchantId), order: 'counted_on.desc,created_at.desc', limit: '1' }); return r ? { id: r.id, merchantId, amountCents: Number(r.amount_cents), countedOn: r.counted_on, note: r.note, createdAt: r.created_at } : null; },
    async insertCashMovement(m) { const [r] = await guard(() => supabase.insert('fin_cash_movements', [{ merchant_id: merchantId, kind: m.kind, amount_cents: m.amountCents, date: m.date, note: m.note }])); return { id: r.id, merchantId, kind: r.kind, amountCents: Number(r.amount_cents), date: r.date, note: r.note, createdAt: r.created_at }; },
    async listCashMovements() { return (await supabase.selectAll('fin_cash_movements', { select: '*', merchant_id: eq(merchantId) })).map((r) => ({ id: r.id, merchantId, kind: r.kind, amountCents: Number(r.amount_cents), date: r.date, note: r.note, createdAt: r.created_at })); },
    async listSupplierInvoices() { return (await supabase.selectAll('fin_supplier_invoices', { select: '*', merchant_id: eq(merchantId) })).map(supplierFromRow); },

    // ---- Stock movement ledger (append-only; see stock.js) ----
    // stockToRow/stockFromRow already existed below, unused - the store side of this feature was never wired up
    // even though memory-store.js (used by tests) already implements it, and the migration/DB trigger enforcing
    // append-only + allowed-transitions-only was already live. Found while verifying the new tables end to end.
    async insertStockMovement(row) {
      try {
        const [r] = await guard(() => supabase.insert('fin_stock_movements', [stockToRow(row)]));
        return { created: true, row: stockFromRow(r) };
      } catch (e) {
        if (!/23505|duplicate key|unique/i.test(String(e.message))) throw translateDbError(e);
        const [ex] = await supabase.select('fin_stock_movements', { select: '*', merchant_id: eq(merchantId), idempotency_key: eq(row.idempotencyKey) });
        return { created: false, row: stockFromRow(ex) };
      }
    },
    async getStockMovement(id) { const [r] = await supabase.select('fin_stock_movements', { select: '*', id: eq(id), merchant_id: eq(merchantId) }); return r ? stockFromRow(r) : null; },
    async updateStockMovement(id, patch, expectedStatus) {
      const body = {}; for (const [k, v] of Object.entries(patch)) body[{ status: 'status', error: 'error', shopifyAdjustmentId: 'shopify_adjustment_id', appliedAt: 'applied_at', locationId: 'location_id', locationSourceId: 'location_source_id' }[k]] = v;
      const r = await guard(() => supabase.update('fin_stock_movements', { id: eq(id), merchant_id: eq(merchantId), status: eq(expectedStatus) }, body));
      return r && r.length ? stockFromRow(r[0]) : null;
    },
    async listStockMovements(f = {}) {
      const p = { select: '*', merchant_id: eq(merchantId), order: 'created_at.asc' };
      if (f.documentId) p.document_id = eq(f.documentId);
      if (f.status) p.status = eq(f.status);
      return (await supabase.selectAll('fin_stock_movements', p)).map(stockFromRow);
    },
  };
}

const SUPPLIER_MAP = { supplierName: 'supplier_name', supplierVatNumber: 'supplier_vat_number', invoiceNumber: 'invoice_number', issueDate: 'issue_date', dueDate: 'due_date', netCents: 'net_cents', vatCents: 'vat_cents', grossCents: 'gross_cents', currency: 'currency',
  source: 'source', status: 'status', paymentReference: 'payment_reference', fileName: 'file_name', contentType: 'content_type', sizeBytes: 'size_bytes', sha256: 'sha256', attachmentRef: 'attachment_ref', receivedAt: 'received_at', fromAddress: 'from_address',
  subject: 'subject', extraction: 'extraction', validatedAt: 'validated_at', paidAt: 'paid_at', paidAmountCents: 'paid_amount_cents', paidReference: 'paid_reference', rejectedReason: 'rejected_reason',
  // Phase 1 (Contact foundation): additive, nullable link to fin_companies - see 20260924090000_finance_supplier_company_link.
  // Naming follows the existing customer_company_id/companyId convention on fin_documents, not a new "contactId".
  supplierCompanyId: 'supplier_company_id' };
function supplierToRow(s, partial = false) { const r = {}; for (const [k, col] of Object.entries(SUPPLIER_MAP)) if (k in s) r[col] = s[k]; if (!partial) r.merchant_id = s.merchantId; return r; }
const supplierFromRow = (r) => { const s = { id: r.id, merchantId: r.merchant_id, paymentStatus: r.payment_status }; for (const [k, col] of Object.entries(SUPPLIER_MAP)) s[k] = r[col] ?? null; for (const k of ['netCents', 'vatCents', 'grossCents', 'paidAmountCents']) if (s[k] !== null) s[k] = Number(s[k]); return s; };
const bankConnFromRow = (r) => ({ merchantId: r.merchant_id, provider: r.provider, tokenCipher: r.token_ciphertext || null, tokenFingerprint: r.token_fingerprint, scopes: r.scopes, accountIds: r.account_ids, grantedAt: r.granted_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, lastUsedAt: r.last_used_at });
const bankTxToRow = (t) => ({ merchant_id: t.merchantId, account_id: t.accountId, provider_tx_id: t.providerTxId, date: t.date, amount_cents: t.amountCents, currency: t.currency, counterparty_name: t.counterpartyName, reference: t.reference, structured_reference: t.structuredReference, source: t.source, status: t.status });
const bankTxFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, accountId: r.account_id, providerTxId: r.provider_tx_id, date: r.date, amountCents: Number(r.amount_cents), currency: r.currency, counterpartyName: r.counterparty_name, reference: r.reference, structuredReference: r.structured_reference, source: r.source, status: r.status, matchedKind: r.matched_kind, matchedDocumentId: r.matched_document_id, matchedPaymentId: r.matched_payment_id, matchedAmountCents: r.matched_amount_cents == null ? null : Number(r.matched_amount_cents), matchedAt: r.matched_at, importedAt: r.imported_at });
const stockToRow = (m) => ({ merchant_id: m.merchantId, document_id: m.documentId, document_number: m.documentNumber, document_type: m.documentType, line_position: m.linePosition, kind: m.kind, variant_id: m.variantId, variant_source_id: m.variantSourceId, sku: m.sku, location_id: m.locationId, location_source_id: m.locationSourceId, quantity: m.quantity, delta: m.delta, status: m.status, error: m.error, idempotency_key: m.idempotencyKey });
const stockFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, documentId: r.document_id, documentNumber: r.document_number, documentType: r.document_type, linePosition: r.line_position, kind: r.kind, variantId: r.variant_id, variantSourceId: r.variant_source_id, sku: r.sku, locationId: r.location_id, locationSourceId: r.location_source_id, quantity: r.quantity, delta: r.delta, status: r.status, error: r.error, idempotencyKey: r.idempotency_key, shopifyAdjustmentId: r.shopify_adjustment_id, createdAt: r.created_at, appliedAt: r.applied_at });
const companyFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, kind: r.kind, name: r.name, enterpriseNumber: r.enterprise_number, vatNumber: r.vat_number, legalForm: r.legal_form,
  address: { street: r.street, postalCode: r.postal_code, city: r.city, countryCode: r.country_code }, email: r.contact_email, peppolId: r.peppol_id, source: r.source, verifiedAt: r.verified_at,
  notes: r.notes ?? null, archivedAt: r.archived_at ?? null });
