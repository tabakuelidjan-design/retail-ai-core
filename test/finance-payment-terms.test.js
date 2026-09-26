// Phase 4.7: the closed grammar of supplier payment terms. Synthetic wordings only. Pure functions, no clock, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GRAMMAR_VERSION, parsePaymentTerms, termSignature } from '../src/finance/payables/payment-terms.js';

const ok = (text, labelled, expected) => {
  const r = parsePaymentTerms(text, { labelled });
  assert.equal(r.status, 'PARSED', `${text} -> ${r.status}`); assert.equal(r.grammarVersion, GRAMMAR_VERSION);
  assert.deepEqual({ kind: r.parsed.kind, days: r.parsed.days, endOfMonth: r.parsed.endOfMonth, referencePoint: r.parsed.referencePoint }, expected, text);
  return r;
};
const not = (text, labelled, status) => { const r = parsePaymentTerms(text, { labelled }); assert.equal(r.status, status, `${text} (labelled=${labelled}) -> ${r.status}`); assert.equal(r.parsed, null, text); };

test('payable immediately, in every supported language: the due date is the invoice date (days = 0)', () => {
  for (const t of ['Payable immédiatement', 'Paiement comptant', 'Payable à réception de facture', 'Onmiddellijk betaalbaar', 'Betaalbaar bij ontvangst', 'Due on receipt', 'Payable immediately', 'Immediate payment'])
    ok(t, false, { kind: 'IMMEDIATE', days: 0, endOfMonth: false, referencePoint: 'INVOICE_DATE' });
});

test('net N days: 14 and 30 days, in FR / NL / EN wordings, with or without a label', () => {
  for (const [t, n] of [['Paiement à 14 jours', 14], ['Payable à 30 jours', 30], ['30 jours net', 30], ['Betaalbaar binnen 14 dagen', 14], ['Betaling binnen 30 dagen', 30], ['Net 30', 30], ['Payable within 14 days', 14], ['Payment due in 30 days', 30], ['Net 14', 14]])
    ok(t, false, { kind: 'NET_DAYS', days: n, endOfMonth: false, referencePoint: 'INVOICE_DATE' });
  for (const [t, n] of [['30 jours', 30], ['14 dagen', 14], ['30 days', 30], ['30j', 30], ['14 d net', 14]]) ok(t, true, { kind: 'NET_DAYS', days: n, endOfMonth: false, referencePoint: 'INVOICE_DATE' });
});

test('30 days end of month (and its NL / EN / abbreviated forms)', () => {
  for (const t of ['30 jours fin de mois', 'Paiement à 30 jours fin de mois', '30 jours FDM', '30 dagen einde maand', 'Net 30 days end of month', 'Payable 30 days EOM'])
    ok(t, true, { kind: 'NET_DAYS_END_OF_MONTH', days: 30, endOfMonth: true, referencePoint: 'INVOICE_DATE' });
});

test('the starting point: the invoice date (stated or by convention) is computable; receipt / delivery / other events are not', () => {
  assert.equal(ok('Payable à 30 jours date de facture', false, { kind: 'NET_DAYS', days: 30, endOfMonth: false, referencePoint: 'INVOICE_DATE' }).parsed.referenceExplicit, true);
  assert.equal(ok('Paiement à 30 jours', false, { kind: 'NET_DAYS', days: 30, endOfMonth: false, referencePoint: 'INVOICE_DATE' }).parsed.referenceExplicit, false, 'the convention is visible, not hidden');
  for (const t of ['30 jours date de réception', '30 dagen na ontvangst', '30 days from delivery', '30 jours après livraison', 'Payable à la livraison', 'Due on delivery']) not(t, true, 'OUT_OF_GRAMMAR');
});

test('payment made in advance / at the source is recognised (no due date follows from it)', () => {
  for (const t of ['Payment upfront', 'PAYMENT UPFRONT', 'Paiement anticipé', 'Payé', 'Betaald', 'Paid']) assert.equal(parsePaymentTerms(t).parsed.kind, 'PREPAID', t);
});

test('an unknown wording is never interpreted: discounts, deposits, contracts, percentages, out-of-range days', () => {
  for (const t of ['2/10 net 30', '30 jours net avec escompte 2 %', 'Acompte 50 % puis solde à 30 jours', 'Selon contrat', 'As agreed', 'Volgens contract', 'Payable en 3 tranches', '400 jours', 'Paiement à 1000 jours']) not(t, true, 'OUT_OF_GRAMMAR');
  not('Payer sous 30 jours ou 60 jours', true, 'AMBIGUOUS'); not('Payable immédiatement ou à 30 jours', true, 'AMBIGUOUS');
});

test('an unlabelled text must be a short whole phrase with a payment cue: warranties, returns, quotes and delivery times are not payment terms', () => {
  for (const t of ['30 jours', '14 days', 'Garantie 30 jours', 'Retour sous 30 jours', 'Delivery within 14 days', 'Offre valable 30 jours', 'Levering binnen 14 dagen']) not(t, false, 'NOT_A_TERM');
  not(`Paiement à 30 jours ${'x'.repeat(80)}`, false, 'NOT_A_TERM');
  not('', false, 'NOT_A_TERM'); not(null, true, 'NOT_A_TERM');
});

test('a term is never invented from nothing: no number of days exists in the grammar', () => {
  for (const t of ['Merci pour votre commande', 'Thank you for your business', 'Please pay promptly', 'Bedankt voor uw bestelling']) assert.notEqual(parsePaymentTerms(t, { labelled: true }).status, 'PARSED', t);
});

test('termSignature: the same term in different words has the same signature', () => {
  const a = parsePaymentTerms('Paiement à 30 jours').parsed; const b = parsePaymentTerms('Net 30').parsed; const c = parsePaymentTerms('Net 14').parsed; const d = parsePaymentTerms('30 jours fin de mois', { labelled: true }).parsed;
  assert.equal(termSignature(a), termSignature(b)); assert.notEqual(termSignature(a), termSignature(c)); assert.notEqual(termSignature(a), termSignature(d)); assert.equal(termSignature(null), '');
});
