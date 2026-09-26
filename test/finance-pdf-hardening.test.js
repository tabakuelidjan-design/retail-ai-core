// Document intelligence, phase 3.1: PDF_TEXT hardening. Each test reproduces, with SYNTHETIC data, the LAYOUT of a real supplier
// document on which the 224213b reader failed (see test/finance-pdf-layouts.js). Abstaining stays preferred to guessing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { amountsIn, datesIn, readPdfDocument } from '../src/finance/pdf-invoice.js';
import { makePdf } from './finance-pdf-fixtures.js';
import { FR_VAT, IE_VAT, LAYOUTS, LU_VAT, NL_VAT, OWN_NAME } from './finance-pdf-layouts.js';
import { startApp } from './finance-dashboard-helpers.js';

const own = { vatNumbers: ['BE0000000097'], ibans: ['BE68539007547034'], names: [OWN_NAME] };
const read = async (k) => readPdfDocument(await LAYOUTS[k](), own);
const v = (r) => Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, x.value]));

test('values: 26-MAR-2026, 02 APR 2026, Jan 12, 2026, Aug 30, 2025, 2026/02/13; a currency glued to its amount', () => {
  assert.deepEqual(datesIn('26-MAR-2026 · 02 APR 2026 · Jan 12, 2026 · Aug 30, 2025 · 2026/02/13 · 3 mrt 2026 · 5 févr. 2026').map((d) => d.value), ['2026-03-26', '2026-04-02', '2026-01-12', '2025-08-30', '2026-02-13', '2026-03-03', '2026-02-05']);
  assert.deepEqual(datesIn('13235..MARSEILLE · Mar · 2026 · ref MAR-2026'), []);
  assert.deepEqual(amountsIn('Total amount EUR597.28 · Total paid EUR582.28 · -EUR15').map((a) => a.cents), [59728, 58228]);
});

test('REGRESSION X-Forwarding: labels ABOVE the values -> invoice date and due date each from its own column; "BTW Import" on a line is never the VAT', async () => {
  const r = await read('labelsAbove'); const x = v(r);
  assert.equal(x.issueDate, '2025-12-30'); assert.equal(x.dueDate, '2026-01-14');
  assert.equal(r.fields.dueDate.path, 'LABEL_DUE_DATE_ABOVE'); assert.equal(r.fields.issueDate.path, 'LABEL_ISSUE_DATE_ABOVE');
  assert.deepEqual([x.netCents, x.vatCents, x.grossCents], [194914, 3360, 198274], 'VAT 33,60 from the 21 % row; "BTW Import 1.788,76" is an invoice line');
  assert.deepEqual(x.lines.map((l) => [l.description, l.netCents]), [['Import document', 8500], ['Expeditie service', 7500], ['A00: Invoerrechten', 38], ['B00 : BTW Import', 178876]]);
  assert.deepEqual([x.supplierName, x.supplierVatNumber], ['BV Exemple-Transit', 'BE0000000196']);
  assert.deepEqual(x.supplierAddress, { street: 'Rootputstraat 31', postalCode: '9100', city: 'Sint-Niklaas', countryCode: 'BE' });
  assert.deepEqual(r.warnings, []);
});
test('REGRESSION X-Forwarding: when the header row is NOT aligned with the dates, no date label is guessed (never the invoice date as due date)', async () => {
  const pdf = await makePdf([[[26, 40, 'BV Exemple-Transit', 12], [26, 220, 'Factuur INV/2026/00014', 14], [120, 245, 'Factuurdatum'], [330, 245, 'Vervaldatum'], [26, 262, '30-12-2025'], [200, 262, '14-01-2026'],
    [343, 450, 'Excl. btw'], [470, 450, '100,00 €'], [343, 470, 'BTW 21% op 100,00 €'], [470, 470, '21,00 €'], [343, 495, 'Totaal'], [470, 495, '121,00 €']]]);
  const r = await readPdfDocument(pdf, own);
  assert.equal(r.fields.dueDate, undefined, 'no due date rather than a wrong one'); assert.ok(r.warnings.includes('DATE_LABELS_NOT_ALIGNED'));
  assert.ok(!r.fields.issueDate || r.fields.issueDate.confidence < 0.7);
});
test('REGRESSION AILY: a PRO FORMA is never typed as an invoice, and cannot be validated as a purchase', async () => {
  const r = await read('proforma'); const x = v(r);
  assert.equal(x.documentType, undefined); assert.ok(r.warnings.includes('DOCUMENT_IS_PRO_FORMA'));
  assert.deepEqual([x.invoiceNumber, x.supplierName, x.issueDate, x.currency, x.grossCents], ['PF2503111', 'HANGZHOU EXEMPLE PRINTING TECHNOLOGY CO.,LTD', '2025-09-24', 'USD', 900000]);
  const a = await startApp(); const c = await a.authed();
  try {
    const it = (await c.post('/api/inbox/upload', { fileName: 'proforma.pdf', dataBase64: (await LAYOUTS.proforma()).toString('base64') })).data.item;
    assert.ok(it.errors.includes('PRO_FORMA_NOT_AN_INVOICE'));
    const val = await c.post(`/api/inbox/${it.id}/validate`, {}); assert.equal(val.status, 409); assert.match(JSON.stringify(val.data), /PRO_FORMA_NOT_AN_INVOICE/);
    assert.equal((await c.post(`/api/inbox/${it.id}/reject`, { reason: 'Pro forma' })).data.status, 'REJECTED', 'the person rejects it and imports the final invoice');
  } finally { await a.close(); }
  assert.match(readFileSync(new URL('../src/finance/ui/views-workspace.js', import.meta.url), 'utf8'), /DOCUMENT_IS_PRO_FORMA'\)\) \? h\('span', \{ class: 'chip bad doc-type' \}, tt\('Pro forma'\)\)/, 'shown as "Pro forma", never as an invoice');
});
test('Amazon-like invoice (NL + FR pages): label | value columns, seller block with labels above, 2-line VAT table and item header', async () => {
  const r = await read('bilingual'); const x = v(r);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual([x.documentType, x.invoiceNumber, x.issueDate, x.orderReference], ['INVOICE', 'LU62EXEMPLE01', '2026-05-31', '406-2146550-3713107']);
  assert.equal(r.fields.invoiceNumber.confidence, 0.85, '"Totaal factuur 69,90" is not a second invoice number');
  assert.deepEqual([x.supplierName, x.supplierVatNumber, x.supplierEnterpriseNumber], ['Exemple Retail S.à r.l., Belgisch bijkantoor', LU_VAT, '0000.000.196']);
  assert.equal(r.fields.supplierVatNumber.confidence, 0.9, '"TVA LUXEMBOURGEOISE" is not a VAT number');
  assert.deepEqual(x.supplierAddress, { street: 'Kunstlaan 27', postalCode: '1040', city: 'Brussel', countryCode: 'BE' });
  assert.deepEqual([x.netCents, x.vatCents, x.grossCents], [5777, 1213, 6990]);
  assert.deepEqual(x.vatBreakdown, [{ taxableCents: 5777, vatCents: 1213, rateBp: 2100, category: 'S', exemptionReason: null }], 'the table printed on both pages counts once');
  assert.deepEqual(x.lines.map((l) => [l.description, l.netCents]), [['Moniteur Exemple 24 pouces', 5777], ['Verzendkosten', 0]], 'the excl. VAT column, not the incl. VAT subtotal');
});
test('a PDF with TWO invoices: reported, totals not read, number proposed with a low confidence', async () => {
  const r = await read('twoInvoices'); const x = v(r);
  assert.ok(r.warnings.includes('MULTIPLE_INVOICES_IN_PDF'));
  assert.deepEqual([x.grossCents, x.netCents, x.vatCents, x.lines, x.vatBreakdown], [undefined, undefined, undefined, undefined, undefined]);
  assert.equal(x.invoiceNumber, undefined, 'phase 3.2: no invoice is chosen automatically; each one is listed in r.invoices');
});
test('CMA-like shipping invoice: number under the title, "Account Number" ignored, 26-MAR-2026 / "Payable by", "Total Excluding Tax", call date ignored', async () => {
  const r = await read('shipping'); const x = v(r);
  assert.deepEqual([x.invoiceNumber, x.issueDate, x.dueDate], ['EXDIC236019', '2026-03-26', '2026-04-02']);
  assert.deepEqual([x.netCents, x.vatCents, x.grossCents, x.currency], [30000, 0, 30000, 'EUR']);
  assert.deepEqual([x.supplierName, x.supplierVatNumber], ['EXEMPLE - LINES', FR_VAT]);
  assert.deepEqual(x.supplierAddress, { street: "BOULEVARD EXEMPLE, 4 QUAI D'EXEMPLE", postalCode: '13235', city: 'MARSEILLE', countryCode: 'FR' });
  assert.deepEqual(x.lines.map((l) => [l.description, l.netCents]), [['Terminal Handling Charge', 25000], ['Documentation Fee', 5000]]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(x.vatBreakdown.map((b) => [b.rateBp, b.taxableCents, b.vatCents, b.category]), [[0, 30000, 0, 'AE']], 'phase 3.2: "C2" read through its reverse-charge legend');
});
test('Shopify-like bill and receipt: "Bill #", "Paid on Jan 12, 2026", "Receipt / Tax Invoice", "Limited", Eircode, rows on several lines, "Thank you" is not a name', async () => {
  const b = v(await read('bill'));
  assert.deepEqual([b.documentType, b.invoiceNumber, b.issueDate, b.supplierName, b.supplierVatNumber, b.grossCents, b.netCents, b.vatCents], ['INVOICE', '472742124', '2026-01-12', 'Exemple International Limited', IE_VAT, 1485, 1485, 0]);
  assert.deepEqual(b.supplierAddress, { street: '2nd Floor, 1-2 Exemple Buildings, Haddington Road', postalCode: 'D04 XN32', city: 'Dublin 4', countryCode: 'IE' });
  const r = v(await read('receipt'));
  assert.deepEqual([r.documentType, r.invoiceNumber, r.supplierName, r.grossCents, r.netCents, r.vatCents], ['INVOICE', '264828-HWS', 'Exemple International Limited', 21800, 21800, 0]);
  assert.deepEqual(r.supplierAddress, { street: '1-2 Exemple Buildings, Haddington Road', postalCode: 'D04 XN32', city: 'Dublin', countryCode: 'IE' });
  assert.deepEqual(r.lines.map((l) => [l.description, l.netCents]), [['Cash Drawer 16"', 9900], ['Tablet Stand', 11900]]);
});
test('booking confirmation: reported, nothing read as an invoice (no street number as number, no print date, no estimate as total)', async () => {
  const r = await read('booking'); const x = v(r);
  assert.ok(r.warnings.includes('DOCUMENT_IS_BOOKING_CONFIRMATION'));
  assert.deepEqual([x.documentType, x.invoiceNumber, x.issueDate, x.grossCents], [undefined, undefined, undefined, undefined]);
  assert.equal(x.orderReference, '4894.780.823'); assert.ok(r.warnings.includes('CURRENCY_AMBIGUOUS'), 'EUR estimate, paid in CNY');
});
test('Chinese commercial invoice: empty "Invoice NO." stays empty (never "158" from the bank address), 2026/02/13, "CO.,LIMITED", RMB + USD', async () => {
  const r = await read('china'); const x = v(r);
  assert.equal(x.invoiceNumber, undefined); assert.equal(x.issueDate, '2026-02-13'); assert.equal(x.supplierName, 'ZHEJIANG EXEMPLE TRADE CO.,LIMITED');
  assert.equal(x.currency, undefined); assert.ok(r.warnings.includes('CURRENCY_AMBIGUOUS'));
  assert.deepEqual(x.lines.map((l) => [l.description, l.netCents]), [['C-C cable 2M', 64000]], 'the AMOUNT column, not the weight column printed after it');
});
test('travel e-receipt: a RECEIPT, "PTE. LTD.", "Aug 30, 2025", "EUR582.28" paid (not the amount before discount), booking number as reference', async () => {
  const x = v(await read('travelReceipt'));
  assert.deepEqual([x.documentType, x.supplierName, x.issueDate, x.grossCents, x.orderReference, x.invoiceNumber], ['RECEIPT', 'TRIP.EXEMPLE TRAVEL SINGAPORE PTE. LTD.', '2025-08-30', 58228, '1185315927488530', undefined]);
});
test('marketplace invoice: "Name B.V. • street • 7512HL City • country" on one line; prices incl. VAT: "Sous-total" is NOT the amount excl. VAT', async () => {
  const r = await read('marketplace'); const x = v(r);
  assert.deepEqual([x.supplierName, x.supplierVatNumber, x.invoiceNumber, x.issueDate], ['Exemple Trading B.V.', NL_VAT, '80184653', '2026-04-30']);
  assert.deepEqual(x.supplierAddress, { street: 'Exempelstraat 25-E', postalCode: '7512HL', city: 'Enschede', countryCode: 'NL' });
  assert.deepEqual([x.netCents, x.vatCents, x.grossCents], [undefined, 11281, 65000]); assert.ok(!r.warnings.includes('TOTALS_DO_NOT_ADD_UP'));
  assert.deepEqual(x.lines.map((l) => [l.description, l.netCents]), [['1 iPad Pro 12.9" 512 Go', 65000]], 'description on the line above its amounts');
});
test('forwarder invoice: "Invoice Date | : 19-12-2025", ETS / ETA ignored, EUR on the total line despite USD in a line, descriptions that contain numbers', async () => {
  const r = await read('forwarder'); const x = v(r);
  assert.deepEqual([x.invoiceNumber, x.issueDate, x.vatCents, x.grossCents, x.currency], ['25100231', '2025-12-19', 0, 27767, 'EUR']);
  assert.deepEqual(x.lines.map((l) => [l.description, l.netCents]), [['UNLOADING / RELOADING COST 2,690 CBM X 45,00', 12105], ['LOCAL IMPORT CHARGES USD 180,23 X 0,869', 15662]]);
});
test('REGRESSION (found by the real-invoice diff): ": EUR" is a currency cell, not a label; an airline "TICKET NUMBER" is not a till receipt', async () => {
  const r = await read('airTicket'); const x = v(r);
  assert.equal(x.grossCents, 75696); assert.equal(x.currency, 'EUR'); assert.equal(x.issueDate, '2025-04-10'); assert.equal(x.documentType, undefined);
});
test('REGRESSION (found by the real-invoice diff): on a travel receipt, the booking date is the purchase date, not the flight date', async () => {
  const r = await read('travelBooking'); const x = v(r);
  assert.deepEqual([x.documentType, x.issueDate, x.grossCents, x.orderReference], ['RECEIPT', '2025-10-23', 9553, '1185317900000000']);
});
test('VAT numbers: a word or a malformed string is never accepted', async () => {
  const pdf = await makePdf([[[50, 30, 'FACTURE', 18], [50, 60, 'Régime TVA LUXEMBOURGEOISE'], [50, 75, 'VAT NL12345'], [50, 90, 'TVA FR ABCDEFGHIJK'], [50, 105, 'Btw-nummer DE12345678'], [50, 170, 'Facture n° V-1']]]);
  const r = await readPdfDocument(pdf, own); assert.equal(r.fields.supplierVatNumber, undefined);
});
