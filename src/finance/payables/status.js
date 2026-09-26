// Payment status of a supplier document: TWO independent axes, both DERIVED (never stored as a fact). Pure: today is a parameter.
//
//   settlement axis   what the payments establish            UNPAID | PARTIALLY_PAID | PAID   (+ NOT_PAYABLE for a credit note / rejected document, UNKNOWN when the amount is unknown)
//   calendar axis     where the due date stands vs today     NOT_DUE | DUE_TODAY | OVERDUE      (+ NO_DUE_DATE, NOT_APPLICABLE once settled)
//
// The axes never merge: a document can be PARTIALLY_PAID and OVERDUE at once. A validated document is never PAID because it was validated:
// the settlement comes only from recorded payments (today the single manual payment of pay(); later, allocations - a simulated list can already be passed).

import { documentTypeOf } from '../purchase-document.js';
import { daysRemaining, isIsoDate } from './due.js';

export const SETTLEMENT_STATES = ['UNPAID', 'PARTIALLY_PAID', 'PAID', 'NOT_PAYABLE', 'UNKNOWN'];
export const CALENDAR_STATES = ['NOT_DUE', 'DUE_TODAY', 'OVERDUE', 'NO_DUE_DATE', 'NOT_APPLICABLE'];
export const DUE_SOON_DEFAULT_DAYS = 7;
/** Up to this many days left the message is "due in N days" instead of "N days left to pay". */
export const DUE_IN_DAYS_MAX = 3;

const isCents = (x) => Number.isInteger(x) && x >= 0;

/**
 * @param {{ status?: string, documentType?: string, grossCents: number|null, paidAmountCents?: number|null, extraction?: object }} row a supplier-invoice record
 * @param {{ allocations?: Array<{ amountCents: number }>|null }} [opts] simulated / future payment allocations; without them the single recorded payment (status PAID + paid amount) is the only payment there is
 * @returns {{ state: string, paidCents: number, remainingCents: number|null, overpaidCents: number }}
 */
export function settlementOf(row, { allocations = null } = {}) {
  if (!row || row.status === 'REJECTED' || documentTypeOf(row) === 'CREDIT_NOTE') return { state: 'NOT_PAYABLE', paidCents: 0, remainingCents: null, overpaidCents: 0 };
  if (!isCents(row.grossCents)) return { state: 'UNKNOWN', paidCents: 0, remainingCents: null, overpaidCents: 0 };
  const paidCents = Array.isArray(allocations) ? allocations.reduce((a, x) => a + (isCents(x?.amountCents) ? x.amountCents : 0), 0)
    : row.status === 'PAID' && isCents(row.paidAmountCents) ? row.paidAmountCents : 0;
  const remainingCents = Math.max(0, row.grossCents - paidCents); const overpaidCents = Math.max(0, paidCents - row.grossCents);
  const state = row.grossCents > 0 && paidCents >= row.grossCents ? 'PAID' : paidCents > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
  return { state, paidCents, remainingCents, overpaidCents };
}

/**
 * @param {{ dueDate: string|null, settlement: string, today: string, dueSoonDays?: number }} p
 * @returns {{ state: string, daysRemaining: number|null, dueSoon: boolean }}
 */
export function calendarOf({ dueDate, settlement, today, dueSoonDays = DUE_SOON_DEFAULT_DAYS }) {
  if (settlement === 'PAID' || settlement === 'NOT_PAYABLE') return { state: 'NOT_APPLICABLE', daysRemaining: null, dueSoon: false };
  if (!isIsoDate(dueDate) || !isIsoDate(today)) return { state: 'NO_DUE_DATE', daysRemaining: null, dueSoon: false };
  const days = daysRemaining(dueDate, today);
  return { state: days > 0 ? 'NOT_DUE' : days === 0 ? 'DUE_TODAY' : 'OVERDUE', daysRemaining: days, dueSoon: days >= 0 && days <= dueSoonDays };
}

/** Both axes for one record. */
export function axesOf(row, { today, dueSoonDays = DUE_SOON_DEFAULT_DAYS, dueDate = row?.dueDate ?? null, allocations = null } = {}) {
  const settlement = settlementOf(row, { allocations });
  return { settlement, calendar: calendarOf({ dueDate, settlement: settlement.state, today, dueSoonDays }) };
}

/**
 * A structured message (never a sentence, never model-written): the interface turns it into text with its translations.
 * @param {{ settlement: object, calendar: object }} axes
 * @param {{ origin?: string, paidAt?: string|null, grossCents?: number|null, prepaid?: boolean }} [ctx]
 */
export function dueMessageOf(axes, { origin = 'UNKNOWN', paidAt = null, grossCents = null, prepaid = false } = {}) {
  const { settlement: s, calendar: c } = axes;
  if (s.state === 'NOT_PAYABLE') return { kind: 'NOT_PAYABLE' };
  if (s.state === 'PAID') return { kind: 'PAID', paidAt, paidCents: s.paidCents };
  const calendar = c.state === 'OVERDUE' ? { kind: 'OVERDUE', days: -c.daysRemaining, origin }
    : c.state === 'DUE_TODAY' ? { kind: 'DUE_TODAY', origin }
    : c.state === 'NOT_DUE' ? (c.daysRemaining <= DUE_IN_DAYS_MAX ? { kind: 'DUE_SOON', days: c.daysRemaining, origin } : { kind: 'DAYS_LEFT', days: c.daysRemaining, origin })
    : prepaid ? { kind: 'PREPAID' } : { kind: 'NO_DUE_DATE' };
  if (s.state === 'PARTIALLY_PAID') return { kind: 'PARTIAL', paidCents: s.paidCents, grossCents, remainingCents: s.remainingCents, calendar };
  return calendar;
}
