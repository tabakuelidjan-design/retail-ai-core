// Phase 4.7: the two status axes (settlement / calendar) and the days remaining. Derived, deterministic, today injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { axesOf, calendarOf, daysRemaining, dueMessageOf, dueViewOf, settlementOf } from '../src/finance/payables/index.js';
import { daysBetween } from '../src/finance/document.js';

const inv = (o = {}) => ({ status: 'TO_PAY', documentType: 'INVOICE', grossCents: 84250, paidAmountCents: null, dueDate: '2026-10-14', ...o });
const TODAY = '2026-09-26';

test('settlement axis: only recorded payments make a document paid - validated / to-pay never do', () => {
  for (const status of ['RECEIVED', 'TO_REVIEW', 'VALIDATED', 'TO_PAY']) assert.equal(settlementOf(inv({ status })).state, 'UNPAID', status);
  assert.deepEqual(settlementOf(inv({ status: 'PAID', paidAmountCents: 84250 })), { state: 'PAID', paidCents: 84250, remainingCents: 0, overpaidCents: 0 });
  assert.equal(settlementOf(inv({ status: 'PAID', paidAmountCents: null })).state, 'UNPAID', 'PAID with no recorded amount establishes nothing');
  assert.equal(settlementOf(inv({ status: 'VALIDATED', paidAmountCents: 84250 })).state, 'UNPAID', 'an amount on a document that is not PAID is not a payment');
  assert.equal(settlementOf(inv({ grossCents: null })).state, 'UNKNOWN'); assert.equal(settlementOf(inv({ documentType: 'CREDIT_NOTE' })).state, 'NOT_PAYABLE'); assert.equal(settlementOf(inv({ status: 'REJECTED' })).state, 'NOT_PAYABLE');
});

test('settlement axis with SIMULATED allocations (real partial payments come later): unpaid / partial / paid / several payments / overpayment', () => {
  const s = (allocations, o) => settlementOf(inv(o), { allocations });
  assert.deepEqual(s([]), { state: 'UNPAID', paidCents: 0, remainingCents: 84250, overpaidCents: 0 });
  assert.deepEqual(s([{ amountCents: 50000 }]), { state: 'PARTIALLY_PAID', paidCents: 50000, remainingCents: 34250, overpaidCents: 0 });
  assert.equal(s([{ amountCents: 50000 }, { amountCents: 34250 }]).state, 'PAID', 'several payments add up');
  assert.deepEqual(s([{ amountCents: 90000 }]), { state: 'PAID', paidCents: 90000, remainingCents: 0, overpaidCents: 5750 });
  assert.equal(s([{ amountCents: -5 }, { amountCents: 'x' }]).state, 'UNPAID', 'invalid amounts count for nothing');
});

test('calendar axis: not due / due today / overdue, "due soon" from the existing setting, none when settled or without a due date', () => {
  const c = (dueDate, settlement = 'UNPAID', extra = {}) => calendarOf({ dueDate, settlement, today: TODAY, ...extra });
  assert.deepEqual(c('2026-10-14'), { state: 'NOT_DUE', daysRemaining: 18, dueSoon: false });
  assert.deepEqual(c('2026-09-29'), { state: 'NOT_DUE', daysRemaining: 3, dueSoon: true });
  assert.deepEqual(c('2026-10-03'), { state: 'NOT_DUE', daysRemaining: 7, dueSoon: true }, 'default dueSoonDays = 7 (dashboard.dueSoonDays)');
  assert.equal(c('2026-10-03', 'UNPAID', { dueSoonDays: 5 }).dueSoon, false);
  assert.deepEqual(c('2026-09-26'), { state: 'DUE_TODAY', daysRemaining: 0, dueSoon: true });
  assert.deepEqual(c('2026-09-19'), { state: 'OVERDUE', daysRemaining: -7, dueSoon: false });
  assert.equal(c(null).state, 'NO_DUE_DATE'); assert.equal(c('garbage').state, 'NO_DUE_DATE');
  assert.equal(c('2026-09-19', 'PAID').state, 'NOT_APPLICABLE', 'a settled document is never "overdue"'); assert.equal(c('2026-09-19', 'NOT_PAYABLE').state, 'NOT_APPLICABLE');
});

test('the two axes are independent: PARTIALLY_PAID + OVERDUE together, and every other combination', () => {
  const both = axesOf(inv({ dueDate: '2026-09-19' }), { today: TODAY, allocations: [{ amountCents: 50000 }] });
  assert.equal(both.settlement.state, 'PARTIALLY_PAID'); assert.equal(both.calendar.state, 'OVERDUE'); assert.equal(both.calendar.daysRemaining, -7);
  const m = dueMessageOf(both, { origin: 'PRINTED', grossCents: 84250 });
  assert.deepEqual(m, { kind: 'PARTIAL', paidCents: 50000, grossCents: 84250, remainingCents: 34250, calendar: { kind: 'OVERDUE', days: 7, origin: 'PRINTED' } }, 'no information lost: partial AND overdue');
  assert.equal(axesOf(inv({ dueDate: '2026-10-14' }), { today: TODAY, allocations: [{ amountCents: 50000 }] }).calendar.state, 'NOT_DUE', 'partial + not due');
  assert.equal(axesOf(inv({ dueDate: '2026-09-19' }), { today: TODAY }).settlement.state, 'UNPAID', 'unpaid + overdue');
  assert.equal(axesOf(inv({ status: 'PAID', paidAmountCents: 84250, dueDate: '2026-09-19' }), { today: TODAY }).calendar.state, 'NOT_APPLICABLE');
});

test('days remaining = due date - today, the exact inverse of receivables days-overdue; today is a parameter', () => {
  assert.equal(daysRemaining('2026-10-14', '2026-09-26'), 18); assert.equal(daysRemaining('2026-09-26', '2026-09-26'), 0); assert.equal(daysRemaining('2026-09-19', '2026-09-26'), -7);
  assert.equal(daysRemaining('2027-01-03', '2026-12-31'), 3, 'across the year'); assert.equal(daysRemaining('2028-03-01', '2028-02-28'), 2, 'leap year'); assert.equal(daysRemaining(null, '2026-09-26'), null); assert.equal(daysRemaining('2026-09-26', 'x'), null);
  for (const [due, today] of [['2026-09-19', TODAY], ['2026-10-14', TODAY], ['2026-09-26', TODAY]]) assert.equal(daysRemaining(due, today), 0 - daysBetween(due, today), 'same function and convention as receivables.js (daysOverdue = daysBetween(due, today))');
});

test('messages are structured (never model-written) and cover every case', () => {
  const m = (row, extra = {}, ctx = {}) => dueMessageOf(axesOf(row, { today: TODAY, ...extra }), ctx);
  assert.deepEqual(m(inv({ dueDate: '2026-10-14' }), {}, { origin: 'PRINTED' }), { kind: 'DAYS_LEFT', days: 18, origin: 'PRINTED' });
  assert.deepEqual(m(inv({ dueDate: '2026-09-29' })), { kind: 'DUE_SOON', days: 3, origin: 'UNKNOWN' });
  assert.deepEqual(m(inv({ dueDate: '2026-09-27' })), { kind: 'DUE_SOON', days: 1, origin: 'UNKNOWN' });
  assert.deepEqual(m(inv({ dueDate: '2026-09-30' })), { kind: 'DAYS_LEFT', days: 4, origin: 'UNKNOWN' });
  assert.deepEqual(m(inv({ dueDate: '2026-09-26' })), { kind: 'DUE_TODAY', origin: 'UNKNOWN' });
  assert.deepEqual(m(inv({ dueDate: '2026-09-19' }), {}, { origin: 'COMPUTED_FROM_TERMS' }), { kind: 'OVERDUE', days: 7, origin: 'COMPUTED_FROM_TERMS' });
  assert.deepEqual(m(inv({ dueDate: null })), { kind: 'NO_DUE_DATE' }); assert.deepEqual(m(inv({ dueDate: null }), {}, { prepaid: true }), { kind: 'PREPAID' });
  assert.deepEqual(m(inv({ status: 'PAID', paidAmountCents: 84250 }), {}, { paidAt: '2026-10-12' }), { kind: 'PAID', paidAt: '2026-10-12', paidCents: 84250 });
  assert.deepEqual(m(inv({ documentType: 'CREDIT_NOTE' })), { kind: 'NOT_PAYABLE' });
});

test('dueViewOf: what the interface shows, for a computed date with its wording, a printed one and an unknown one', () => {
  const computedRow = { ...inv({ dueDate: '2026-10-30' }), extraction: { provenance: { dueDate: { source: 'computed', text: 'Paiement à 30 jours' } }, due: { terms: { raw: 'Paiement à 30 jours', status: 'PARSED', parsed: { kind: 'NET_DAYS', days: 30, endOfMonth: false, referenceExplicit: false } }, printed: null, computed: { value: '2026-10-30' }, divergence: null } } };
  const v = dueViewOf(computedRow, { today: '2026-09-30' });
  assert.deepEqual([v.origin, v.legacy, v.settlement, v.calendar, v.daysRemaining, v.terms.raw, v.terms.days], ['COMPUTED_FROM_TERMS', false, 'UNPAID', 'NOT_DUE', 30, 'Paiement à 30 jours', 30]);
  assert.deepEqual(dueViewOf(inv({ dueDate: null }), { today: TODAY }).message, { kind: 'NO_DUE_DATE' });
  const legacy = dueViewOf(inv({ dueDate: '2026-10-14' }), { today: TODAY }); assert.deepEqual([legacy.origin, legacy.legacy], ['MANUAL', true]);
});
