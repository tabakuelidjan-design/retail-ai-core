// Finance service: orchestrates the pure document engine, the store, numbering, linkage checks and the audit trail.
// The agent may PREPARE (create, validate, calculate, list missing fields). Anything that issues, sends or approves is a
// merchant action and is refused for a non-merchant actor. Nothing here contacts an external system.

import {
  FinanceError, acceptQuote, deepFreeze, applyStatus, cancelDraft, convertQuoteToInvoice, createDraft, creditNoteFromInvoice, decide, effectiveStatus, makePayment,
  markSent, rejectQuote, sendQuote, settledStatus, settlement, submitForApproval, updateDraft, validateForIssue, verifyIntegrity,
} from './document.js';
import { checkLinkage, orderTotalsFromLedger } from './linking.js';
import { DEFAULT_NUMBERING, formatNumber } from './numbering.js';

/**
 * @param {{store: object, config: object, clock?: {now: () => string, today: () => string}, ledgerProvider?: () => Promise<object|null>}} deps
 * config: { merchantId, seller, numbering?, vat: { allowedRatesBp[] }, defaults?: { currency, language, paymentTermsDays, paymentTerms }, linking?: { dupWindowDays, toleranceCents } }
 */
export function createFinanceService({ store, config, clock, ledgerProvider = async () => null }) {
  const now = clock?.now ?? (() => new Date().toISOString());
  const today = clock?.today ?? (() => new Date().toISOString().slice(0, 10));
  const vatConfig = config.vat ?? { allowedRatesBp: [] };
  const numbering = { ...DEFAULT_NUMBERING, ...(config.numbering ?? {}) };
  const ctx = { vatConfig };

  const seal = (d) => (d?.lockedAt ? deepFreeze(d) : d);
  const must = async (id) => { const d = await store.getDocument(id); if (!d) throw new FinanceError('DOCUMENT_NOT_FOUND', id); return seal(d); };
  const persist = async (doc, prev, event) => {
    const saved = await store.saveDocument(doc, prev ? prev.version : null);
    if (event) await store.appendEvent({ ...event, documentId: doc.id, at: now() });
    return seal(saved);
  };
  const relatedCreditNotes = async (invoice) => (await store.listDocuments({ merchantId: config.merchantId, type: 'credit_note', relatedDocumentId: invoice.id }));

  async function linkage(doc) {
    const ledger = await ledgerProvider();
    const invoices = await store.listDocuments({ merchantId: config.merchantId });
    return checkLinkage(doc, { orderTotals: ledger ? orderTotalsFromLedger(ledger) : null, invoices, dupWindowDays: config.linking?.dupWindowDays ?? 3, toleranceCents: config.linking?.toleranceCents ?? 1 });
  }

  /** Everything that blocks issuance right now, so the merchant sees the full list at once. */
  async function readiness(doc) {
    const errors = validateForIssue(doc, ctx);
    const l = await linkage(doc);
    return { ready: errors.length === 0 && l.errors.length === 0, errors: [...errors, ...l.errors], warnings: l.warnings, checks: l.checks };
  }

  return {
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

    /** The merchant's decision. APPROVE validates, THEN allocates the number, then issues: a failed check never burns a number. */
    async decide(id, decision, actor, note) {
      const prev = await must(id);
      if (actor?.type !== 'merchant') throw new FinanceError('APPROVAL_REQUIRES_A_MERCHANT_ACTOR');
      let number;
      if (decision === 'APPROVE') {
        const r = await readiness(prev);
        if (!r.ready) throw new FinanceError('NOT_READY_TO_ISSUE', r.errors.join(', '));
        const fresh = await must(id);
        if (fresh.version !== prev.version) throw new FinanceError('CONCURRENT_MODIFICATION');
        const year = Number(prev.issueDate.slice(0, 4));
        number = formatNumber(numbering, prev.type, year, await store.allocateNumber(config.merchantId, prev.type, year));
      }
      const { doc, event } = decide(prev, { decision, actor, number, at: now(), note, ctx });
      const saved = await persist(doc, prev, event);
      if (doc.type === 'credit_note' && decision === 'APPROVE' && doc.relatedDocumentId) await this.resettle(doc.relatedDocumentId, actor);
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
      const year = Number(prev.issueDate.slice(0, 4));
      const number = formatNumber(numbering, 'quote', year, await store.allocateNumber(config.merchantId, 'quote', year));
      const { doc, event } = sendQuote(prev, { actor, number, at: now(), ctx });
      return persist(doc, prev, event);
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
    async createCreditNote(invoiceId, { reason, lines }, actor) {
      const invoice = await must(invoiceId);
      const existing = await relatedCreditNotes(invoice);
      const { doc, event } = creditNoteFromInvoice(invoice, { creditNoteId: store.newId(), reason, lines, existingCreditNotes: existing, actor, at: now() });
      const withDates = { ...doc, issueDate: today(), dueDate: today() };
      return persist(withDates, null, event);
    },

    // ---- payments / status ----
    async recordPayment(invoiceId, payment, actor) {
      const invoice = await must(invoiceId);
      const [payments, credits] = [await store.listPayments(invoiceId), await relatedCreditNotes(invoice)];
      const p = makePayment(invoice, payments, credits, { ...payment, actor });
      const saved = await store.addPayment(p);
      await store.appendEvent({ documentId: invoiceId, merchantId: invoice.merchantId, actor, action: 'RECORD_PAYMENT', fromStatus: invoice.status, toStatus: invoice.status, detail: { amountCents: p.amountCents, method: p.method, paidOn: p.paidOn }, at: now() });
      await this.resettle(invoiceId, actor);
      return saved;
    },

    /** Re-derive the stored lifecycle status from payments and credit notes (call after either changes). */
    async resettle(invoiceId, actor) {
      const prev = await must(invoiceId);
      if (prev.type !== 'invoice' || !prev.lockedAt) return prev;
      const s = settlement(prev, await store.listPayments(invoiceId), await relatedCreditNotes(prev));
      const status = settledStatus(prev, s);
      if (status === prev.status) return prev;
      const { doc, event } = applyStatus(prev, status, { actor, at: now(), reason: 'settlement' });
      return persist(doc, prev, event);
    },

    async view(id) {
      const doc = await must(id);
      if (doc.type !== 'invoice') return { doc, integrity: verifyIntegrity(doc) };
      const s = settlement(doc, await store.listPayments(id), await relatedCreditNotes(doc));
      return { doc, settlement: s, effectiveStatus: effectiveStatus(doc, s, today()), integrity: verifyIntegrity(doc) };
    },
    events: (id) => store.listEvents(id),
    get: must,
    ctx,
  };
}
