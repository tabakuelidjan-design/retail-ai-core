import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestForCredit, suggestForDebit } from '../src/finance/reconcile.js';

// Currency guard on BOTH sides of the matching: a transaction never matches a document in another currency,
// even with an identical reference and an identical amount. Pure rules, no I/O.
const debit = (over = {}) => ({ id: 't', date: '2026-09-20', amountCents: -7190, currency: 'EUR', counterpartyName: 'Fournisseur X', reference: 'facture FN-7', ...over });
const payable = (over = {}) => ({ itemId: 'p1', invoiceNumber: 'FN-7', supplierName: 'Fournisseur X', grossCents: 7190, paymentReference: '+++090/9337/55493+++', dueDate: '2026-09-25', ...over });
const credit = (over = {}) => ({ id: 't', date: '2026-09-20', amountCents: 7190, currency: 'EUR', counterpartyName: 'Client Exemple SA', reference: 'facture INV-2026-0001', ...over });
const invoice = (over = {}) => ({ documentId: 'd1', number: 'INV-2026-0001', customer: 'Client Exemple SA', remainingCents: 7190, currency: 'EUR', ...over });

test('DEBIT: the same reference and the same amount in EUR match; the same in USD never match (payables are EUR)', () => {
  assert.equal(suggestForDebit(debit(), [payable()]).status, 'PROBABLE', 'baseline: EUR debit matches its EUR payable');
  const usd = suggestForDebit(debit({ currency: 'USD' }), [payable()]);
  assert.equal(usd.status, 'NO_MATCH', 'a USD debit must not match a EUR payable');
  assert.equal(usd.candidates.length, 0);
});

test('DEBIT: a payable carrying its own currency matches only the same currency', () => {
  assert.notEqual(suggestForDebit(debit({ currency: 'USD' }), [payable({ currency: 'EUR' })]).status, 'PROBABLE');
  assert.equal(suggestForDebit(debit({ currency: 'USD' }), [payable({ currency: 'USD' })]).status, 'PROBABLE');
});

test('CREDIT: an invoice in another currency never matches, even with the invoice number in the reference and the exact amount', () => {
  assert.equal(suggestForCredit(credit(), [invoice()]).status, 'PROBABLE', 'baseline: invoice number in the reference and the exact amount');
  assert.equal(suggestForCredit(credit({ currency: 'USD' }), [invoice()]).status, 'NO_MATCH');
});

test('IDENTICAL amounts, references and counterparties in different currencies: no ambiguity is created, nothing is proposed', () => {
  const r = suggestForCredit(credit({ currency: 'USD' }), [invoice(), invoice({ documentId: 'd2', number: 'INV-2026-0002' })]);
  assert.equal(r.status, 'NO_MATCH'); assert.equal(r.candidates.length, 0);
});

test('UNKNOWN transaction currency: a payment with no currency never matches, on either side, even with the exact reference and amount', () => {
  const noCcyDebit = suggestForDebit(debit({ currency: undefined }), [payable()]);
  assert.equal(noCcyDebit.status, 'NO_MATCH', 'a debit with no currency is refused');
  assert.equal(noCcyDebit.candidates.length, 0);
  const noCcyCredit = suggestForCredit(credit({ currency: undefined }), [invoice()]);
  assert.equal(noCcyCredit.status, 'NO_MATCH', 'a credit with no currency is refused');
  assert.equal(noCcyCredit.candidates.length, 0);
  assert.equal(suggestForDebit(debit({ currency: '' }), [payable()]).status, 'NO_MATCH', 'an empty currency is refused too');
});

test('MISSING document currency: a payable or invoice without currency is EUR (the only currency the module carries)', () => {
  assert.equal(suggestForDebit(debit(), [payable({ currency: undefined })]).status, 'PROBABLE', 'EUR debit matches a payable with no currency');
  assert.equal(suggestForDebit(debit({ currency: 'USD' }), [payable({ currency: undefined })]).status, 'NO_MATCH', 'USD debit never matches it');
  assert.equal(suggestForCredit(credit(), [invoice({ currency: undefined })]).status, 'PROBABLE', 'EUR credit matches an invoice with no currency');
  assert.equal(suggestForCredit(credit({ currency: 'USD' }), [invoice({ currency: undefined })]).status, 'NO_MATCH', 'USD credit never matches it');
});
