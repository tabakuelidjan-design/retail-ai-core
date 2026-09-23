// Finance service: orchestrates the pure document engine, the store, numbering, linkage checks and the audit trail.
// The agent may PREPARE (create, validate, calculate, list missing fields). Anything that issues, sends or approves is a
// merchant action and is refused for a non-merchant actor. Nothing here contacts an external system.

import {
  FinanceError, acceptQuote, canonicalSnapshot, deepFreeze, makeNumberPlaceholder, applyStatus, cancelDraft, convertQuoteToInvoice, createDraft, creditNoteFromInvoice, decide, effectiveStatus, makePayment,
  markSent, rejectQuote, sendQuote, settledStatus, settlement, submitForApproval, updateDraft, validateForIssue, verifyIntegrity,
} from './document.js';
import { checkLinkage, orderTotalsFromLedger } from './linking.js';
import { DEFAULT_NUMBERING, formatNumber } from './numbering.js';

/**
 * @param {{store: object, config: object, clock?: {now: () => string, today: () => string}, ledgerProvider?: () => Promise<object|null>}} deps
 * config: { merchantId, seller, numbering?, vat: { allowedRatesBp[] }, defaults?: { currency, language, paymentTermsDays, paymentTerms }, linking?: { dupWindowDays, toleranceCents } }
 */
export function createFinanceService({ store, config, clock, ledgerProvider = async () => null, hooks = {} }) {
  const now = clock?.now ?? (() => new Date().toISOString());
  const today = clock?.today ?? (() => new Date().toISOString().slice(0, 10));
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
}
