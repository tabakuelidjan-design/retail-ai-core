// Finance service: orchestrates the pure document engine, the store, numbering, linkage checks and the audit trail.
// The agent may PREPARE (create, validate, calculate, list missing fields). Anything that issues, sends or approves is a
// merchant action and is refused for a non-merchant actor. Nothing here contacts an external system.

import {
  FinanceError, acceptQuote, canonicalSnapshot, deepFreeze, makeNumberPlaceholder, applyStatus, cancelDraft, convertQuoteToInvoice, createDraft, creditNoteFromInvoice, decide, effectiveStatus, makePayment, payableOf,
  markSent, rejectQuote, sendQuote, settledStatus, settlement, submitForApproval, updateDraft, validateForIssue, verifyIntegrity,
} from './document.js';
import { randomUUID } from 'node:crypto';
import { requireClock } from './civil-date.js';
import { toCents } from './money.js';
import { standingAllocations } from './payment-ledger.js';
import { createPayments } from './payments.js';
import { checkLinkage, orderTotalsFromLedger } from './linking.js';
import { DEFAULT_NUMBERING, formatNumber } from './numbering.js';

/**
 * @param {{store: object, config: object, clock?: {now: () => string, today: () => string}, ledgerProvider?: () => Promise<object|null>}} deps
 * config: { merchantId, seller, numbering?, vat: { allowedRatesBp[] }, defaults?: { currency, language, paymentTermsDays, paymentTerms }, linking?: { dupWindowDays, toleranceCents } }
 */
export function createFinanceService({ store, config, clock, ledgerProvider = async () => null, hooks = {} }) {
  requireClock(clock, 'createFinanceService');
  const { now, today } = clock;
  const vatConfig = config.vat ?? { allowedRatesBp: [] };
  const numbering = { ...DEFAULT_NUMBERING, ...(config.numbering ?? {}) };
  const ctx = { vatConfig };
  const numberingFor = (type) => ({ prefix: numbering[type].prefix, pad: numbering[type].pad, format: numbering.format });

  const seal = (d) => (d?.lockedAt ? deepFreeze(d) : d);
  // Tenant isolation: a document of another merchant is indistinguishable from a missing one (no enumeration).
  const must = async (id) => { const d = await store.getDocument(id); if (!d || d.merchantId !== config.merchantId) throw new FinanceError('DOCUMENT_NOT_FOUND', id); return seal(d); };
  const persist = async (doc, prev, event) => {
    const saved = await store.saveDocument(doc, prev ? prev.version : null);
    if (event) await store.appendEvent({ ...event, documentId: doc.id, at: now() });
    return seal(saved);
  };
  const relatedCreditNotes = async (invoice) => (await store.listDocuments({ merchantId: config.merchantId, type: 'credit_note', relatedDocumentId: invoice.id }));
  /** Money handed back for the credit notes of an invoice: the allocations to those credit notes (negative = a reversed refund). */
  const refundsOf = async (creditNotes) => { const out = []; for (const c of creditNotes) out.push(...(await store.listPayments(c.id))); return out; };

  /** A negative payment is a correction: reverse the most recent standing allocations up to the amount (all or nothing, one atomic call, idempotent per key). */
  async function correct(invoice, p, key, actor) {
    const already = (await store.listAllocations({ merchantId: config.merchantId, customerDocumentId: invoice.id })).filter((a) => a.amountCents < 0 && a.idempotencyKey.startsWith(`${key}:`));
    if (already.length) return { id: already[0].paymentId, documentId: invoice.id, merchantId: invoice.merchantId, amountCents: already.reduce((s, a) => s + a.amountCents, 0), paidOn: p.paidOn, method: p.method, reference: p.reference, duplicate: true };
    let need = -p.amountCents; const items = [];
    for (const a of standingAllocations(await store.listAllocations({ merchantId: config.merchantId, customerDocumentId: invoice.id }), { customerDocumentId: invoice.id })) { if (need <= 0) break; const take = Math.min(need, a.remainingCents); items.push({ allocationId: a.id, amountCents: take }); need -= take; }
    if (need > 0) throw new FinanceError('CORRECTION_EXCEEDS_PAID', `${-p.amountCents} > paid`);
    const r = await store.reverseAllocations({ merchantId: config.merchantId, key, items, reason: p.reference, actor, at: now() });
    return { id: r.reversals[0].paymentId, documentId: invoice.id, merchantId: invoice.merchantId, amountCents: p.amountCents, paidOn: p.paidOn, method: p.method, reference: p.reference, duplicate: r.duplicate };
  }

  async function linkage(doc) {
    const ledger = await ledgerProvider();
    const invoices = await store.listDocuments({ merchantId: config.merchantId });
    return checkLinkage(doc, { orderTotals: ledger ? orderTotalsFromLedger(ledger) : null, invoices, dupWindowDays: config.linking?.dupWindowDays ?? 3, toleranceCents: config.linking?.toleranceCents ?? 1 });
  }

  /** Everything that blocks issuance right now, so the merchant sees the full list at once. */
  async function readiness(doc) {
    const errors = validateForIssue(doc, ctx);
    const l = await linkage(doc);
    // a credit note against a stock-decremented invoice needs an explicit decision: are the goods returned to sellable stock?
    if (doc.type === 'credit_note' && hooks.restockDecisionNeeded && doc.relatedDocumentId) { const inv = await store.getDocument(doc.relatedDocumentId); if (inv && await hooks.restockDecisionNeeded(doc, inv)) errors.push('STOCK_RESTOCK_DECISION_REQUIRED'); }
    return { ready: errors.length === 0 && l.errors.length === 0, errors: [...errors, ...l.errors], warnings: l.warnings, checks: l.checks };
  }

  const service = {
    readiness,

    async create(input, actor) {
      const { doc, errors } = createDraft({
        ...input, id: store.newId(), merchantId: config.merchantId, seller: input.seller ?? config.seller,
        currency: input.currency ?? config.defaults?.currency, language: input.language ?? config.defaults?.language,
        paymentTermsDays: input.paymentTermsDays ?? config.defaults?.paymentTermsDays ?? null, paymentTerms: input.paymentTerms ?? config.defaults?.paymentTerms ?? null,
        issueDate: input.issueDate ?? today(),
      });
      if (errors.length) throw new FinanceError('INPUT_INVALID', errors.join(', '));
      const saved = await persist(doc, null, { actor, action: 'CREATE_DRAFT', fromStatus: null, toStatus: 'DRAFT', detail: { type: doc.type } });
      return saved;
    },

    async update(id, patch, actor) {
      const prev = await must(id);
      const { doc, errors } = updateDraft(prev, patch);
      if (errors.length) throw new FinanceError('INPUT_INVALID', errors.join(', '));
      return persist({ ...doc, version: prev.version + 1 }, prev, { actor, action: 'UPDATE_DRAFT', fromStatus: 'DRAFT', toStatus: 'DRAFT', detail: { fields: Object.keys(patch) } });
    },

    async submit(id, actor) {
      const prev = await must(id);
      const r = await readiness(prev);
      if (!r.ready) throw new FinanceError('NOT_READY_FOR_APPROVAL', r.errors.join(', '));
      const { doc, event } = submitForApproval(prev, { actor, ctx });
      return persist(doc, prev, event);
    },

    /**
     * The merchant decision. APPROVE validates, then issues ATOMICALLY: number allocation, freezing, hash and audit event are one
     * store transaction, so a failure or crash at any point leaves no burnt number and no half-issued document.
     */
    async decide(id, decision, actor, note) {
      const prev = await must(id);
      if (actor?.type !== 'merchant') throw new FinanceError('APPROVAL_REQUIRES_A_MERCHANT_ACTOR');
      if (decision !== 'APPROVE') { const { doc, event } = decide(prev, { decision, actor, at: now(), note, ctx }); return persist(doc, prev, event); }
      const r = await readiness(prev);
      if (!r.ready) throw new FinanceError('NOT_READY_TO_ISSUE', r.errors.join(', '));
      const at = now();
      const placeholder = makeNumberPlaceholder();
      const { doc: template, event } = decide(prev, { decision, actor, number: placeholder, at, note, ctx });
      const saved = seal(await store.issueDocument({ merchantId: config.merchantId, docId: id, expectedVersion: prev.version, newStatus: 'ISSUED', numbering: numberingFor(prev.type), year: Number(prev.issueDate.slice(0, 4)), canonical: canonicalSnapshot(template), placeholder, lockedAt: at, event: { actor, action: event.action, detail: event.detail } }));
      if (saved.type === 'credit_note' && saved.relatedDocumentId) await this.resettle(saved.relatedDocumentId, actor);
      // stock: recorded once per document line (idempotent); a failure never undoes an issued document, it is audited and can be reconciled
      if (hooks.afterIssue) { try { await hooks.afterIssue(saved); } catch (e) { await store.appendEvent({ documentId: saved.id, merchantId: config.merchantId, actor, action: 'STOCK_HOOK_FAILED', fromStatus: saved.status, toStatus: saved.status, detail: { error: String(e.code ?? e.message).slice(0, 120) }, at: now() }); } }
      // legal archive (PDF original, structured original, compliance record): a failure never undoes an issued document, it is audited and the archive can be repeated (idempotent)
      if (hooks.onIssued) { try { await hooks.onIssued(saved, { actor }); } catch (e) { await store.appendEvent({ documentId: saved.id, merchantId: config.merchantId, actor, action: 'ARCHIVE_HOOK_FAILED', fromStatus: saved.status, toStatus: saved.status, detail: { error: String(e?.message ?? e).slice(0, 200) }, at: now() }); } }
      return saved;
    },

    async markSent(id, actor, channel) { const prev = await must(id); const { doc, event } = markSent(prev, { actor, at: now(), channel }); return persist(doc, prev, event); },
    async cancelDraft(id, actor, reason) { const prev = await must(id); const { doc, event } = cancelDraft(prev, { actor, at: now(), reason }); return persist(doc, prev, event); },

    // ---- quotes ----
    async sendQuote(id, actor) {
      const prev = await must(id);
      if (actor?.type !== 'merchant') throw new FinanceError('SENDING_REQUIRES_A_MERCHANT_ACTOR');
      const errors = validateForIssue(prev, ctx);
      if (errors.length) throw new FinanceError('QUOTE_NOT_READY', errors.join(', '));
      const at = now();
      const placeholder = makeNumberPlaceholder();
      const { doc: template, event } = sendQuote(prev, { actor, number: placeholder, at, ctx });
      return seal(await store.issueDocument({ merchantId: config.merchantId, docId: id, expectedVersion: prev.version, newStatus: 'SENT', numbering: numberingFor('quote'), year: Number(prev.issueDate.slice(0, 4)), canonical: canonicalSnapshot(template), placeholder, lockedAt: at, event: { actor, action: event.action, detail: event.detail } }));
    },
    async acceptQuote(id, actor) { const prev = await must(id); const { doc, event } = acceptQuote(prev, { actor, at: now() }); return persist(doc, prev, event); },
    async rejectQuote(id, actor) { const prev = await must(id); const { doc, event } = rejectQuote(prev, { actor, at: now() }); return persist(doc, prev, event); },
    async convertQuote(id, actor, opts = {}) {
      const prev = await must(id);
      const { invoice, quote, event } = convertQuoteToInvoice(prev, { invoiceId: store.newId(), actor, at: now(), issueDate: opts.issueDate ?? today(), revenueBasis: opts.revenueBasis ?? 'standalone_b2b', sourceOrderId: opts.sourceOrderId ?? null });
      const savedInvoice = await store.saveDocument(invoice, null);
      await store.appendEvent({ documentId: invoice.id, merchantId: invoice.merchantId, actor, action: 'CREATE_DRAFT_FROM_QUOTE', fromStatus: null, toStatus: 'DRAFT', detail: { quoteId: prev.id, quoteNumber: prev.number }, at: now() });
      await persist(quote, prev, event);
      return savedInvoice;
    },

    // ---- credit notes ----
    async createCreditNote(invoiceId, { reason, lines, restock }, actor) {
      const invoice = await must(invoiceId);
      const existing = await relatedCreditNotes(invoice);
      const { doc, event } = creditNoteFromInvoice(invoice, { creditNoteId: store.newId(), reason, lines, existingCreditNotes: existing, actor, at: now() });
      const withDates = { ...doc, issueDate: today(), dueDate: today(), stockReturn: typeof restock === 'boolean' ? { restock, decidedAt: now() } : null };
      return persist(withDates, null, event);
    },

    // ---- payments / status ----
    /**
     * Record a customer payment. The DATABASE is the authority (ceiling under a row lock, idempotency, atomic registry + allocation + audit event);
     * the checks below only give early, friendly errors. IDEMPOTENCY: the caller's key (or a fresh one) identifies the operation; a retry with the same key
     * returns the operation that already committed (duplicate: true), even if the invoice has meanwhile become PAID. A negative amount is a correction:
     * it reverses the most recent standing allocations (the registry is append-only, nothing is ever deleted).
     */
    async recordPayment(invoiceId, payment, actor) {
      const invoice = await must(invoiceId);
      const key = payment.idempotencyKey ?? randomUUID();
      const shape = (r) => ({ id: r.payment.id, documentId: invoiceId, merchantId: invoice.merchantId, amountCents: r.payment.amountCents, paidOn: r.payment.paidOn, method: r.payment.method, reference: r.payment.reference, duplicate: r.duplicate === true });
      const done = await store.getPaymentByKey(config.merchantId, key);
      if (done) { // an operation with this key already committed: same request => the same result, a different request => refused
        const standing = done.allocations.filter((x) => x.amountCents > 0); const a = standing[0]; const cents = toCents(payment.amount); // reversals appended later do not change what the request was
        if (standing.length !== 1 || a.customerDocumentId !== invoiceId || done.payment.amountCents !== cents || done.payment.paidOn !== payment.paidOn) throw new FinanceError('IDEMPOTENCY_KEY_REUSED', key);
        await this.resettle(invoiceId, actor);
        return shape({ payment: done.payment, duplicate: true });
      }
      const [payments, credits] = [await store.listPayments(invoiceId), await relatedCreditNotes(invoice)];
      const p = makePayment(invoice, payments, credits, { ...payment, actor, refunds: await refundsOf(credits) }); // validation + friendly errors (negative = correction, see below)
      if (p.amountCents < 0) { const out = await correct(invoice, p, key, actor); await this.resettle(invoiceId, actor); return out; }
      const r = await store.recordPayment({ merchantId: invoice.merchantId, key, direction: 'IN', amountCents: p.amountCents, currency: invoice.currency, paidOn: p.paidOn, method: p.method, reference: p.reference, actor, at: now(),
        allocations: [{ customerDocumentId: invoiceId, amountCents: p.amountCents }] });
      await this.resettle(invoiceId, actor);
      return shape(r);
    },

    /** Take back (all or part of) one allocation of an invoice. Idempotent per key; nothing is deleted: a negative allocation linked to the original is appended. */
    async reversePayment(invoiceId, { allocationId, amountCents = null, reason, idempotencyKey }, actor) {
      await must(invoiceId);
      if (!String(reason ?? '').trim()) throw new FinanceError('REASON_REQUIRED');
      const r = await store.reverseAllocations({ merchantId: config.merchantId, key: idempotencyKey ?? randomUUID(), items: [{ allocationId, amountCents }], reason: String(reason).slice(0, 300), actor, at: now() });
      await this.resettle(invoiceId, actor);
      return r;
    },

    /** A payment entered by mistake: every allocation still standing is reversed and the payment itself is reversed (it stays in the history). */
    async voidPayment(paymentId, { reason, idempotencyKey }, actor) {
      if (!String(reason ?? '').trim()) throw new FinanceError('REASON_REQUIRED');
      const touched = [...new Set((await store.listAllocations({ merchantId: config.merchantId })).filter((a) => a.paymentId === paymentId && a.customerDocumentId).map((a) => a.customerDocumentId))];
      const r = await store.voidPayment({ merchantId: config.merchantId, key: idempotencyKey ?? randomUUID(), paymentId, on: today(), reason: String(reason).slice(0, 300), actor, at: now() });
      for (const id of touched) await this.resettle(id, actor);
      return r;
    },

    /** Re-derive the stored lifecycle status from payments and credit notes (call after either changes). */
    async resettle(invoiceId, actor) {
      // The stored status is only a mirror of the payment truth and is re-derived idempotently. Money has ALREADY been committed when this runs, so a lost race on the mirror
      // (another payment re-derived it first) must never surface as a failure of that payment: re-read, re-derive, and try again.
      for (let attempt = 0; ; attempt += 1) {
        const prev = await must(invoiceId);
        if (prev.type !== 'invoice' || !prev.lockedAt) return prev;
        const credits = await relatedCreditNotes(prev); const s = settlement(prev, await store.listPayments(invoiceId), credits, await refundsOf(credits));
        const status = settledStatus(prev, s);
        if (status === prev.status) return prev;
        const { doc, event } = applyStatus(prev, status, { actor, at: now(), reason: 'settlement' });
        try { return await persist(doc, prev, event); } catch (e) { if (e?.code !== 'CONCURRENT_MODIFICATION' || attempt >= 12) throw e; }
      }
    },

    async view(id) {
      const doc = await must(id);
      if (doc.type === 'credit_note' && doc.lockedAt && doc.relatedDocumentId) { // what can still be handed back for this credit note (the interface never recomputes it)
        const invoice = await must(doc.relatedDocumentId); const credits = await relatedCreditNotes(invoice); const refunds = await refundsOf(credits);
        const s = settlement(invoice, await store.listPayments(invoice.id), credits, refunds); const done = refunds.filter((r) => r.documentId === doc.id).reduce((a, r) => a + r.amountCents, 0);
        return { doc, integrity: verifyIntegrity(doc), refund: { invoiceId: invoice.id, creditNoteCents: payableOf(doc.totals), refundedCents: done, remainingOnCreditNoteCents: payableOf(doc.totals) - done, refundableOnInvoiceCents: s.refundableCents, maxCents: Math.max(0, Math.min(payableOf(doc.totals) - done, s.refundableCents)), payments: refunds.filter((r) => r.documentId === doc.id) } };
      }
      if (doc.type !== 'invoice') return { doc, integrity: verifyIntegrity(doc) };
      const credits = await relatedCreditNotes(doc); const refunds = await refundsOf(credits); const s = settlement(doc, await store.listPayments(id), credits, refunds);
      return { doc, settlement: s, refunds, effectiveStatus: effectiveStatus(doc, s, today()), integrity: verifyIntegrity(doc) };
    },
    // ---- company directory (merchant-scoped) ----
    listCompanies: () => store.listCompanies(config.merchantId),
    getCompany: async (id) => { const c = await store.getCompany(id); if (!c || c.merchantId !== config.merchantId) throw new FinanceError('COMPANY_NOT_FOUND', id); return c; },
    async saveCompany(company, actor) {
      if (company.vatNumber || company.enterpriseNumber) {
        const dup = await store.findCompany(config.merchantId, { vatNumber: company.vatNumber, enterpriseNumber: company.enterpriseNumber });
        if (dup) throw new FinanceError('COMPANY_ALREADY_EXISTS', dup.id);
      }
      const saved = await store.saveCompany({ ...company, merchantId: config.merchantId });
      await store.appendEvent({ documentId: null, merchantId: config.merchantId, actor, action: 'COMPANY_CREATED', fromStatus: null, toStatus: null, detail: { companyId: saved.id, source: saved.source ?? 'manual' }, at: now() });
      return saved;
    },
    async updateCompany(id, company, actor) {
      const cur = await this.getCompany(id);
      const dup = (company.vatNumber || company.enterpriseNumber) ? await store.findCompany(config.merchantId, { vatNumber: company.vatNumber, enterpriseNumber: company.enterpriseNumber }) : null;
      if (dup && dup.id !== id) throw new FinanceError('COMPANY_ALREADY_EXISTS', dup.id);
      const saved = await store.updateCompany(id, { ...cur, ...company });
      await store.appendEvent({ documentId: null, merchantId: config.merchantId, actor, action: 'COMPANY_UPDATED', fromStatus: null, toStatus: null, detail: { companyId: id }, at: now() });
      return saved;
    },
    /** Contacts V1: archive/restore. Never deletes the contact or touches any linked document/relation -
     * archiving is purely a visibility flag consumed by the /api/contacts role=archived filter. */
    async archiveCompany(id, actor) {
      await this.getCompany(id); // tenant check, 404 if foreign/missing
      const saved = await store.setCompanyArchived(id, now());
      await store.appendEvent({ documentId: null, merchantId: config.merchantId, actor, action: 'COMPANY_ARCHIVED', fromStatus: null, toStatus: null, detail: { companyId: id }, at: now() });
      return saved;
    },
    async restoreCompany(id, actor) {
      await this.getCompany(id);
      const saved = await store.setCompanyArchived(id, null);
      await store.appendEvent({ documentId: null, merchantId: config.merchantId, actor, action: 'COMPANY_RESTORED', fromStatus: null, toStatus: null, detail: { companyId: id }, at: now() });
      return saved;
    },
    events: async (id) => { await must(id); return store.listEvents(id); },
    peekNextNumber: async (type, issueDate) => { const y = Number(issueDate.slice(0, 4)); return formatNumber(numbering, type, y, await store.peekNextNumber(config.merchantId, type, y)); },
    get: must,
    ctx,
  };
  // the payment commands (receive, allocate, reverse, void, refund, list): one business API for the interface; invoice statuses are re-derived after every money movement
  service.payments = createPayments({ store, merchantId: config.merchantId, now, today, defaultCurrency: config.defaults?.currency ?? 'EUR', settleInvoices: async (ids, actor) => { for (const id of ids) await service.resettle(id, actor); } });
  return service;
}
