import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUbl, prepareTransmission } from '../src/finance/peppol.js';
import { structuredCommunication } from '../src/finance/pdf.js';
import { suggestForCredit } from '../src/finance/reconcile.js';
import { issueInvoice, makeService, MERCHANT_ACTOR, AGENT_ACTOR, CUSTOMER, LINES, VAT_OK } from './finance-fixtures.js';

// SYNTHETIC documents only (fixtures): invented companies, invented numbers.

test('the reference printed on the invoice PDF is the PaymentID of the XML (same structured communication)', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc);
  const ref = structuredCommunication(inv.number);
  const structured = prepareTransmission(inv, { defaultBuyerReference: 'document_number', paymentReference: ref });
  assert.equal(structured.status, 'PREPARED');
  assert.match(structured.payloadXml, /<cbc:PaymentID>\+\+\+\d{3}\/\d{4}\/\d{5}\+\+\+<\/cbc:PaymentID>/);
  assert.ok(structured.payloadXml.includes(`<cbc:PaymentID>${ref}</cbc:PaymentID>`));
  const plain = prepareTransmission(inv, { defaultBuyerReference: 'document_number' });
  assert.doesNotMatch(plain.payloadXml, /<cbc:PaymentID>/, 'no PaymentID unless a reference is passed');
});

test('credit note: CreditNote root, references the original invoice, and carries no PaymentID or due date', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc);
  const cn0 = await svc.createCreditNote(inv.id, { reason: 'retour partiel', lines: [{ description: 'Item A', quantity: '1', unitPrice: '10.00', vatRate: '21' }], restock: false }, MERCHANT_ACTOR);
  await svc.submit(cn0.id, AGENT_ACTOR);
  const cn = await svc.decide(cn0.id, 'APPROVE', MERCHANT_ACTOR);
  const xml = buildUbl(cn, { originalNumber: inv.number, defaultBuyerReference: 'document_number' });
  assert.match(xml, /<CreditNote /);
  assert.match(xml, /<cac:InvoiceDocumentReference><cbc:ID>INV-2026-0001<\/cbc:ID><\/cac:InvoiceDocumentReference>/);
  assert.match(xml, /<cbc:CreditNoteTypeCode>381<\/cbc:CreditNoteTypeCode>/);
  assert.doesNotMatch(xml, /<cbc:PaymentID>/);
  assert.equal(cn.totals.grossCents, 1210);
  assert.match(xml, /<cbc:TaxInclusiveAmount currencyID="EUR">12\.10<\/cbc:TaxInclusiveAmount>/);
});

test('invoice totals in the XML equal the totals Nordla computed (no recalculation in the XML layer)', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc);
  const xml = buildUbl(inv, { defaultBuyerReference: 'document_number' });
  assert.match(xml, /<cbc:TaxExclusiveAmount currencyID="EUR">65\.00<\/cbc:TaxExclusiveAmount>/);
  assert.match(xml, /<cbc:TaxInclusiveAmount currencyID="EUR">71\.90<\/cbc:TaxInclusiveAmount>/);
  assert.equal(inv.totals.netCents, 6500);
  assert.equal(inv.totals.grossCents, 7190);
  assert.equal(CUSTOMER.vatNumber, 'BE0000000196');
  assert.equal(LINES.length, 2);
  assert.equal(VAT_OK.regime, 'domestic');
});

// ---- reconciliation (deterministic, nothing applied) ----
const open = (over) => ({ documentId: 'd', number: 'INV-2026-0001', customer: 'Client Exemple SA', remainingCents: 7190, currency: 'EUR', ...over });
const credit = (over) => ({ id: 't1', date: '2026-11-10', amountCents: 7190, currency: 'EUR', counterpartyName: 'Client Exemple SA', reference: '', structuredReference: null, ...over });

test('reconciliation: structured reference + exact amount -> EXACT', () => {
  const ogm = structuredCommunication('INV-2026-0001');
  const r = suggestForCredit(credit({ reference: ogm }), [open()]);
  assert.equal(r.status, 'EXACT');
  assert.equal(r.candidates[0].number, 'INV-2026-0001');
});

test('reconciliation: partial payment -> PARTIAL with the shortfall, never recorded as paid in full', () => {
  const r = suggestForCredit(credit({ amountCents: 5000, reference: structuredCommunication('INV-2026-0001') }), [open()]);
  assert.equal(r.status, 'PARTIAL');
  assert.equal(r.shortfallCents, 2190);
});

test('reconciliation: two invoices fit equally well -> AMBIGUOUS, a person chooses', () => {
  const r = suggestForCredit(credit({ reference: '' }), [open({ documentId: 'a', number: 'INV-2026-0001' }), open({ documentId: 'b', number: 'INV-2026-0002' })]);
  assert.equal(r.status, 'AMBIGUOUS');
  assert.equal(r.candidates.length, 2);
});

test('reconciliation: a payment in another currency never matches an EUR invoice', () => {
  const r = suggestForCredit(credit({ currency: 'USD', reference: structuredCommunication('INV-2026-0001') }), [open()]);
  assert.equal(r.status, 'NO_MATCH');
});

test('reconciliation: no reference and no amount/name agreement -> NO_MATCH, not a guess', () => {
  const r = suggestForCredit(credit({ amountCents: 123, counterpartyName: 'Autre', reference: '' }), [open()]);
  assert.equal(r.status, 'NO_MATCH');
});
