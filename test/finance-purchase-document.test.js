// Document intelligence, phase 1: the common purchase-document model, the UBL / Peppol reader, credit notes (positive amounts +
// accounting sign), VAT by rate, identifiers, lines, deterministic checks, per-field provenance and confidence.
// SYNTHETIC documents only: invented supplier, invented numbers, synthetic identifiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOCUMENT_TYPES, XmlError, accountingSign, checkPurchaseDocument, documentTypeOf, extractUbl, parseXml, purchaseModelOf, readUblDocument } from '../src/finance/purchase-document.js';
import { eurOfSupplier, sumEur } from '../src/finance/currency.js';
import { validationErrorsFor } from '../src/finance/inbox.js';
import { startApp } from './finance-dashboard-helpers.js';

const NS = 'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"';
const sub = (taxable, vat, pct, cat = 'S', extra = '') => `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">${taxable}</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">${vat}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${cat}</cbc:ID><cbc:Percent>${pct}</cbc:Percent>${extra}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`;
const line = (root, id, name, qty, net, pct, price) => `<cac:${root}Line><cbc:ID>${id}</cbc:ID><cbc:${root === 'Invoice' ? 'Invoiced' : 'Credited'}Quantity unitCode="C62">${qty}</cbc:${root === 'Invoice' ? 'Invoiced' : 'Credited'}Quantity><cbc:LineExtensionAmount currencyID="EUR">${net}</cbc:LineExtensionAmount><cac:Item><cbc:Name>${name}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>${pct}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="EUR">${price}</cbc:PriceAmount></cac:Price></cac:${root}Line>`;
/** A Peppol BIS 3.0 style document. Every part can be overridden to build the incoherent cases. */
function doc(o = {}) {
  const root = o.root ?? 'Invoice';
  const typeCode = root === 'Invoice' ? `<cbc:InvoiceTypeCode>${o.typeCode ?? '380'}</cbc:InvoiceTypeCode>` : '<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>';
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" ${NS}>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ID>${o.id ?? 'F-2026-0100'}</cbc:ID><cbc:IssueDate>2026-09-10</cbc:IssueDate>${root === 'Invoice' ? '<cbc:DueDate>2026-10-10</cbc:DueDate>' : ''}${typeCode}<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  ${o.order === false ? '' : '<cac:OrderReference><cbc:ID>PO-7781</cbc:ID></cac:OrderReference>'}
  ${o.billing ?? ''}
  <cac:AccountingSupplierParty><cac:Party><cbc:EndpointID schemeID="0208">0000000097</cbc:EndpointID><cac:PartyName><cbc:Name>Exemple</cbc:Name></cac:PartyName>
    <cac:PartyTaxScheme><cbc:CompanyID>${o.vatNumber ?? 'BE0000000097'}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>Fournisseur Exemple &amp; Fils SRL</cbc:RegistrationName>${o.legalId === false ? '' : `<cbc:CompanyID schemeID="0208">${o.enterprise ?? '0000000097'}</cbc:CompanyID>`}</cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>Client Exemple</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
  <cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode><cbc:PaymentID>+++000/0000/00097+++</cbc:PaymentID><cac:PayeeFinancialAccount><cbc:ID>${o.iban ?? 'BE68 5390 0754 7034'}</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">${o.vat ?? '21.00'}</cbc:TaxAmount>${o.subtotals ?? sub('100.00', '21.00', '21')}</cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">${o.lineExt ?? o.net ?? '100.00'}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">${o.net ?? '100.00'}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">${o.gross ?? '121.00'}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">${o.payable ?? o.gross ?? '121.00'}</cbc:PayableAmount></cac:LegalMonetaryTotal>
  ${o.lines ?? line(root, '1', 'Gourde isotherme 500 ml', '4', '60.00', '21', '15.00') + line(root, '2', 'Gravure laser', '4', '40.00', '21', '10.00')}
</${root}>`, 'utf8');
}
const values = (ex) => Object.fromEntries(Object.entries(ex.fields).map(([k, v]) => [k, v.value]));

test('invoice at 21 %: every field of the common model is read, with its source, path and confidence', () => {
  const ex = readUblDocument(doc()); const v = values(ex);
  assert.equal(ex.extractor, 'ubl'); assert.deepEqual(ex.warnings, []);
  assert.equal(v.documentType, 'INVOICE'); assert.equal(v.invoiceNumber, 'F-2026-0100'); assert.equal(v.issueDate, '2026-09-10'); assert.equal(v.dueDate, '2026-10-10'); assert.equal(v.currency, 'EUR');
  assert.equal(v.supplierName, 'Fournisseur Exemple & Fils SRL', 'entities decoded, registration name preferred to the trading name');
  assert.equal(v.supplierVatNumber, 'BE0000000097'); assert.equal(v.supplierEnterpriseNumber, '0000.000.097'); assert.equal(v.supplierIban, 'BE68539007547034'); assert.equal(v.orderReference, 'PO-7781'); assert.equal(v.paymentReference, '+++000/0000/00097+++');
  assert.deepEqual([v.netCents, v.vatCents, v.grossCents, v.lineExtensionCents, v.payableCents], [10000, 2100, 12100, 10000, 12100]);
  assert.deepEqual(v.vatBreakdown, [{ taxableCents: 10000, vatCents: 2100, rateBp: 2100, category: 'S', exemptionReason: null }]);
  assert.equal(v.lines.length, 2); assert.deepEqual(v.lines[0], { position: 1, id: '1', description: 'Gourde isotherme 500 ml', quantity: '4', unitCode: 'C62', unitPrice: '15.00', netCents: 6000, rateBp: 2100, category: 'S' });
  assert.deepEqual(ex.fields.supplierIban, { value: 'BE68539007547034', confidence: 0.95, source: 'ubl', path: 'Invoice/PaymentMeans/PayeeFinancialAccount/ID', page: null, zone: null });
  assert.equal(ex.fields.supplierEnterpriseNumber.path, 'Invoice/AccountingSupplierParty/Party/PartyLegalEntity/CompanyID');
  assert.equal(ex.fields.netCents.path, 'Invoice/LegalMonetaryTotal/TaxExclusiveAmount');
  for (const f of Object.values(ex.fields)) assert.ok(f.confidence > 0 && f.confidence <= 1 && f.source === 'ubl' && f.path.startsWith('Invoice/'));
  assert.deepEqual(checkPurchaseDocument(v), { errors: [], warnings: [], fieldsAffected: [] });
});

test('several VAT rates and a zero-rated part: broken down by rate, checked rate by rate', () => {
  const x = doc({ net: '300.00', vat: '27.00', gross: '327.00', subtotals: sub('100.00', '6.00', '6') + sub('100.00', '21.00', '21') + sub('100.00', '0.00', '0', 'Z'),
    lines: line('Invoice', '1', 'Livre', '1', '100.00', '6', '100.00') + line('Invoice', '2', 'Coque', '1', '100.00', '21', '100.00') + line('Invoice', '3', 'Export', '1', '100.00', '0', '100.00') });
  const v = values(readUblDocument(x));
  assert.deepEqual(v.vatBreakdown.map((b) => [b.rateBp, b.taxableCents, b.vatCents, b.category]), [[600, 10000, 600, 'S'], [2100, 10000, 2100, 'S'], [0, 10000, 0, 'Z']]);
  assert.deepEqual(checkPurchaseDocument(v).warnings, []);
  // exempt document: 0 VAT, exemption reason kept
  const ex = values(readUblDocument(doc({ vat: '0.00', gross: '100.00', subtotals: sub('100.00', '0.00', '0', 'E', '<cbc:TaxExemptionReason>Exonération art. 44</cbc:TaxExemptionReason>') })));
  assert.equal(ex.vatCents, 0); assert.equal(ex.vatBreakdown[0].exemptionReason, 'Exonération art. 44'); assert.deepEqual(checkPurchaseDocument(ex).errors, []);
});

test('credit note: CREDIT_NOTE with POSITIVE amounts, the credited invoice, credited lines, and a -1 accounting sign', () => {
  const x = doc({ root: 'CreditNote', id: 'NC-2026-0007', billing: '<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>F-2026-0100</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>' });
  const ex = readUblDocument(x); const v = values(ex);
  assert.equal(v.documentType, 'CREDIT_NOTE'); assert.equal(ex.fields.documentType.path, 'CreditNote/CreditNoteTypeCode');
  assert.deepEqual([v.netCents, v.vatCents, v.grossCents], [10000, 2100, 12100], 'stored positive');
  assert.equal(v.billingReference, 'F-2026-0100'); assert.equal(v.lines.length, 2); assert.equal(v.lines[1].quantity, '4');
  assert.deepEqual(ex.warnings, []); assert.deepEqual(checkPurchaseDocument(v).warnings, []);
  assert.equal(accountingSign(v), -1); assert.equal(accountingSign({ documentType: 'INVOICE' }), 1);
  // a credit note that does not say what it credits is pointed out, not refused
  assert.deepEqual(checkPurchaseDocument(values(readUblDocument(doc({ root: 'CreditNote' })))).warnings, ['CREDIT_NOTE_WITHOUT_INVOICE_REFERENCE']);
  // an Invoice root with type code 381 is a credit note too
  assert.equal(values(readUblDocument(doc({ typeCode: '381' }))).documentType, 'CREDIT_NOTE');
});

test('a NEGATIVE invoice is read as a credit note with positive amounts, low confidence, and flagged: nothing negative is stored', () => {
  const ex = readUblDocument(doc({ net: '-100.00', vat: '-21.00', gross: '-121.00', subtotals: sub('-100.00', '-21.00', '21'), lines: line('Invoice', '1', 'Retour', '-1', '-100.00', '21', '100.00') }));
  const v = values(ex);
  assert.equal(v.documentType, 'CREDIT_NOTE'); assert.ok(ex.warnings.includes('NEGATIVE_INVOICE_READ_AS_CREDIT_NOTE'));
  assert.deepEqual([v.netCents, v.vatCents, v.grossCents, v.vatBreakdown[0].taxableCents, v.vatBreakdown[0].vatCents, v.lines[0].netCents], [10000, 2100, 12100, 10000, 2100, 10000]);
  assert.equal(ex.fields.documentType.confidence, 0.5); assert.equal(ex.fields.grossCents.confidence, 0.5);
});

test('incoherent documents: every inconsistency is found deterministically and lowers the confidence of the fields concerned', () => {
  // VAT breakdown does not match the VAT total, per-rate VAT is wrong, lines do not add up, amount to pay differs
  const ex = readUblDocument(doc({ vat: '25.00', gross: '125.00', subtotals: sub('100.00', '25.00', '21'), lines: line('Invoice', '1', 'A', '1', '70.00', '21', '70.00'), payable: '100.00' }));
  const c = checkPurchaseDocument(values(ex));
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.warnings.sort(), ['LINES_DO_NOT_ADD_UP', 'PAYABLE_DIFFERS_FROM_TOTAL', 'VAT_RATE_AMOUNT_MISMATCH']);
  assert.ok(ex.fields.vatBreakdown.confidence <= 0.5 && ex.fields.lines.confidence <= 0.5 && ex.fields.grossCents.confidence <= 0.5); assert.equal(ex.fields.supplierName.confidence, 0.98, 'unrelated fields keep their confidence');
  // breakdown vs header totals
  const c2 = checkPurchaseDocument(values(readUblDocument(doc({ subtotals: sub('90.00', '18.90', '21') }))));
  assert.deepEqual(c2.warnings.sort(), ['VAT_BREAKDOWN_DOES_NOT_MATCH_VAT', 'VAT_BREAKDOWN_TAXABLE_DOES_NOT_MATCH_NET']);
  // net + VAT != total keeps the historical rule
  const c3 = readUblDocument(doc({ vat: '25.00', subtotals: sub('100.00', '25.00', '25') })); assert.ok(c3.warnings.includes('TOTALS_DO_NOT_ADD_UP')); assert.equal(c3.fields.netCents.confidence, 0.4);
  assert.ok(checkPurchaseDocument(values(c3)).warnings.includes('VAT_RATE_UNUSUAL_FOR_BELGIUM'));
  // one cent of rounding per rate is accepted
  assert.deepEqual(checkPurchaseDocument({ vatBreakdown: [{ taxableCents: 3333, vatCents: 701, rateBp: 2100 }] }).warnings, []);
});

test('identifiers: an invalid IBAN, enterprise number or Belgian VAT number blocks validation; a foreign VAT number is kept as written', () => {
  const base = { supplierName: 'X', invoiceNumber: '1', issueDate: '2026-09-01', netCents: 100, vatCents: 21, grossCents: 121, currency: 'EUR' };
  assert.deepEqual(validationErrorsFor(base), []);
  assert.deepEqual(validationErrorsFor({ ...base, supplierIban: 'BE00 0000 0000 0000' }), ['SUPPLIER_IBAN_INVALID']);
  assert.deepEqual(validationErrorsFor({ ...base, supplierEnterpriseNumber: '0000.000.098' }), ['SUPPLIER_ENTERPRISE_NUMBER_INVALID']);
  assert.deepEqual(validationErrorsFor({ ...base, supplierVatNumber: 'BE0000000098' }), ['SUPPLIER_VAT_NUMBER_INVALID']);
  assert.deepEqual(validationErrorsFor({ ...base, supplierVatNumber: 'DE123456789' }), [], 'foreign VAT numbers are not checked');
  assert.deepEqual(validationErrorsFor({ ...base, documentType: 'BILL' }), ['DOCUMENT_TYPE_INVALID']);
  assert.deepEqual(checkPurchaseDocument({ supplierVatNumber: 'BE0000000097', supplierEnterpriseNumber: '0000.000.196' }).warnings, ['VAT_AND_ENTERPRISE_NUMBER_DIFFER']);
  // read from the document: a bad one is kept as read (so the person sees it) with low confidence
  const ex = readUblDocument(doc({ iban: 'BE00 0000 0000 0000', enterprise: '0000000098' }));
  assert.equal(ex.fields.supplierIban.confidence, 0.5); assert.equal(ex.fields.supplierEnterpriseNumber.value, '0000000098'); assert.ok(ex.fields.supplierEnterpriseNumber.confidence <= 0.5);
  // enterprise number from the Peppol endpoint (scheme 0208) when the legal entity carries none
  const e2 = readUblDocument(doc({ legalId: false })); assert.equal(e2.fields.supplierEnterpriseNumber.value, '0000.000.097'); assert.equal(e2.fields.supplierEnterpriseNumber.path, 'Invoice/AccountingSupplierParty/Party/EndpointID');
});

test('XML safety: DOCTYPE / entities are refused, malformed or foreign XML yields nothing rather than a guess', () => {
  const xxe = '<?xml version="1.0"?><!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///etc/passwd">]><Invoice><cbc:ID>&x;</cbc:ID></Invoice>';
  assert.throws(() => parseXml(xxe), (e) => e instanceof XmlError && e.code === 'XML_DOCTYPE_NOT_ALLOWED');
  assert.deepEqual(readUblDocument(Buffer.from(xxe)), { extractor: 'ubl', fields: {}, warnings: ['XML_DOCTYPE_NOT_ALLOWED'] });
  assert.deepEqual(extractUbl('<Invoice><ID>1</Invoice>').warnings, ['XML_MALFORMED']);
  assert.deepEqual(extractUbl('<Invoice/><Invoice/>').warnings, ['XML_MULTIPLE_ROOTS']);
  assert.deepEqual(extractUbl('<Order><ID>1</ID></Order>'), { extractor: 'ubl', fields: {}, warnings: ['NOT_A_UBL_INVOICE_OR_CREDIT_NOTE'] });
  const t = parseXml('<a x="1 > 0" y=\'q\'><!-- c --><b><![CDATA[<raw> & text]]></b><c>&#233;&#x20AC;&lt;</c><d/></a>');
  assert.deepEqual([t.attrs, t.children.map((c) => c.name), t.children[0].text, t.children[1].text], [{ x: '1 > 0', y: 'q' }, ['b', 'c', 'd'], '<raw> & text', 'é€<']);
  let deep = ''; for (let i = 0; i < 70; i += 1) deep += '<x>'; assert.throws(() => parseXml(deep), /XML_TOO_DEEP/);
});

test('accounting direction: stored amounts stay positive, a credit note is subtracted in EUR totals through its type only', () => {
  const inv = { documentType: 'INVOICE', grossCents: 12100, currency: 'EUR' }; const cn = { documentType: 'CREDIT_NOTE', grossCents: 2100, currency: 'EUR' };
  assert.equal(eurOfSupplier(inv), 12100); assert.equal(eurOfSupplier(cn), -2100); assert.equal(sumEur([inv, cn]), 10000);
  assert.equal(eurOfSupplier({ ...cn, currency: 'USD', extraction: { capture: { kind: 'expense', eurAmountCents: 500 } } }), -500);
  assert.equal(eurOfSupplier({ ...cn, currency: 'USD' }), null, 'foreign currency still left out');
  // records written before the model existed
  assert.equal(documentTypeOf({}), 'INVOICE'); assert.equal(documentTypeOf({ extraction: { capture: { kind: 'expense' } } }), 'RECEIPT'); assert.equal(accountingSign({}), 1);
  assert.deepEqual(DOCUMENT_TYPES, ['INVOICE', 'CREDIT_NOTE', 'RECEIPT', 'EXPENSE']);
  assert.deepEqual(purchaseModelOf({ extraction: { provenance: { lineExtensionCents: { value: 5 } } } }).lineExtensionCents, 5);
});

// ---------- through the API, end to end ----------
async function harness() { const a = await startApp(); return { a, c: await a.authed(), close: () => a.close() }; }
const withH = (fn) => async () => { const h = await harness(); try { await fn(h); } finally { await h.close(); } };
const upload = (h, name, buf) => h.c.post('/api/inbox/upload', { fileName: name, dataBase64: buf.toString('base64') });

test('HTTP: an uploaded UBL invoice stores the whole model, with provenance; it stays TO_REVIEW and no contact is created', withH(async (h) => {
  const before = (await h.c.get('/api/contacts')).data.rows.length;
  const r = await upload(h, 'facture.xml', doc()); assert.equal(r.status, 201); const it = r.data.item;
  assert.equal(it.status, 'TO_REVIEW'); assert.equal(it.documentType, 'INVOICE'); assert.equal(it.accountingSign, 1);
  assert.deepEqual([it.supplierEnterpriseNumber, it.supplierIban, it.orderReference, it.billingReference], ['0000.000.097', 'BE68539007547034', 'PO-7781', null]);
  assert.equal(it.vatBreakdown.length, 1); assert.equal(it.lines.length, 2); assert.deepEqual(it.errors, []); assert.deepEqual(it.checks, []);
  assert.deepEqual(it.provenance.supplierIban, { source: 'ubl', path: 'Invoice/PaymentMeans/PayeeFinancialAccount/ID', page: null, zone: null, confidence: 0.95, value: 'BE68539007547034' });
  assert.deepEqual(it.provenance.lines, { source: 'ubl', path: 'Invoice/InvoiceLine', page: null, zone: null, confidence: 0.98, count: 2 });
  assert.equal(it.provenance.lineExtensionCents.value, 10000); assert.equal(it.extraction.fields.lineExtensionCents, undefined, 'reference-only totals are not review fields');
  assert.equal(typeof it.extraction.fields.supplierIban, 'number', 'extraction.fields keeps one confidence number per field (existing UI contract)');
  assert.equal(it.supplierCompanyId, null); assert.equal((await h.c.get('/api/contacts')).data.rows.length, before, 'no supplier contact is ever created automatically');
}));

test('HTTP: a supplier credit note is validated with positive amounts, reduces purchases, and is never "to pay"', withH(async (h) => {
  const inv = (await upload(h, 'f.xml', doc())).data.item;
  const cn = (await upload(h, 'nc.xml', doc({ root: 'CreditNote', id: 'F-2026-0100', net: '20.00', vat: '4.20', gross: '24.20', subtotals: sub('20.00', '4.20', '21'), lines: line('CreditNote', '1', 'Retour', '1', '20.00', '21', '20.00'),
    billing: '<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>F-2026-0100</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>' }))).data.item;
  assert.equal(cn.documentType, 'CREDIT_NOTE'); assert.equal(cn.accountingSign, -1); assert.equal(cn.grossCents, 2420); assert.equal(cn.billingReference, 'F-2026-0100');
  assert.equal((await h.c.post(`/api/inbox/${inv.id}/validate`, {})).status, 200);
  assert.equal((await h.c.post(`/api/inbox/${cn.id}/validate`, {})).status, 200, 'same number as the invoice it credits is not a duplicate: different type');
  const bd = (await h.c.get('/api/overview/expense-breakdown')).data; assert.equal(bd.total, 12100 - 2420, 'purchases = invoice - credit note');
  const tp = await h.c.post(`/api/inbox/${cn.id}/to-pay`, {}); assert.equal(tp.status, 409); assert.match(JSON.stringify(tp.data), /CREDIT_NOTE_IS_NOT_PAYABLE/);
  assert.equal((await h.c.post(`/api/inbox/${inv.id}/to-pay`, {})).status, 200);
  assert.equal((await h.c.get('/api/inbox/status')).data.counts.toPayCents, 12100, 'amounts to pay are unchanged by the credit note');
}));

test('HTTP: a correction is recorded as coming from the person (the extracted value is kept), invalid values are refused, old records still work', withH(async (h) => {
  const it = (await upload(h, 'f.xml', doc({ iban: 'BE00 0000 0000 0000' }))).data.item;
  assert.deepEqual(it.errors, ['SUPPLIER_IBAN_INVALID']);
  assert.equal((await h.c.post(`/api/inbox/${it.id}/validate`, {})).status, 409);
  assert.equal((await h.c.put(`/api/inbox/${it.id}`, { documentType: 'BILL' })).status, 422);
  const r = await h.c.put(`/api/inbox/${it.id}`, { supplierIban: 'be68 5390 0754 7034', documentType: 'invoice' }); assert.equal(r.status, 200);
  assert.equal(r.data.supplierIban, 'BE68539007547034'); assert.deepEqual(r.data.errors, []);
  assert.equal(r.data.provenance.supplierIban.source, 'user'); assert.equal(r.data.provenance.supplierIban.extracted.value, 'BE00 0000 0000 0000'.replace(/\s/g, ''));
  assert.equal(r.data.provenance.documentType.source, 'ubl', 'an unchanged field keeps its provenance');
  const again = await h.c.put(`/api/inbox/${it.id}`, { supplierIban: 'BE68539007547034' }); assert.equal(again.data.provenance.supplierIban.extracted.value, 'BE00 0000 0000 0000'.replace(/\s/g, ''), 'the first extracted value survives later edits');
  // manual entry (no document): type chosen by the person, defaults to invoice
  const man = await h.c.post('/api/inbox/manual', { supplierName: 'Fournisseur Manuel SA', invoiceNumber: 'M-9', issueDate: '2026-09-01', net: '10.00', vat: '2.10', gross: '12.10', currency: 'EUR' });
  assert.equal(man.data.documentType, 'INVOICE'); assert.deepEqual(man.data.provenance, {}); assert.deepEqual(man.data.vatBreakdown, []);
  const nc = await h.c.post('/api/inbox/manual', { documentType: 'CREDIT_NOTE', supplierName: 'Fournisseur Manuel SA', invoiceNumber: 'NC-1', issueDate: '2026-09-02', net: '1.00', vat: '0.21', gross: '1.21', currency: 'EUR' });
  assert.equal(nc.data.documentType, 'CREDIT_NOTE');
  assert.equal((await h.c.post('/api/inbox/manual', { net: '-1.00' })).status, 422, 'negative amounts are still refused: use a credit note');
}));

test('migration: additive only, positive amounts enforced, captured receipts typed explicitly', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260926160000_finance_purchase_document_model.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
  assert.doesNotMatch(sql, /drop\s+(column|table)|rename/i);
  assert.match(sql, /add column document_type text not null default 'INVOICE' check \(document_type in \('INVOICE', 'CREDIT_NOTE', 'RECEIPT', 'EXPENSE'\)\)/);
  for (const c of ['supplier_enterprise_number text', 'supplier_iban text', 'order_reference text', 'billing_reference text', 'vat_breakdown jsonb', 'lines jsonb']) assert.ok(sql.includes(`add column ${c}`), c);
  assert.match(sql, /coalesce\(net_cents, 0\) >= 0 and coalesce\(vat_cents, 0\) >= 0 and coalesce\(gross_cents, 0\) >= 0/);
  assert.match(sql, /set document_type = 'RECEIPT' where coalesce\(\(extraction -> 'capture' ->> 'kind'\) = 'expense', false\)/);
  const store = readFileSync(new URL('../src/finance/supabase-store.js', import.meta.url), 'utf8');
  for (const col of ['document_type', 'supplier_enterprise_number', 'supplier_iban', 'order_reference', 'billing_reference', 'vat_breakdown', 'lines']) assert.ok(store.includes(`'${col}'`), col);
});

test('local only: the document model never calls the network or an external provider', () => {
  const src = readFileSync(new URL('../src/finance/purchase-document.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /fetch\(|https?:\/\/|require\(|child_process|openai|anthropic|mistral|google/i);
});

test('UI: the review pane renders for a document that is not a capture (captureInfoNode returns null for it)', () => {
  const ws = readFileSync(new URL('../src/finance/ui/views-workspace.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ws, /body\.appendChild\(captureInfoNode\(it\)\)/, 'appendChild(null) threw and left the pane without fields or actions');
  assert.match(ws, /const capInfo = captureInfoNode\(it\); if \(capInfo\) body\.appendChild\(capInfo\);/);
  assert.match(ws, /'data-field': 'documentType'/); assert.match(ws, /if \(it\.documentType !== 'CREDIT_NOTE'\) act\.appendChild/);
});
