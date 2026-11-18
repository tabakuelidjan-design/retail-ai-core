import test from 'node:test';
import assert from 'node:assert/strict';
import { readScanFields, createOcrExtractor, withOcrFallback } from '../src/finance/ocr-scan.js';
import { defaultExtractor } from '../src/finance/inbox.js';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { createInboxService, createMemoryAttachmentStore } from '../src/finance/inbox.js';

// SYNTHETIC scan text (fictitious supplier, invented numbers).
const LINES = [
  'FACTURE FOURNISSEUR (FICTIF)', 'Fournisseur Exemple Papier SRL', 'Rue Imaginaire 7, 4000 Liege', 'TVA BE0555.555.555',
  'Numéro de facture : F-2026-0815', 'Date de facture : 02/11/2026', 'Date d’échéance : 02/12/2026',
  'Description : Papier et enveloppes (exemple) Montant HTVA : 250,00 EUR', 'TVA 21 % : 52,50 EUR', 'Total TTC : 302,50 EUR',
  'IBAN : BE71 0961 2345 6769   BIC : GKCCBEBB', 'Communication : +++002/0260/81537+++',
];
const PDF = Buffer.from('%PDF-1.4\n% synthetic scan, no text layer\n%%EOF\n');

test('scan text -> invoice fields with confidences; the supplier name is flagged as uncertain', () => {
  const r = readScanFields(LINES, { ownVats: ['BE0000000097'] });
  assert.equal(r.fields.invoiceNumber.value, 'F-2026-0815');
  assert.equal(r.fields.issueDate.value, '2026-11-02');
  assert.equal(r.fields.dueDate.value, '2026-12-02');
  assert.equal(r.fields.netCents.value, 25000);
  assert.equal(r.fields.vatCents.value, 5250);
  assert.equal(r.fields.grossCents.value, 30250);
  assert.equal(r.fields.supplierVatNumber.value, 'BE0555555555');
  assert.equal(r.fields.paymentReference.value, '+++002/0260/81537+++');
  assert.ok(r.warnings.includes('OCR_UNVERIFIED'));
  assert.ok(r.warnings.includes('FIELD_UNCERTAIN:supplierName'));
});

test('the merchant own VAT is never read as the supplier', () => {
  const r = readScanFields(['TVA BE0000000097', 'Numéro de facture : X-1', 'TVA BE0555.555.555'], { ownVats: ['BE0000000097'] });
  assert.equal(r.fields.supplierVatNumber.value, 'BE0555555555');
});

test('inconsistent totals are reported, never corrected', () => {
  const r = readScanFields(LINES.map((l) => l.replace('302,50', '300,00')));
  assert.ok(r.warnings.includes('TOTALS_DO_NOT_ADD_UP'));
  assert.equal(r.fields.grossCents.value, 30000);
});

test('without an OCR command a scan is reported as needing OCR and nothing is read', async () => {
  const r = await createOcrExtractor({}).extract({ data: PDF, contentType: 'application/pdf' });
  assert.deepEqual(r.fields, {});
  assert.deepEqual(r.warnings, ['SCAN_REQUIRES_OCR']);
});

test('a failing OCR never blocks intake: the scan lands in review with the original attached', async () => {
  const store = createMemoryStore(); const attachments = createMemoryAttachmentStore();
  const ext = createOcrExtractor({ runOcr: async () => { throw new Error('OCR_FAILED:1:boom'); } });
  const svc = createInboxService({ store, attachments, extractor: ext, merchantId: 'merchant-test-1' });
  const r = await svc.ingest({ source: 'upload', fileName: 'scan.pdf', data: PDF });
  assert.equal(r.item.status, 'TO_REVIEW');
  assert.ok(r.item.attachmentRef, 'original kept');
  assert.ok(r.item.extraction.warnings.includes('OCR_UNVERIFIED'));
  const again = await svc.ingest({ source: 'upload', fileName: 'scan-copie.pdf', data: PDF });
  assert.equal(again.duplicate, true, 'the same scan twice is one item');
});

test('OCR output becomes a TO_REVIEW draft with the fields filled', async () => {
  const store = createMemoryStore(); const attachments = createMemoryAttachmentStore();
  const svc = createInboxService({ store, attachments, extractor: createOcrExtractor({ runOcr: async () => LINES }), merchantId: 'merchant-test-1' });
  const r = await svc.ingest({ source: 'upload', fileName: 'scan.pdf', data: PDF });
  assert.equal(r.item.status, 'TO_REVIEW');
  assert.equal(r.item.invoiceNumber, 'F-2026-0815');
  assert.equal(r.item.grossCents, 30250);
});

test('fallback: a text PDF keeps the normal reader; a scan or an image goes to OCR', async () => {
  const calls = [];
  const ocr = { name: 'ocr', extract: async () => { calls.push('ocr'); return { extractor: 'ocr', fields: {}, warnings: ['OCR_UNVERIFIED'] }; } };
  const base = { name: 'base', label: 'base', extract: async (f) => ({ extractor: 'pdf_text', fields: {}, warnings: f.scan ? ['SCAN_REQUIRES_OCR'] : [] }) };
  const ex = withOcrFallback(base, ocr);
  await ex.extract({ contentType: 'application/pdf', data: PDF, scan: false });
  assert.deepEqual(calls, []);
  await ex.extract({ contentType: 'application/pdf', data: PDF, scan: true });
  await ex.extract({ contentType: 'image/png', data: PDF });
  assert.deepEqual(calls, ['ocr', 'ocr']);
  assert.ok(defaultExtractor);
});
