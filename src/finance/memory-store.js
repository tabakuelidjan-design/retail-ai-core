// In-memory finance store: the reference implementation of the store interface, used by tests. It enforces the same
// rules the database triggers enforce (locked documents cannot change commercially, audit events and payments are
// append-only, one active invoice per source order, gapless per-year numbering), so tests exercise real invariants.

import { TRANSITIONS as STOCK_TRANSITIONS } from './stock.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { FinanceError } from './document.js';
import { formatNumber } from './numbering.js';

const clone = (o) => structuredClone(o);

export function createMemoryStore() {
  const docs = new Map();
  const events = [];
  const payments = [];
  const seqs = new Map();
  const companies = new Map();
  const supplierInvoices = [];
  const stockMovements = [];
  const bankConnections = new Map(); const bankTx = []; const bankBalances = new Map(); const cashCounts = []; const cashMovements = [];
  const hooks = { beforeCommit: null }; // failure injection for crash tests: throw to simulate a crash inside the transaction

  return {
    newId: () => randomUUID(),

    async getDocument(id) { const d = docs.get(id); return d ? clone(d) : null; },

    /** Insert or update with optimistic concurrency and the immutability rules of a locked document. */
    async saveDocument(doc, expectedVersion = null) {
      const prev = docs.get(doc.id);
      if (!prev) {
        if (doc.type === 'invoice' && doc.sourceOrderId && doc.status !== 'CANCELLED' && [...docs.values()].some((d) => d.type === 'invoice' && d.sourceOrderId === doc.sourceOrderId && d.status !== 'CANCELLED')) throw new FinanceError('SOURCE_ORDER_ALREADY_INVOICED', doc.sourceOrderId);
        if (doc.number && [...docs.values()].some((d) => d.merchantId === doc.merchantId && d.type === doc.type && d.number === doc.number)) throw new FinanceError('DUPLICATE_DOCUMENT_NUMBER', doc.number);
        docs.set(doc.id, clone(doc));
        return clone(doc);
      }
      if (expectedVersion !== null && prev.version !== expectedVersion) throw new FinanceError('CONCURRENT_MODIFICATION', `expected v${expectedVersion}, found v${prev.version}`);
      if (prev.lockedAt) {
        if (doc.lockedAt !== prev.lockedAt || doc.snapshotHash !== prev.snapshotHash || doc.number !== prev.number) throw new FinanceError('LOCKED_DOCUMENT_CANNOT_CHANGE');
        for (const k of ['totals', 'lines', 'customer', 'seller', 'vat', 'issueDate', 'dueDate', 'currency', 'sourceOrderId', 'revenueBasis', 'relatedDocumentId']) if (JSON.stringify(doc[k]) !== JSON.stringify(prev[k])) throw new FinanceError('LOCKED_DOCUMENT_CANNOT_CHANGE', k);
      } else if (doc.number && [...docs.values()].some((d) => d.id !== doc.id && d.merchantId === doc.merchantId && d.type === doc.type && d.number === doc.number)) throw new FinanceError('DUPLICATE_DOCUMENT_NUMBER', doc.number);
      docs.set(doc.id, clone(doc));
      return clone(doc);
    },

    async deleteDocument(id) {
      const d = docs.get(id);
      if (d?.lockedAt || d?.number) throw new FinanceError('ISSUED_DOCUMENTS_CANNOT_BE_DELETED');
      docs.delete(id);
    },

    async listDocuments(f = {}) {
      return [...docs.values()].filter((d) => (!f.merchantId || d.merchantId === f.merchantId) && (!f.type || d.type === f.type) && (!f.status || d.status === f.status)
        && (f.sourceOrderId === undefined || d.sourceOrderId === f.sourceOrderId) && (f.relatedDocumentId === undefined || d.relatedDocumentId === f.relatedDocumentId)).map(clone);
    },

    async appendEvent(e) { events.push(Object.freeze({ id: randomUUID(), ...clone(e) })); },
    async listEvents(documentId) { return events.filter((e) => e.documentId === documentId).map(clone); },
    /** Recent document lifecycle events across the whole merchant (dashboard "recent activity" feed) - read only, newest first. */
    async listEventsForMerchant({ merchantId, limit = 20 } = {}) {
      return events.filter((e) => e.merchantId === merchantId).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, limit).map(clone);
    },

    async addPayment(p) { payments.push(Object.freeze({ id: randomUUID(), ...clone(p) })); return clone(payments.at(-1)); },
    async listPayments(documentId) { return payments.filter((p) => p.documentId === documentId).map(clone); },
    // ---- Bank & Treasury (read only). The encrypted token is stored here and is never part of any view. ----
    async saveBankConnection(row) { bankConnections.set(row.merchantId, clone(row)); return clone(row); },
    async getBankConnection(merchantId) { const c = bankConnections.get(merchantId); return c ? clone(c) : null; },
    async touchBankConnection(merchantId, at) { const c = bankConnections.get(merchantId); if (c) c.lastUsedAt = at; },
    async revokeBankConnection(merchantId, at) { const c = bankConnections.get(merchantId); if (c) { c.revokedAt = at; c.tokenCipher = null; } },
    async insertBankTransaction(row) {
      const dup = bankTx.find((t) => t.merchantId === row.merchantId && t.accountId === row.accountId && t.providerTxId === row.providerTxId);
      if (dup) return { created: false, row: clone(dup) };
      const t = { id: randomUUID(), ...clone(row) }; bankTx.push(t); return { created: true, row: clone(t) };
    },
    /**
     * ATOMIC batch: every row is validated and de-duplicated first (against the stored transactions and inside the batch); the rows are then added in one
     * step. Any problem throws BEFORE anything is stored, so a batch is saved completely or not at all. Returns { created, duplicates }.
     */
    async insertBankTransactionsBatch(rows) {
      const fresh = []; const seen = new Set(bankTx.map((t) => `${t.merchantId}|${t.accountId}|${t.providerTxId}`));
      for (const row of rows) {
        if (!Number.isInteger(row.amountCents) || !row.date || !row.providerTxId) throw new FinanceError('BANK_TRANSACTION_INVALID', String(row.providerTxId ?? ''));
        const k = `${row.merchantId}|${row.accountId}|${row.providerTxId}`; if (seen.has(k)) continue; seen.add(k);
        fresh.push({ id: randomUUID(), ...clone(row) });
      }
      bankTx.push(...fresh);
      return { created: fresh.length, duplicates: rows.length - fresh.length };
    },
    async getBankTransaction(id) { const t = bankTx.find((x) => x.id === id); return t ? clone(t) : null; },
    async updateBankTransaction(id, patch, expectedStatus) {
      const t = bankTx.find((x) => x.id === id); if (!t || t.status !== expectedStatus) return null;
      for (const k of Object.keys(patch)) if (!['status', 'matchedKind', 'matchedDocumentId', 'matchedPaymentId', 'matchedAmountCents', 'matchedAt'].includes(k)) throw new FinanceError('BANK_TRANSACTION_IS_IMMUTABLE', k);
      Object.assign(t, patch); return clone(t);
    },
    async listBankTransactions(f = {}) { return bankTx.filter((t) => (!f.merchantId || t.merchantId === f.merchantId) && (!f.status || t.status === f.status)).map(clone); },
    async upsertBankBalance(row) { bankBalances.set(`${row.merchantId}|${row.accountId}`, clone(row)); },
    async listBankBalances(merchantId) { return [...bankBalances.values()].filter((b) => b.merchantId === merchantId).map(clone); },
    async insertCashCount(row) { const r = { id: randomUUID(), ...clone(row) }; cashCounts.push(r); return clone(r); },
    async latestCashCount(merchantId) { const l = cashCounts.filter((c) => c.merchantId === merchantId).sort((a, b) => String(b.countedOn).localeCompare(String(a.countedOn)) || String(b.createdAt).localeCompare(String(a.createdAt)))[0]; return l ? clone(l) : null; },
    async insertCashMovement(row) { const r = { id: randomUUID(), ...clone(row) }; cashMovements.push(r); return clone(r); },
    async listCashMovements(merchantId) { return cashMovements.filter((m) => m.merchantId === merchantId).map(clone); },

    // ---- stock movement ledger: append-only; only the status fields may change, through allowed transitions ----
    async insertStockMovement(row) {
      const dup = stockMovements.find((m) => m.merchantId === row.merchantId && m.idempotencyKey === row.idempotencyKey);
      if (dup) return { created: false, row: clone(dup) };
      const m = { id: randomUUID(), ...clone(row) }; stockMovements.push(m); return { created: true, row: clone(m) };
    },
    async getStockMovement(id) { const m = stockMovements.find((x) => x.id === id); return m ? clone(m) : null; },
    async updateStockMovement(id, patch, expectedStatus) {
      const m = stockMovements.find((x) => x.id === id);
      if (!m || m.status !== expectedStatus) return null;
      if (patch.status && !(STOCK_TRANSITIONS[m.status] ?? []).includes(patch.status)) throw new FinanceError('INVALID_TRANSITION', `${m.status} -> ${patch.status}`);
      for (const k of Object.keys(patch)) if (!['status', 'error', 'shopifyAdjustmentId', 'appliedAt', 'locationId', 'locationSourceId'].includes(k)) throw new FinanceError('STOCK_MOVEMENT_IS_IMMUTABLE', k);
      Object.assign(m, patch); return clone(m);
    },
    async listStockMovements(f = {}) { return stockMovements.filter((m) => (!f.merchantId || m.merchantId === f.merchantId) && (!f.documentId || m.documentId === f.documentId) && (!f.status || m.status === f.status)).map(clone); },
    async listPaymentsForMerchant(merchantId) { return payments.filter((p) => p.merchantId === merchantId).map(clone); },

    /**
     * ATOMIC issue: allocate the number, lock the document, hash it and append the audit event as ONE unit. Anything that throws
     * before the commit point (including the injected beforeCommit hook) leaves sequence, document and events untouched.
     */
    async issueDocument({ merchantId, docId, expectedVersion, newStatus, numbering, year, canonical, placeholder, lockedAt, event }) {
      const prev = docs.get(docId);
      if (!prev || prev.merchantId !== merchantId) throw new FinanceError('DOCUMENT_NOT_FOUND', docId);
      if (prev.lockedAt || prev.number || prev.version !== expectedVersion) throw new FinanceError('CONCURRENT_MODIFICATION');
      const k = `${merchantId}|${prev.type}|${year}`;
      const seq = (seqs.get(k) ?? 0) + 1; // tentative: NOT stored yet
      const number = formatNumber({ [prev.type]: { prefix: numbering.prefix, pad: numbering.pad }, format: numbering.format }, prev.type, year, seq);
      if ([...docs.values()].some((d) => d.merchantId === merchantId && d.type === prev.type && d.number === number)) throw new FinanceError('DUPLICATE_DOCUMENT_NUMBER', number);
      const finalDoc = { ...clone(prev), number, status: newStatus, lockedAt, version: prev.version + 1, snapshotHash: createHash('sha256').update(canonical.split(placeholder).join(number)).digest('hex') };
      const ev = { id: randomUUID(), merchantId, documentId: docId, at: lockedAt, actor: event.actor, action: event.action, fromStatus: prev.status, toStatus: newStatus, detail: JSON.parse(JSON.stringify(event.detail ?? {}).split(placeholder).join(number)) };
      if (hooks.beforeCommit) hooks.beforeCommit({ number, seq }); // a crash here must change nothing
      seqs.set(k, seq); docs.set(docId, finalDoc); events.push(Object.freeze(ev)); // commit point
      return clone(finalDoc);
    },
    async peekNextNumber(merchantId, type, year) { return (seqs.get(`${merchantId}|${type}|${year}`) ?? 0) + 1; },

    async allocateNumber(merchantId, type, year) {
      const k = `${merchantId}|${type}|${year}`;
      const next = (seqs.get(k) ?? 0) + 1;
      seqs.set(k, next);
      return next;
    },

    async listCompanies(merchantId) { return [...companies.values()].filter((c) => c.merchantId === merchantId).map(clone); },
    async updateCompany(id, patch) { const c = companies.get(id); if (!c) return null; const row = { ...c, ...clone(patch), id, merchantId: c.merchantId }; companies.set(id, row); return clone(row); },
    async saveCompany(c) { const row = { id: c.id ?? randomUUID(), ...clone(c) }; companies.set(row.id, row); return clone(row); },
    async getCompany(id) { const c = companies.get(id); return c ? clone(c) : null; },
    async findCompany(merchantId, { vatNumber, enterpriseNumber }) {
      const c = [...companies.values()].find((x) => x.merchantId === merchantId && ((vatNumber && x.vatNumber === vatNumber) || (enterpriseNumber && x.enterpriseNumber === enterpriseNumber)));
      return c ? clone(c) : null;
    },
    /** Contacts V1: archive/restore without touching any other field (mirrors supabase-store.js). */
    async setCompanyArchived(id, archivedAt) {
      const c = companies.get(id); if (!c) return null;
      c.archivedAt = archivedAt;
      return clone(c);
    },
    async saveSupplierInvoice(s) {
      if (s.sha256 && supplierInvoices.some((x) => x.merchantId === s.merchantId && x.sha256 === s.sha256)) throw new FinanceError('DUPLICATE_ATTACHMENT');
      const row = { id: randomUUID(), status: 'TO_REVIEW', ...clone(s) }; supplierInvoices.push(row); return clone(row);
    },
    async getSupplierInvoice(id) { const r = supplierInvoices.find((x) => x.id === id); return r ? clone(r) : null; },
    async findSupplierInvoiceBySha(merchantId, sha) { const r = supplierInvoices.find((x) => x.merchantId === merchantId && x.sha256 === sha); return r ? clone(r) : null; },
    /** Compare-and-set on the status: a concurrent change makes this return null. Only workflow / extracted fields may change; the attachment identity never does. */
    async updateSupplierInvoice(id, patch, expectedStatus) {
      const r = supplierInvoices.find((x) => x.id === id);
      if (!r || r.status !== expectedStatus) return null;
      for (const k of Object.keys(patch)) if (['id', 'merchantId', 'sha256', 'attachmentRef', 'source', 'receivedAt', 'fileName', 'contentType', 'sizeBytes'].includes(k)) throw new FinanceError('INBOX_ITEM_IS_IMMUTABLE', k);
      Object.assign(r, patch); r.paymentStatus = r.status === 'PAID' ? 'paid' : 'unpaid'; return clone(r);
    },
    /** Phase 1: link/unlink a supplier invoice to a fin_companies contact, independent of status/review
     * workflow (mirrors supabase-store.js). contactId=null unlinks. */
    async setSupplierInvoiceContact(id, contactId) {
      const r = supplierInvoices.find((x) => x.id === id);
      if (!r) return null;
      r.supplierCompanyId = contactId;
      return clone(r);
    },
    /** Attach a first document to a record that has none. An existing attachment is never replaced (returns null). */
    async setSupplierInvoiceAttachment(id, patch) {
      const r = supplierInvoices.find((x) => x.id === id);
      if (!r || r.attachmentRef) return null;
      Object.assign(r, clone(patch)); return clone(r);
    },
    async listSupplierInvoices(merchantId) { return supplierInvoices.filter((s) => s.merchantId === merchantId).map(clone); },
    _debug: { docs, events, payments, seqs, hooks },
  };
}
