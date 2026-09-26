// Document intelligence, phase 3: local reading of the text of a PDF (pdfjs-dist) into the common model, then the same checks,
// supplier matching and duplicate detection as every other document. SYNTHETIC PDFs only (test/finance-pdf-fixtures.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { amountsIn, datesIn, readPdfDocument, SCAN_TEXT_THRESHOLD } from '../src/finance/pdf-invoice.js';
import { readPdfText } from '../src/finance/pdf-text.js';
import { CASES, COMM, NL_IBAN, OWN, SUPPLIER_IBAN, makeIban, makeStructured } from './finance-pdf-fixtures.js';
import { startApp } from './finance-dashboard-helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const own = { vatNumbers: [OWN.vat], ibans: [OWN.iban], names: [OWN.name] };
const read = async (name) => readPdfDocument(await CASES[name](PNG), own);
const v = (r) => Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, x.value]));

test('values: European and English amounts with two decimals, never a bare integer; day-first, ISO and month-name dates', () => {
  assert.deepEqual(amountsIn('Total 1.234,56 € et 1 234,56 et 12,50 et -4,20 et 1,210.00 et 999.99').map((a) => a.cents), [123456, 123456, 1250, -420, 121000, 99999]);
  assert.deepEqual(amountsIn('Qté 4 · TVA 21 % · 2026 · BE0000000196 · 10/09/2026'), [], 'quantities, rates, years, VAT numbers and dates are not amounts');
  assert.deepEqual(datesIn('10/09/2026 · 2026-09-11 · 12 septembre 2026 · 1er octobre 2026 · 3 mei 2026 · September 15, 2026 · 31/02/2026').map((d) => d.value), ['2026-09-10', '2026-09-11', '2026-09-12', '2026-10-01', '2026-05-03', '2026-09-15']);
  assert.equal(makeStructured('0100000001'), COMM); assert.match(makeIban('BE', '000000000101'), /^BE\d{14}$/);
});

test('FR invoice 21 %: every field of the common model, with provenance (page, source text, rule, PDF_TEXT)', async () => {
  const r = await read('frSimple'); const x = v(r);
  assert.equal(r.extractor, 'pdf_text'); assert.deepEqual(r.warnings, []);
  assert.deepEqual([x.documentType, x.invoiceNumber, x.issueDate, x.dueDate, x.currency, x.orderReference], ['INVOICE', 'F-2026-0101', '2026-09-10', '2026-10-10', 'EUR', 'BC-2026-44']);
  assert.deepEqual([x.supplierName, x.supplierVatNumber, x.supplierIban, x.paymentReference], ['Imprimerie Exemple SRL', 'BE0000000196', SUPPLIER_IBAN, COMM]);
  assert.deepEqual(x.supplierAddress, { street: "Rue de l'Exemple 12", postalCode: '5000', city: 'Namur', countryCode: 'BE' });
  assert.deepEqual([x.netCents, x.vatCents, x.grossCents], [10000, 2100, 12100]);
  assert.deepEqual(x.vatBreakdown, [{ taxableCents: 10000, vatCents: 2100, rateBp: 2100, category: 'S', exemptionReason: null }]);
  assert.deepEqual(x.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.netCents]), [['Gourde isotherme 500 ml', '4', '15,00', 6000], ['Gravure laser', '4', '10,00', 4000]]);
  const g = r.fields.grossCents; assert.deepEqual([g.source, g.page, g.path, g.text], ['PDF_TEXT', 1, 'LABEL_TOTAL_INCL_VAT', 'Total TVAC   121,00 €']);
  assert.equal(r.fields.supplierVatNumber.text, 'TVA BE 0000.000.196'); assert.ok(r.fields.issueDate.zone && Number.isFinite(r.fields.issueDate.zone.y));
  assert.equal(r.fields.vatCents.path, 'SUM_OF_VAT_BY_RATE', 'no VAT total printed: the sum of the printed VAT row, stated as such'); assert.equal(r.fields.vatCents.confidence, 0.6);
  assert.deepEqual(r.pdf, { pages: 1, textChars: r.pdf.textChars });
});
test("the merchant's own identity (VAT, IBAN, name in the customer block) is never read as the supplier's", async () => {
  const x = v(await read('frSimple'));
  assert.notEqual(x.supplierVatNumber, OWN.vat); assert.notEqual(x.supplierIban, OWN.iban); assert.notEqual(x.supplierName, OWN.name);
  const blind = v(await readPdfDocument(await CASES.frSimple(), {}));
  assert.equal(blind.supplierVatNumber, 'BE0000000196', 'without the own identity, the first VAT number of the document is proposed');
});
test('NL and EN invoices', async () => {
  const nl = v(await read('nl'));
  assert.deepEqual([nl.invoiceNumber, nl.issueDate, nl.dueDate, nl.supplierName, nl.supplierVatNumber, nl.supplierEnterpriseNumber, nl.orderReference, nl.paymentReference, nl.netCents, nl.vatCents, nl.grossCents],
    ['2026/055', '2026-09-12', '2026-10-12', 'Drukkerij Voorbeeld BV', 'BE0000000295', '0000.000.295', 'PO-2026-9', COMM, 20000, 4200, 24200]);
  const en = v(await read('en'));
  assert.deepEqual([en.invoiceNumber, en.issueDate, en.dueDate, en.supplierName, en.supplierVatNumber, en.orderReference, en.netCents, en.vatCents, en.grossCents, en.currency],
    ['INV-3001', '2026-09-15', '2026-10-15', 'Example Supplies Ltd', 'BE0000000394', 'ORD-77', 100000, 21000, 121000, 'EUR']);
  assert.equal(en.lines[0].netCents, 100000);
  assert.equal(makeIban('NL', 'ABNA0000000101'), NL_IBAN);
});
test('several VAT rates, and an invoice without VAT (reverse charge)', async () => {
  const m = v(await read('multiRate'));
  assert.deepEqual(m.vatBreakdown.map((b) => [b.rateBp, b.taxableCents, b.vatCents]), [[600, 10000, 600], [2100, 20000, 4200]]);
  assert.deepEqual([m.netCents, m.vatCents, m.grossCents], [30000, 4800, 34800]);
  const z = await read('noVat'); const n = v(z);
  assert.deepEqual([n.netCents, n.vatCents, n.grossCents], [50000, 0, 50000]); assert.deepEqual(n.vatBreakdown[0], { taxableCents: 50000, vatCents: 0, rateBp: 0, category: 'E', exemptionReason: 'Autoliquidation' });
});
test('credit note: typed CREDIT_NOTE, stored positive, the credited invoice is not taken as its own number', async () => {
  const r = await read('creditNote'); const x = v(r);
  assert.deepEqual([x.documentType, x.invoiceNumber, x.billingReference, x.netCents, x.vatCents, x.grossCents], ['CREDIT_NOTE', 'NC-2026-007', 'F-2026-0101', 2000, 420, 2420]);
  assert.ok(r.warnings.includes('NEGATIVE_AMOUNTS_ON_CREDIT_NOTE'));
});
test('several dates: only a labelled one is taken; delivery / period dates are ignored; unlabelled ones stay to check', async () => {
  const x = v(await read('manyDates')); assert.deepEqual([x.issueDate, x.dueDate], ['2026-09-10', '2026-10-10']);
  const u = await read('unlabelledDates'); assert.equal(v(u).issueDate, undefined); assert.ok(u.warnings.includes('ISSUE_DATE_AMBIGUOUS'));
});
test('several amounts: never "the largest"; a total is chosen only by an explicit rule, otherwise it stays to check', async () => {
  const r = await read('manyAmounts'); const x = v(r);
  assert.equal(x.grossCents, 121000, 'net + VAT = total designates 1 210,00 among "Total TVAC 1 210,00" and "Solde à payer 710,00"; the 2 500,00 guarantee is ignored');
  assert.equal(r.fields.grossCents.confidence, 0.7); assert.ok(r.warnings.includes('AMOUNTS_CHOSEN_BY_CONSISTENCY'));
  const a = await read('ambiguousTotals'); assert.equal(v(a).grossCents, undefined); assert.ok(a.warnings.includes('TOTAL_INCL_VAT_AMBIGUOUS'));
});
test('IBAN and structured communication: two supplier IBANs -> proposed with a low confidence; wrong check digits -> flagged', async () => {
  const r = await read('twoIbans'); const x = v(r);
  assert.equal(x.supplierIban, SUPPLIER_IBAN); assert.equal(r.fields.supplierIban.confidence, 0.4); assert.ok(r.warnings.includes('IBAN_AMBIGUOUS'));
  assert.equal(x.paymentReference, '+++010/0000/00199+++'); assert.equal(r.fields.paymentReference.confidence, 0.4); assert.ok(r.warnings.includes('STRUCTURED_COMMUNICATION_INVALID'));
});
test('incoherent totals are flagged by the SAME checks as UBL (confidence lowered); a total on page 2 keeps its page', async () => {
  const r = await read('incoherent'); assert.ok(r.warnings.includes('TOTALS_DO_NOT_ADD_UP')); assert.equal(r.fields.grossCents.confidence, 0.4);
  const p = await read('twoPages'); assert.equal(p.fields.grossCents.page, 2); assert.equal(v(p).grossCents, 12100);
});
test('a scan, or a PDF with almost no text, is reported honestly: nothing is read, nothing is guessed', async () => {
  for (const k of ['scanned', 'nearlyEmpty']) { const r = await read(k); assert.deepEqual([r.fields, r.warnings], [{}, ['SCAN_REQUIRES_OCR']], k); assert.ok(r.pdf.textChars < SCAN_TEXT_THRESHOLD); }
  const p = await read('prose'); assert.deepEqual(p.fields, {}); assert.ok(p.warnings.includes('PDF_TEXT_NOTHING_RECOGNISED'));
  assert.deepEqual((await readPdfDocument(Buffer.from('%PDF-1.4\n%%EOF\n'))).warnings, ['PDF_TEXT_UNREADABLE']);
  const t = await readPdfText(await CASES.twoPages()); assert.equal(t.pageCount, 2);
});
test('local only: no network, no OCR, no external model, no eval in the PDF readers', () => {
  for (const f of ['pdf-text.js', 'pdf-invoice.js']) {
    const src = readFileSync(new URL(`../src/finance/${f}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(src, /fetch\(|https?:\/\/|tesseract|openai|anthropic|vision|azure|textract|documentai/i, f);
  }
  assert.match(readFileSync(new URL('../src/finance/pdf-text.js', import.meta.url), 'utf8'), /isEvalSupported: false/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')); assert.equal(pkg.dependencies['pdfjs-dist'], '4.10.38', 'pinned: Railway runs Node 20');
});

// ---------- one pipeline, end to end ----------
async function harness() { const a = await startApp(); return { a, c: await a.authed(), close: () => a.close() }; }
const withH = (fn) => async () => { const h = await harness(); try { await fn(h); } finally { await h.close(); } };
const upload = async (h, name, buf) => h.c.post('/api/inbox/upload', { fileName: name, dataBase64: buf.toString('base64') });

test('HTTP: a text PDF prefills the review, with provenance; the same PDF twice is one record; known supplier recognised', withH(async (h) => {
  const contact = (await h.c.post('/api/companies', { kind: 'business', name: 'Imprimerie Exemple SRL', vatNumber: 'BE0000000196', roles: { customer: false, supplier: true }, address: { countryCode: 'BE' } })).data;
  const pdf = await CASES.frSimple();
  const r = await upload(h, 'facture.pdf', pdf); assert.equal(r.status, 201); const it = r.data.item;
  assert.deepEqual([it.status, it.extraction.extractor, it.invoiceNumber, it.issueDate, it.grossCents, it.supplierVatNumber, it.supplierIban, it.paymentReference], ['TO_REVIEW', 'pdf_text', 'F-2026-0101', '2026-09-10', 12100, 'BE0000000196', SUPPLIER_IBAN, COMM]);
  assert.deepEqual(it.errors, [], 'complete: the person still validates');
  assert.deepEqual(it.provenance.grossCents, { source: 'PDF_TEXT', path: 'LABEL_TOTAL_INCL_VAT', page: 1, zone: it.provenance.grossCents.zone, text: 'Total TVAC   121,00 €', confidence: 0.9, value: 12100 });
  const again = await upload(h, 'copie.pdf', pdf); assert.equal(again.data.duplicate, true); assert.equal(again.data.item.id, it.id);
  const g = (await h.c.get(`/api/inbox/${it.id}`)).data;
  assert.deepEqual([g.supplierMatch.status, g.supplierMatch.proposal.contactId, g.supplierMatch.level], ['recognized', contact.id, 'HIGH']); assert.equal(g.supplierCompanyId, null, 'proposed, never linked by itself');
  // a correction keeps the value read in the PDF
  const fix = await h.c.put(`/api/inbox/${it.id}`, { invoiceNumber: 'F-2026-0101-B' });
  assert.equal(fix.data.provenance.invoiceNumber.source, 'user'); assert.deepEqual([fix.data.provenance.invoiceNumber.extracted.source, fix.data.provenance.invoiceNumber.extracted.value], ['PDF_TEXT', 'F-2026-0101']);
}));
test('HTTP: unknown supplier -> creation proposed, prefilled from the PDF (never with our own details)', withH(async (h) => {
  const it = (await upload(h, 'nl.pdf', await CASES.nl())).data.item;
  const p = (await h.c.get(`/api/inbox/${it.id}`)).data.supplierMatch;
  assert.equal(p.status, 'unknown');
  assert.deepEqual(p.createPrefill, { kind: 'business', role: 'supplier', name: 'Drukkerij Voorbeeld BV', vatNumber: 'BE0000000295', enterpriseNumber: '0000.000.295', iban: SUPPLIER_IBAN, street: 'Voorbeeldstraat 7', postalCode: '2000', city: 'Antwerpen', countryCode: 'BE' });
  assert.equal((await h.c.get('/api/contacts')).data.rows.length, 0);
}));
test('HTTP: duplicates on PDFs - same supplier + number + type refused before storing; a possible duplicate shown; an incoherent PDF cannot be validated', withH(async (h) => {
  const first = (await upload(h, 'f.pdf', await CASES.frSimple())).data.item;
  const other = await CASES.frSimple(); const bytes = Buffer.concat([other, Buffer.from('\n% re-sent\n')]); // same invoice, other file
  const d = await upload(h, 'f-renvoi.pdf', bytes); assert.equal(d.status, 409); assert.equal(d.data.error.existing.id, first.id);
  const cn = await upload(h, 'nc.pdf', await CASES.creditNote()); assert.equal(cn.status, 201, 'the credit note of that invoice is a different document'); assert.equal(cn.data.item.documentType, 'CREDIT_NOTE'); assert.equal(cn.data.item.grossCents, 2420);
  const man = (await h.c.post('/api/inbox/manual', { supplierName: 'Imprimerie Exemple SRL', supplierVatNumber: 'BE0000000196', invoiceNumber: 'F-2026-0999', issueDate: '2026-09-12', net: '100.00', vat: '21.00', gross: '121.00', currency: 'EUR' })).data;
  const dup = (await h.c.get(`/api/inbox/${man.id}`)).data.duplicates; assert.equal(dup.level, 'possible'); assert.equal(dup.items[0].id, first.id);
  const bad = (await upload(h, 'incoherent.pdf', await CASES.incoherent())).data.item;
  assert.ok(bad.errors.includes('NET_PLUS_VAT_DOES_NOT_EQUAL_TOTAL')); assert.equal((await h.c.post(`/api/inbox/${bad.id}/validate`, {})).status, 409);
}));
test('HTTP: a scanned PDF says so; the person completes the form by hand and validates', withH(async (h) => {
  const it = (await upload(h, 'scan.pdf', await CASES.scanned(PNG))).data.item;
  assert.deepEqual([it.extraction.extractor, it.extraction.warnings, it.supplierName], ['pdf_text', ['SCAN_REQUIRES_OCR'], null]);
  assert.equal((await h.c.put(`/api/inbox/${it.id}`, { supplierName: 'Fournisseur Scanné SRL', invoiceNumber: 'S-1', issueDate: '2026-09-15', net: '10.00', vat: '2.10', gross: '12.10', currency: 'EUR' })).status, 200);
  assert.equal((await h.c.post(`/api/inbox/${it.id}/validate`, {})).data.status, 'VALIDATED');
}));
