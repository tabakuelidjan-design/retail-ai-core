// Pure rules of bank reconciliation (twin of migration 20261005090000, same rules, same error codes). The database is the authority; this module lets the memory store honour
// the identical contract. Integer cents, one currency, no float.
//
//   Bank transaction  = an OBSERVED movement (immutable facts). It is NOT a Finance payment.
//   Reconciliation    = append-only row linking a transaction to a payment (kind MATCH) or setting it aside on purpose (kind IGNORE); N<->M, partial; negative = unreconcile.
//   Derived           = matched / ignored / remaining / status of a transaction come ONLY from its reconciliation rows. The legacy status/matched_* are a mirror.
//
//   abs = |amount|;  matched = net MATCH;  ignored = net IGNORE;  remaining = abs - matched - ignored   (invariant: remaining >= 0)
//   status: UNRECONCILED | PARTIALLY_RECONCILED | RECONCILED (remaining 0 with a match) | IGNORED (remaining 0, nothing matched)

import { FinanceError } from './document.js';
import { paymentReversedCents } from './payment-ledger.js';

export const isCents = (x) => Number.isInteger(x);

export function txAmounts(tx, reconciliations) {
  const mine = reconciliations.filter((r) => r.bankTransactionId === tx.id);
  const abs = Math.abs(tx.amountCents); const matched = mine.filter((r) => r.kind === 'MATCH').reduce((s, r) => s + r.amountCents, 0); const ignored = mine.filter((r) => r.kind === 'IGNORE').reduce((s, r) => s + r.amountCents, 0);
  const remaining = abs - matched - ignored;
  const status = matched === 0 && ignored === 0 ? 'UNRECONCILED' : remaining === 0 && matched > 0 ? 'RECONCILED' : remaining === 0 ? 'IGNORED' : 'PARTIALLY_RECONCILED';
  const lastAt = mine.reduce((m, r) => (m === null || String(r.createdAt) > String(m) ? r.createdAt : m), null);
  return { amount: abs, matched, ignored, remaining, status, lastAt };
}
/** The legacy column value implied by the derived state (a mirror: nothing reads it as a fact). */
export const legacyStatusOf = (status) => (status === 'RECONCILED' ? 'MATCHED' : status === 'IGNORED' ? 'IGNORED' : 'NEW');

export const paymentReconciledCents = (reconciliations, paymentId) => reconciliations.filter((r) => r.paymentId === paymentId).reduce((s, r) => s + r.amountCents, 0);

/** Mirror of fin_bank_reconciliation_guard. `row` = the reconciliation about to be written (camelCase). Throws a FinanceError; returns nothing. */
export function checkReconciliation({ tx, payment, registry, reconciliations, row }) {
  if (!tx || tx.merchantId !== row.merchantId) throw new FinanceError('BANK_TX_NOT_FOUND');
  if (row.paymentId) {
    if (!payment || payment.merchantId !== row.merchantId) throw new FinanceError('PAYMENT_NOT_FOUND');
    if (payment.reversalOfId) throw new FinanceError('BANK_PAYMENT_IS_A_REVERSAL');
  }
  if (row.currency !== tx.currency || (payment && payment.currency !== tx.currency)) throw new FinanceError('BANK_CURRENCY_MISMATCH', `transaction ${tx.currency}, payment ${payment?.currency}, row ${row.currency}`);
  if (payment && ((tx.amountCents > 0 && payment.direction !== 'IN') || (tx.amountCents < 0 && payment.direction !== 'OUT'))) throw new FinanceError('BANK_DIRECTION_MISMATCH', `${tx.amountCents > 0 ? 'IN' : 'OUT'} transaction, ${payment.direction} payment`);
  if (row.amountCents > 0) {
    const a = txAmounts(tx, reconciliations);
    if (row.amountCents > a.remaining) throw new FinanceError('BANK_OVER_RECONCILED', `${row.amountCents} > remaining ${a.remaining} (cents)`);
    if (payment) {
      const left = payment.amountCents - paymentReversedCents(registry, payment.id) - paymentReconciledCents(reconciliations, payment.id);
      if (row.amountCents > left) throw new FinanceError('BANK_PAYMENT_OVER_RECONCILED', `${row.amountCents} > what is left of the payment ${left} (cents)`);
    }
    return;
  }
  const orig = reconciliations.find((r) => r.id === row.reversesId);
  if (!orig || orig.amountCents <= 0) throw new FinanceError('BANK_RECONCILIATION_NOT_FOUND');
  if (orig.bankTransactionId !== row.bankTransactionId || (orig.paymentId ?? null) !== (row.paymentId ?? null) || orig.kind !== row.kind || orig.currency !== row.currency) throw new FinanceError('BANK_UNRECONCILE_MISMATCH');
  const left = orig.amountCents + reconciliations.filter((r) => r.reversesId === orig.id).reduce((s, r) => s + r.amountCents, 0);
  if (left + row.amountCents < 0) throw new FinanceError('BANK_UNRECONCILE_EXCEEDS', `${-row.amountCents} > still reconciled ${left} (cents)`);
}

/** Where every guarantee lives. S = service, P = PostgreSQL, B = both (the database is the authority; the service check gives the friendlier error). */
export const BANK_GUARANTEES = {
  noOverReconciliation: 'B (trigger fin_bank_reconciliation_guard under the transaction row lock; service reads the remaining first)',
  paymentNotOverReconciled: 'P (same trigger, payment row locked)',
  directionAndCurrency: 'B (trigger; service derives the direction from the sign)',
  claimPaymentAtomicity: 'P (fin_bank_reconcile_and_pay: payment + reconciliation in ONE transaction); the service never claims first',
  reversibleNoDelete: 'P (append-only reconciliations; negative rows linked to the original; trigger bounds)',
  statusIsDerived: 'P (fin_bank_tx_guard refuses any status/matched_* value the reconciliation rows do not imply; mirror trigger writes it)',
  noLastWriterWins: 'P (row locks + ceilings; a hand-written claim is refused)',
  idempotency: 'B (unique (merchant, key) per row + advisory lock per key; payment key through fin_record_payment)',
  reconciledPaymentCannotBeVoided: 'P (registry guard)',
  merchantIsolation: 'P (composite foreign keys account/transaction/payment/reconciliation) + S (every query carries merchant_id)',
  importIdentity: 'B (unique (merchant, account, provider_tx_id); fingerprint + occurrence number computed by the parser)',
  noFullIban: 'B (masked at the boundary by maskIban; CHECK requires a mask in fin_bank_accounts and counterparty_account_masked)',
  suggestionHasNoAuthority: 'S (reconcile.js only scores; a reconciliation exists only through an explicit command, the suggestion is stored as evidence)',
};
