// Payment commands: the business API of money. Every command EXPRESSES AN INTENTION (receive a payment, pay a supplier, allocate, reverse, void, refund) and returns the
// derived truth the interface needs, so the interface never rebuilds a financial fact and never writes a financial field.
// The DATABASE is the authority for every ceiling (see payment-ledger.js GUARANTEES); the checks here only fail early with a readable error.
//
//   Payment    = fin_payment_registry row        (a real monetary operation, IN or OUT, one currency, one method, a provenance)
//   Allocation = fin_payment_allocations row     (part of a payment applied to ONE document; negative = reversal of an earlier allocation)
//   Reversal   = a negative allocation, or a registry row linked to the payment it cancels
//   Refund     = an OUT payment allocated to a customer CREDIT NOTE (and optionally tied to the IN payment it gives back)
//   Status     = DERIVED from allocations; never stored as a fact (the stored lifecycle status of a customer invoice is re-derived after every change)
//
// A surplus is never lost and never applied by itself: it stays "unallocated" on its payment until a person names the document (allocate).

import { randomUUID } from 'node:crypto';
import { FinanceError, makeRefund } from './document.js';
import { toCents } from './money.js';
import { DEFAULT_SOURCE, isPaymentMethod, isPaymentSource } from './payment-methods.js';
import { paymentSummary, standingAllocations } from './payment-ledger.js';

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const text = (v, max) => (v == null || v === '' ? null : String(v).trim().slice(0, max) || null);
const KEY = /^[A-Za-z0-9_.:-]{8,120}$/;

/** Cents from `amountCents` (an integer) or `amount` (a decimal string "12.50"); anything else is refused. */
export function centsOf(input, field = 'amount') {
  if (input.amountCents !== undefined) { if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new FinanceError('PAYMENT_AMOUNT_INVALID', field); return input.amountCents; }
  const c = toCents(input.amount); if (c === null || !Number.isInteger(c) || c <= 0) throw new FinanceError('PAYMENT_AMOUNT_INVALID', field); return c;
}

/**
 * @param {{ store: object, merchantId: string, now: () => string, today: () => string, defaultCurrency?: string, settleInvoices?: (invoiceIds: string[], actor: object) => Promise<void> }} deps
 * settleInvoices re-derives the stored lifecycle status of customer invoices after money moved (customer side only).
 */
export function createPayments({ store, merchantId, now, today, defaultCurrency = 'EUR', settleInvoices = async () => {} }) {
  const metaOf = (input) => {
    const source = input.source ?? DEFAULT_SOURCE; if (!isPaymentSource(source)) throw new FinanceError('PAYMENT_SOURCE_INVALID', String(source));
    return { source, externalReference: text(input.externalReference, 200), structuredReference: text(input.structuredReference, 40), bankReference: text(input.bankReference, 200), refundOfPaymentId: input.refundOfPaymentId ?? null };
  };
  const common = (input) => {
    if (!isDate(input.paidOn)) throw new FinanceError('PAYMENT_DATE_INVALID');
    const method = input.method ?? 'unspecified'; if (!isPaymentMethod(method)) throw new FinanceError('PAYMENT_METHOD_INVALID', String(method));
    if (input.idempotencyKey != null && !KEY.test(input.idempotencyKey)) throw new FinanceError('IDEMPOTENCY_KEY_INVALID');
    return { method, key: input.idempotencyKey ?? randomUUID(), reference: text(input.reference, 100), meta: metaOf(input) };
  };
  const mustDoc = async (id) => { const d = await store.getDocument(id); if (!d || d.merchantId !== merchantId) throw new FinanceError('DOCUMENT_NOT_FOUND', String(id)); return d; };
  const mustSupplier = async (id) => { const s = await store.getSupplierInvoice(id); if (!s || s.merchantId !== merchantId) throw new FinanceError('INBOX_ITEM_NOT_FOUND', String(id)); return s; };
  const invoiceIdsOf = async (docIds) => { const out = new Set(); for (const id of docIds) { const d = await store.getDocument(id); if (!d) continue; if (d.type === 'invoice') out.add(d.id); else if (d.type === 'credit_note' && d.relatedDocumentId) out.add(d.relatedDocumentId); } return [...out]; };

  /** A payment as a person reads it: amounts, derived status, unallocated surplus, every allocation and reversal (the audit answer to "what happened to this money"). */
  async function view(paymentId) {
    const full = await store.getPayment(merchantId, paymentId); if (!full) throw new FinanceError('PAYMENT_NOT_FOUND', String(paymentId));
    return paymentSummary(full.payment, [full.payment, ...full.reversals], full.allocations);
  }
  const sameRequest = (done, { amountCents, paidOn, direction }) => done.payment.amountCents === amountCents && done.payment.paidOn === paidOn && done.payment.direction === direction;

  async function record(direction, input, actor) {
    const { method, key, reference, meta } = common(input); const amountCents = centsOf(input);
    const wanted = (input.allocations ?? []).map((a) => ({ id: a.documentId ?? a.supplierInvoiceId, cents: centsOf(a, 'allocation') }));
    if (new Set(wanted.map((w) => w.id)).size !== wanted.length) throw new FinanceError('ALLOCATION_DUPLICATE_TARGET');
    const done = await store.getPaymentByKey(merchantId, key);
    if (done) { if (!sameRequest(done, { amountCents, paidOn: input.paidOn, direction })) throw new FinanceError('IDEMPOTENCY_KEY_REUSED', key); return { duplicate: true, payment: await view(done.payment.id) }; }
    if (wanted.reduce((s, w) => s + w.cents, 0) > amountCents) throw new FinanceError('PAYMENT_OVER_ALLOCATED', `allocations exceed the payment (${amountCents} cents)`);
    let currency = input.currency ?? null; const allocations = [];
    for (const w of wanted) {
      const target = direction === 'IN' ? await mustDoc(w.id) : await mustSupplier(w.id);
      if (direction === 'IN' && target.type !== 'invoice') throw new FinanceError('PAYMENTS_APPLY_TO_INVOICES');
      if (currency && target.currency !== currency) throw new FinanceError('CURRENCY_MISMATCH', `${currency} vs ${target.currency}`);
      currency = target.currency; allocations.push(direction === 'IN' ? { customerDocumentId: w.id, amountCents: w.cents } : { supplierInvoiceId: w.id, amountCents: w.cents });
    }
    const r = await store.recordPayment({ merchantId, key, direction, amountCents, currency: currency ?? defaultCurrency, paidOn: input.paidOn, method, reference, actor, at: now(), allocations, meta });
    if (direction === 'IN') await settleInvoices(await invoiceIdsOf(allocations.map((a) => a.customerDocumentId)), actor);
    return { duplicate: r.duplicate === true, payment: await view(r.payment.id) };
  }

  return {
    /** Money received. allocations: [{ documentId, amount | amountCents }] (customer invoices; may be empty = an advance, or partly allocated: the rest stays unallocated). */
    receive: (input, actor) => record('IN', input, actor),
    /** Money paid out to suppliers. allocations: [{ supplierInvoiceId, amount | amountCents }]. */
    pay: (input, actor) => record('OUT', input, actor),

    /** Apply (part of) the unallocated amount of an existing payment to documents. The caller names every target; nothing is ever allocated automatically. */
    async allocate(paymentId, input, actor) {
      if (input.idempotencyKey != null && !KEY.test(input.idempotencyKey)) throw new FinanceError('IDEMPOTENCY_KEY_INVALID');
      const before = await view(paymentId); if (before.reversalOfId) throw new FinanceError('PAYMENT_NOT_FOUND', String(paymentId));
      if (input.idempotencyKey) { // idempotency first: a repeat of an allocation that already committed returns it (the ceilings below would otherwise refuse the repeat)
        const prior = (await store.listAllocations({ merchantId, keyPrefix: `${input.idempotencyKey}:` })).filter((a) => a.paymentId === paymentId);
        if (prior.length) {
          const want = new Map((input.allocations ?? []).map((a) => [a.documentId ?? a.supplierInvoiceId, centsOf(a, 'allocation')]));
          const same = prior.length === want.size && prior.every((a) => want.get(a.customerDocumentId ?? a.supplierInvoiceId) === a.amountCents);
          if (!same) throw new FinanceError('IDEMPOTENCY_KEY_REUSED', input.idempotencyKey);
          return { duplicate: true, payment: before };
        }
      }
      const customer = before.direction === 'IN'; const allocations = [];
      for (const a of input.allocations ?? []) {
        const id = a.documentId ?? a.supplierInvoiceId; const cents = centsOf(a, 'allocation');
        const target = customer ? await mustDoc(id) : await mustSupplier(id);
        if (target.currency !== before.currency) throw new FinanceError('CURRENCY_MISMATCH', `${before.currency} vs ${target.currency}`);
        allocations.push(customer ? { customerDocumentId: id, amountCents: cents } : { supplierInvoiceId: id, amountCents: cents });
      }
      if (!allocations.length) throw new FinanceError('PAYMENT_AMOUNT_INVALID', 'nothing to allocate');
      if (allocations.reduce((s, a) => s + a.amountCents, 0) > before.unallocatedCents) throw new FinanceError('PAYMENT_OVER_ALLOCATED', `${allocations.reduce((s, a) => s + a.amountCents, 0)} > unallocated ${before.unallocatedCents} (cents)`);
      const r = await store.allocatePayment({ merchantId, key: input.idempotencyKey ?? randomUUID(), paymentId, allocations, actor, at: now() });
      if (customer) await settleInvoices(await invoiceIdsOf(allocations.map((a) => a.customerDocumentId)), actor);
      return { duplicate: r.duplicate === true, payment: await view(paymentId) };
    },

    /** Take back (all or part of) one allocation. Appends a linked negative row; never deletes. */
    async reverseAllocation(allocationId, { amountCents = null, reason, idempotencyKey }, actor) {
      if (!String(reason ?? '').trim()) throw new FinanceError('REASON_REQUIRED');
      const rows = await store.listAllocations({ merchantId }); const al = rows.find((a) => a.id === allocationId); if (!al) throw new FinanceError('ALLOCATION_NOT_FOUND', String(allocationId));
      const r = await store.reverseAllocations({ merchantId, key: idempotencyKey ?? randomUUID(), items: [{ allocationId, amountCents }], reason: String(reason).slice(0, 300), actor, at: now() });
      await settleInvoices(await invoiceIdsOf([al.customerDocumentId].filter(Boolean)), actor);
      return { duplicate: r.duplicate === true, payment: await view(al.paymentId) };
    },

    /** A payment entered by mistake: every standing allocation is reversed, then the payment itself is reversed. It stays in the history. */
    async voidPayment(paymentId, { reason, idempotencyKey }, actor) {
      if (!String(reason ?? '').trim()) throw new FinanceError('REASON_REQUIRED');
      const touched = [...new Set((await store.listAllocations({ merchantId })).filter((a) => a.paymentId === paymentId && a.customerDocumentId).map((a) => a.customerDocumentId))];
      const r = await store.voidPayment({ merchantId, key: idempotencyKey ?? randomUUID(), paymentId, on: today(), reason: String(reason).slice(0, 300), actor, at: now() });
      await settleInvoices(await invoiceIdsOf(touched), actor);
      return { duplicate: r.duplicate === true, payment: await view(paymentId) };
    },

    /**
     * Refund: money handed back to the customer FOR an issued credit note. A credit note never creates a bank movement by itself; this is the explicit act.
     * input: { amount | amountCents, paidOn, method, reference, refundOfPaymentId? (the payment given back), idempotencyKey, source, externalReference }.
     */
    async refund(creditNoteId, input, actor) {
      const cn = await mustDoc(creditNoteId); if (cn.type !== 'credit_note' || !cn.relatedDocumentId) throw new FinanceError('REFUND_REQUIRES_AN_ISSUED_CREDIT_NOTE');
      const invoice = await mustDoc(cn.relatedDocumentId); const { method, key, reference, meta } = common(input); const amountCents = centsOf(input);
      const done = await store.getPaymentByKey(merchantId, key);
      if (done) { if (!sameRequest(done, { amountCents, paidOn: input.paidOn, direction: 'OUT' }) || !done.allocations.some((a) => a.customerDocumentId === cn.id)) throw new FinanceError('IDEMPOTENCY_KEY_REUSED', key); return { duplicate: true, payment: await view(done.payment.id) }; }
      const creditNotes = await store.listDocuments({ merchantId, type: 'credit_note', relatedDocumentId: invoice.id });
      const refunds = []; for (const c of creditNotes) refunds.push(...(await store.listPayments(c.id)));
      const m = makeRefund(cn, invoice, creditNotes, await store.listPayments(invoice.id), refunds, { amount: (amountCents / 100).toFixed(2), paidOn: input.paidOn, method, reference, actor });
      const r = await store.recordPayment({ merchantId, key, direction: 'OUT', amountCents: m.amountCents, currency: invoice.currency, paidOn: m.paidOn, method, reference, actor, at: now(), allocations: [{ customerDocumentId: cn.id, amountCents: m.amountCents }], meta });
      await settleInvoices([invoice.id], actor);
      return { duplicate: r.duplicate === true, payment: await view(r.payment.id) };
    },

    get: view,
    /** Every payment (reversal rows excluded), newest first, with its derived status and unallocated surplus. filter: { direction, status, unallocated } */
    async list({ direction, status, unallocated } = {}) {
      const registry = await store.listRegistry(merchantId); const allocations = await store.listAllocations({ merchantId });
      return registry.filter((p) => !p.reversalOfId).map((p) => paymentSummary(p, registry, allocations))
        .filter((p) => (!direction || p.direction === direction) && (!status || p.status === status) && (!unallocated || p.unallocatedCents > 0))
        .sort((a, b) => String(b.paidOn).localeCompare(String(a.paidOn)) || String(b.createdAt).localeCompare(String(a.createdAt)));
    },
    standingAllocations,
  };
}
