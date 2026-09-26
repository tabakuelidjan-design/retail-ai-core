// Phase 4.7 (correction): a printed due date that differs from the one the payment terms give must be acknowledged by a person before the purchase is validated.
// The printed date stays the due date; the warning, the two dates and the wording stay; the acknowledgement is recorded in the document (extraction.due, jsonb) and is
// bound to what was shown. Synthetic documents only, dates injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeDueConflict, dueConflictOf, supersedeAcknowledgements } from '../src/finance/payables/index.js';
import { COMM, OWN, SUPPLIER_IBAN, makePdf, spaced } from './finance-pdf-fixtures.js';
import { startApp } from './finance-dashboard-helpers.js';

const invoicePdf = ({ issue = '30/09/2026', due = null, terms = null, number }) => makePdf([[
  [50, 30, 'FACTURE', 18], [50, 80, 'Imprimerie Exemple SRL', 12], [50, 96, "Rue de l'Exemple 12"], [50, 110, '5000 Namur'], [50, 124, 'TVA BE 0000.000.196'],
  [330, 64, 'Client :'], [330, 80, OWN.name, 11], [330, 96, 'Rue Exemple 1'], [330, 110, '1000 Bruxelles'], [330, 124, `TVA ${OWN.vat}`],
  [50, 170, `Facture n° ${number}`], [50, 185, `Date de facture : ${issue}`], ...(due ? [[50, 200, `Échéance : ${due}`]] : []), ...(terms ? [[50, 222, terms]] : []),
  [50, 240, 'Description'], [300, 240, 'Qté'], [360, 240, 'Prix unitaire'], [460, 240, 'Total HTVA'], [50, 260, 'Gourde'], [300, 260, '4'], [360, 260, '25,00'], [460, 260, '100,00'],
  [330, 320, 'Total HTVA'], [460, 320, '100,00 €'], [330, 336, 'TVA 21 % sur 100,00 €'], [460, 336, '21,00 €'], [330, 352, 'Total TVAC'], [460, 352, '121,00 €'],
  [50, 400, `À payer sur le compte IBAN ${spaced(SUPPLIER_IBAN)}`], [50, 414, `Communication : ${COMM}`],
]]);
let seq = 0;
const withH = (fn) => async () => { const a = await startApp({ today: '2026-09-26' }); const c = await a.authed(); try { await fn({ a, c }); } finally { await a.close(); } };
const ingest = async (h, o) => (await h.c.post('/api/inbox/upload', { fileName: 'f.pdf', dataBase64: (await invoicePdf({ number: `K-${++seq}`, ...o })).toString('base64') })).data.item;
const CONFLICT = { due: '15/11/2026', terms: 'Paiement à 30 jours' };   // printed 2026-11-15, terms give 2026-10-30
const validate = (h, id) => h.c.post(`/api/inbox/${id}/validate`, {});
const ack = (h, id) => h.c.post(`/api/inbox/${id}/acknowledge-due-conflict`, {});
const get = async (h, id) => (await h.c.get(`/api/inbox/${id}`)).data;

test('the conflict is detected, the purchase cannot be validated, and the person sees both dates and the wording that produced the computed one', withH(async (h) => {
  const it = await ingest(h, CONFLICT);
  assert.equal(it.dueDate, '2026-11-15', 'the printed date stays the due date'); assert.equal(it.due.origin, 'PRINTED');
  assert.deepEqual([it.due.conflict.state, it.due.conflict.printed, it.due.conflict.computed, it.due.conflict.days, it.due.conflict.terms], ['UNACKNOWLEDGED', '2026-11-15', '2026-10-30', 16, 'Paiement à 30 jours']);
  assert.ok(it.errors.includes('DUE_DATE_CONFLICT_NOT_ACKNOWLEDGED'), 'listed among the things still needed before validation'); assert.ok(it.extraction.warnings.includes('DUE_DATE_DIFFERS_FROM_TERMS'));
  const r = await validate(h, it.id); assert.ok(r.status >= 400, `validation refused (${r.status})`); assert.match(JSON.stringify(r.data), /NOT_READY_TO_VALIDATE/); assert.match(JSON.stringify(r.data), /DUE_DATE_CONFLICT_NOT_ACKNOWLEDGED/);
  assert.equal((await get(h, it.id)).status, 'TO_REVIEW', 'nothing changed');
}));

test('an explicit acknowledgement unblocks the validation; the printed date stays the value; warning, dates, wording and history all stay', withH(async (h) => {
  const it = await ingest(h, CONFLICT);
  const r = await ack(h, it.id); assert.equal(r.status, 200, JSON.stringify(r.data)); const a = r.data;
  assert.deepEqual([a.due.conflict.state, a.due.conflict.acknowledgedAt !== null], ['ACKNOWLEDGED', true]); assert.ok(!a.errors.includes('DUE_DATE_CONFLICT_NOT_ACKNOWLEDGED'));
  assert.equal(a.dueDate, '2026-11-15'); assert.equal(a.due.origin, 'PRINTED');
  assert.ok(a.extraction.warnings.includes('DUE_DATE_DIFFERS_FROM_TERMS'), 'the warning is not removed'); assert.deepEqual(a.extraction.due.divergence, { printed: '2026-11-15', computed: '2026-10-30', days: 16 });
  assert.equal(a.extraction.due.computed.value, '2026-10-30'); assert.equal(a.extraction.due.terms.raw, 'Paiement à 30 jours');
  assert.equal(a.extraction.due.acknowledgements.length, 1); assert.deepEqual(Object.keys(a.extraction.due.acknowledgements[0]).sort(), ['at', 'by', 'computed', 'days', 'printed', 'terms']);
  assert.deepEqual([a.extraction.due.acknowledgements[0].printed, a.extraction.due.acknowledgements[0].computed, a.extraction.due.acknowledgements[0].terms, a.extraction.due.acknowledgements[0].by], ['2026-11-15', '2026-10-30', 'Paiement à 30 jours', 'merchant']);
  assert.ok(h.a.audits.some((e) => e.action === 'SUPPLIER_INVOICE_DUE_CONFLICT_ACKNOWLEDGED' && e.itemId === it.id), 'audited');
  const v = await validate(h, it.id); assert.equal(v.status, 200, JSON.stringify(v.data)); assert.equal(v.data.status, 'VALIDATED'); assert.equal(v.data.dueDate, '2026-11-15');
  assert.equal((await ack(h, it.id)).status >= 400, true, 'nothing to acknowledge any more / not editable once validated');
  const reopened = (await h.c.post(`/api/inbox/${it.id}/reopen`, {})).data; assert.equal(reopened.due.conflict.state, 'ACKNOWLEDGED', 'reopening keeps the acknowledgement of the same difference');
}));

test('no conflict, no blocking: printed = computed, only PRINTED, only a reliable COMPUTED_FROM_TERMS, UNKNOWN - and nothing artificial to acknowledge', withH(async (h) => {
  const cases = [['printed = computed', { due: '30/10/2026', terms: 'Paiement à 30 jours' }, 'PRINTED'], ['only printed', { due: '15/11/2026' }, 'PRINTED'], ['only computed', { terms: 'Paiement à 30 jours' }, 'COMPUTED_FROM_TERMS'],
    ['unknown', {}, 'UNKNOWN'], ['unrecognised wording', { terms: 'Selon contrat' }, 'UNKNOWN']];
  for (const [label, o, origin] of cases) {
    const it = await ingest(h, o); assert.equal(it.due.origin, origin, label); assert.equal(it.due.conflict.state, 'NONE', label); assert.ok(!it.errors.includes('DUE_DATE_CONFLICT_NOT_ACKNOWLEDGED'), label);
    const r = await validate(h, it.id); assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.data)}`);
    assert.ok(ack.length && (await ack(h, it.id)).status >= 400, `${label}: nothing to acknowledge`);
  }
}));

test('a manual edit or clearing of the due date after an acknowledgement: the conflict is replaced by the person\'s decision, the old acknowledgement stays in the history but is never reused', withH(async (h) => {
  const it = await ingest(h, CONFLICT); await ack(h, it.id);
  let r = await h.c.put(`/api/inbox/${it.id}`, { dueDate: '2026-12-01' }); assert.equal(r.data.due.origin, 'MANUAL'); assert.equal(r.data.due.conflict.state, 'NONE', 'the person decided');
  const history = r.data.extraction.due.acknowledgements; assert.equal(history.length, 1, 'history kept'); assert.equal(history[0].supersededBy, 'DUE_DATE_EDITED'); assert.ok(history[0].supersededAt);
  assert.equal(r.data.extraction.due.divergence.printed, '2026-11-15', 'the evidence of the difference stays'); assert.ok(r.data.extraction.warnings.includes('DUE_DATE_DIFFERS_FROM_TERMS'));
  r = await h.c.put(`/api/inbox/${it.id}`, { dueDate: '' }); assert.equal(r.data.due.origin, 'UNKNOWN'); assert.equal(r.data.due.conflict.state, 'NONE'); assert.equal(r.data.extraction.due.acknowledgements[0].supersededBy, 'DUE_DATE_EDITED', 'the first reason is kept');
  assert.ok(!r.data.errors.includes('DUE_DATE_CONFLICT_NOT_ACKNOWLEDGED')); assert.equal((await validate(h, it.id)).status, 200);
}));

test('an acknowledgement is bound to what was shown: if the computed date changes (invoice date edited), the old acknowledgement does not cover the new difference', withH(async (h) => {
  const it = await ingest(h, CONFLICT); await ack(h, it.id);
  assert.equal((await get(h, it.id)).due.conflict.state, 'ACKNOWLEDGED');
  let r = await h.c.put(`/api/inbox/${it.id}`, { issueDate: '2026-10-05' });   // terms now give 2026-11-04, printed stays 2026-11-15
  assert.deepEqual([r.data.due.conflict.state, r.data.due.conflict.computed, r.data.due.conflict.days], ['UNACKNOWLEDGED', '2026-11-04', 11], 'a new difference: blocked again');
  assert.ok(r.data.errors.includes('DUE_DATE_CONFLICT_NOT_ACKNOWLEDGED')); assert.ok((await validate(h, it.id)).status >= 400);
  r = await ack(h, it.id); assert.equal(r.data.extraction.due.acknowledgements.length, 2, 'appended, the first one is kept'); assert.equal(r.data.due.conflict.state, 'ACKNOWLEDGED'); assert.equal(r.data.due.conflict.computed, '2026-11-04');
  r = await h.c.put(`/api/inbox/${it.id}`, { issueDate: '2026-10-16' });   // terms now give 2026-11-15 = printed: no difference at all
  assert.deepEqual([r.data.due.conflict.state, r.data.extraction.due.divergence], ['NONE', null]); assert.equal((await validate(h, it.id)).status, 200);
}));

test('unit: dueConflictOf / acknowledgeDueConflict / supersedeAcknowledgements on plain records', () => {
  const base = { dueDate: '2026-11-15', extraction: { provenance: { dueDate: { source: 'PDF_TEXT' } }, due: { terms: { raw: 'Net 30' }, divergence: { printed: '2026-11-15', computed: '2026-10-30', days: 16 } } } };
  assert.equal(dueConflictOf(base).state, 'UNACKNOWLEDGED'); assert.equal(dueConflictOf({ dueDate: '2026-11-15' }).state, 'NONE'); assert.equal(dueConflictOf({ dueDate: null, extraction: base.extraction }).state, 'NONE');
  assert.equal(dueConflictOf({ ...base, dueDate: '2026-12-01', extraction: { ...base.extraction, provenance: { dueDate: { source: 'user' } } } }).state, 'NONE', 'a manual date is a decision');
  const due = acknowledgeDueConflict(base, { at: '2026-09-26T10:00:00Z' }); const acked = { ...base, extraction: { ...base.extraction, due } };
  assert.equal(dueConflictOf(acked).state, 'ACKNOWLEDGED'); assert.throws(() => acknowledgeDueConflict(acked, { at: 'x' }), /NO_DUE_CONFLICT_TO_ACKNOWLEDGE/); assert.throws(() => acknowledgeDueConflict({ dueDate: '2026-11-15' }, { at: 'x' }), RangeError);
  assert.equal(dueConflictOf({ ...acked, extraction: { ...acked.extraction, due: { ...due, terms: { raw: 'Net 45' } } } }).state, 'UNACKNOWLEDGED', 'another wording is another difference');
  const gone = supersedeAcknowledgements(due, 'DUE_DATE_EDITED', 'T'); assert.equal(gone.acknowledgements[0].supersededBy, 'DUE_DATE_EDITED'); assert.equal(supersedeAcknowledgements(gone, 'OTHER', 'U').acknowledgements[0].supersededBy, 'DUE_DATE_EDITED', 'first reason kept');
  assert.equal(dueConflictOf({ ...base, extraction: { ...base.extraction, due: gone } }).state, 'UNACKNOWLEDGED', 'a superseded acknowledgement is never reused');
});
