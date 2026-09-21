// Receivables facts: deterministic, no reminders sent. A future reminder agent can consume these facts.
// days_overdue = today - due date (negative = not yet due). Buckets are by days overdue:
//   not_due (<0) | 0_7 (0..7, includes "due today") | 8_30 | 31_60 | 60_plus
// `overdue` means days_overdue > 0. `due_soon` = not yet due and due within `dueSoonDays`.

import { daysBetween, effectiveStatus, settlement } from './document.js';

export const AGING_BUCKETS = ['not_due', '0_7', '8_30', '31_60', '60_plus'];
export const bucketOf = (daysOverdue) => (daysOverdue < 0 ? 'not_due' : daysOverdue <= 7 ? '0_7' : daysOverdue <= 30 ? '8_30' : daysOverdue <= 60 ? '31_60' : '60_plus');

/**
 * @param {Array<{doc: object, payments: object[], creditNotes: object[]}>} invoices issued invoices with their payments and credit notes
 */
export function buildReceivables(invoices, { today, dueSoonDays = 7 }) {
  const open = [];
  for (const { doc, payments, creditNotes } of invoices) {
    if (doc.type !== 'invoice' || !['ISSUED', 'SENT', 'PARTIALLY_PAID'].includes(doc.status)) continue;
    const s = settlement(doc, payments, creditNotes);
    if (s.remainingCents <= 0) continue;
    const daysOverdue = daysBetween(doc.dueDate, today);
    open.push({
      number: doc.number, customer: doc.customer.name, issueDate: doc.issueDate, dueDate: doc.dueDate, currency: doc.currency,
      grossCents: s.grossCents, creditedCents: s.creditedCents, paidCents: s.paidCents, remainingCents: s.remainingCents,
      daysOverdue, bucket: bucketOf(daysOverdue), overdue: daysOverdue > 0, dueSoon: daysOverdue <= 0 && daysOverdue >= -dueSoonDays,
      effectiveStatus: effectiveStatus(doc, s, today),
    });
  }
  open.sort((a, b) => b.daysOverdue - a.daysOverdue || a.number.localeCompare(b.number));
  const sum = (xs) => xs.reduce((a, x) => a + x.remainingCents, 0);
  const currencies = [...new Set(open.map((o) => o.currency))];
  return {
    as_of: today, currencies,
    unpaid: { count: open.length, outstandingCents: sum(open) },
    overdue: { count: open.filter((o) => o.overdue).length, outstandingCents: sum(open.filter((o) => o.overdue)) },
    due_soon: { count: open.filter((o) => o.dueSoon).length, outstandingCents: sum(open.filter((o) => o.dueSoon)), withinDays: dueSoonDays },
    aging: Object.fromEntries(AGING_BUCKETS.map((b) => [b, { count: open.filter((o) => o.bucket === b).length, outstandingCents: sum(open.filter((o) => o.bucket === b)) }])),
    invoices: open,
    notes: currencies.length > 1 ? ['MULTIPLE_CURRENCIES_TOTALS_ARE_NOT_COMPARABLE'] : [],
    provenance: { source: 'finance documents and manual payments', evidence_kind: 'derived', reminders_sent: false, bank_reconciled: false },
  };
}
