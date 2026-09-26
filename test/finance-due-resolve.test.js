// Phase 4.7: due date, its origin, and the computation from an explicit payment term. Synthetic data, dates injected, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDue, computeDueFromTerms, dueForProjection, dueOriginOf, refreshDueAfterIssueDateChange, resolveDue } from '../src/finance/payables/index.js';
import { parsePaymentTerms } from '../src/finance/payables/payment-terms.js';

const terms = (raw, labelled = false) => ({ raw, ...parsePaymentTerms(raw, { labelled }) });
const field = (value, extra = {}) => ({ value, confidence: 0.9, page: 1, ...extra });

test('validated example: invoice of 30/09/2026 + payment at 30 days = 30/10/2026, computed from the terms', () => {
  const r = resolveDue({ issueDate: '2026-09-30', printed: null, terms: terms('Paiement à 30 jours') });
  assert.deepEqual(r.effective, { value: '2026-10-30', origin: 'COMPUTED_FROM_TERMS' });
  assert.deepEqual(r.computed, { value: '2026-10-30', referenceDate: '2026-09-30', days: 30, endOfMonth: false });
});

test('14 days, 30 days, 30 days end of month, immediately: exact dates including month / year / leap-year edges', () => {
  const due = (issue, raw) => resolveDue({ issueDate: issue, printed: null, terms: terms(raw, true) }).effective.value;
  assert.equal(due('2026-09-30', '14 jours'), '2026-10-14');
  assert.equal(due('2026-12-20', '14 jours'), '2027-01-03', 'across the year');
  assert.equal(due('2026-01-31', '30 jours'), '2026-03-02');
  assert.equal(due('2028-01-30', '30 jours'), '2028-02-29', 'leap year');
  assert.equal(due('2026-09-10', '30 jours fin de mois'), '2026-10-31', '10/09 + 30 days = 10/10 -> end of October');
  assert.equal(due('2026-09-30', '30 jours fin de mois'), '2026-10-31');
  assert.equal(due('2026-01-15', '30 jours fin de mois'), '2026-02-28', 'end of February');
  assert.equal(due('2028-01-15', '30 jours fin de mois'), '2028-02-29', 'end of February, leap year');
  assert.equal(due('2026-11-05', '60 jours fin de mois'), '2027-01-31');
  assert.equal(due('2026-09-30', 'Payable immédiatement'), '2026-09-30', 'immediately = the invoice date');
});

test('a printed due date is used as printed', () => {
  const r = resolveDue({ issueDate: '2026-09-30', printed: '2026-10-14', terms: null });
  assert.deepEqual(r.effective, { value: '2026-10-14', origin: 'PRINTED' }); assert.equal(r.computed, null); assert.equal(r.divergence, null);
});

test('printed = computed: the printed date stays the main value, the computed one is kept as evidence, no divergence', () => {
  const r = resolveDue({ issueDate: '2026-09-30', printed: '2026-10-30', terms: terms('Paiement à 30 jours') });
  assert.deepEqual(r.effective, { value: '2026-10-30', origin: 'PRINTED' }); assert.equal(r.computed.value, '2026-10-30'); assert.equal(r.divergence, null);
});

test('printed != computed: the printed date wins, the difference is reported and never hidden', () => {
  const r = resolveDue({ issueDate: '2026-09-30', printed: '2026-11-15', terms: terms('Paiement à 30 jours') });
  assert.deepEqual(r.effective, { value: '2026-11-15', origin: 'PRINTED' }); assert.deepEqual(r.divergence, { printed: '2026-11-15', computed: '2026-10-30', days: 16 });
  const early = resolveDue({ issueDate: '2026-09-30', printed: '2026-10-20', terms: terms('Paiement à 30 jours') }); assert.equal(early.divergence.days, -10, 'printed earlier than the terms: negative');
});

test('NO invented due date: no term, unknown term, ambiguous term, prepaid, non-invoice starting point, unparsable text all give UNKNOWN', () => {
  const unknown = { effective: { value: null, origin: 'UNKNOWN' }, computed: null, divergence: null, suppressed: false };
  assert.deepEqual(resolveDue({ issueDate: '2026-09-30', printed: null, terms: null }), unknown, 'absence of a condition');
  for (const raw of ['Selon contrat', '2/10 net 30', '30 jours date de réception', 'Payer sous 30 jours ou 60 jours', 'Acompte 30 %']) assert.deepEqual(resolveDue({ issueDate: '2026-09-30', printed: null, terms: terms(raw, true) }), unknown, raw);
  assert.deepEqual(resolveDue({ issueDate: '2026-09-30', printed: null, terms: terms('Payment upfront') }), unknown, 'prepaid: nothing to compute');
  assert.equal(resolveDue({ issueDate: '2026-09-30', printed: 'not a date', terms: null }).effective.origin, 'UNKNOWN', 'an invalid printed date is not a due date');
});

test('an invoice without a valid date gives no computed due date (never a guess), but a printed date still stands', () => {
  for (const bad of [null, '', 'yesterday', '2026-13-40', '2026-02-30']) {
    assert.deepEqual(resolveDue({ issueDate: bad, printed: null, terms: terms('Paiement à 30 jours') }).effective, { value: null, origin: 'UNKNOWN' }, String(bad));
    assert.equal(computeDueFromTerms(bad, parsePaymentTerms('Net 30').parsed), null);
  }
  assert.equal(resolveDue({ issueDate: null, printed: '2026-10-14', terms: terms('Net 30') }).effective.origin, 'PRINTED');
});

test('MANUAL wins over everything and is never overwritten; clearing it gives UNKNOWN and is not re-applied', () => {
  const t = terms('Paiement à 30 jours');
  assert.deepEqual(resolveDue({ issueDate: '2026-09-30', printed: '2026-10-14', terms: t, manual: { value: '2026-12-01' } }).effective, { value: '2026-12-01', origin: 'MANUAL' });
  const cleared = resolveDue({ issueDate: '2026-09-30', printed: null, terms: t, manual: { value: null } });
  assert.deepEqual(cleared.effective, { value: null, origin: 'UNKNOWN' }); assert.equal(cleared.suppressed, true);
});

test('buildDue: what a reader extracted becomes the column value, the evidence block and the provenance (original wording kept)', () => {
  const computed = buildDue({ issueDate: '2026-09-30', fields: { paymentTerms: field('Paiement à 30 jours', { path: 'TERMS_PHRASE' }) } });
  assert.equal(computed.dueDate, '2026-10-30'); assert.equal(computed.origin, 'COMPUTED_FROM_TERMS');
  assert.equal(computed.provenance.source, 'computed'); assert.equal(computed.provenance.text, 'Paiement à 30 jours'); assert.equal(computed.provenance.value, '2026-10-30');
  assert.equal(computed.due.terms.raw, 'Paiement à 30 jours'); assert.equal(computed.due.terms.parsed.days, 30); assert.equal(computed.due.effective.origin, 'COMPUTED_FROM_TERMS'); assert.deepEqual(computed.warnings, []);
  const printedAndDifferent = buildDue({ issueDate: '2026-09-30', fields: { dueDate: field('2026-11-15', { path: 'LABEL_DUE_DATE' }), paymentTerms: field('Paiement à 30 jours', { path: 'TERMS_PHRASE' }) } });
  assert.equal(printedAndDifferent.dueDate, '2026-11-15'); assert.equal(printedAndDifferent.origin, 'PRINTED'); assert.equal(printedAndDifferent.provenance, null, 'the printed date keeps the reader\'s own provenance');
  assert.deepEqual(printedAndDifferent.warnings, ['DUE_DATE_DIFFERS_FROM_TERMS']); assert.equal(printedAndDifferent.due.divergence.days, 16); assert.equal(printedAndDifferent.due.printed.value, '2026-11-15');
  const nothing = buildDue({ issueDate: '2026-09-30', fields: {} });
  assert.deepEqual([nothing.due, nothing.dueDate, nothing.origin, nothing.provenance], [null, null, 'UNKNOWN', null], 'no evidence: no block, no date');
  const unknownWording = buildDue({ issueDate: '2026-09-30', fields: { paymentTerms: field('Selon contrat', { path: 'LABEL_PAYMENT_TERMS' }) } });
  assert.equal(unknownWording.dueDate, null); assert.equal(unknownWording.due.terms.status, 'OUT_OF_GRAMMAR'); assert.equal(unknownWording.due.terms.raw, 'Selon contrat', 'the wording is kept for the person');
});

test('dueOriginOf: reads the existing provenance mechanism (source "user" = MANUAL); old records without evidence are never rewritten', () => {
  assert.deepEqual(dueOriginOf({ dueDate: null }), { origin: 'UNKNOWN', legacy: false });
  assert.deepEqual(dueOriginOf({ dueDate: '2026-10-14', extraction: { provenance: { dueDate: { source: 'user', at: 'x', confidence: 1 } } } }), { origin: 'MANUAL', legacy: false });
  assert.deepEqual(dueOriginOf({ dueDate: '2026-10-14', extraction: { provenance: { dueDate: { source: 'PDF_TEXT', path: 'LABEL_DUE_DATE' } } } }), { origin: 'PRINTED', legacy: false });
  assert.deepEqual(dueOriginOf({ dueDate: '2026-10-14', extraction: { provenance: { dueDate: { source: 'ubl', path: 'Invoice/DueDate' } } } }), { origin: 'PRINTED', legacy: false });
  assert.deepEqual(dueOriginOf({ dueDate: '2026-10-30', extraction: { provenance: { dueDate: { source: 'computed', path: 'COMPUTED_FROM_TERMS', text: 'x' } } } }), { origin: 'COMPUTED_FROM_TERMS', legacy: false });
  assert.deepEqual(dueOriginOf({ dueDate: '2026-10-14' }), { origin: 'MANUAL', legacy: true }, 'legacy: a date with no recorded reading is not claimed to be printed');
  assert.deepEqual(dueOriginOf({ dueDate: '2026-10-14', extraction: { extractor: 'manual', provenance: {} } }), { origin: 'MANUAL', legacy: true });
});

test('a changed invoice date recomputes a COMPUTED due date only; printed and manual dates never move', () => {
  const computedRow = { dueDate: '2026-10-30', extraction: { provenance: { dueDate: { source: 'computed', text: 'Paiement à 30 jours' } }, due: buildDue({ issueDate: '2026-09-30', fields: { paymentTerms: field('Paiement à 30 jours', { path: 'TERMS_PHRASE' }) } }).due } };
  const moved = refreshDueAfterIssueDateChange(computedRow, '2026-10-10'); assert.equal(moved.dueDate, '2026-11-09'); assert.equal(moved.provenance.value, '2026-11-09'); assert.equal(moved.due.issueDate, '2026-10-10'); assert.equal(moved.due.computed.referenceDate, '2026-10-10');
  const invalid = refreshDueAfterIssueDateChange(computedRow, null); assert.equal(invalid.dueDate, null, 'no valid invoice date: the computed date is withdrawn, not guessed'); assert.equal(invalid.provenance, null);
  const printedRow = { ...computedRow, dueDate: '2026-11-15', extraction: { ...computedRow.extraction, provenance: { dueDate: { source: 'PDF_TEXT' } }, due: { ...computedRow.extraction.due, printed: { value: '2026-11-15' } } } };
  const kept = refreshDueAfterIssueDateChange(printedRow, '2026-10-10'); assert.equal(kept.dueDate, undefined, 'a printed date is left alone'); assert.equal(kept.due.divergence.computed, '2026-11-09');
  const manualRow = { ...computedRow, dueDate: '2026-12-01', extraction: { ...computedRow.extraction, provenance: { dueDate: { source: 'user' } } } };
  assert.equal(refreshDueAfterIssueDateChange(manualRow, '2026-10-10').dueDate, undefined, 'a manual date is left alone');
  assert.deepEqual(refreshDueAfterIssueDateChange({ dueDate: null, extraction: {} }, '2026-10-10'), { due: null, dueDate: undefined, provenance: undefined });
});

test('treasury eligibility: printed and manual dates, computed only when the explicit wording is kept; UNKNOWN never', () => {
  const printed = { dueDate: '2026-10-14', extraction: { provenance: { dueDate: { source: 'PDF_TEXT' } } } };
  assert.deepEqual(dueForProjection(printed), { dueDate: '2026-10-14', origin: 'PRINTED' });
  assert.deepEqual(dueForProjection({ dueDate: '2026-10-14', extraction: { provenance: { dueDate: { source: 'user' } } } }), { dueDate: '2026-10-14', origin: 'MANUAL' });
  const computed = { dueDate: '2026-10-30', extraction: { provenance: { dueDate: { source: 'computed', text: 'Paiement à 30 jours' } }, due: { terms: { raw: 'Paiement à 30 jours' } } } };
  assert.deepEqual(dueForProjection(computed), { dueDate: '2026-10-30', origin: 'COMPUTED_FROM_TERMS' }, 'distinguishable from a printed date');
  assert.deepEqual(dueForProjection({ dueDate: '2026-10-30', extraction: { provenance: { dueDate: { source: 'computed', text: '' } } } }), { dueDate: null, origin: 'UNKNOWN' }, 'a computed date without its wording is not reliable');
  assert.deepEqual(dueForProjection({ dueDate: null }), { dueDate: null, origin: 'UNKNOWN' });
});
