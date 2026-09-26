// Document intelligence, phase 3.2: marketplace VAT, payment reference under its label, stacked 0 % VAT, VAT codes explained by a legend,
// several invoices in one PDF, items tables continued over pages, Chinese supplier addresses. SYNTHETIC layouts only (test/finance-pdf-layouts.js).
// Every new behaviour has its negative case: when an association is not certain, nothing is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPdfDocument } from '../src/finance/pdf-invoice.js';
import { matchSupplier } from '../src/finance/purchase-matching.js';
import { FR_VAT, LAYOUTS, LU_VAT, NL_VAT, OWN_NAME, PAY_REF } from './finance-pdf-layouts.js';
import { startApp } from './finance-dashboard-helpers.js';

const own = { vatNumbers: ['BE0000000097'], ibans: ['BE68539007547034'], names: [OWN_NAME] };
const read = async (k) => readPdfDocument(await LAYOUTS[k](), own);
const v = (r) => Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, x.value]));

// ---------- 1. marketplace VAT vs seller VAT ----------
test('marketplace, non-EU seller: the VAT declared by the platform is NOT the supplier VAT number; it is kept as the platform VAT, with its provenance', async () => {
  for (const k of ['amazonThirdParty', 'amazonThirdPartyFr']) {
    const r = await read(k); const x = v(r);
    assert.equal(x.supplierName, 'Exemple Keji Youxian Gongsi', k); assert.equal(x.supplierVatNumber, undefined, k);
    assert.deepEqual([x.platformVatNumber, x.platformName], [LU_VAT, 'Exemple Retail S.a.r.L.'], k);
    assert.deepEqual([r.fields.platformVatNumber.path, r.fields.platformVatNumber.page], ['VAT_DECLARED_BY_PLATFORM', 1], k);
    assert.ok(r.warnings.includes('MARKETPLACE_VAT_BELONGS_TO_PLATFORM'), k);
  }
});
test('marketplace: the platform VAT never matches the platform contact', async () => {
  const x = v(await read('amazonThirdParty'));
  const platform = { id: 'platform', merchantId: 'm1', kind: 'business', name: 'Exemple Retail S.à r.l.', vatNumber: LU_VAT, enterpriseNumber: null, address: {}, archivedAt: null, declaredRoles: { customer: false, supplier: true } };
  const m = matchSupplier({ id: 'd1', supplierName: x.supplierName, supplierVatNumber: x.supplierVatNumber ?? null, supplierEnterpriseNumber: null, supplierIban: null, supplierCompanyId: null, extraction: {} }, [platform]);
  assert.ok(!JSON.stringify(m.candidates).includes('"platform"') && m.proposal?.contactId !== 'platform', 'no candidate, no proposal: the seller is not the platform');
});
test('marketplace negatives: the platform sells itself (same entity) / an EU seller with its own VAT / a seller that also prints its own VAT -> normal behaviour', async () => {
  let r = await read('amazonDirect'); let x = v(r);
  assert.deepEqual([x.supplierName, x.supplierVatNumber, x.platformVatNumber], ['Exemple Retail S.à r.l., Belgisch bijkantoor', LU_VAT, undefined]);
  assert.equal(r.fields.supplierVatNumber.confidence, 0.9); assert.ok(!r.warnings.includes('MARKETPLACE_VAT_BELONGS_TO_PLATFORM'));
  r = await read('amazonEuSeller'); x = v(r);
  assert.deepEqual([x.supplierName, x.supplierVatNumber, x.platformVatNumber], ['Exemple Handel B.V.', NL_VAT, undefined]); assert.ok(!r.warnings.includes('MARKETPLACE_VAT_BELONGS_TO_PLATFORM'));
  r = await read('amazonThirdPartyOwnVat'); x = v(r);
  assert.deepEqual([x.supplierName, x.supplierVatNumber, x.platformVatNumber], ['Exemple Commerce SAS', FR_VAT, LU_VAT], 'the seller keeps its own VAT number, the platform VAT is kept apart');
});
test('marketplace, order "payée via" the platform: the VAT number of the platform footer is not the seller\'s; the seller confidence is lowered', async () => {
  const r = await read('marketplacePaidVia'); const x = v(r);
  assert.deepEqual([x.supplierName, x.supplierVatNumber, x.platformVatNumber, x.platformName], ['Exemple Trading B.V.', undefined, NL_VAT, 'Exemple Market']);
  assert.equal(r.fields.platformVatNumber.path, 'ORDER_PAID_VIA_PLATFORM'); assert.ok(r.fields.supplierName.confidence < 0.7);
  assert.ok(r.warnings.includes('MARKETPLACE_VAT_BELONGS_TO_PLATFORM'));
  const plain = v(await read('marketplace')); assert.equal(plain.supplierVatNumber, NL_VAT, 'without "payée via", nothing says the VAT is the platform\'s: unchanged');
});

// ---------- 2. payment reference under its label ----------
test('payment reference printed under its label (aligned, close, one token); never a sentence or a value too far', async () => {
  const r = await read('amazonEuSeller');
  assert.deepEqual([r.fields.paymentReference.value, r.fields.paymentReference.path, r.fields.paymentReference.confidence], [PAY_REF, 'LABEL_PAYMENT_REFERENCE_BELOW', 0.6]);
  assert.equal(v(await read('payRefFar')).paymentReference, undefined);
  assert.equal(v(await read('payRefSentence')).paymentReference, undefined);
});

// ---------- 3. 0 % VAT on stacked lines ----------
test('0 % VAT on three stacked lines (label / amount / rate) -> one VAT row; not when the rate is not adjacent, or a 0 % rate carries VAT', async () => {
  let x = v(await read('stackedVat'));
  assert.deepEqual(x.vatBreakdown, [{ taxableCents: null, vatCents: 0, rateBp: 0, category: 'E', exemptionReason: 'reverse charge' }]); assert.equal(x.vatCents, 0);
  x = v(await read('stackedVatRateFar')); assert.equal(x.vatBreakdown, undefined);
  x = v(await read('stackedVatZeroRateWithVat')); assert.equal(x.vatBreakdown, undefined);
});

// ---------- 4. VAT codes ("C2") ----------
test('VAT code "C2" explained by a reverse-charge legend, VAT total 0 -> 0 % reverse-charge row, lines keep the code', async () => {
  const r = await read('taxCodeLegend'); const x = v(r);
  assert.deepEqual(x.vatBreakdown, [{ taxableCents: 30000, vatCents: 0, rateBp: 0, category: 'AE', exemptionReason: 'Auto Liquidation - VAT due by the client' }]);
  assert.equal(r.fields.vatBreakdown.path, 'VAT_CODE_LEGEND_REVERSE_CHARGE'); assert.ok(r.fields.vatBreakdown.confidence < 0.7);
  assert.deepEqual(x.lines.map((l) => [l.taxCode, l.rateBp, l.category]), [['C2', 0, 'AE'], ['C2', 0, 'AE']]); assert.deepEqual(r.warnings, []);
});
test('VAT code negatives: no legend / a legend that is not reverse charge / VAT total not 0 / two codes -> raw code kept, nothing interpreted', async () => {
  for (const k of ['taxCodeNoLegend', 'taxCodeLegendNotReverse', 'taxCodeVatNotZero', 'taxCodeTwoCodes']) {
    const r = await read(k); const x = v(r);
    assert.equal(x.vatBreakdown, undefined, k); assert.ok(r.warnings.includes('VAT_CODE_NOT_INTERPRETED'), k);
    assert.ok(x.lines.every((l) => l.taxCode && l.rateBp === null && l.category === null), k);
  }
});

// ---------- 5. several invoices in one PDF ----------
test('several invoices in one PDF: each is listed (number, pages, seller, total incl. VAT, provenance); no global total, no invoice chosen', async () => {
  const r = await read('twoInvoices'); const x = v(r);
  assert.deepEqual([x.invoiceNumber, x.grossCents, x.netCents, x.vatCents, x.lines], [undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(r.invoices.map((i) => [i.invoiceNumber, i.pages, i.supplierName, i.grossCents, i.currency]), [
    ['BE66EXEMPLE01', [1], 'Exemple Retail S.à r.l., Belgisch bijkantoor', 4047, 'EUR'], ['BE66EXEMPLE02', [2], 'Exemple Retail S.à r.l., Belgisch bijkantoor', 1399, 'EUR']]);
  assert.deepEqual(Object.keys(r.invoices[0].provenance).sort(), ['grossCents', 'invoiceNumber', 'supplierName']);
  assert.deepEqual([r.invoices[1].provenance.grossCents.page, r.invoices[1].provenance.grossCents.path], [2, 'LABEL_TOTAL_TO_PAY']);
});
test('several invoices: a page that carries two numbers belongs to neither', async () => {
  const r = await read('twoInvoicesMixedPage');
  assert.deepEqual(r.invoices.map((i) => i.pages), [[1], [2]]); assert.ok(r.warnings.includes('INVOICE_PAGES_AMBIGUOUS'));
});
test('several invoices: the list is kept with the imported document (none is chosen, validation stays blocked)', async () => {
  const a = await startApp(); const c = await a.authed();
  try {
    const it = (await c.post('/api/inbox/upload', { fileName: 'two.pdf', dataBase64: (await LAYOUTS.twoInvoices()).toString('base64') })).data.item;
    assert.deepEqual(it.extraction.invoices.map((i) => [i.invoiceNumber, i.grossCents]), [['BE66EXEMPLE01', 4047], ['BE66EXEMPLE02', 1399]]);
    assert.equal(it.invoiceNumber ?? null, null); assert.equal(it.grossCents ?? null, null); assert.ok(it.errors.includes('INVOICE_NUMBER_MISSING'));
  } finally { await a.close(); }
});

// ---------- 6. items table continued over pages ----------
test('items table continued: the SAME header repeated on the next pages -> one table; mixed currencies stay flagged, lines to check', async () => {
  const r = await read('chinaMultipage'); const x = v(r);
  assert.deepEqual(x.lines.map((l) => [l.position, l.description, l.netCents]), [[1, 'C-C cable 2M', 64000], [2, '65W charger', 44000], [3, '45W charger suit', 66000], [4, '3in1 cable', 104000], [5, 'Photo frame 8 inch', 38400]]);
  assert.equal(r.fields.lines.path, 'ITEMS_TABLE_CONTINUED_ON_NEXT_PAGES'); assert.equal(r.fields.lines.confidence, 0.4);
  for (const w of ['ITEMS_TABLE_CONTINUED_ON_NEXT_PAGES', 'CURRENCY_AMBIGUOUS', 'LINES_MIXED_CURRENCIES']) assert.ok(r.warnings.includes(w), w);
});
test('items table negatives: another table on the next page, or a table closed by its totals, is never merged', async () => {
  for (const k of ['chinaOtherTable', 'chinaTableClosed']) {
    const r = await read(k); const x = v(r);
    assert.deepEqual(x.lines.map((l) => l.description), ['C-C cable 2M', '65W charger'], k); assert.ok(!r.warnings.includes('ITEMS_TABLE_CONTINUED_ON_NEXT_PAGES'), k);
    assert.ok(!r.warnings.includes('LINES_MIXED_CURRENCIES'), `${k}: one currency only`);
  }
});

// ---------- 7. Chinese addresses ----------
test('Chinese supplier address under the supplier name: read with a LOW confidence (to check); the buyer and beneficiary addresses are never used', async () => {
  const r = await read('chinaMultipage');
  assert.deepEqual(r.fields.supplierAddress.value, { street: 'ROOM 2106, EXEMPLE BUILDING B, FUTIAN STREET', postalCode: null, city: 'YIWU', countryCode: 'CN' });
  assert.deepEqual([r.fields.supplierAddress.path, r.fields.supplierAddress.confidence], ['ADDRESS_CN_UNDER_SUPPLIER_NAME', 0.5]);
  assert.equal(v(await read('chinaBuyerBelow')).supplierAddress, undefined, 'a customer block right under the name stops the address');
  assert.equal(v(await read('china')).supplierAddress, undefined, 'the bank / beneficiary address is not the supplier\'s');
});
