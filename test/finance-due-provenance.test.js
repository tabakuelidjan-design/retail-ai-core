// Phase 4.7: reading the payment terms of a supplier document (PDF text, UBL), the due date and its provenance through the inbox, the person's edits (MANUAL),
// the treasury projection, and non-regression on existing documents. SYNTHETIC documents only (invented parties, invented numbers), dates injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPdfDocument } from '../src/finance/pdf-invoice.js';
import { readUblDocument } from '../src/finance/purchase-document.js';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { createInboxService, createMemoryAttachmentStore } from '../src/finance/inbox.js';
import { COMM, OWN, SUPPLIER_IBAN, makePdf, spaced } from './finance-pdf-fixtures.js';
import { startApp } from './finance-dashboard-helpers.js';

const own = { vatNumbers: [OWN.vat], ibans: [OWN.iban], names: [OWN.name] };
const v = (r) => Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, x.value]));

/** A French invoice (layout of the phase 3 fixtures) with optional printed due date and payment-terms lines. */
const invoicePdf = ({ issue = '10/09/2026', due = null, termsLabel = null, terms = [], number = 'F-2026-0101' } = {}) => makePdf([[
  [50, 30, 'FACTURE', 18], [50, 80, 'Imprimerie Exemple SRL', 12], [50, 96, "Rue de l'Exemple 12"], [50, 110, '5000 Namur'], [50, 124, 'TVA BE 0000.000.196'],
  [330, 64, 'Client :'], [330, 80, OWN.name, 11], [330, 96, 'Rue Exemple 1'], [330, 110, '1000 Bruxelles'], [330, 124, `TVA ${OWN.vat}`],
  [50, 170, `Facture n° ${number}`], [50, 185, `Date de facture : ${issue}`], ...(due ? [[50, 200, `Échéance : ${due}`]] : []),
  ...(termsLabel ? [[50, 212, `Conditions de paiement : ${termsLabel}`]] : []), ...terms.map((t, i) => [50, 222 + i * 8, t]),
  [50, 240, 'Description'], [300, 240, 'Qté'], [360, 240, 'Prix unitaire'], [460, 240, 'Total HTVA'],
  [50, 260, 'Gourde isotherme 500 ml'], [300, 260, '4'], [360, 260, '15,00'], [460, 260, '60,00'], [50, 278, 'Gravure laser'], [300, 278, '4'], [360, 278, '10,00'], [460, 278, '40,00'],
  [330, 320, 'Total HTVA'], [460, 320, '100,00 €'], [330, 336, 'TVA 21 % sur 100,00 €'], [460, 336, '21,00 €'], [330, 352, 'Total TVAC'], [460, 352, '121,00 €'],
  [50, 400, `À payer sur le compte IBAN ${spaced(SUPPLIER_IBAN)}`], [50, 414, `Communication : ${COMM}`],
]]);
const read = async (o) => readPdfDocument(await invoicePdf(o), own);

// ---------- reading ----------
test('PDF: an explicit payment term is located and kept as the supplier wrote it (labelled, or a short whole phrase)', async () => {
  const labelled = await read({ termsLabel: '30 jours fin de mois' });
  assert.equal(labelled.fields.paymentTerms.value, '30 jours fin de mois'); assert.equal(labelled.fields.paymentTerms.path, 'LABEL_PAYMENT_TERMS'); assert.equal(labelled.fields.paymentTerms.page, 1); assert.ok(labelled.fields.paymentTerms.confidence >= 0.7);
  const phrase = await read({ terms: ['Paiement à 14 jours'] }); assert.equal(phrase.fields.paymentTerms.value, 'Paiement à 14 jours'); assert.equal(phrase.fields.paymentTerms.path, 'TERMS_PHRASE');
  const now = await read({ terms: ['Payable immédiatement'] }); assert.equal(now.fields.paymentTerms.value, 'Payable immédiatement');
  const nl = await read({ termsLabel: 'Betaalbaar binnen 30 dagen' }); assert.equal(nl.fields.paymentTerms.value, 'Betaalbaar binnen 30 dagen');
});

test('PDF: no condition, a warranty / return period, or an unrecognised wording never produce a term the grammar computes from', async () => {
  const none = await read({}); assert.equal(none.fields.paymentTerms, undefined); assert.ok(!none.warnings.some((w) => w.startsWith('PAYMENT_TERMS')));
  const dispute = await read({ terms: ['Please contact billing@example.com within 7 days after invoice date', 'Payment reference 2Q0xx7im6CPubdtNFZRL'] }); assert.equal(dispute.fields.paymentTerms, undefined, 'a dispute period and a reference id are not payment terms (seen on real invoices)');
  const warranty = await read({ terms: ['Garantie 30 jours', 'Retour sous 14 jours'] }); assert.equal(warranty.fields.paymentTerms, undefined, 'not payment terms');
  const contract = await read({ termsLabel: 'Selon contrat' }); assert.equal(contract.fields.paymentTerms.value, 'Selon contrat'); assert.ok(contract.fields.paymentTerms.confidence < 0.7, 'kept for the person, flagged to check'); assert.ok(contract.warnings.includes('PAYMENT_TERMS_NOT_RECOGNISED'));
  const two = await read({ terms: ['Paiement à 14 jours', 'Paiement à 30 jours'] }); assert.equal(two.fields.paymentTerms, undefined); assert.ok(two.warnings.includes('PAYMENT_TERMS_AMBIGUOUS'), 'two different terms: abstention');
});

test('PDF: the printed due date is read exactly as before (the terms rule changes nothing about it)', async () => {
  const printed = await read({ due: '10/10/2026' }); assert.deepEqual([v(printed).issueDate, v(printed).dueDate], ['2026-09-10', '2026-10-10']); assert.equal(printed.fields.dueDate.path, 'LABEL_DUE_DATE');
  const both = await read({ due: '10/10/2026', terms: ['Paiement à 30 jours'] }); assert.equal(v(both).dueDate, '2026-10-10'); assert.equal(v(both).paymentTerms, 'Paiement à 30 jours');
});

test('UBL: PaymentTerms/Note is the term wording; DueDate stays the printed date', () => {
  const ubl = (extra) => `<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:ID>F-1</cbc:ID><cbc:IssueDate>2026-09-30</cbc:IssueDate>${extra}<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode></Invoice>`;
  const withNote = readUblDocument(ubl('<cac:PaymentTerms><cbc:Note>Paiement à 30 jours</cbc:Note></cac:PaymentTerms>')); assert.equal(withNote.fields.paymentTerms.value, 'Paiement à 30 jours'); assert.equal(withNote.fields.paymentTerms.path, 'Invoice/PaymentTerms/Note'); assert.equal(withNote.fields.dueDate, undefined);
  assert.equal(readUblDocument(ubl('<cbc:DueDate>2026-10-14</cbc:DueDate>')).fields.paymentTerms, undefined, 'no note, no term');
});

// ---------- through the inbox ----------
const upload = (h, name, buf) => h.c.post('/api/inbox/upload', { fileName: name, dataBase64: buf.toString('base64') });
const withH = (fn, today = '2026-09-26') => async () => { const a = await startApp({ today }); const c = await a.authed(); try { await fn({ a, c }); } finally { await a.close(); } };
const ingest = async (h, o, name = 'f.pdf') => (await upload(h, name, await invoicePdf(o))).data.item;

test('inbox: an explicit term computes the due date, keeps its original wording, and says where it comes from (validated example: 30/09 + 30 days = 30/10)', withH(async (h) => {
  const it = await ingest(h, { issue: '30/09/2026', terms: ['Paiement à 30 jours'] });
  assert.equal(it.dueDate, '2026-10-30'); assert.equal(it.due.origin, 'COMPUTED_FROM_TERMS'); assert.equal(it.due.legacy, false);
  assert.deepEqual(it.provenance.dueDate, { source: 'computed', path: 'COMPUTED_FROM_TERMS', page: 1, zone: null, text: 'Paiement à 30 jours', value: '2026-10-30', confidence: 0.85 });
  assert.equal(it.extraction.due.terms.raw, 'Paiement à 30 jours'); assert.equal(it.extraction.due.terms.parsed.days, 30); assert.equal(it.extraction.due.terms.grammarVersion, 'pt-1'); assert.equal(it.extraction.due.printed, null);
  assert.equal(it.status, 'TO_REVIEW'); assert.equal(it.due.settlement, 'UNPAID'); assert.equal(it.due.calendar, 'NOT_DUE');
}));

test('inbox: 14 days, 30 days end of month, payable immediately', withH(async (h) => {
  assert.deepEqual([(await ingest(h, { issue: '30/09/2026', number: 'A-1', terms: ['Paiement à 14 jours'] })).dueDate], ['2026-10-14']);
  assert.equal((await ingest(h, { issue: '10/09/2026', number: 'A-2', termsLabel: '30 jours fin de mois' })).dueDate, '2026-10-31');
  const now = await ingest(h, { issue: '30/09/2026', number: 'A-3', terms: ['Payable immédiatement'] });
  assert.equal(now.dueDate, '2026-09-30', 'payable immediately: due date = invoice date'); assert.equal(now.due.origin, 'COMPUTED_FROM_TERMS'); assert.equal(now.provenance.dueDate.text, 'Payable immédiatement', 'the wording that triggered the rule is kept');
}));

test('inbox: a printed due date wins; equal to the computed one it is kept with the computed date as evidence; different, the difference is reported and never hidden', withH(async (h) => {
  const same = await ingest(h, { issue: '30/09/2026', due: '30/10/2026', number: 'B-1', terms: ['Paiement à 30 jours'] });
  assert.deepEqual([same.dueDate, same.due.origin, same.due.divergence, same.due.computed], ['2026-10-30', 'PRINTED', null, '2026-10-30']); assert.ok(!same.extraction.warnings.includes('DUE_DATE_DIFFERS_FROM_TERMS'));
  const diff = await ingest(h, { issue: '30/09/2026', due: '15/11/2026', number: 'B-2', terms: ['Paiement à 30 jours'] });
  assert.deepEqual([diff.dueDate, diff.due.origin, diff.due.printed, diff.due.computed], ['2026-11-15', 'PRINTED', '2026-11-15', '2026-10-30']);
  assert.deepEqual(diff.due.divergence, { printed: '2026-11-15', computed: '2026-10-30', days: 16 }); assert.ok(diff.extraction.warnings.includes('DUE_DATE_DIFFERS_FROM_TERMS'), 'explicit warning');
  assert.equal(diff.status, 'TO_REVIEW', 'a person reviews every document; the divergence is in front of them');
}));

test('inbox: NO invented due date - no condition, unknown condition, prepaid, or no valid invoice date; the merchant\'s own invoicing terms (30 days by default) are never used', withH(async (h) => {
  const seen = {};
  for (const [o, why] of [[{ number: 'C-1' }, 'no condition'], [{ number: 'C-2', termsLabel: 'Selon contrat' }, 'unknown wording'], [{ number: 'C-3', termsLabel: '2/10 net 30' }, 'discount term'], [{ number: 'C-4', terms: ['Payment upfront'] }, 'prepaid'],
    [{ number: 'C-5', termsLabel: '30 jours date de réception' }, 'starting point is not the invoice date'], [{ number: 'C-6', issue: '', terms: ['Paiement à 30 jours'] }, 'no valid invoice date']]) {
    const it = await ingest(h, o); seen[o.number] = it; assert.equal(it.dueDate, null, why); assert.equal(it.due.origin, 'UNKNOWN', why); assert.equal(it.provenance.dueDate, undefined, why); assert.equal(it.due.message.kind === 'NO_DUE_DATE' || it.due.message.kind === 'PREPAID', true, why);
  }
  assert.equal(seen['C-2'].extraction.due.terms.raw, 'Selon contrat', 'the wording stays visible to the person');
  assert.equal(seen['C-4'].due.message.kind, 'PREPAID');
}));

test('inbox: MANUAL reuses the existing provenance mechanism - a person\'s date is never recomputed, clearing it is respected, and a changed invoice date only moves a COMPUTED date', withH(async (h) => {
  const it = await ingest(h, { issue: '30/09/2026', terms: ['Paiement à 30 jours'] }); const id = it.id;
  let r = await h.c.put(`/api/inbox/${id}`, { issueDate: '2026-10-10' }); assert.equal(r.status, 200);
  assert.equal(r.data.dueDate, '2026-11-09', 'a computed date follows the invoice date'); assert.equal(r.data.due.origin, 'COMPUTED_FROM_TERMS'); assert.equal(r.data.provenance.dueDate.value, '2026-11-09'); assert.equal(r.data.extraction.due.issueDate, '2026-10-10');
  r = await h.c.put(`/api/inbox/${id}`, { dueDate: '2026-12-01' }); assert.equal(r.data.dueDate, '2026-12-01'); assert.equal(r.data.provenance.dueDate.source, 'user'); assert.equal(r.data.due.origin, 'MANUAL');
  assert.equal(r.data.due.terms.raw, 'Paiement à 30 jours', 'the evidence is kept'); assert.equal(r.data.extraction.due.effective.origin, 'MANUAL');
  r = await h.c.put(`/api/inbox/${id}`, { issueDate: '2026-11-01' }); assert.equal(r.data.dueDate, '2026-12-01', 'a MANUAL date is never moved'); assert.equal(r.data.due.origin, 'MANUAL');
  r = await h.c.put(`/api/inbox/${id}`, { dueDate: '' }); assert.equal(r.data.dueDate, null); assert.equal(r.data.due.origin, 'UNKNOWN'); assert.equal(r.data.extraction.due.suppressed, true);
  r = await h.c.put(`/api/inbox/${id}`, { issueDate: '2026-11-15' }); assert.equal(r.data.dueDate, null, 'a cleared date is not silently filled back');
}));

test('inbox: a computed due date can never precede the invoice date; a date changed to invalid withdraws the computed date instead of guessing', withH(async (h) => {
  const it = await ingest(h, { issue: '30/09/2026', terms: ['Paiement à 14 jours'] });
  const r = await h.c.put(`/api/inbox/${it.id}`, { issueDate: null }); assert.equal(r.data.dueDate, null); assert.equal(r.data.due.origin, 'UNKNOWN'); assert.equal(r.data.provenance.dueDate, undefined);
}));

test('days remaining through the interface model: future, today, and computed date already before today (overdue) - today injected', withH(async (h) => {
  const it = await ingest(h, { issue: '30/09/2026', terms: ['Paiement à 30 jours'] });   // due 2026-10-30
  const at = async (d) => { h.a.setToday(d); return (await h.c.get(`/api/inbox/${it.id}`)).data.due; };
  let d = await at('2026-10-12'); assert.deepEqual([d.calendar, d.daysRemaining, d.message.kind, d.message.days], ['NOT_DUE', 18, 'DAYS_LEFT', 18]);
  d = await at('2026-10-27'); assert.deepEqual([d.message.kind, d.message.days], ['DUE_SOON', 3]);
  d = await at('2026-10-30'); assert.deepEqual([d.calendar, d.daysRemaining, d.message.kind], ['DUE_TODAY', 0, 'DUE_TODAY']);
  d = await at('2026-11-06'); assert.deepEqual([d.calendar, d.daysRemaining, d.message.kind, d.message.days, d.message.calendar === undefined], ['OVERDUE', -7, 'OVERDUE', 7, true]); assert.equal(d.message.origin, 'COMPUTED_FROM_TERMS');
  assert.equal(d.settlement, 'UNPAID');
}));

test('a validated document is not paid; paying it (existing pay()) settles it and the calendar axis no longer applies', withH(async (h) => {
  const it = await ingest(h, { issue: '30/09/2026', terms: ['Paiement à 30 jours'] });
  let r = await h.c.post(`/api/inbox/${it.id}/validate`, {}); assert.equal(r.status, 200); assert.equal(r.data.status, 'VALIDATED'); assert.equal(r.data.due.settlement, 'UNPAID', 'validated is not paid');
  r = await h.c.post(`/api/inbox/${it.id}/to-pay`, {}); assert.equal(r.data.due.settlement, 'UNPAID', 'to pay is a workflow step, not a payment');
  r = await h.c.post(`/api/inbox/${it.id}/pay`, { paidOn: '2026-10-12', amount: '121.00', reference: 'X' }); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.status, r.data.due.settlement, r.data.due.calendar, r.data.due.message.kind], ['PAID', 'PAID', 'NOT_APPLICABLE', 'PAID']);
}));

// ---------- treasury projection ----------
test('treasury: a computed date enters the projection only when it comes from an explicit term with its wording kept, and stays distinguishable; UNKNOWN never enters', withH(async (h) => {
  const printed = await ingest(h, { issue: '20/09/2026', due: '28/09/2026', number: 'T-1' });               // printed 2026-09-28
  const computed = await ingest(h, { issue: '20/09/2026', number: 'T-2', terms: ['Paiement à 14 jours'] }); // computed 2026-10-04
  const unknown = await ingest(h, { issue: '20/09/2026', number: 'T-3' });                                   // unknown
  for (const it of [printed, computed, unknown]) await h.c.post(`/api/inbox/${it.id}/validate`, {});
  const t = (await h.c.get('/api/treasury?horizon=30')).data;
  assert.equal(t.expected.outgoingCount, 2, 'printed + computed; the unknown one is not a due date'); assert.equal(t.expected.outgoingFromTermsCount, 1, 'the computed one is counted apart');
  assert.equal(t.expected.outgoingFromTermsCents, 12100); assert.equal(t.expected.outgoingCents, 24200);
  const week = (await h.c.get('/api/treasury')).data; assert.equal(week.expected.outgoingCount, 1, 'horizon 7 days from 2026-09-26: the computed 2026-10-04 is not yet in it'); assert.equal(week.expected.outgoingFromTermsCount, 0);
}));

test('treasury: a computed date whose wording is not kept is not reliable and does not enter the projection', async () => {
  const { buildTreasury } = await import('../src/finance/treasury.js'); const { dueForProjection } = await import('../src/finance/payables/index.js');
  const row = { dueDate: '2026-10-04', grossCents: 12100, extraction: { provenance: { dueDate: { source: 'computed', text: '' } } } };
  const p = dueForProjection(row); assert.equal(p.dueDate, null);
  const t = buildTreasury({ asOf: '2026-09-26', horizonDays: 30, bank: null, cashCount: null, receivables: [], payables: [{ invoiceNumber: 'X', supplierName: 'S', dueDate: p.dueDate, dueOrigin: p.origin, grossCents: 12100 }] });
  assert.equal(t.expected.outgoingCount, 0);
});

// ---------- non-regression: existing documents ----------
test('non-regression: a document extracted before 4.7 (no extraction.due, no paymentTerms) keeps its due date, is readable, and its origin is derived without rewriting it', async () => {
  const store = createMemoryStore(); const M = 'm1';
  const inbox = createInboxService({ store, attachments: createMemoryAttachmentStore(), merchantId: M });
  const legacy = await store.saveSupplierInvoice({ merchantId: M, source: 'upload', status: 'TO_REVIEW', supplierName: 'Ancien SRL', invoiceNumber: 'OLD-1', issueDate: '2026-08-01', dueDate: '2026-08-31', netCents: 1000, vatCents: 210, grossCents: 1210, currency: 'EUR', extraction: { extractor: 'pdf_text', at: 'x', fields: {}, warnings: [], provenance: { dueDate: { source: 'PDF_TEXT', path: 'LABEL_DUE_DATE', page: 1 } } } });
  const { dueViewOf } = await import('../src/finance/payables/index.js');
  const v1 = dueViewOf(legacy, { today: '2026-09-26' }); assert.deepEqual([v1.dueDate, v1.origin, v1.legacy, v1.terms, v1.calendar, v1.daysRemaining], ['2026-08-31', 'PRINTED', false, null, 'OVERDUE', -26]);
  const noEvidence = await store.saveSupplierInvoice({ merchantId: M, source: 'manual', status: 'TO_REVIEW', supplierName: 'Manuel SRL', invoiceNumber: 'OLD-2', issueDate: '2026-08-01', dueDate: '2026-08-15', grossCents: 100, currency: 'EUR' });
  const v2 = dueViewOf(noEvidence, { today: '2026-09-26' }); assert.deepEqual([v2.origin, v2.legacy], ['MANUAL', true], 'a date with no recorded reading is not claimed to be printed');
  const edited = await inbox.update(legacy.id, { invoiceNumber: 'OLD-1B' }, { type: 'merchant' }); assert.equal(edited.dueDate, '2026-08-31'); assert.equal(edited.extraction.due, undefined, 'no block is invented on an old record');
  const moved = await inbox.update(legacy.id, { issueDate: '2026-08-05' }, { type: 'merchant' }); assert.equal(moved.dueDate, '2026-08-31', 'a printed date does not move with the invoice date');
  assert.equal((await inbox.update(legacy.id, { dueDate: '2026-09-15' }, { type: 'merchant' })).extraction.provenance.dueDate.source, 'user');
});

test('non-regression: a document without any term is ingested exactly as before (same fields, same warnings, no new key besides an absent block)', withH(async (h) => {
  const it = await ingest(h, { issue: '10/09/2026', due: '10/10/2026', number: 'R-1' });
  assert.deepEqual([it.dueDate, it.due.origin, it.extraction.warnings], ['2026-10-10', 'PRINTED', []]); assert.equal(it.extraction.fields.paymentTerms, undefined); assert.equal(it.extraction.due.terms, null);
}));
