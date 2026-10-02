// In-memory finance store: the reference implementation of the store interface, used by tests. It enforces the same
// rules the database triggers enforce (locked documents cannot change commercially, audit events and payments are
// append-only, one active invoice per source order, gapless per-year numbering), so tests exercise real invariants.

import { TRANSITIONS as STOCK_TRANSITIONS } from './stock.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { FinanceError } from './document.js';
import { formatNumber } from './numbering.js';
import { allocationRemaining, checkAllocation, checkPaymentReversal, creditedOfInvoice, netAllocated, paymentUnallocatedCents, requestFingerprint, standingAllocations, supplierTruth } from './payment-ledger.js';

const clone = (o) => structuredClone(o);

export function createMemoryStore() {
  const docs = new Map();
  const events = [];
  // Payment registry + allocations (mirror of fin_payment_registry / fin_payment_allocations): append-only, every rule checked BEFORE anything is written.
  const registry = []; const allocations = []; let seq = 0;
  const fingerprints = new Map(); // registry id -> request fingerprint (the database keeps request_hash)
  const seqs = new Map();
  const companies = new Map();
  const supplierInvoices = [];
  // Mirrors the database unique index fin_supplier_invoice_type_uq (merchant, supplier name, number, document type): NULLs never collide,
  // a missing type is the column default (INVOICE; a captured expense is typed RECEIPT by the application).
  const typeOf = (x) => x.documentType ?? 'INVOICE';
  const sameSupplierDocument = (s, exceptId = null) => s.supplierName != null && s.invoiceNumber != null && supplierInvoices.some((x) => x.id !== exceptId && x.merchantId === s.merchantId && x.supplierName === s.supplierName && x.invoiceNumber === s.invoiceNumber && typeOf(x) === typeOf(s));
  const supplierNet = (id) => netAllocated(allocations, { supplierInvoiceId: id });
  const withTruth = (r) => { const net = supplierNet(r.id); return clone({ ...r, allocatedCents: net, paymentStatus: supplierTruth(r, net).paymentStatus }); };
  /** After allocations of supplier invoices change: the legacy single-payment fields follow the allocations (mirror of fin_supplier_invoice_mirror). */
  function refreshSuppliers(rows) {
    for (const id of new Set(rows.map((a) => a.supplierInvoiceId).filter(Boolean))) {
      const r = supplierInvoices.find((x) => x.id === id); if (!r) continue;
      const net = supplierNet(id); const t = supplierTruth(r, net);
      if (t.paid) {
        const standing = [...new Set(allocations.filter((a) => a.supplierInvoiceId === id).map((a) => a.paymentId))].map((pid) => ({ p: registry.find((x) => x.id === pid), n: allocations.filter((a) => a.supplierInvoiceId === id && a.paymentId === pid).reduce((s, a) => s + a.amountCents, 0) }))
          .filter((x) => x.n > 0).sort((a, b) => String(b.p.paidOn).localeCompare(String(a.p.paidOn)) || b.p.seq - a.p.seq);
        r.status = 'PAID'; r.paidAt = standing[0]?.p.paidOn ?? null; r.paidAmountCents = net; r.paidReference = standing[0]?.p.reference ?? null;
      } else if (r.status === 'PAID') { r.status = 'TO_PAY'; r.paidAt = null; r.paidAmountCents = null; r.paidReference = null; }
      r.paymentStatus = t.paymentStatus;
    }
  }
  const stockMovements = [];
  const bankConnections = new Map(); const bankTx = []; const bankBalances = new Map(); const cashCounts = []; const cashMovements = [];
  const hooks = { beforeCommit: null }; // failure injection for crash tests: throw to simulate a crash inside the transaction

  return {
    newId: () => randomUUID(),

    async getDocument(id) { const d = docs.get(id); return d ? clone(d) : null; },

    /** Insert or update with optimistic concurrency and the immutability rules of a locked document. */
    async saveDocument(doc, expectedVersion = null) {
      const prev = docs.get(doc.id);
      // merchant-consistent references (composite foreign keys in the database)
      for (const [ref, label] of [[doc.relatedDocumentId, 'relatedDocumentId'], [doc.convertedInvoiceId, 'convertedInvoiceId']]) { const t = ref ? docs.get(ref) : null; if (ref && t && t.merchantId !== doc.merchantId) throw new FinanceError('CROSS_MERCHANT_REFERENCE', label); }
      if (doc.customer?.companyId) { const c = companies.get(doc.customer.companyId); if (c && c.merchantId !== doc.merchantId) throw new FinanceError('CROSS_MERCHANT_REFERENCE', 'customer.companyId'); }
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

    async appendEvent(e) {
      const d = e.documentId ? docs.get(e.documentId) : null;
      if (d && e.merchantId && d.merchantId !== e.merchantId) throw new FinanceError('CROSS_MERCHANT_REFERENCE', 'event.documentId');
      events.push(Object.freeze({ id: randomUUID(), ...clone(e) }));
    },
    async listEvents(documentId) { return events.filter((e) => e.documentId === documentId).map(clone); },
    /** Recent document lifecycle events across the whole merchant (dashboard "recent activity" feed) - read only, newest first. */
    async listEventsForMerchant({ merchantId, limit = 20 } = {}) {
      return events.filter((e) => e.merchantId === merchantId).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, limit).map(clone);
    },

    // ---- payment registry (the only way money is recorded). Every method validates everything first and writes last: atomic by construction. ----
    async getPaymentByKey(merchantId, key) {
      const p = registry.find((x) => x.merchantId === merchantId && x.idempotencyKey === key); if (!p) return null;
      return { payment: clone(p), allocations: allocations.filter((a) => a.paymentId === p.id).map(clone), fingerprint: fingerprints.get(p.id) };
    },
    async recordPayment({ merchantId, key, direction, amountCents, currency, paidOn, method = 'unspecified', reference = null, actor = null, allocations: wanted = [], at = null }) {
      if (!key) throw new FinanceError('IDEMPOTENCY_KEY_REQUIRED');
      if (!['IN', 'OUT'].includes(direction)) throw new FinanceError('DIRECTION_INVALID');
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new FinanceError('AMOUNT_INVALID');
      const fp = requestFingerprint({ direction, amountCents, currency, paidOn, method, reference, allocations: wanted });
      const prior = registry.find((x) => x.merchantId === merchantId && x.idempotencyKey === key);
      if (prior) {
        if (fingerprints.get(prior.id) !== fp) throw new FinanceError('IDEMPOTENCY_KEY_REUSED', key);
        return { duplicate: true, payment: clone(prior), allocations: allocations.filter((a) => a.paymentId === prior.id).map(clone) };
      }
      const payment = { id: randomUUID(), merchantId, direction, amountCents, currency, paidOn, method, reference, reversalOfId: null, idempotencyKey: key, actor: clone(actor), createdAt: at ?? new Date().toISOString(), seq: ++seq };
      const staged = []; const reg = [...registry, payment]; const plan = [...wanted].sort((a, b) => String(a.customerDocumentId ?? a.supplierInvoiceId).localeCompare(String(b.customerDocumentId ?? b.supplierInvoiceId)));
      const docList = [...docs.values()];
      for (const w of plan) {
        const kind = w.customerDocumentId ? 'customer' : 'supplier'; const targetId = w.customerDocumentId ?? w.supplierInvoiceId;
        const target = kind === 'customer' ? docs.get(targetId) : supplierInvoices.find((x) => x.id === targetId);
        const row = { id: randomUUID(), merchantId, paymentId: payment.id, customerDocumentId: w.customerDocumentId ?? null, supplierInvoiceId: w.supplierInvoiceId ?? null, amountCents: w.amountCents, currency, reversesAllocationId: null, idempotencyKey: `${key}:${targetId}`, reason: null, actor: clone(actor), createdAt: payment.createdAt, seq: ++seq };
        checkAllocation({ merchantId, payment, registry: reg, allocations: [...allocations, ...staged], docs: docList, target, kind, allocation: row });
        staged.push(row);
      }
      // ---- commit point: nothing above wrote anything ----
      registry.push(payment); fingerprints.set(payment.id, fp); allocations.push(...staged);
      const customerIds = [...new Set(staged.map((a) => a.customerDocumentId).filter(Boolean))]; const doc = customerIds.length === 1 ? docs.get(customerIds[0]) : null;
      events.push(Object.freeze({ id: randomUUID(), merchantId, documentId: doc?.id ?? null, at: at ?? payment.createdAt, actor: clone(actor), action: direction === 'IN' ? 'RECORD_PAYMENT' : 'RECORD_SUPPLIER_PAYMENT', fromStatus: doc?.status ?? null, toStatus: doc?.status ?? null,
        detail: { paymentId: payment.id, amountCents, currency, method, paidOn, direction, allocations: clone(wanted) } }));
      refreshSuppliers(staged);
      return { duplicate: false, payment: clone(payment), allocations: staged.map(clone) };
    },
    /** Take back (all or part of) allocations: appends negative rows linked to the originals; idempotent per (key, allocation). */
    async reverseAllocations({ merchantId, key, items, reason = null, actor = null, at = null }) {
      if (!key) throw new FinanceError('IDEMPOTENCY_KEY_REQUIRED');
      const staged = []; let duplicate = false; const out = []; const docList = [...docs.values()];
      const sorted = [...items].sort((a, b) => { const t = (i) => { const o = allocations.find((x) => x.id === i.allocationId); return String(o?.customerDocumentId ?? o?.supplierInvoiceId ?? ''); }; return t(a).localeCompare(t(b)); });
      for (const it of sorted) {
        const orig = allocations.find((a) => a.id === it.allocationId && a.merchantId === merchantId);
        if (!orig || orig.amountCents <= 0) throw new FinanceError('ALLOCATION_NOT_FOUND');
        const idem = `${key}:${it.allocationId}`; const prior = allocations.find((a) => a.merchantId === merchantId && a.idempotencyKey === idem);
        if (prior) { if (it.amountCents != null && -prior.amountCents !== it.amountCents) throw new FinanceError('IDEMPOTENCY_KEY_REUSED', key); duplicate = true; out.push(clone(prior)); continue; }
        const left = allocationRemaining([...allocations, ...staged], orig.id); const amt = it.amountCents ?? left;
        if (!Number.isInteger(amt) || amt <= 0 || amt > left) throw new FinanceError('REVERSAL_EXCEEDS_ALLOCATION', `${amt} > ${left} (cents)`);
        const row = { id: randomUUID(), merchantId, paymentId: orig.paymentId, customerDocumentId: orig.customerDocumentId, supplierInvoiceId: orig.supplierInvoiceId, amountCents: -amt, currency: orig.currency, reversesAllocationId: orig.id, idempotencyKey: idem, reason, actor: clone(actor), createdAt: at ?? new Date().toISOString(), seq: ++seq };
        const kind = orig.customerDocumentId ? 'customer' : 'supplier'; const target = kind === 'customer' ? docs.get(orig.customerDocumentId) : supplierInvoices.find((x) => x.id === orig.supplierInvoiceId);
        checkAllocation({ merchantId, payment: registry.find((p) => p.id === orig.paymentId), registry, allocations: [...allocations, ...staged], docs: docList, target, kind, allocation: row });
        staged.push(row); out.push(row);
      }
      allocations.push(...staged);
      for (const r of staged) events.push(Object.freeze({ id: randomUUID(), merchantId, documentId: r.customerDocumentId, at: r.createdAt, actor: clone(actor), action: 'REVERSE_PAYMENT_ALLOCATION', fromStatus: null, toStatus: null, detail: { allocationId: r.reversesAllocationId, reversalId: r.id, paymentId: r.paymentId, amountCents: -r.amountCents, reason } }));
      refreshSuppliers(staged);
      return { duplicate: duplicate && staged.length === 0, reversals: out.map(clone) };
    },
    /** A payment entered by mistake: every standing allocation is reversed, then a registry reversal row takes back what is left of it. */
    async voidPayment({ merchantId, key, paymentId, on, reason = null, actor = null, at = null }) {
      if (!key) throw new FinanceError('IDEMPOTENCY_KEY_REQUIRED');
      const fp = JSON.stringify(['VOID', paymentId, reason ?? '']);
      const prior = registry.find((x) => x.merchantId === merchantId && x.idempotencyKey === key);
      if (prior) { if (fingerprints.get(prior.id) !== fp) throw new FinanceError('IDEMPOTENCY_KEY_REUSED', key); return { duplicate: true, reversal: clone(prior) }; }
      const pay = registry.find((p) => p.id === paymentId && p.merchantId === merchantId);
      if (!pay || pay.reversalOfId) throw new FinanceError('PAYMENT_NOT_FOUND');
      const reversed = registry.filter((p) => p.reversalOfId === pay.id).reduce((a, p) => a + p.amountCents, 0); const leftCents = pay.amountCents - reversed;
      const standing = allocations.filter((a) => a.paymentId === pay.id && a.amountCents > 0 && allocationRemaining(allocations, a.id) > 0);
      if (leftCents <= 0) throw new FinanceError('PAYMENT_ALREADY_REVERSED');
      // dry run on copies first so a refusal leaves nothing behind
      const saveAlloc = allocations.length; const saveEvents = events.length;
      try {
        if (standing.length) await this.reverseAllocations({ merchantId, key: `${key}:void`, items: standing.map((a) => ({ allocationId: a.id, amountCents: null })), reason: reason ?? 'PAYMENT_VOIDED', actor, at });
        const row = { id: randomUUID(), merchantId, direction: pay.direction, amountCents: leftCents, currency: pay.currency, paidOn: on ?? pay.paidOn, method: pay.method, reference: reason, reversalOfId: pay.id, idempotencyKey: key, actor: clone(actor), createdAt: at ?? new Date().toISOString(), seq: ++seq };
        checkPaymentReversal({ payment: pay, registry, allocations, reversal: row });
        registry.push(row); fingerprints.set(row.id, fp);
        events.push(Object.freeze({ id: randomUUID(), merchantId, documentId: null, at: row.createdAt, actor: clone(actor), action: 'VOID_PAYMENT', fromStatus: null, toStatus: null, detail: { paymentId: pay.id, reversalId: row.id, amountCents: leftCents, reason } }));
        return { duplicate: false, reversal: clone(row) };
      } catch (e) { allocations.length = saveAlloc; events.length = saveEvents; refreshSuppliers(standing); throw e; }
    },
    async listAllocations({ merchantId, customerDocumentId, supplierInvoiceId } = {}) {
      return allocations.filter((a) => (!merchantId || a.merchantId === merchantId) && (!customerDocumentId || a.customerDocumentId === customerDocumentId) && (!supplierInvoiceId || a.supplierInvoiceId === supplierInvoiceId))
        .map((a) => { const p = registry.find((x) => x.id === a.paymentId); return clone({ ...a, paidOn: p.paidOn, method: p.method, reference: p.reference, direction: p.direction }); });
    },
    async listRegistry(merchantId) { return registry.filter((p) => p.merchantId === merchantId).map(clone); },
    /** Customer-invoice payments as the rest of the application reads them: one entry per allocation (negative = a reversal), derived, never stored separately. */
    async listPayments(documentId) {
      return allocations.filter((a) => a.customerDocumentId === documentId).map((a) => { const p = registry.find((x) => x.id === a.paymentId); return { id: a.paymentId, allocationId: a.id, documentId, merchantId: a.merchantId, amountCents: a.amountCents, paidOn: p.paidOn, method: p.method, reference: a.amountCents < 0 ? (a.reason ?? p.reference) : p.reference }; });
    },
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
      // a handled transaction is claimed once: matched_* are frozen (the only later write is attaching the payment id once)
      if (t.status !== 'NEW') for (const k of ['matchedKind', 'matchedDocumentId', 'matchedAmountCents', 'matchedAt']) if (k in patch && patch[k] !== t[k]) throw new FinanceError('BANK_TRANSACTION_ALREADY_CLAIMED', k);
      if (t.status !== 'NEW' && 'matchedPaymentId' in patch && t.matchedPaymentId && patch.matchedPaymentId !== t.matchedPaymentId) throw new FinanceError('BANK_TRANSACTION_ALREADY_CLAIMED', 'matchedPaymentId');
      if ('matchedAmountCents' in patch && patch.matchedAmountCents != null && (patch.matchedAmountCents < 0 || patch.matchedAmountCents > Math.abs(t.amountCents))) throw new FinanceError('BANK_MATCH_EXCEEDS_TRANSACTION', String(patch.matchedAmountCents));
      if (patch.matchedDocumentId && patch.matchedDocumentId !== t.matchedDocumentId) {
        const ok = patch.matchedKind === 'INVOICE' ? docs.get(patch.matchedDocumentId)?.merchantId === t.merchantId : patch.matchedKind === 'SUPPLIER_INVOICE' ? supplierInvoices.find((x) => x.id === patch.matchedDocumentId)?.merchantId === t.merchantId : true;
        if (!ok) throw new FinanceError('BANK_MATCH_TARGET_NOT_FOUND', patch.matchedDocumentId);
      }
      if (patch.matchedPaymentId && patch.matchedPaymentId !== t.matchedPaymentId && registry.find((p) => p.id === patch.matchedPaymentId)?.merchantId !== t.merchantId) throw new FinanceError('BANK_MATCH_PAYMENT_NOT_FOUND', patch.matchedPaymentId);
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
    async listPaymentsForMerchant(merchantId) { const out = []; for (const a of allocations.filter((x) => x.merchantId === merchantId && x.customerDocumentId)) out.push(...(await this.listPayments(a.customerDocumentId)).filter((p) => p.allocationId === a.id)); return out; },

    /**
     * ATOMIC issue: allocate the number, lock the document, hash it and append the audit event as ONE unit. Anything that throws
     * before the commit point (including the injected beforeCommit hook) leaves sequence, document and events untouched.
     */
    async issueDocument({ merchantId, docId, expectedVersion, newStatus, numbering, year, canonical, placeholder, lockedAt, event }) {
      const prev = docs.get(docId);
      if (!prev || prev.merchantId !== merchantId) throw new FinanceError('DOCUMENT_NOT_FOUND', docId);
      if (prev.lockedAt || prev.number || prev.version !== expectedVersion) throw new FinanceError('CONCURRENT_MODIFICATION');
      if (prev.type === 'credit_note') {
        const inv = prev.relatedDocumentId ? docs.get(prev.relatedDocumentId) : null;
        if (!prev.relatedDocumentId) throw new FinanceError('CREDIT_WITHOUT_INVOICE');
        if (!inv || inv.merchantId !== merchantId) throw new FinanceError('CREDIT_INVOICE_NOT_FOUND');
        if (inv.type !== 'invoice' || !inv.lockedAt) throw new FinanceError('CREDIT_INVOICE_NOT_ISSUED');
        if (inv.currency !== prev.currency) throw new FinanceError('CREDIT_CURRENCY_MISMATCH', `${prev.currency} vs ${inv.currency}`);
        const payable = (inv.totals?.grossCents ?? 0) + (inv.totals?.roundingCents ?? 0); const mine = (prev.totals?.grossCents ?? 0) + (prev.totals?.roundingCents ?? 0); const credited = creditedOfInvoice([...docs.values()], inv, prev.id);
        if (credited + mine > payable) throw new FinanceError('CREDIT_EXCEEDS_INVOICE', `credit ${mine} > creditable ${payable - credited} (cents)`);
      }
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
      if (s.status === 'PAID') throw new FinanceError('PAID_REQUIRES_ALLOCATIONS', 'insert');
      if (s.supplierCompanyId) { const c = companies.get(s.supplierCompanyId); if (c && c.merchantId !== s.merchantId) throw new FinanceError('CROSS_MERCHANT_REFERENCE', 'supplierCompanyId'); }
      if (s.sha256 && supplierInvoices.some((x) => x.merchantId === s.merchantId && x.sha256 === s.sha256)) throw new FinanceError('DUPLICATE_ATTACHMENT');
      if (sameSupplierDocument(s)) throw new FinanceError('DUPLICATE_SUPPLIER_INVOICE');
      const row = { id: randomUUID(), status: 'TO_REVIEW', ...clone(s) }; row.paymentStatus = 'unpaid'; supplierInvoices.push(row); return withTruth(row);
    },
    async getSupplierInvoice(id) { const r = supplierInvoices.find((x) => x.id === id); return r ? withTruth(r) : null; },
    async findSupplierInvoiceBySha(merchantId, sha) { const r = supplierInvoices.find((x) => x.merchantId === merchantId && x.sha256 === sha); return r ? withTruth(r) : null; },
    /** Compare-and-set on the status: a concurrent change makes this return null. Only workflow / extracted fields may change; the attachment identity never does. */
    async updateSupplierInvoice(id, patch, expectedStatus) {
      const r = supplierInvoices.find((x) => x.id === id);
      if (!r || r.status !== expectedStatus) return null;
      for (const k of Object.keys(patch)) if (['id', 'merchantId', 'sha256', 'attachmentRef', 'source', 'receivedAt', 'fileName', 'contentType', 'sizeBytes'].includes(k)) throw new FinanceError('INBOX_ITEM_IS_IMMUTABLE', k);
      if (sameSupplierDocument({ ...r, ...patch }, id)) throw new FinanceError('DUPLICATE_SUPPLIER_INVOICE');
      // the database refuses the same things (trigger fin_supplier_invoice_truth_guard): PAID only through allocations, nothing financial changes under payments
      const net = supplierNet(id); const next = { ...r, ...patch };
      if (next.status === 'PAID' && !supplierTruth(next, net).paid) throw new FinanceError('PAID_REQUIRES_ALLOCATIONS', `allocated ${net} of ${next.grossCents ?? 0} (cents)`);
      if (net !== 0 && (('grossCents' in patch && patch.grossCents !== r.grossCents) || ('currency' in patch && patch.currency !== r.currency) || ['RECEIVED', 'TO_REVIEW', 'REJECTED'].includes(next.status))) throw new FinanceError('INVOICE_HAS_PAYMENTS', id);
      Object.assign(r, patch); r.paymentStatus = supplierTruth(r, net).paymentStatus; return withTruth(r);
    },
    /** Phase 1: link/unlink a supplier invoice to a fin_companies contact, independent of status/review
     * workflow (mirrors supabase-store.js). contactId=null unlinks. */
    async setSupplierInvoiceContact(id, contactId) {
      const r = supplierInvoices.find((x) => x.id === id);
      if (!r) return null;
      if (contactId) { const c = companies.get(contactId); if (c && c.merchantId !== r.merchantId) throw new FinanceError('CROSS_MERCHANT_REFERENCE', 'supplierCompanyId'); }
      r.supplierCompanyId = contactId;
      return withTruth(r);
    },
    /** Attach a first document to a record that has none. An existing attachment is never replaced (returns null). */
    async setSupplierInvoiceAttachment(id, patch) {
      const r = supplierInvoices.find((x) => x.id === id);
      if (!r || r.attachmentRef) return null;
      Object.assign(r, clone(patch)); return withTruth(r);
    },
    async listSupplierInvoices(merchantId) { return supplierInvoices.filter((s) => s.merchantId === merchantId).map(withTruth); },
    _debug: { docs, events, registry, allocations, seqs, hooks },
  };
}
