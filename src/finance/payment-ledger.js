// Pure rules of the payment registry and its allocations (frozen architecture: fin_payment_registry + fin_payment_allocations).
// This is the in-memory twin of the PostgreSQL triggers of migrations 20261003090000 + 20261004090000: same rules, same error codes. The database is the authority;
// this module lets the memory store (used by tests and the demo) honour the identical business contract. Amounts are integer cents, never floats.
// The amounts of an invoice have ONE definition: amounts.js.

import { FinanceError } from './document.js';
import { invoiceAmounts } from './amounts.js';

export const isCents = (x) => Number.isInteger(x);

/** Net allocated to a target (customer invoice, customer credit note or supplier invoice): positive allocations minus their reversals. */
export const netAllocated = (rows, { customerDocumentId = null, supplierInvoiceId = null } = {}) =>
  rows.filter((a) => (customerDocumentId ? a.customerDocumentId === customerDocumentId : a.supplierInvoiceId === supplierInvoiceId)).reduce((s, a) => s + a.amountCents, 0);

/** What is still standing of one allocation (its amount plus the negative rows that reverse it). */
export const allocationRemaining = (rows, allocationId) => {
  const orig = rows.find((a) => a.id === allocationId); if (!orig) return 0;
  return orig.amountCents + rows.filter((a) => a.reversesAllocationId === allocationId).reduce((s, a) => s + a.amountCents, 0);
};

/** Standing positive allocations of a target, newest first (the order a correction takes money back). */
export const standingAllocations = (rows, target) => rows.filter((a) => a.amountCents > 0 && (target.customerDocumentId ? a.customerDocumentId === target.customerDocumentId : a.supplierInvoiceId === target.supplierInvoiceId))
  .map((a) => ({ ...a, remainingCents: allocationRemaining(rows, a.id) })).filter((a) => a.remainingCents > 0).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || (b.seq ?? 0) - (a.seq ?? 0));

export const paymentReversedCents = (registry, paymentId) => registry.filter((p) => p.reversalOfId === paymentId).reduce((s, p) => s + p.amountCents, 0);
export const paymentAllocatedCents = (allocations, paymentId) => allocations.filter((a) => a.paymentId === paymentId).reduce((s, a) => s + a.amountCents, 0);
export const paymentUnallocatedCents = (registry, allocations, payment) => payment.amountCents - paymentReversedCents(registry, payment.id) - paymentAllocatedCents(allocations, payment.id);

const payableOfDoc = (d) => (d.totals?.grossCents ?? 0) + (d.totals?.roundingCents ?? 0);
export const creditedOfInvoice = (docs, invoice, exceptId = null) => docs.filter((c) => c.type === 'credit_note' && c.relatedDocumentId === invoice.id && c.merchantId === invoice.merchantId && c.lockedAt && c.id !== exceptId).reduce((s, c) => s + payableOfDoc(c), 0);

/** The amounts of an invoice from the committed state (mirror of fin_invoice_amounts). */
export function amountsOfInvoice(docs, allocations, invoice) {
  const creditNotes = docs.filter((c) => c.type === 'credit_note' && c.relatedDocumentId === invoice.id && c.merchantId === invoice.merchantId);
  return invoiceAmounts({ documentTotal: payableOfDoc(invoice), credited: creditedOfInvoice(docs, invoice),
    allocated: netAllocated(allocations, { customerDocumentId: invoice.id }), refunded: creditNotes.reduce((s, c) => s + netAllocated(allocations, { customerDocumentId: c.id }), 0) });
}

/**
 * Validates ONE allocation against the committed state (mirror of fin_payment_allocation_guard). `target` is the customer document (invoice or credit note) or the supplier
 * invoice already loaded. Throws a FinanceError; returns nothing.
 */
export function checkAllocation({ merchantId, payment, registry, allocations, docs, target, kind, allocation }) {
  const cents = allocation.amountCents;
  if (!isCents(cents) || cents === 0) throw new FinanceError('ALLOCATION_AMOUNT_INVALID');
  if (!target || target.merchantId !== merchantId) throw new FinanceError('TARGET_NOT_FOUND');
  let invoice = null;
  if (kind === 'customer') {
    if (target.type === 'invoice') invoice = target;
    else if (target.type === 'credit_note') { invoice = docs.find((d) => d.id === target.relatedDocumentId && d.merchantId === merchantId) ?? null; if (!invoice) throw new FinanceError('TARGET_NOT_OPEN', 'credit note without its invoice'); }
    else throw new FinanceError('TARGET_NOT_OPEN', `a ${target.type} cannot be settled`);
  }
  if (!payment || payment.merchantId !== merchantId) throw new FinanceError('PAYMENT_NOT_FOUND');
  if (payment.reversalOfId) throw new FinanceError('ALLOCATION_ON_REVERSAL');
  if ((kind === 'customer' && target.type === 'invoice' && payment.direction !== 'IN') || (kind === 'customer' && target.type === 'credit_note' && payment.direction !== 'OUT') || (kind === 'supplier' && payment.direction !== 'OUT')) throw new FinanceError('DIRECTION_MISMATCH', payment.direction);
  const ccy = target.currency;
  if (allocation.currency !== payment.currency || ccy !== allocation.currency) throw new FinanceError('CURRENCY_MISMATCH', `payment ${payment.currency}, allocation ${allocation.currency}, document ${ccy}`);
  const key = kind === 'customer' ? { customerDocumentId: target.id } : { supplierInvoiceId: target.id };
  if (cents > 0) {
    if (kind === 'customer' && target.type === 'invoice') {
      if (!target.lockedAt || !['ISSUED', 'SENT', 'PARTIALLY_PAID'].includes(target.status)) throw new FinanceError('TARGET_NOT_OPEN', target.status);
      const a = amountsOfInvoice(docs, allocations, target);
      if (a.retained + cents > a.effectiveDue) throw new FinanceError('PAYMENT_EXCEEDS_REMAINING', `${cents} > ${a.effectiveDue - a.retained} (cents)`);
    } else if (kind === 'customer') { // a refund: money handed back for a credit note
      if (!target.lockedAt || !invoice.lockedAt) throw new FinanceError('TARGET_NOT_OPEN', 'credit note or invoice not issued');
      const net = netAllocated(allocations, key);
      if (net + cents > payableOfDoc(target)) throw new FinanceError('REFUND_EXCEEDS_CREDIT_NOTE', `${cents} > ${payableOfDoc(target) - net} (cents)`);
      const a = amountsOfInvoice(docs, allocations, invoice);
      if (cents > a.refundable) throw new FinanceError('REFUND_EXCEEDS_REFUNDABLE', `${cents} > ${a.refundable} (cents)`);
      if (payment.refundOfPaymentId) {
        const opay = registry.find((p) => p.id === payment.refundOfPaymentId); const given = registry.filter((p) => p.refundOfPaymentId === opay.id).reduce((s, p) => s + paymentAllocatedCents(allocations, p.id), 0);
        if (given + cents > opay.amountCents - paymentReversedCents(registry, opay.id)) throw new FinanceError('REFUND_EXCEEDS_PAYMENT', `${cents} > ${opay.amountCents - paymentReversedCents(registry, opay.id) - given} (cents)`);
      }
    } else {
      if ((target.documentType ?? 'INVOICE') === 'CREDIT_NOTE' || !['VALIDATED', 'TO_PAY'].includes(target.status) || !isCents(target.grossCents)) throw new FinanceError('TARGET_NOT_OPEN', `${target.status} (${target.documentType ?? 'INVOICE'})`);
      const net = netAllocated(allocations, key);
      if (net + cents > target.grossCents) throw new FinanceError('PAYMENT_EXCEEDS_REMAINING', `${cents} > ${target.grossCents - net} (cents)`);
    }
    const free = paymentUnallocatedCents(registry, allocations, payment);
    if (cents > free) throw new FinanceError('PAYMENT_OVER_ALLOCATED', `${cents} > unallocated ${free} (cents)`);
    return;
  }
  const orig = allocations.find((a) => a.id === allocation.reversesAllocationId);
  if (!orig || orig.amountCents <= 0) throw new FinanceError('ALLOCATION_NOT_FOUND');
  if (orig.paymentId !== payment.id || orig.customerDocumentId !== (allocation.customerDocumentId ?? null) || orig.supplierInvoiceId !== (allocation.supplierInvoiceId ?? null) || orig.currency !== allocation.currency) throw new FinanceError('REVERSAL_MISMATCH');
  const left = allocationRemaining(allocations, orig.id);
  if (left + cents < 0) throw new FinanceError('REVERSAL_EXCEEDS_ALLOCATION', `${-cents} > ${left} (cents)`);
  if (kind === 'customer' && target.type === 'invoice') { // money already given back cannot be taken back
    const a = amountsOfInvoice(docs, allocations, target);
    if (a.retained + cents < 0) throw new FinanceError('REVERSAL_BREAKS_REFUND', `only ${a.retained} cents are retained, the rest was refunded`);
  }
}

/** Mirror of fin_payment_registry_guard for a payment-level reversal row. */
export function checkPaymentReversal({ payment, registry, allocations, reversal }) {
  if (!payment) throw new FinanceError('PAYMENT_NOT_FOUND');
  if (payment.reversalOfId) throw new FinanceError('REVERSAL_OF_REVERSAL');
  if (payment.direction !== reversal.direction || payment.currency !== reversal.currency) throw new FinanceError('REVERSAL_MISMATCH');
  const reversed = paymentReversedCents(registry, payment.id);
  if (reversed + reversal.amountCents > payment.amountCents) throw new FinanceError('REVERSAL_EXCEEDS_PAYMENT', `${reversal.amountCents} > ${payment.amountCents - reversed} (cents)`);
  const allocated = paymentAllocatedCents(allocations, payment.id);
  if (payment.amountCents - reversed - reversal.amountCents < allocated) throw new FinanceError('REVERSAL_PAYMENT_ALLOCATED', `${allocated} cents still allocated`);
}

/** Static rules of a refund link (mirror of fin_payment_registry_guard): an OUT payment giving back an IN payment of the same merchant and currency. */
export function checkRefundLink({ payment, registry }) {
  if (!payment.refundOfPaymentId) return;
  const orig = registry.find((p) => p.id === payment.refundOfPaymentId && p.merchantId === payment.merchantId);
  if (!orig) throw new FinanceError('PAYMENT_NOT_FOUND', 'refundOfPaymentId');
  if (orig.direction !== 'IN' || orig.reversalOfId || payment.direction !== 'OUT') throw new FinanceError('REFUND_MISMATCH');
  if (orig.currency !== payment.currency) throw new FinanceError('CURRENCY_MISMATCH', `refund ${payment.currency}, original ${orig.currency}`);
}

/**
 * What a payment looks like to a person: derived, never stored. unallocated = amount - reversed - net allocations (the surplus never disappears and is never applied by itself).
 * status: UNALLOCATED (nothing applied) | PARTIALLY_ALLOCATED | ALLOCATED (everything applied) | REVERSED (nothing left).
 */
export function paymentSummary(payment, registry, allocations) {
  const mine = allocations.filter((a) => a.paymentId === payment.id); const reversedCents = paymentReversedCents(registry, payment.id);
  const allocatedCents = mine.reduce((s, a) => s + a.amountCents, 0); const remainingCents = payment.amountCents - reversedCents; const unallocatedCents = remainingCents - allocatedCents;
  const status = remainingCents === 0 ? 'REVERSED' : unallocatedCents === 0 ? 'ALLOCATED' : allocatedCents === 0 ? 'UNALLOCATED' : 'PARTIALLY_ALLOCATED';
  return { ...payment, reversedCents, allocatedCents, unallocatedCents, status, allocations: mine, reversals: registry.filter((r) => r.reversalOfId === payment.id) };
}

/** The state a supplier invoice must show, derived from allocations only (never an input). */
export function supplierTruth(row, net) {
  const paid = isCents(row.grossCents) && row.grossCents > 0 && net === row.grossCents;
  return { paid, paymentStatus: net <= 0 ? 'unpaid' : paid ? 'paid' : 'partially_paid' };
}

/** Request fingerprint for idempotency: same key + same fingerprint = same operation; same key + another fingerprint = refused. */
export const requestFingerprint = ({ direction, amountCents, currency, paidOn, method, reference, allocations, meta = {} }) =>
  JSON.stringify([direction, amountCents, currency, paidOn, method ?? 'unspecified', reference ?? '', meta.source ?? '', meta.externalReference ?? '', meta.structuredReference ?? '', meta.bankReference ?? '', meta.refundOfPaymentId ?? '',
    [...allocations].map((a) => [a.customerDocumentId ?? '', a.supplierInvoiceId ?? '', a.amountCents]).sort((x, y) => String(x[0] || x[1]).localeCompare(String(y[0] || y[1])))]);

/** Where every guarantee lives. S = service, P = PostgreSQL, B = both (the service check only gives a friendlier error; the database is the authority). */
export const GUARANTEES = {
  creditCeiling: 'B (trigger fin_credit_ceiling_guard, invoice row locked; service pre-check in creditNoteFromInvoice)',
  allocationCeilingPerDocument: 'B (trigger fin_payment_allocation_guard on retained <= effective_due, document row locked; service pre-check in makePayment)',
  allocationCeilingPerPayment: 'P (same trigger, payment row locked)',
  refundCeilings: 'B (same trigger: refund <= credit note, <= refundable of the invoice, <= the payment it gives back; credit note then invoice then payment locked; service pre-check in makeRefund)',
  reversalCannotTakeBackRefundedMoney: 'P (same trigger: retained must stay >= 0)',
  idempotency: 'B (unique (merchant, key) + request hash in fin_record_payment; per (key, target) in fin_allocate_payment / fin_reverse_allocations; service looks the key up first)',
  directionAndCurrency: 'B (trigger; service uses the document currency)',
  methodVocabulary: 'B (CHECK on fin_payment_registry.method; service validates earlier)',
  reversalBounds: 'P (trigger; service picks what to reverse)',
  supplierPaidIsDerived: 'P (trigger fin_supplier_invoice_truth_guard + mirror); service never writes PAID',
  customerStatusMirror: 'S (the stored lifecycle status PARTIALLY_PAID/PAID/CREDITED is re-derived by the service after every change; every amount is derived from allocations)',
  merchantIsolation: 'P (composite foreign keys) + S (every query carries merchant_id)',
  bankClaimFrozen: 'P (trigger fin_bank_tx_guard) + S (compare-and-set on status NEW)',
  appendOnly: 'P (triggers fin_append_only)',
  lockingOrder: 'P (document [credit note, then its invoice] -> payment [new, then the one it refunds] -> bank transaction; several targets ascending by id)',
};
