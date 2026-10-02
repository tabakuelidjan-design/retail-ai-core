// Pure rules of the payment registry and its allocations (frozen architecture: fin_payment_registry + fin_payment_allocations).
// This is the in-memory twin of the PostgreSQL triggers of migration 20261003090000: same rules, same error codes. The database is the authority;
// this module lets the memory store (used by tests and the demo) honour the identical business contract. Amounts are integer cents, never floats.
//
// GUARANTEES (classified S = service only, P = PostgreSQL only, B = both): see GUARANTEES at the bottom.

import { FinanceError } from './document.js';

export const isCents = (x) => Number.isInteger(x);

/** Net allocated to a target (customer invoice or supplier invoice): positive allocations minus their reversals. */
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

/**
 * Validates ONE allocation against the committed state (mirror of fin_payment_allocation_guard). `target` is the customer document or the supplier
 * invoice already loaded (merchant-checked by the caller). Throws a FinanceError; returns nothing.
 */
export function checkAllocation({ merchantId, payment, registry, allocations, docs, target, kind, allocation }) {
  const cents = allocation.amountCents;
  if (!isCents(cents) || cents === 0) throw new FinanceError('ALLOCATION_AMOUNT_INVALID');
  if (!target || target.merchantId !== merchantId) throw new FinanceError('TARGET_NOT_FOUND');
  if (!payment || payment.merchantId !== merchantId) throw new FinanceError('PAYMENT_NOT_FOUND');
  if (payment.reversalOfId) throw new FinanceError('ALLOCATION_ON_REVERSAL');
  if ((kind === 'customer' && payment.direction !== 'IN') || (kind === 'supplier' && payment.direction !== 'OUT')) throw new FinanceError('DIRECTION_MISMATCH', payment.direction);
  const ccy = target.currency;
  if (allocation.currency !== payment.currency || ccy !== allocation.currency) throw new FinanceError('CURRENCY_MISMATCH', `payment ${payment.currency}, allocation ${allocation.currency}, document ${ccy}`);
  const key = kind === 'customer' ? { customerDocumentId: target.id } : { supplierInvoiceId: target.id };
  if (cents > 0) {
    let payable;
    if (kind === 'customer') {
      if (target.type !== 'invoice' || !target.lockedAt || !['ISSUED', 'SENT', 'PARTIALLY_PAID'].includes(target.status)) throw new FinanceError('TARGET_NOT_OPEN', target.status);
      payable = Math.max(0, payableOfDoc(target) - creditedOfInvoice(docs, target));
    } else {
      if ((target.documentType ?? 'INVOICE') === 'CREDIT_NOTE' || !['VALIDATED', 'TO_PAY'].includes(target.status) || !isCents(target.grossCents)) throw new FinanceError('TARGET_NOT_OPEN', `${target.status} (${target.documentType ?? 'INVOICE'})`);
      payable = target.grossCents;
    }
    const net = netAllocated(allocations, key);
    if (net + cents > payable) throw new FinanceError('PAYMENT_EXCEEDS_REMAINING', `${cents} > ${payable - net} (cents)`);
    const free = paymentUnallocatedCents(registry, allocations, payment);
    if (cents > free) throw new FinanceError('PAYMENT_OVER_ALLOCATED', `${cents} > unallocated ${free} (cents)`);
    return;
  }
  const orig = allocations.find((a) => a.id === allocation.reversesAllocationId);
  if (!orig || orig.amountCents <= 0) throw new FinanceError('ALLOCATION_NOT_FOUND');
  if (orig.paymentId !== payment.id || orig.customerDocumentId !== (allocation.customerDocumentId ?? null) || orig.supplierInvoiceId !== (allocation.supplierInvoiceId ?? null) || orig.currency !== allocation.currency) throw new FinanceError('REVERSAL_MISMATCH');
  const left = allocationRemaining(allocations, orig.id);
  if (left + cents < 0) throw new FinanceError('REVERSAL_EXCEEDS_ALLOCATION', `${-cents} > ${left} (cents)`);
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

/** The state a supplier invoice must show, derived from allocations only (never an input). */
export function supplierTruth(row, net) {
  const paid = isCents(row.grossCents) && row.grossCents > 0 && net === row.grossCents;
  return { paid, paymentStatus: net <= 0 ? 'unpaid' : paid ? 'paid' : 'partially_paid' };
}

/** Request fingerprint for idempotency: same key + same fingerprint = same operation; same key + another fingerprint = refused. */
export const requestFingerprint = ({ direction, amountCents, currency, paidOn, method, reference, allocations }) =>
  JSON.stringify([direction, amountCents, currency, paidOn, method ?? 'unspecified', reference ?? '', [...allocations].map((a) => [a.customerDocumentId ?? '', a.supplierInvoiceId ?? '', a.amountCents]).sort((x, y) => String(x[0] || x[1]).localeCompare(String(y[0] || y[1])))]);

/** Where every guarantee lives. S = service, P = PostgreSQL, B = both (the service check only gives a friendlier error; the database is the authority). */
export const GUARANTEES = {
  creditCeiling: 'B (trigger fin_credit_ceiling_guard, invoice row locked; service pre-check in creditNoteFromInvoice)',
  allocationCeilingPerDocument: 'B (trigger fin_payment_allocation_guard, document row locked; service pre-check in makePayment)',
  allocationCeilingPerPayment: 'P (same trigger, payment row locked)',
  idempotency: 'B (unique (merchant, key) + request hash in fin_record_payment; service looks the key up before its own pre-checks)',
  directionAndCurrency: 'B (trigger; service uses the document currency)',
  reversalBounds: 'P (trigger; service picks what to reverse)',
  supplierPaidIsDerived: 'P (trigger fin_supplier_invoice_truth_guard + mirror); service never writes PAID',
  merchantIsolation: 'P (composite foreign keys) + S (every query carries merchant_id)',
  bankClaimFrozen: 'P (trigger fin_bank_tx_guard) + S (compare-and-set on status NEW)',
  appendOnly: 'P (triggers fin_append_only)',
  lockingOrder: 'P (document -> payment -> bank transaction; several targets ascending by id)',
};
