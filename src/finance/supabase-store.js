// Supabase-backed finance store: same interface as the in-memory store. The database triggers and unique indexes in
// migration 20260921200000 are the last line of defence; errors they raise are translated into FinanceError codes.

import { legalStoreMethods } from './supabase-store-legal.js';
import { randomUUID } from 'node:crypto';
import { FinanceError } from './document.js';
import { txAmounts } from './bank-ledger.js';

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
  // same supplier + number (+ type, once 20260926160000 is applied): the same purchase document already exists
  if (m.includes('fin_supplier_invoice_type_uq') || m.includes('fin_supplier_invoice_uq')) return new FinanceError('DUPLICATE_SUPPLIER_INVOICE');
  if (m.includes('FIN_CONCURRENT_MODIFICATION')) return new FinanceError('CONCURRENT_MODIFICATION', 'document changed or was already issued');
  if (m.includes('FIN_NOT_FOUND')) return new FinanceError('DOCUMENT_NOT_FOUND');
  // rules enforced by the P0 integrity triggers (migration 20261003090000): the message starts with FIN_<CODE>; the domain code is the same without the prefix
  const fin = /\bFIN_([A-Z_]+)\b/.exec(m);
  if (fin) { const RENAMED = { ALLOCATION_EXCEEDS_REMAINING: 'PAYMENT_EXCEEDS_REMAINING', BANK_TX_ALREADY_CLAIMED: 'BANK_TRANSACTION_ALREADY_CLAIMED' }; return new FinanceError(RENAMED[fin[1]] ?? fin[1], m.slice(m.indexOf(fin[0]) + fin[0].length).replace(/^:\s*/, '').split('"')[0].slice(0, 200)); }
  // legal artifacts / Peppol messages (migration 20261006090000)
  if (/fin_artifacts_payment_reference_uq/.test(m)) return new FinanceError('PAYMENT_REFERENCE_NOT_UNIQUE');
  if (/fin_artifacts_vcs_valid/.test(m)) return new FinanceError('PAYMENT_REFERENCE_INVALID', 'refused by the database');
  if (/fin_artifacts_(document|supplier|parent|message)_fk|fin_peppol_messages_(document|supplier|duplicate)_fk/.test(m)) return new FinanceError('CROSS_MERCHANT_REFERENCE', 'refused by the database');
  if (/fin_bank_tx_amount_nonzero_chk|fin_bank_tx_currency_chk/.test(m)) return new FinanceError('BANK_TRANSACTION_INVALID', 'refused by the database');
  if (/fin_payment_registry_method_chk/.test(m)) return new FinanceError('PAYMENT_METHOD_INVALID', 'refused by the database');
  if (/fin_payment_registry_source_check|source_check/.test(m)) return new FinanceError('PAYMENT_SOURCE_INVALID', 'refused by the database');
  if (/_same_merchant_fk|fin_payment_allocations_(payment|customer|supplier|reverses)_fk|fin_payment_registry_reversal_fk|fin_bank_reconciliations_(tx|payment|reverses)_fk|fin_bank_tx_account_fk|fin_bank_balances_account_fk/.test(m)) return new FinanceError('CROSS_MERCHANT_REFERENCE', 'refused by the database');
  if (m.includes('is immutable') || m.includes('cannot be deleted')) return new FinanceError('LOCKED_DOCUMENT_CANNOT_CHANGE', 'refused by the database');
  if (m.includes('append-only')) return new FinanceError('APPEND_ONLY_TABLE', 'refused by the database');
  return err;
}

export function createSupabaseFinanceStore(supabase, { merchantId }) {
  const guard = async (fn) => { try { return await fn(); } catch (e) { throw translateDbError(e); } };
  const eq = (v) => `eq.${v}`;
  // the reconciled / ignored / remaining amounts and the status of a bank transaction, derived from its reconciliation rows (never read from the legacy status column)
  const withBankTruth = async (txs, onlyId = null) => {
    if (!txs.length) return txs;
    const recs = (await supabase.selectAll('fin_bank_reconciliations', { select: 'id,bank_transaction_id,kind,amount_cents,created_at', merchant_id: eq(merchantId), ...(onlyId ? { bank_transaction_id: eq(onlyId) } : {}) })).map((r) => ({ id: r.id, bankTransactionId: r.bank_transaction_id, kind: r.kind, amountCents: Number(r.amount_cents), createdAt: r.created_at }));
    return txs.map((t) => { const a = txAmounts(t, recs); return { ...t, reconciledCents: a.matched, ignoredCents: a.ignored, remainingCents: a.remaining, reconciliationStatus: a.status }; });
  };
  // allocations joined with the registry rows they belong to (two reads, joined here: PostgREST embedding of a composite key is not relied upon)
  const joinPayments = async (allocRows) => {
    if (!allocRows.length) return [];
    const ids = [...new Set(allocRows.map((a) => a.payment_id))];
    const regs = []; for (let i = 0; i < ids.length; i += 100) regs.push(...await supabase.select('fin_payment_registry', { select: '*', merchant_id: eq(merchantId), id: `in.(${ids.slice(i, i + 100).join(',')})` }));
    const byId = new Map(regs.map((r) => [r.id, r]));
    return allocRows.map((a) => { const p = byId.get(a.payment_id); return { ...allocFromRow(a), paidOn: p.paid_on, method: p.method, reference: p.reference, direction: p.direction }; });
  };
  const paymentsView = (rows) => rows.map((a) => ({ id: a.paymentId, allocationId: a.id, documentId: a.customerDocumentId, merchantId: a.merchantId, amountCents: a.amountCents, paidOn: a.paidOn, method: a.method, reference: a.amountCents < 0 ? (a.reason ?? a.reference) : a.reference }));
  // the derived net allocated of supplier invoices (the only financial truth of "paid"); the row's own columns are a mirror kept by the database
  const withAllocated = async (rows) => {
    if (!rows.length) return rows;
    const al = rows.length === 1 ? await supabase.select('fin_payment_allocations', { select: 'supplier_invoice_id,amount_cents', merchant_id: eq(merchantId), supplier_invoice_id: eq(rows[0].id) })
      : await supabase.selectAll('fin_payment_allocations', { select: 'id,supplier_invoice_id,amount_cents', merchant_id: eq(merchantId), supplier_invoice_id: 'not.is.null' });
    const net = new Map(); for (const a of al) net.set(a.supplier_invoice_id, (net.get(a.supplier_invoice_id) ?? 0) + Number(a.amount_cents));
    return rows.map((r) => ({ ...r, allocatedCents: net.get(r.id) ?? 0 }));
  };

  return {
    newId: () => randomUUID(),
    ...legalStoreMethods(supabase, { merchantId, guard, eq }),

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

    // ---- payment registry: every operation is ONE rpc = ONE database transaction. The idempotency key makes a retry after an ambiguous network result safe,
    // so these rpcs (and only these) opt in to the client's transient-failure retry. fin_payments (legacy) is no longer read or written by the application. ----
    async getPaymentByKey(_m, key) {
      const [p] = await supabase.select('fin_payment_registry', { select: '*', merchant_id: eq(merchantId), idempotency_key: eq(key) });
      if (!p) return null;
      const rows = await supabase.select('fin_payment_allocations', { select: '*', merchant_id: eq(merchantId), payment_id: eq(p.id), order: 'created_at.asc,id.asc' });
      return { payment: payFromRow(p), allocations: rows.map(allocFromRow) };
    },
    async recordPayment({ key, direction, amountCents, currency, paidOn, method = 'unspecified', reference = null, actor = null, allocations = [], at = null, meta = {} }) {
      const r = await guard(() => supabase.rpc('fin_record_payment', { p_merchant: merchantId, p_key: key, p_direction: direction, p_amount: amountCents, p_currency: currency, p_paid_on: paidOn, p_method: method, p_reference: reference, p_actor: actor,
        p_allocations: allocations.map((a) => ({ customerDocumentId: a.customerDocumentId ?? undefined, supplierInvoiceId: a.supplierInvoiceId ?? undefined, amountCents: a.amountCents })), p_at: at,
        p_meta: { source: meta.source ?? undefined, externalReference: meta.externalReference ?? undefined, structuredReference: meta.structuredReference ?? undefined, bankReference: meta.bankReference ?? undefined, refundOfPaymentId: meta.refundOfPaymentId ?? undefined } }, { retry: true }));
      return { duplicate: r.duplicate === true, payment: payFromRow(r.payment), allocations: (r.allocations ?? []).map(allocFromRow) };
    },
    async allocatePayment({ key, paymentId, allocations, actor = null, at = null }) {
      const r = await guard(() => supabase.rpc('fin_allocate_payment', { p_merchant: merchantId, p_key: key, p_payment_id: paymentId, p_actor: actor, p_at: at,
        p_allocations: allocations.map((a) => ({ customerDocumentId: a.customerDocumentId ?? undefined, supplierInvoiceId: a.supplierInvoiceId ?? undefined, amountCents: a.amountCents })) }, { retry: true }));
      return { duplicate: r.duplicate === true, allocations: (r.allocations ?? []).map(allocFromRow) };
    },
    async reverseAllocations({ key, items, reason = null, actor = null, at = null }) {
      const r = await guard(() => supabase.rpc('fin_reverse_allocations', { p_merchant: merchantId, p_key: key, p_items: items.map((i) => ({ allocationId: i.allocationId, amountCents: i.amountCents ?? null })), p_reason: reason, p_actor: actor, p_at: at }, { retry: true }));
      return { duplicate: r.duplicate === true, reversals: (r.reversals ?? []).map(allocFromRow) };
    },
    async voidPayment({ key, paymentId, on, reason = null, actor = null, at = null }) {
      const r = await guard(() => supabase.rpc('fin_void_payment', { p_merchant: merchantId, p_key: key, p_payment_id: paymentId, p_on: on, p_reason: reason, p_actor: actor, p_at: at }, { retry: true }));
      return { duplicate: r.duplicate === true, reversal: payFromRow(r.reversal) };
    },
    async listAllocations({ customerDocumentId, supplierInvoiceId, keyPrefix } = {}) {
      if (keyPrefix) return joinPayments((await supabase.selectAll('fin_payment_allocations', { select: '*', merchant_id: eq(merchantId), idempotency_key: `like.${keyPrefix}*` })).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))));
      const p = { select: '*', merchant_id: eq(merchantId), order: 'created_at.asc,id.asc' };
      if (customerDocumentId) p.customer_document_id = eq(customerDocumentId);
      if (supplierInvoiceId) p.supplier_invoice_id = eq(supplierInvoiceId);
      const rows = (await supabase.selectAll('fin_payment_allocations', { ...p, order: 'id.asc' })).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
      return joinPayments(rows);
    },
    async listRegistry() { return (await supabase.selectAll('fin_payment_registry', { select: '*', merchant_id: eq(merchantId) })).map(payFromRow); },
    async getPayment(_m, id) {
      const [p] = await supabase.select('fin_payment_registry', { select: '*', id: eq(id), merchant_id: eq(merchantId) }); if (!p) return null;
      const reversals = await supabase.select('fin_payment_registry', { select: '*', reversal_of_id: eq(id), merchant_id: eq(merchantId) });
      const allocs = await supabase.select('fin_payment_allocations', { select: '*', payment_id: eq(id), merchant_id: eq(merchantId), order: 'created_at.asc,id.asc' });
      return { payment: payFromRow(p), reversals: reversals.map(payFromRow), allocations: allocs.map(allocFromRow) };
    },
    /** Customer-invoice payments as the rest of the application reads them: one entry per allocation (negative = a reversal), derived from the registry. */
    async listPayments(documentId) {
      const rows = await supabase.select('fin_payment_allocations', { select: '*', customer_document_id: eq(documentId), merchant_id: eq(merchantId), order: 'created_at.asc,id.asc' });
      return paymentsView(await joinPayments(rows));
    },
    async listPaymentsForMerchant() {
      const rows = await supabase.selectAll('fin_payment_allocations', { select: '*', merchant_id: eq(merchantId), customer_document_id: 'not.is.null' });
      return paymentsView(await joinPayments(rows));
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
        street: c.address?.street ?? null, postal_code: c.address?.postalCode ?? null, city: c.address?.city ?? null, country_code: c.address?.countryCode ?? null, contact_email: c.email ?? null, peppol_id: c.peppolId ?? null, first_name: c.firstName ?? null, phone: c.phone ?? null, iban: c.iban ?? null, declared_customer: !!c.declaredRoles?.customer, declared_supplier: !!c.declaredRoles?.supplier, source: c.source ?? 'manual', verified_at: c.verifiedAt ?? null, notes: c.notes ?? null };
      const [r] = await guard(() => supabase.insert('fin_companies', [row]));
      return companyFromRow(r);
    },
    async listCompanies() { return (await supabase.selectAll('fin_companies', { select: '*', merchant_id: eq(merchantId) })).map(companyFromRow); },
    async updateCompany(id, c) {
      // Deliberately does not touch archived_at: archiving/restoring is a separate, explicit action
      // (setCompanyArchived) so an ordinary "Edit" save can never silently resurrect an archived contact.
      const row = { kind: c.kind ?? 'business', name: c.name, enterprise_number: c.enterpriseNumber ?? null, vat_number: c.vatNumber ?? null, legal_form: c.legalForm ?? null,
        street: c.address?.street ?? null, postal_code: c.address?.postalCode ?? null, city: c.address?.city ?? null, country_code: c.address?.countryCode ?? null, contact_email: c.email ?? null, peppol_id: c.peppolId ?? null, notes: c.notes ?? null, first_name: c.firstName ?? null, phone: c.phone ?? null, iban: c.iban ?? null, declared_customer: !!c.declaredRoles?.customer, declared_supplier: !!c.declaredRoles?.supplier };
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
      return { ...supplierFromRow(r), allocatedCents: 0 };
    },
    async getSupplierInvoice(id) { const [r] = await supabase.select('fin_supplier_invoices', { select: '*', id: eq(id), merchant_id: eq(merchantId) }); return r ? (await withAllocated([supplierFromRow(r)]))[0] : null; },
    async findSupplierInvoiceBySha(_m, sha) { const [r] = await supabase.select('fin_supplier_invoices', { select: '*', sha256: eq(sha), merchant_id: eq(merchantId) }); return r ? (await withAllocated([supplierFromRow(r)]))[0] : null; },
    async updateSupplierInvoice(id, patch, expectedStatus) {
      const body = supplierToRow(patch, true); // payment_status is never written: the database derives it from the allocations (and refuses status PAID without them)
      const r = await guard(() => supabase.update('fin_supplier_invoices', { id: eq(id), merchant_id: eq(merchantId), status: eq(expectedStatus) }, body));
      return r && r.length ? (await withAllocated([supplierFromRow(r[0])]))[0] : null;
    },
    /** Phase 1: link/unlink a supplier invoice to a fin_companies contact. Deliberately NOT gated by
     * status (unlike updateSupplierInvoice) - linking a contact is a separate concern from the review
     * workflow and must remain possible at any status, including after payment. contactId=null unlinks. */
    async setSupplierInvoiceContact(id, contactId) {
      const r = await guard(() => supabase.update('fin_supplier_invoices', { id: eq(id), merchant_id: eq(merchantId) }, { supplier_company_id: contactId }));
      return r && r.length ? (await withAllocated([supplierFromRow(r[0])]))[0] : null;
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
    /** ATOMIC batch: a single INSERT ... ON CONFLICT DO NOTHING statement (one request, one database transaction). Returns { created, duplicates }. */
    async insertBankTransactionsBatch(rows) {
      if (!rows.length) return { created: 0, duplicates: 0 };
      const inserted = await guard(() => supabase.insertIgnoringDuplicates('fin_bank_transactions', rows.map(bankTxToRow), { onConflict: 'merchant_id,account_id,provider_tx_id' }));
      return { created: inserted.length, duplicates: rows.length - inserted.length };
    },
    async getBankTransaction(id) { const [r] = await supabase.select('fin_bank_transactions', { select: '*', id: eq(id), merchant_id: eq(merchantId) }); return r ? (await withBankTruth([bankTxFromRow(r)], id))[0] : null; },
    /** The status and matched_* of a bank transaction are DERIVED from its reconciliations: nothing can write them (the database refuses too: fin_bank_tx_guard). */
    async updateBankTransaction(id, patch) {
      for (const k of Object.keys(patch)) {
        if (['status', 'matchedKind', 'matchedDocumentId', 'matchedPaymentId', 'matchedAmountCents', 'matchedAt'].includes(k)) throw new FinanceError('BANK_STATUS_IS_DERIVED', 'the status of a bank transaction follows its reconciliations; use reconcile / unreconcile / ignore');
        throw new FinanceError('BANK_TRANSACTION_IS_IMMUTABLE', k);
      }
      return this.getBankTransaction(id);
    },
    async listBankTransactions(f = {}) { const p = { select: '*', merchant_id: eq(merchantId) }; if (f.status) p.status = eq(f.status); if (f.bankAccountId) p.bank_account_id = eq(f.bankAccountId); return withBankTruth((await supabase.selectAll('fin_bank_transactions', p)).map(bankTxFromRow)); },
    async upsertBankBalance(b) { await supabase.upsert('fin_bank_balances', [{ merchant_id: merchantId, account_id: b.accountId, iban: b.iban, balance_cents: b.balanceCents, currency: b.currency, as_of: b.asOf, source: b.source ?? 'provider' }], { onConflict: 'merchant_id,account_id' }); },
    // fin_bank_balances has no `id` column (its primary key is the composite merchant_id/account_id, by design -
    // one current balance row per account), so selectAll's default `order: 'id.asc'` pagination sort must be
    // overridden here or every call 400s with "column fin_bank_balances.id does not exist".
    async listBankBalances() { return (await supabase.selectAll('fin_bank_balances', { select: '*', merchant_id: eq(merchantId), order: 'account_id.asc' })).map((r) => ({ merchantId, accountId: r.account_id, iban: r.iban, balanceCents: Number(r.balance_cents), currency: r.currency, asOf: r.as_of, source: r.source ?? 'provider', bankAccountId: r.bank_account_id ?? null }));
    },
    // ---- bank accounts and reconciliations (migration 20261005090000): one operation = one rpc = one database transaction; the rpcs are idempotent, so they opt in to the client's transient-failure retry ----
    async ensureBankAccount({ externalId, origin, provider = null, displayName = null, ibanMasked = null, currency = 'EUR' }) {
      await guard(() => supabase.insertIgnoringDuplicates('fin_bank_accounts', [{ merchant_id: merchantId, external_id: externalId, origin, provider, display_name: displayName, iban_masked: ibanMasked, currency }], { onConflict: 'merchant_id,external_id' }));
      const [a] = await supabase.select('fin_bank_accounts', { select: '*', merchant_id: eq(merchantId), external_id: eq(externalId) });
      if (a.currency !== currency) throw new FinanceError('BANK_CURRENCY_MISMATCH', `account ${a.currency}, given ${currency}`);
      const patch = {}; if (displayName && displayName !== a.display_name) patch.display_name = displayName; if (ibanMasked && ibanMasked !== a.iban_masked) patch.iban_masked = ibanMasked; if (provider && provider !== a.provider) patch.provider = provider;
      if (Object.keys(patch).length) { const [u] = await guard(() => supabase.update('fin_bank_accounts', { id: eq(a.id), merchant_id: eq(merchantId) }, patch)); return accFromRow(u); }
      return accFromRow(a);
    },
    async listBankAccounts() { return (await supabase.selectAll('fin_bank_accounts', { select: '*', merchant_id: eq(merchantId) })).map(accFromRow); },
    async listReconciliations({ bankTransactionId, paymentId } = {}) {
      const p = { select: '*', merchant_id: eq(merchantId) }; if (bankTransactionId) p.bank_transaction_id = eq(bankTransactionId); if (paymentId) p.payment_id = eq(paymentId);
      return (await supabase.selectAll('fin_bank_reconciliations', p)).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)) || String(x.id).localeCompare(String(y.id))).map(recFromRow);
    },
    async bankTxAmounts(_m, txId) { const a = await supabase.rpc('fin_bank_tx_amounts', { p_merchant: merchantId, p_tx: txId }); return a ? amountsFromJson(a) : null; },
    async reconcileBank({ key, transactionId, items, suggestion = null, actor = null, at = null }) {
      const r = await guard(() => supabase.rpc('fin_bank_reconcile', { p_merchant: merchantId, p_key: key, p_tx: transactionId, p_items: items.map((i) => ({ paymentId: i.paymentId, amountCents: i.amountCents })), p_suggestion: suggestion, p_actor: actor, p_at: at }, { retry: true }));
      return { duplicate: r.duplicate === true, reconciliations: r.reconciliations.map(recFromRow), transaction: amountsFromJson(r.transaction) };
    },
    async reconcileAndPay({ key, transactionId, payment, suggestion = null, actor = null, at = null }) {
      const r = await guard(() => supabase.rpc('fin_bank_reconcile_and_pay', { p_merchant: merchantId, p_key: key, p_tx: transactionId, p_actor: actor, p_at: at, p_suggestion: suggestion,
        p_payment: { amountCents: payment.amountCents, method: payment.method, reference: payment.reference, allocations: (payment.allocations ?? []).map((a) => ({ customerDocumentId: a.customerDocumentId ?? undefined, supplierInvoiceId: a.supplierInvoiceId ?? undefined, amountCents: a.amountCents })), meta: payment.meta ?? {} } }, { retry: true }));
      return { duplicate: r.duplicate === true, payment: payFromRow(r.payment), allocations: (r.allocations ?? []).map(allocFromRow), reconciliation: recFromRow(r.reconciliation), transaction: amountsFromJson(r.transaction) };
    },
    async unreconcileBank({ key, items, reason = null, actor = null, at = null }) {
      const r = await guard(() => supabase.rpc('fin_bank_unreconcile', { p_merchant: merchantId, p_key: key, p_items: items.map((i) => ({ reconciliationId: i.reconciliationId, amountCents: i.amountCents ?? null })), p_reason: reason, p_actor: actor, p_at: at }, { retry: true }));
      return { duplicate: r.duplicate === true, reversals: r.reversals.map(recFromRow), transaction: r.transaction ? amountsFromJson(r.transaction) : null };
    },
    async ignoreBank({ key, transactionId, amountCents = null, reason = null, actor = null, at = null }) {
      const r = await guard(() => supabase.rpc('fin_bank_ignore', { p_merchant: merchantId, p_key: key, p_tx: transactionId, p_amount: amountCents, p_reason: reason, p_actor: actor, p_at: at }, { retry: true }));
      return { duplicate: r.duplicate === true, reconciliation: recFromRow(r.reconciliation), transaction: amountsFromJson(r.transaction) }; },
    async insertCashCount(c) { const [r] = await guard(() => supabase.insert('fin_cash_counts', [{ merchant_id: merchantId, amount_cents: c.amountCents, counted_on: c.countedOn, note: c.note }])); return { id: r.id, merchantId, amountCents: Number(r.amount_cents), countedOn: r.counted_on, note: r.note, createdAt: r.created_at }; },
    async listCashCounts() { return (await supabase.selectAll('fin_cash_counts', { select: '*', merchant_id: eq(merchantId) })).map((r) => ({ id: r.id, merchantId, amountCents: Number(r.amount_cents), countedOn: r.counted_on, note: r.note, createdAt: r.created_at })); },
    async latestCashCount() { const [r] = await supabase.select('fin_cash_counts', { select: '*', merchant_id: eq(merchantId), order: 'counted_on.desc,created_at.desc', limit: '1' }); return r ? { id: r.id, merchantId, amountCents: Number(r.amount_cents), countedOn: r.counted_on, note: r.note, createdAt: r.created_at } : null; },
    async insertCashMovement(m) { const [r] = await guard(() => supabase.insert('fin_cash_movements', [{ merchant_id: merchantId, kind: m.kind, amount_cents: m.amountCents, date: m.date, note: m.note }])); return { id: r.id, merchantId, kind: r.kind, amountCents: Number(r.amount_cents), date: r.date, note: r.note, createdAt: r.created_at }; },
    async listCashMovements() { return (await supabase.selectAll('fin_cash_movements', { select: '*', merchant_id: eq(merchantId) })).map((r) => ({ id: r.id, merchantId, kind: r.kind, amountCents: Number(r.amount_cents), date: r.date, note: r.note, createdAt: r.created_at })); },
    /** Attach a first document to a record that has none (the filter makes it a no-op when one exists). */
    async setSupplierInvoiceAttachment(id, patch) {
      const r = await guard(() => supabase.update('fin_supplier_invoices', { id: eq(id), merchant_id: eq(merchantId), attachment_ref: 'is.null' }, supplierToRow(patch, true)));
      return r && r.length ? (await withAllocated([supplierFromRow(r[0])]))[0] : null;
    },
    async listSupplierInvoices() { return withAllocated((await supabase.selectAll('fin_supplier_invoices', { select: '*', merchant_id: eq(merchantId) })).map(supplierFromRow)); },

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
  supplierCompanyId: 'supplier_company_id',
  // Document intelligence phase 1 - see 20260926160000_finance_purchase_document_model.
  documentType: 'document_type', supplierEnterpriseNumber: 'supplier_enterprise_number', supplierIban: 'supplier_iban', orderReference: 'order_reference', billingReference: 'billing_reference',
  vatBreakdown: 'vat_breakdown', lines: 'lines' };
function supplierToRow(s, partial = false) { const r = {}; for (const [k, col] of Object.entries(SUPPLIER_MAP)) if (k in s) r[col] = s[k]; if (!partial) r.merchant_id = s.merchantId; return r; }
const supplierFromRow = (r) => { const s = { id: r.id, merchantId: r.merchant_id, paymentStatus: r.payment_status }; for (const [k, col] of Object.entries(SUPPLIER_MAP)) s[k] = r[col] ?? null; for (const k of ['netCents', 'vatCents', 'grossCents', 'paidAmountCents']) if (s[k] !== null) s[k] = Number(s[k]); return s; };
const payFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, direction: r.direction, amountCents: Number(r.amount_cents), currency: r.currency, paidOn: r.paid_on, method: r.method, reference: r.reference, reversalOfId: r.reversal_of_id ?? null, idempotencyKey: r.idempotency_key, actor: r.actor ?? null, createdAt: r.created_at,
  source: r.source ?? 'manual', externalReference: r.external_reference ?? null, structuredReference: r.structured_reference ?? null, bankReference: r.bank_reference ?? null, refundOfPaymentId: r.refund_of_payment_id ?? null });
const allocFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, paymentId: r.payment_id, customerDocumentId: r.customer_document_id ?? null, supplierInvoiceId: r.supplier_invoice_id ?? null, amountCents: Number(r.amount_cents), currency: r.currency, reversesAllocationId: r.reverses_allocation_id ?? null, idempotencyKey: r.idempotency_key, reason: r.reason ?? null, actor: r.actor ?? null, createdAt: r.created_at });
const bankConnFromRow = (r) => ({ merchantId: r.merchant_id, provider: r.provider, tokenCipher: r.token_ciphertext || null, tokenFingerprint: r.token_fingerprint, scopes: r.scopes, accountIds: r.account_ids, grantedAt: r.granted_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, lastUsedAt: r.last_used_at });
const bankTxToRow = (t) => ({ merchant_id: t.merchantId, account_id: t.accountId, provider_tx_id: t.providerTxId, date: t.date, amount_cents: t.amountCents, currency: t.currency, counterparty_name: t.counterpartyName, reference: t.reference, structured_reference: t.structuredReference, source: t.source, status: t.status,
  value_date: t.valueDate ?? null, fingerprint: t.fingerprint ?? null, bank_reference: t.bankReference ?? null, counterparty_account_masked: t.counterpartyAccountMasked ?? null });
const accFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, externalId: r.external_id, origin: r.origin, provider: r.provider ?? null, displayName: r.display_name ?? null, ibanMasked: r.iban_masked ?? null, currency: r.currency, status: r.status, createdAt: r.created_at, closedAt: r.closed_at ?? null });
const recFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, bankTransactionId: r.bank_transaction_id, paymentId: r.payment_id ?? null, kind: r.kind, amountCents: Number(r.amount_cents), currency: r.currency, reversesId: r.reverses_id ?? null, method: r.method, suggestion: r.suggestion ?? null, idempotencyKey: r.idempotency_key, reason: r.reason ?? null, actor: r.actor ?? null, createdAt: r.created_at });
const amountsFromJson = (a) => ({ amount: Number(a.amount), matched: Number(a.matched), ignored: Number(a.ignored), remaining: Number(a.remaining), status: a.status, lastAt: a.last_at ?? null });
const bankTxFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, accountId: r.account_id, providerTxId: r.provider_tx_id, date: r.date, amountCents: Number(r.amount_cents), currency: r.currency, counterpartyName: r.counterparty_name, reference: r.reference, structuredReference: r.structured_reference, source: r.source, status: r.status, matchedKind: r.matched_kind, matchedDocumentId: r.matched_document_id, matchedPaymentId: r.matched_payment_id, matchedAmountCents: r.matched_amount_cents == null ? null : Number(r.matched_amount_cents), matchedAt: r.matched_at, importedAt: r.imported_at,
  bankAccountId: r.bank_account_id ?? null, valueDate: r.value_date ?? null, fingerprint: r.fingerprint ?? null, bankReference: r.bank_reference ?? null, counterpartyAccountMasked: r.counterparty_account_masked ?? null, direction: r.direction });
const stockToRow = (m) => ({ merchant_id: m.merchantId, document_id: m.documentId, document_number: m.documentNumber, document_type: m.documentType, line_position: m.linePosition, kind: m.kind, variant_id: m.variantId, variant_source_id: m.variantSourceId, sku: m.sku, location_id: m.locationId, location_source_id: m.locationSourceId, quantity: m.quantity, delta: m.delta, status: m.status, error: m.error, idempotency_key: m.idempotencyKey });
const stockFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, documentId: r.document_id, documentNumber: r.document_number, documentType: r.document_type, linePosition: r.line_position, kind: r.kind, variantId: r.variant_id, variantSourceId: r.variant_source_id, sku: r.sku, locationId: r.location_id, locationSourceId: r.location_source_id, quantity: r.quantity, delta: r.delta, status: r.status, error: r.error, idempotencyKey: r.idempotency_key, shopifyAdjustmentId: r.shopify_adjustment_id, createdAt: r.created_at, appliedAt: r.applied_at });
export const companyFromRow = (r) => ({ id: r.id, merchantId: r.merchant_id, kind: r.kind, name: r.name, enterpriseNumber: r.enterprise_number, vatNumber: r.vat_number, legalForm: r.legal_form,
  address: { street: r.street, postalCode: r.postal_code, city: r.city, countryCode: r.country_code }, email: r.contact_email, peppolId: r.peppol_id, source: r.source, verifiedAt: r.verified_at,
  notes: r.notes ?? null, archivedAt: r.archived_at ?? null,
  firstName: r.first_name ?? null, phone: r.phone ?? null, iban: r.iban ?? null, declaredRoles: { customer: r.declared_customer === true, supplier: r.declared_supplier === true } });
