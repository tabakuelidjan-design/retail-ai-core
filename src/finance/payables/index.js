// Payables (supplier documents): due dates, payment terms and the two derived status axes. Pure, deterministic, model-free.
// Nothing here talks to a bank, a database or a clock: today and the record are always given.

import { dueOriginOf } from './due.js';
import { axesOf, dueMessageOf } from './status.js';

export { GRAMMAR_VERSION, parsePaymentTerms, termSignature } from './payment-terms.js';
export { DUE_ORIGINS, DUE_DATE_DIFFERS_WARNING, buildDue, computeDueFromTerms, computedProvenance, daysRemaining, dueForProjection, dueOriginOf, isIsoDate, refreshDueAfterIssueDateChange, resolveDue } from './due.js';
export { CALENDAR_STATES, SETTLEMENT_STATES, axesOf, calendarOf, dueMessageOf, settlementOf } from './status.js';

/**
 * Everything the interface shows about the due date and payment of one record.
 * @param {object} row a supplier-invoice record
 * @param {{ today: string, dueSoonDays?: number, allocations?: Array<{amountCents:number}>|null }} ctx
 */
export function dueViewOf(row, { today, dueSoonDays, allocations = null }) {
  const { origin, legacy } = dueOriginOf(row); const ex = row?.extraction?.due ?? null; const terms = ex?.terms ?? null;
  const axes = axesOf(row, { today, dueSoonDays, allocations });
  const prepaid = terms?.status === 'PARSED' && terms.parsed?.kind === 'PREPAID';
  return {
    dueDate: row?.dueDate ?? null, origin, legacy, printed: ex?.printed?.value ?? null, computed: ex?.computed?.value ?? null, divergence: ex?.divergence ?? null,
    terms: terms ? { raw: terms.raw, status: terms.status, kind: terms.parsed?.kind ?? null, days: terms.parsed?.days ?? null, endOfMonth: !!terms.parsed?.endOfMonth, referenceExplicit: !!terms.parsed?.referenceExplicit } : null,
    settlement: axes.settlement.state, calendar: axes.calendar.state, dueSoon: axes.calendar.dueSoon, daysRemaining: axes.calendar.daysRemaining,
    message: dueMessageOf(axes, { origin, paidAt: row?.paidAt ?? null, grossCents: row?.grossCents ?? null, prepaid }),
  };
}
