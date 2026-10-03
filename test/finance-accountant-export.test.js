import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LAYOUT, VAT_LABEL, buildAccountantExport, verifyExportPackage } from '../src/finance/accountant-export.js';
import { createAccountantExportService } from '../src/finance/accountant-export-service.js';
import { resolvePeriod } from '../src/finance/accountant-package.js';
import { createMerchantClock } from '../src/finance/civil-date.js';
import { loadDocsForReports } from '../src/finance/reports.js';
import { unzip, zip } from '../src/finance/xlsx.js';
import { MERCHANT, MERCHANT_ACTOR, issueInvoice, makeService, CUSTOMER } from './finance-fixtures.js';
import { startApp } from './finance-dashboard-helpers.js';

// Accountant Export V1 (data package). SYNTHETIC data only. The package is realised data: never a Treasury forecast, never a VAT return.
const TZ = 'Europe/Brussels'; const NOW = '2026-10-05T09:00:00.000Z'; const sha = (b) => createHash('sha256').update(b).digest('hex');
const Q3 = { kind: 'quarter', year: 2026, quarter: 3 };
function parseCsv(buf) {
  const text = buf.toString('utf8').replace(/^﻿/, ''); const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\r') { /* skip */ } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c; }
  const [head, ...body] = rows; return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const csv = (pkg, name) => parseCsv(pkg.files.get(name));
function world({ attachments = [], now = NOW } = {}) {
  const w = makeService({ today: '2026-09-30' }); const files = new Map(attachments);
  const ex = createAccountantExportService({ store: w.store, merchantId: MERCHANT, clock: createMerchantClock({ now: () => now, timeZone: TZ }), merchant: { name: 'Exemple Atelier SRL' },
    finance: { listInvoices: () => loadDocsForReports(w.store, MERCHANT) }, inbox: { list: () => w.store.listSupplierInvoices(MERCHANT) }, attachments: { get: async (ref) => files.get(ref) ?? null }, renderPdf: async (doc) => Buffer.from(`%PDF-copy ${doc.number}`), sourceSchemaVersion: '20261005090000' });
  return { ...w, fin: w.svc, ex, files, P: w.svc.payments };
}
const supplier = (over = {}) => ({ merchantId: MERCHANT, supplierName: 'Fournisseur Éléphant', supplierVatNumber: 'BE0000000097', invoiceNumber: `S-${Math.random().toString(36).slice(2, 7)}`, issueDate: '2026-09-01', dueDate: '2026-10-01', netCents: 10000, vatCents: 2100, grossCents: 12100, currency: 'EUR', status: 'TO_PAY', source: 'manual', ...over });
const ids = (pkg, name, key) => csv(pkg, name).map((r) => r[key]);

// ===================================================== PERIOD / TIMEZONE
test('PERIOD: month, quarter, year, custom (inclusive civil dates); invalid is refused', () => {
  assert.deepEqual([resolvePeriod({ kind: 'month', year: 2026, month: 2 }).start, resolvePeriod({ kind: 'month', year: 2026, month: 2 }).end], ['2026-02-01', '2026-02-28']);
  assert.deepEqual([resolvePeriod(Q3).start, resolvePeriod(Q3).end], ['2026-07-01', '2026-09-30']); assert.equal(resolvePeriod({ kind: 'year', year: 2026 }).end, '2026-12-31');
  for (const bad of [{}, { kind: 'month', year: 2026, month: 13 }, { kind: 'custom', from: '2026-03-05', to: '2026-03-04' }]) assert.throws(() => resolvePeriod(bad), (e) => e.code === 'PERIOD_INVALID');
});
test('PERIOD boundaries: first and last day are in, the day before / after are out; the period is in the manifest', async () => {
  const w = world(); const mk = (d) => issueInvoice(w.fin, { issueDate: d }); const inside = [await mk('2026-07-01'), await mk('2026-09-30')]; await mk('2026-06-30'); await mk('2026-10-01');
  const pkg = await w.ex.generate(Q3, { includeDocuments: false }); assert.deepEqual(ids(pkg, 'sales.csv', 'document_id').sort(), inside.map((d) => d.id).sort());
  assert.deepEqual([pkg.manifest.period.start, pkg.manifest.period.end, pkg.manifest.period.label, pkg.manifest.timeZone], ['2026-07-01', '2026-09-30', 'Q3_2026', TZ]);
});
test('TIMEZONE / DST: an allocation reversal belongs to the merchant civil day, not the UTC day (23:30 UTC on the DST night is the 25th in Brussels)', () => {
  const base = { merchant: { id: 'm' }, timeZone: TZ, generatedAt: NOW, documents: [], suppliers: [], bankAccounts: [], bankTransactions: [], reconciliations: [], cashCounts: [], cashMovements: [], registry: [{ id: 'p1', merchantId: 'm', direction: 'IN', paidOn: '2026-09-01', amountCents: 100, currency: 'EUR', createdAt: '2026-09-01T10:00:00Z' }],
    allocations: [{ id: 'a1', merchantId: 'm', paymentId: 'p1', customerDocumentId: 'd', amountCents: -50, currency: 'EUR', reversesAllocationId: 'a0', reason: 'x', createdAt: '2026-10-24T23:30:00.000Z' }] };
  const on25 = buildAccountantExport({ ...base, period: { kind: 'custom', start: '2026-10-25', end: '2026-10-25', label: 'd25' } }); const on24 = buildAccountantExport({ ...base, period: { kind: 'custom', start: '2026-10-24', end: '2026-10-24', label: 'd24' } });
  assert.equal(parseCsv(on25.files.get('payment-allocations.csv'))[0].allocation_date, '2026-10-25'); assert.equal(parseCsv(on24.files.get('payment-allocations.csv')).length, 0);
});

// ===================================================== A. EMPTY PERIOD
test('A. EMPTY PERIOD: a valid package with every file, headers only, 0 rows in the manifest, verifiable', async () => {
  const pkg = await world().ex.generate({ kind: 'month', year: 2030, month: 1 }, { includeDocuments: false });
  for (const [name, cols] of Object.entries(LAYOUT)) { assert.equal(pkg.manifest.rowCounts[name], 0, name); assert.equal(pkg.files.get(name).toString('utf8').replace(/^﻿/, '').split('\r\n')[0], cols.map((c) => c.header).join(','), name); }
  assert.deepEqual(pkg.warnings.filter((w) => w.code !== 'NO_BANK_DATA'), []); assert.equal(verifyExportPackage(pkg.zip).ok, true); assert.equal(pkg.manifest.realisedDataOnly, true); assert.equal(pkg.manifest.treasuryForecastIncluded, false);
});

// ===================================================== B-D. SALES, PAYMENT STATUS, CREDIT NOTE
test('B / C / D. SALES: paid, partially paid, unpaid and credited invoices; amounts and status come from the payment engine', async () => {
  const w = world(); const mk = (o = {}) => issueInvoice(w.fin, { issueDate: '2026-09-10', ...o });
  const paid = await mk(); await w.P.receive({ amountCents: 7190, paidOn: '2026-09-12', method: 'bank_transfer', reference: 'VIR-1', idempotencyKey: 'ae-key-b', allocations: [{ documentId: paid.id, amountCents: 7190 }] }, MERCHANT_ACTOR);
  const part = await mk(); await w.P.receive({ amountCents: 4000, paidOn: '2026-09-12', method: 'cash', idempotencyKey: 'ae-key-c', allocations: [{ documentId: part.id, amountCents: 4000 }] }, MERCHANT_ACTOR);
  const crd = await mk(); await w.P.receive({ amountCents: 4000, paidOn: '2026-09-12', idempotencyKey: 'ae-key-d', allocations: [{ documentId: crd.id, amountCents: 4000 }] }, MERCHANT_ACTOR);
  const cn = await w.fin.createCreditNote(crd.id, { reason: 'return', lines: [{ description: 'Item A', quantity: '1', unitPrice: '10.00', vatRate: '21' }] }, MERCHANT_ACTOR); await w.fin.submit(cn.id, MERCHANT_ACTOR); await w.fin.decide(cn.id, 'APPROVE', MERCHANT_ACTOR);
  const open = await mk(); const pkg = await w.ex.generate(Q3, { includeDocuments: false }); const by = Object.fromEntries(csv(pkg, 'sales.csv').map((r) => [r.document_id, r]));
  assert.deepEqual([by[paid.id].payment_status, by[paid.id].gross, by[paid.id].allocated, by[paid.id].remaining, by[paid.id].payment_references], ['PAID', '71.90', '71.90', '0.00', 'VIR-1']);
  assert.deepEqual([by[part.id].payment_status, by[part.id].allocated, by[part.id].remaining], ['PARTIALLY_PAID', '40.00', '31.90']);
  assert.deepEqual([by[crd.id].gross, by[crd.id].credited, by[crd.id].effective_due, by[crd.id].allocated, by[crd.id].remaining, by[crd.id].payment_status], ['71.90', '12.10', '59.80', '40.00', '19.80', 'PARTIALLY_PAID']);
  assert.equal(by[open.id].payment_status, 'UNPAID'); assert.equal(by[open.id].customer_vat_number, CUSTOMER.vatNumber); assert.match(by[open.id].source_snapshot_sha256, /^[0-9a-f]{64}$/);
  const c = csv(pkg, 'credit-notes.csv'); assert.equal(c.length, 1); assert.deepEqual([c[0].original_invoice_number, c[0].gross], [crd.number, '12.10']);
  assert.equal(csv(pkg, 'payments.csv').length, 3); assert.equal(csv(pkg, 'payment-allocations.csv').length, 3);
});
test('OLD STATUS IS NOT AUTHORITY: a stored PAID status with no payment does not make an invoice paid in the export', async () => {
  const w = world(); const inv = await issueInvoice(w.fin, { issueDate: '2026-09-10' }); const docs = await loadDocsForReports(w.store, MERCHANT);
  const forged = docs.map((x) => (x.doc.id === inv.id ? { ...x, doc: { ...x.doc, status: 'PAID' } } : x));
  const pkg = buildAccountantExport({ merchant: { id: MERCHANT }, period: { kind: 'quarter', start: '2026-07-01', end: '2026-09-30', label: 'Q3_2026' }, timeZone: TZ, generatedAt: NOW, documents: forged, suppliers: [], registry: [], allocations: [], bankAccounts: [], bankTransactions: [], reconciliations: [], cashCounts: [], cashMovements: [] });
  const r = parseCsv(pkg.files.get('sales.csv'))[0]; assert.deepEqual([r.document_status, r.payment_status, r.remaining], ['PAID', 'UNPAID', '71.90']);
});

// ===================================================== E. PURCHASES
test('E. PURCHASES: partially paid supplier invoice -> remaining; validation state; accents and IBAN/VAT carried; unvalidated flagged', async () => {
  const w = world(); const s1 = await w.store.saveSupplierInvoice(supplier({ supplierIban: 'BE68539007547034' })); const s2 = await w.store.saveSupplierInvoice(supplier({ status: 'RECEIVED', invoiceNumber: 'S-NEW' }));
  await w.P.pay({ amountCents: 5000, paidOn: '2026-09-20', method: 'bank_transfer', idempotencyKey: 'ae-key-e', allocations: [{ supplierInvoiceId: s1.id, amountCents: 5000 }] }, MERCHANT_ACTOR);
  const pkg = await w.ex.generate(Q3, { includeDocuments: false }); const by = Object.fromEntries(csv(pkg, 'purchases.csv').map((r) => [r.purchase_id, r]));
  assert.deepEqual([by[s1.id].gross, by[s1.id].allocated, by[s1.id].remaining, by[s1.id].payment_state, by[s1.id].validation_status, by[s1.id].supplier_name, by[s1.id].supplier_iban, by[s1.id].supplier_vat_number], ['121.00', '50.00', '71.00', 'PARTIALLY_PAID', 'TO_PAY', 'Fournisseur Éléphant', 'BE68539007547034', 'BE0000000097']);
  assert.equal(by[s2.id].validation_status, 'RECEIVED'); assert.ok(pkg.warnings.some((x) => x.code === 'UNVALIDATED_PURCHASES' && x.count === 1));
  assert.match(pkg.files.get('purchases.csv').toString('utf8'), /Fournisseur Éléphant/, 'UTF-8 intact'); assert.equal(pkg.files.get('purchases.csv')[0], 0xef, 'BOM for Excel');
});

// ===================================================== F-H. BANK, REFUNDS
test('F / G. BANK: reconciled and partially reconciled transactions expose reconciled / remaining / linked payments / status (never matched_*)', async () => {
  const w = world(); const at = '2026-10-03T10:00:00.000Z'; const row = (tag, cents) => ({ merchantId: MERCHANT, accountId: 'acc-1', providerTxId: tag, date: '2026-09-15', amountCents: cents, currency: 'EUR', source: 'bank', status: 'NEW', counterpartyName: 'Client Éco', reference: tag });
  await w.store.insertBankTransactionsBatch([row('t-full', 7190), row('t-part', 10000), row('t-none', 500), { ...row('t-old', 999), date: '2026-05-01' }]);
  const tx = async (tag) => (await w.store.listBankTransactions({ merchantId: MERCHANT })).find((t) => t.providerTxId === tag);
  const inv = await issueInvoice(w.fin, { issueDate: '2026-09-10' });
  const full = await w.store.reconcileAndPay({ merchantId: MERCHANT, key: 'ae-key-f', transactionId: (await tx('t-full')).id, actor: MERCHANT_ACTOR, at, payment: { amountCents: 7190, method: 'bank_transfer', allocations: [{ customerDocumentId: inv.id, amountCents: 7190 }] } });
  const part = await w.store.reconcileAndPay({ merchantId: MERCHANT, key: 'ae-key-g', transactionId: (await tx('t-part')).id, actor: MERCHANT_ACTOR, at, payment: { amountCents: 3000, method: 'bank_transfer', allocations: [] } });
  const pkg = await w.ex.generate(Q3, { includeDocuments: false }); const by = Object.fromEntries(csv(pkg, 'bank-transactions.csv').map((r) => [r.provider_tx_id, r]));
  assert.deepEqual([by['t-full'].reconciliation_status, by['t-full'].reconciled, by['t-full'].remaining, by['t-full'].linked_payment_ids], ['RECONCILED', '71.90', '0.00', full.payment.id]);
  assert.deepEqual([by['t-part'].reconciliation_status, by['t-part'].reconciled, by['t-part'].remaining, by['t-part'].linked_payment_ids], ['PARTIALLY_RECONCILED', '30.00', '70.00', part.payment.id]);
  assert.equal(by['t-none'].reconciliation_status, 'UNRECONCILED'); assert.equal(by['t-old'], undefined, 'outside the period'); assert.equal(csv(pkg, 'bank-reconciliations.csv').length, 2);
  assert.ok(pkg.warnings.some((x) => x.code === 'UNRECONCILED_BANK_TRANSACTIONS' && x.count === 2)); assert.equal(csv(pkg, 'bank-accounts.csv')[0].origin, 'PROVIDER');
  assert.equal(csv(pkg, 'payments.csv').find((p) => p.payment_id === full.payment.id).bank_reconciled, '71.90'); assert.ok(!pkg.files.get('bank-transactions.csv').toString('utf8').includes('matched_'));
});
test('H. REFUND / REVERSAL: a refund of a credit note, a reversed allocation and a voided payment are visible and explained', async () => {
  const w = world(); const inv = await issueInvoice(w.fin, { issueDate: '2026-09-10' });
  const pay = await w.P.receive({ amountCents: 7190, paidOn: '2026-09-12', idempotencyKey: 'ae-key-h1', allocations: [{ documentId: inv.id, amountCents: 7190 }] }, MERCHANT_ACTOR);
  const cn = await w.fin.createCreditNote(inv.id, { reason: 'return', lines: [{ description: 'Item A', quantity: '1', unitPrice: '10.00', vatRate: '21' }] }, MERCHANT_ACTOR); await w.fin.submit(cn.id, MERCHANT_ACTOR); const cnIssued = await w.fin.decide(cn.id, 'APPROVE', MERCHANT_ACTOR);
  const rf = await w.P.refund(cn.id, { amountCents: 1210, paidOn: '2026-09-26', method: 'bank_transfer', idempotencyKey: 'ae-key-h2', refundOfPaymentId: pay.payment.id }, MERCHANT_ACTOR);
  const inv2 = await issueInvoice(w.fin, { issueDate: '2026-09-11' }); const p2 = await w.P.receive({ amountCents: 1000, paidOn: '2026-09-13', idempotencyKey: 'ae-key-h3', allocations: [{ documentId: inv2.id, amountCents: 1000 }] }, MERCHANT_ACTOR);
  await w.P.reverseAllocation((await w.store.listAllocations({ merchantId: MERCHANT, customerDocumentId: inv2.id }))[0].id, { reason: 'wrong invoice', idempotencyKey: 'ae-key-h4' }, MERCHANT_ACTOR);
  const p3 = await w.P.receive({ amountCents: 500, paidOn: '2026-09-14', idempotencyKey: 'ae-key-h5', allocations: [] }, MERCHANT_ACTOR); await w.P.voidPayment(p3.payment.id, { reason: 'duplicate', idempotencyKey: 'ae-key-h6' }, MERCHANT_ACTOR);
  const pkg = await w.ex.generate(Q3, { includeDocuments: false }); const kinds = csv(pkg, 'refunds-reversals.csv'); const k = (name) => kinds.filter((r) => r.kind === name);
  assert.equal(k('REFUND').length, 1); assert.deepEqual([k('REFUND')[0].record_id, k('REFUND')[0].amount, k('REFUND')[0].linked_document_number, k('REFUND')[0].refund_of_payment_id], [rf.payment.id, '-12.10', cnIssued.number, pay.payment.id]); assert.match(k('REFUND')[0].explanation, /^REFUND_OF_A_CREDIT_NOTE/);
  assert.equal(k('ALLOCATION_REVERSAL').length, 1); assert.deepEqual([k('ALLOCATION_REVERSAL')[0].amount, k('ALLOCATION_REVERSAL')[0].reason], ['-10.00', 'wrong invoice']);
  assert.equal(k('PAYMENT_VOID').length, 1); assert.match(k('PAYMENT_VOID')[0].explanation, /^REVERSAL_OF_A_PAYMENT/); assert.equal(k('PAYMENT_VOID')[0].reverses_id, p3.payment.id); void p2;
});

// ===================================================== CASH
test('CASH: confirmed counts and movements of the period, with signs', async () => {
  const w = world(); await w.store.insertCashCount({ merchantId: MERCHANT, amountCents: 35000, countedOn: '2026-09-10', note: 'caisse', createdAt: NOW }); await w.store.insertCashCount({ merchantId: MERCHANT, amountCents: 1, countedOn: '2026-01-10', note: null, createdAt: NOW });
  await w.store.insertCashMovement({ merchantId: MERCHANT, kind: 'CASH_IN', amountCents: 1000, date: '2026-09-11', note: 'vente', createdAt: NOW }); await w.store.insertCashMovement({ merchantId: MERCHANT, kind: 'DEPOSIT_TO_BANK', amountCents: 500, date: '2026-09-12', note: null, createdAt: NOW });
  const r = csv(await w.ex.generate(Q3, { includeDocuments: false }), 'cash.csv'); assert.deepEqual(r.map((x) => [x.record_type, x.kind, x.amount]), [['COUNT', 'CONFIRMED_COUNT', '350.00'], ['MOVEMENT', 'CASH_IN', '10.00'], ['MOVEMENT', 'DEPOSIT_TO_BANK', '-5.00']]);
});

// ===================================================== VAT SUMMARY
test('VAT SUMMARY: informational, by stream / currency / rate; credit notes distinct; purchases without a recorded rate are flagged, never guessed', async () => {
  const w = world(); const inv = await issueInvoice(w.fin, { issueDate: '2026-09-10' }); const cn = await w.fin.createCreditNote(inv.id, { reason: 'r', lines: [{ description: 'Item A', quantity: '1', unitPrice: '10.00', vatRate: '21' }] }, MERCHANT_ACTOR); await w.fin.submit(cn.id, MERCHANT_ACTOR); await w.fin.decide(cn.id, 'APPROVE', MERCHANT_ACTOR);
  await w.store.saveSupplierInvoice(supplier({ vatBreakdown: [{ taxableCents: 10000, vatCents: 2100, rateBp: 2100 }] })); await w.store.saveSupplierInvoice(supplier({ netCents: 5000, vatCents: 300, grossCents: 5300 }));
  const rows = csv(await w.ex.generate(Q3, { includeDocuments: false }), 'vat-summary.csv'); const pick = (s, rate) => rows.find((r) => r.stream === s && r.rate_percent === rate);
  assert.deepEqual([pick('SALES', '21').taxable_base, pick('SALES', '21').vat_amount, pick('SALES', '6').taxable_base, pick('SALES', '6').vat_amount], ['20.00', '4.20', '45.00', '2.70']);
  assert.deepEqual([pick('CREDIT_NOTES', '21').taxable_base, pick('CREDIT_NOTES', '21').vat_amount], ['10.00', '2.10']); assert.deepEqual([pick('PURCHASES', '21').taxable_base, pick('PURCHASES', '21').vat_amount], ['100.00', '21.00']);
  assert.deepEqual([pick('PURCHASES', '').treatment, pick('PURCHASES', '').taxable_base, pick('PURCHASES', '').vat_amount], ['RATE_NOT_RECORDED', '50.00', '3.00']); assert.ok(rows.every((r) => r.label === VAT_LABEL));
});

// ===================================================== MISSING ARTIFACTS / PDF TRUTH
test('I. MISSING ARTIFACTS: issued PDFs are reported as not archived (a regenerated copy is labelled, never the original); a validated purchase without a source file is missing; present files are not', async () => {
  const w = world({ attachments: [['ref-ok', { data: Buffer.from('%PDF source') }]] }); const inv = await issueInvoice(w.fin, { issueDate: '2026-09-10' });
  const ok = await w.store.saveSupplierInvoice(supplier({ attachmentRef: 'ref-ok', sha256: sha(Buffer.from('%PDF source')), fileName: 'f.pdf', contentType: 'application/pdf' })); const none = await w.store.saveSupplierInvoice(supplier({ invoiceNumber: 'S-NOFILE' }));
  const gone = await w.store.saveSupplierInvoice(supplier({ invoiceNumber: 'S-GONE', attachmentRef: 'ref-gone', contentType: 'application/pdf' }));
  const withDocs = await w.ex.generate(Q3, { includeDocuments: true }); const m = csv(withDocs, 'missing-artifacts.csv'); const by = (id) => m.find((r) => r.source_id === id);
  assert.deepEqual([by(inv.id).expected_artifact, by(inv.id).status, by(inv.id).reason, by(inv.id).alternative_provided], ['PDF_ARCHIVED_ORIGINAL', 'MISSING', 'NOT_ARCHIVED_AT_ISSUANCE', 'REGENERATED_COPY']);
  assert.deepEqual([by(none.id).reason, by(gone.id).reason, by(ok.id)], ['NO_ATTACHMENT', 'ATTACHMENT_FILE_NOT_FOUND', undefined]); assert.equal(csv(withDocs, 'sales.csv')[0].pdf_status, 'REGENERATED_COPY');
  const sources = Object.fromEntries(csv(withDocs, 'purchases.csv').map((r) => [r.purchase_id, r.source_document_status])); assert.deepEqual([sources[ok.id], sources[none.id], sources[gone.id]], ['ARCHIVED_ORIGINAL', 'MISSING', 'MISSING']);
  assert.ok([...withDocs.files.keys()].some((n) => /^documents\/sales\/.*REGENERATED-COPY\.pdf$/.test(n))); assert.ok([...withDocs.files.keys()].some((n) => n.startsWith('documents/purchases/')));
  assert.deepEqual([withDocs.manifest.pdfArchive.archivedOriginal, withDocs.manifest.pdfArchive.regeneratedCopy, withDocs.manifest.pdfArchive.missing], [0, 1, 0]);
  const noDocs = await w.ex.generate(Q3, { includeDocuments: false }); assert.equal(csv(noDocs, 'missing-artifacts.csv').find((r) => r.source_id === inv.id).alternative_provided, 'NONE'); assert.equal(noDocs.manifest.pdfArchive.missing, 1); assert.equal(csv(noDocs, 'sales.csv')[0].pdf_status, 'MISSING');
  assert.ok(withDocs.warnings.some((x) => x.code === 'PDF_NOT_ARCHIVED_AT_ISSUANCE')); assert.ok(withDocs.warnings.some((x) => x.code === 'SOURCE_DOCUMENT_MISSING' && x.count === 2));
});

// ===================================================== MANIFEST / HASHES / TAMPER / REPRODUCIBILITY
test('MANIFEST: every artifact has rows and SHA-256; the README explains; the package verifies; tampering is detected (modified, missing, added, forged manifest line)', async () => {
  const w = world(); await issueInvoice(w.fin, { issueDate: '2026-09-10' }); const pkg = await w.ex.generate(Q3, { includeDocuments: true });
  for (const f of pkg.manifest.files) { assert.equal(f.sha256, sha(pkg.files.get(f.path)), f.path); assert.ok(f.bytes > 0); }
  assert.equal(pkg.manifest.files.find((f) => f.path === 'sales.csv').rows, 1); assert.deepEqual([pkg.manifest.exportVersion, pkg.manifest.merchant.id, pkg.manifest.generatedAt, pkg.manifest.sourceSchemaVersion], ['1.0', MERCHANT, NOW, '20261005090000']);
  const readme = pkg.files.get('README.txt').toString('utf8'); for (const s of ['Exemple Atelier SRL', '2026-07-01 au 2026-09-30', NOW, VAT_LABEL, 'sha256sum -c SHA256SUMS.txt', 'REGENERATED_COPY', 'missing-artifacts.csv', 'jamais additionnées']) assert.ok(readme.includes(s), s);
  assert.equal(verifyExportPackage(pkg.zip).ok, true);
  const entries = unzip(pkg.zip); const root = [...entries.keys()][0].split('/')[0]; const rebuild = (mut) => { const m = new Map(entries); mut(m); return zip([...m].map(([name, data]) => ({ name, data }))); };
  const bad = (z, code) => { const v = verifyExportPackage(z); assert.equal(v.ok, false); assert.ok(v.problems.some((p) => p.code === code), JSON.stringify(v.problems)); };
  bad(rebuild((m) => m.set(`${root}/sales.csv`, Buffer.concat([m.get(`${root}/sales.csv`), Buffer.from('x')]))), 'FILE_MODIFIED'); bad(rebuild((m) => m.delete(`${root}/payments.csv`)), 'FILE_MISSING'); bad(rebuild((m) => m.set(`${root}/extra.csv`, Buffer.from('x'))), 'FILE_NOT_IN_MANIFEST');
  bad(rebuild((m) => { const mf = JSON.parse(m.get(`${root}/manifest.json`)); mf.files[0].sha256 = '0'.repeat(64); m.set(`${root}/manifest.json`, Buffer.from(JSON.stringify(mf))); }), 'FILE_MODIFIED'); bad(zip([{ name: 'x/a.txt', data: Buffer.from('a') }]), 'MANIFEST_MISSING');
});
test('J. REPRODUCIBILITY: same data + same parameters -> identical business content (byte-identical CSV, same fingerprint); only generated_at differs', async () => {
  const w = world(); const inv = await issueInvoice(w.fin, { issueDate: '2026-09-10' }); await w.P.receive({ amountCents: 1000, paidOn: '2026-09-12', idempotencyKey: 'ae-key-j', allocations: [{ documentId: inv.id, amountCents: 1000 }] }, MERCHANT_ACTOR); await w.store.saveSupplierInvoice(supplier());
  const a = await w.ex.generate(Q3, { includeDocuments: false }); const b = world({ now: '2027-01-01T00:00:00.000Z' }); b.store = null;
  const again = await w.ex.generate(Q3, { includeDocuments: false }); for (const n of Object.keys(LAYOUT)) assert.equal(sha(a.files.get(n)), sha(again.files.get(n)), n); assert.equal(a.contentFingerprint, again.contentFingerprint);
  const later = createAccountantExportService({ store: w.store, merchantId: MERCHANT, clock: createMerchantClock({ now: () => '2027-01-01T00:00:00.000Z', timeZone: TZ }), merchant: { name: 'Exemple Atelier SRL' }, finance: { listInvoices: () => loadDocsForReports(w.store, MERCHANT) }, inbox: { list: () => w.store.listSupplierInvoices(MERCHANT) } });
  const c = await later.generate(Q3, { includeDocuments: false }); assert.equal(c.contentFingerprint, a.contentFingerprint); assert.notEqual(c.manifest.generatedAt, a.manifest.generatedAt); assert.notEqual(c.sha256, a.sha256, 'the ZIP carries generated_at');
  const cols = (n) => a.files.get(n).toString('utf8').split('\r\n')[0]; for (const n of Object.keys(LAYOUT)) assert.equal(cols(n), LAYOUT[n].map((x) => x.header).join(',').replace(/^/, '﻿')); void b;
});
test('ORDERING: rows are sorted by date, number and id regardless of the input order', () => {
  const mk = (n, d) => ({ doc: { id: n, merchantId: 'm', type: 'invoice', number: n, lockedAt: 'x', status: 'ISSUED', issueDate: d, currency: 'EUR', customer: { name: 'c' }, totals: { netCents: 100, vatCents: 21, grossCents: 121, vatBreakdown: [] }, snapshotHash: 'h' }, payments: [], creditNotes: [], refunds: [] });
  const input = (docs) => ({ merchant: { id: 'm' }, period: { kind: 'custom', start: '2026-01-01', end: '2026-12-31', label: 'y' }, timeZone: TZ, generatedAt: NOW, documents: docs, suppliers: [], registry: [], allocations: [], bankAccounts: [], bankTransactions: [], reconciliations: [], cashCounts: [], cashMovements: [] });
  const docs = [mk('B', '2026-03-01'), mk('A', '2026-03-01'), mk('C', '2026-01-01')]; const one = buildAccountantExport(input(docs)); const two = buildAccountantExport(input([...docs].reverse()));
  assert.deepEqual(parseCsv(one.files.get('sales.csv')).map((r) => r.number), ['C', 'A', 'B']); assert.equal(one.contentFingerprint, two.contentFingerprint);
});

// ===================================================== K. CURRENCY / ISOLATION / ROBUSTNESS / PRIVACY
test('K. MIXED CURRENCIES: totals are per currency, never one global total; the warning says so', () => {
  const mk = (id, cur, gross) => ({ doc: { id, merchantId: 'm', type: 'invoice', number: id, lockedAt: 'x', status: 'ISSUED', issueDate: '2026-03-01', currency: cur, customer: { name: 'c' }, totals: { netCents: gross, vatCents: 0, grossCents: gross, vatBreakdown: [{ vatRateBp: 0, taxableCents: gross, vatCents: 0 }] }, snapshotHash: 'h' }, payments: [], creditNotes: [], refunds: [] });
  const p = buildAccountantExport({ merchant: { id: 'm' }, period: { kind: 'custom', start: '2026-01-01', end: '2026-12-31', label: 'y' }, timeZone: TZ, generatedAt: NOW, documents: [mk('E1', 'EUR', 10000), mk('U1', 'USD', 5000)], suppliers: [], registry: [], allocations: [], bankAccounts: [], bankTransactions: [], reconciliations: [], cashCounts: [], cashMovements: [] });
  assert.deepEqual(p.manifest.currencies, ['EUR', 'USD']); assert.equal(p.manifest.totalsByCurrency.EUR.salesGross, '100.00'); assert.equal(p.manifest.totalsByCurrency.USD.salesGross, '50.00'); assert.ok(!('totals' in p.manifest) && !JSON.stringify(p.manifest).includes('150.00'));
  assert.ok(p.warnings.some((w) => w.code === 'MIXED_CURRENCIES')); const vat = parseCsv(p.files.get('vat-summary.csv')); assert.deepEqual(vat.map((r) => r.currency).sort(), ['EUR', 'USD']);
});
test('MERCHANT ISOLATION: rows of another merchant never enter the package', () => {
  const doc = (id, m) => ({ doc: { id, merchantId: m, type: 'invoice', number: id, lockedAt: 'x', status: 'ISSUED', issueDate: '2026-03-01', currency: 'EUR', customer: { name: 'c' }, totals: { netCents: 100, vatCents: 0, grossCents: 100, vatBreakdown: [] }, snapshotHash: 'h' }, payments: [], creditNotes: [], refunds: [] });
  const p = buildAccountantExport({ merchant: { id: 'm' }, period: { kind: 'custom', start: '2026-01-01', end: '2026-12-31', label: 'y' }, timeZone: TZ, generatedAt: NOW, documents: [doc('mine', 'm'), doc('theirs', 'other')], suppliers: [{ id: 's', merchantId: 'other', issueDate: '2026-03-01', status: 'PAID', grossCents: 1 }],
    registry: [{ id: 'p', merchantId: 'other', paidOn: '2026-03-01', direction: 'IN', amountCents: 1, currency: 'EUR' }], allocations: [], bankAccounts: [{ id: 'a', merchantId: 'other', externalId: 'x', currency: 'EUR' }], bankTransactions: [{ id: 't', merchantId: 'other', date: '2026-03-01', amountCents: 1, currency: 'EUR' }], reconciliations: [], cashCounts: [], cashMovements: [{ id: 'c', merchantId: 'other', kind: 'CASH_IN', date: '2026-03-01', amountCents: 1 }] });
  assert.deepEqual(parseCsv(p.files.get('sales.csv')).map((r) => r.document_id), ['mine']); for (const n of ['purchases.csv', 'payments.csv', 'bank-accounts.csv', 'bank-transactions.csv', 'cash.csv']) assert.equal(parseCsv(p.files.get(n)).length, 0, n);
});
test('ROBUSTNESS: malformed / missing optional fields never throw and never invent data (blank, not zero)', () => {
  const p = buildAccountantExport({ merchant: { id: 'm' }, period: { kind: 'custom', start: '2026-01-01', end: '2026-12-31', label: 'y' }, timeZone: TZ, generatedAt: NOW, documents: [], suppliers: [{ id: 's1', merchantId: 'm', issueDate: '2026-02-01', status: 'VALIDATED' }, { id: 's2', merchantId: 'm', issueDate: 'garbage', status: 'PAID', grossCents: 5 }, { id: 's3', merchantId: 'm', issueDate: '2026-02-02', status: 'VALIDATED', grossCents: 100, netCents: 'x', vatBreakdown: 'oops' }],
    registry: [], allocations: [], bankAccounts: [], bankTransactions: [{ id: 't', merchantId: 'm', date: '2026-02-01', amountCents: -250, currency: 'EUR' }], reconciliations: [], cashCounts: [], cashMovements: [] });
  const r = parseCsv(p.files.get('purchases.csv')); assert.equal(r.length, 2); assert.deepEqual([r[0].gross, r[0].remaining, r[0].supplier_name], ['', '', '']); assert.equal(r[1].net, ''); assert.equal(parseCsv(p.files.get('bank-transactions.csv'))[0].reconciliation_status, 'UNRECONCILED');
});
test('PRIVACY: no secret, token, credential or full own-bank identifier in any file; whitelisted columns only; no Treasury data', async () => {
  const w = world(); await issueInvoice(w.fin, { issueDate: '2026-09-10' }); await w.store.upsertBankBalance({ merchantId: MERCHANT, accountId: 'acc-1', iban: 'BE68539007547034', balanceCents: 100, currency: 'EUR', asOf: '2026-09-30T08:00:00Z' });
  await w.store.insertBankTransactionsBatch([{ merchantId: MERCHANT, accountId: 'acc-1', providerTxId: 'p1', date: '2026-09-15', amountCents: 100, currency: 'EUR', source: 'bank', status: 'NEW', counterpartyAccountMasked: 'BE12 **** **** 3456' }]); await w.store.saveBankConnection?.({ merchantId: MERCHANT, provider: 'x' });
  const pkg = await w.ex.generate(Q3, { includeDocuments: true }); const all = [...pkg.files.entries()].filter(([n]) => !n.endsWith('.pdf')).map(([, d]) => d.toString('utf8')).join('\n');
  const clean = all.replace(/treasuryForecastIncluded|realisedDataOnly/g, '');
  assert.equal(/token|secret|password|api[_-]?key|bearer|authorization|vault|consent|BE68539007547034|projected|forecast|scenario|treasury/i.exec(clean)?.[0] ?? null, null, 'no secret / forecast wording');
  assert.match(all, /BE68 \*{4} \*{4} 7034|^﻿?account_id/m); for (const [n, cols] of Object.entries(LAYOUT)) assert.deepEqual(Object.keys(parseCsv(pkg.files.get(n))[0] ?? Object.fromEntries(cols.map((c) => [c.key, '']))), cols.map((c) => c.key), n);
  assert.ok(!pkg.files.has('treasury.csv') && !JSON.stringify(pkg.manifest).includes('treasury"')); const src = readFileSync(new URL('../src/finance/accountant-export.js', import.meta.url), 'utf8'); assert.ok(!/treasury-(engine|service)/.test(src), 'the builder never imports Treasury'); assert.ok(!/fin_payments|listPaymentsForMerchant/.test(src), 'the legacy payments table is not a source');
});

// ===================================================== L. UTF-8, EVENTS, API, VOLUME
test('L. UTF-8: French and Dutch accents survive in CSV, README and manifest', async () => {
  const w = world(); await w.store.saveSupplierInvoice(supplier({ supplierName: 'Brasserie Ça Mousse – Spaß & Zoë « Gèrard »', invoiceNumber: 'N°1/été' })); const pkg = await w.ex.generate(Q3, { includeDocuments: false });
  assert.equal(csv(pkg, 'purchases.csv')[0].supplier_name, 'Brasserie Ça Mousse – Spaß & Zoë « Gèrard »'); assert.equal(csv(pkg, 'purchases.csv')[0].invoice_number, 'N°1/été'); assert.ok(pkg.files.get('README.txt').toString('utf8').includes('PÉRIODE'.toLowerCase().replace('période', 'Période')));
  assert.equal(JSON.parse(pkg.files.get('manifest.json').toString('utf8')).merchant.name, 'Exemple Atelier SRL');
});
test('AUDIT: generating records ONE event with the package identity; history lists it; no new table, nothing else is written', async () => {
  const w = world(); await issueInvoice(w.fin, { issueDate: '2026-09-10' }); const before = JSON.stringify([await w.store.listRegistry(MERCHANT), await w.store.listBankTransactions({ merchantId: MERCHANT })]);
  const pkg = await w.ex.generate(Q3, { includeDocuments: false, actor: MERCHANT_ACTOR }); const h = await w.ex.history(); assert.equal(h.length, 1); assert.deepEqual([h[0].zipSha256, h[0].contentFingerprint, h[0].period.label], [pkg.sha256, pkg.contentFingerprint, 'Q3_2026']);
  assert.equal(JSON.stringify([await w.store.listRegistry(MERCHANT), await w.store.listBankTransactions({ merchantId: MERCHANT })]), before); await w.ex.preview(Q3); assert.equal((await w.ex.history()).length, 1, 'a preview writes nothing');
});
test('API: preview, generate (verified, downloadable ZIP), invalid period, history', async () => {
  const a = await startApp({}); try {
    const c = await a.authed(); const pv = await c.get('/api/accountant-export/preview?kind=quarter&year=2026&quarter=3'); assert.equal(pv.status, 200); assert.equal(pv.data.period.label, 'Q3_2026'); assert.ok(pv.data.rowCounts['sales.csv'] >= 0);
    assert.equal((await c.get('/api/accountant-export/preview?kind=month&year=2026&month=14')).status, 422);
    const g = await c.post('/api/accountant-export/generate', { kind: 'quarter', year: 2026, quarter: 3, includeDocuments: false }); assert.equal(g.status, 200); assert.equal(g.data.verified, true); assert.match(g.data.sha256, /^[0-9a-f]{64}$/);
    const hist = await c.get('/api/accountant-export/history'); assert.equal(hist.data.rows.length, 1); assert.equal((await c.get('/api/accountant-export/nope/download')).status, 404); assert.equal((await c.get(g.data.downloadUrl)).status, 200);

  } finally { await a.close(); }
});
test('VOLUME: 3 000 invoices, 1 500 supplier invoices, 4 500 payments + allocations, 15 000 bank transactions -> no per-row query, around a second', async () => {
  const N = 3000; const doc = (i) => ({ doc: { id: `d${i}`, merchantId: 'm', type: 'invoice', number: `F-${i}`, lockedAt: 'x', status: 'ISSUED', issueDate: `2026-0${1 + (i % 9)}-1${i % 9}`, dueDate: '2026-12-01', currency: 'EUR', customer: { name: `Client ${i}`, vatNumber: 'BE0000000097' }, totals: { netCents: 10000, vatCents: 2100, grossCents: 12100, vatBreakdown: [{ vatRateBp: 2100, taxableCents: 10000, vatCents: 2100 }] }, snapshotHash: 'h' }, payments: i % 2 ? [{ amountCents: 5000 }] : [], creditNotes: [], refunds: [] });
  const registry = Array.from({ length: 4500 }, (_, i) => ({ id: `p${i}`, merchantId: 'm', direction: 'IN', paidOn: `2026-0${1 + (i % 9)}-15`, amountCents: 5000, currency: 'EUR', createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z` }));
  const allocations = registry.map((p, i) => ({ id: `a${i}`, merchantId: 'm', paymentId: p.id, customerDocumentId: `d${i % N}`, amountCents: 5000, currency: 'EUR', createdAt: p.createdAt }));
  const reconciliations = Array.from({ length: 5000 }, (_, i) => ({ id: `r${i}`, merchantId: 'm', bankTransactionId: `t${i}`, paymentId: `p${i % 4500}`, kind: 'MATCH', amountCents: 100, currency: 'EUR', createdAt: '2026-02-01T00:00:00Z' }));
  const bankTransactions = Array.from({ length: 15000 }, (_, i) => ({ id: `t${i}`, merchantId: 'm', accountId: 'a', bankAccountId: 'ba', date: `2026-0${1 + (i % 9)}-10`, amountCents: i % 3 ? -1234 : 4321, currency: 'EUR', providerTxId: `x${i}`, source: 'csv', reconciliationStatus: i % 5 ? 'UNRECONCILED' : 'RECONCILED', reconciledCents: 0, ignoredCents: 0, remainingCents: 100 }));
  const suppliers = Array.from({ length: 1500 }, (_, i) => ({ id: `s${i}`, merchantId: 'm', issueDate: `2026-0${1 + (i % 9)}-05`, status: 'TO_PAY', supplierName: `F ${i}`, grossCents: 12100, netCents: 10000, vatCents: 2100, currency: 'EUR', allocatedCents: i % 3 ? 100 : 0, attachmentRef: i % 4 ? `r${i}` : null }));
  const t0 = performance.now(); const p = buildAccountantExport({ merchant: { id: 'm' }, period: { kind: 'year', start: '2026-01-01', end: '2026-12-31', label: '2026' }, timeZone: TZ, generatedAt: NOW, documents: Array.from({ length: N }, (_, i) => doc(i)), suppliers, registry, allocations, bankAccounts: [], bankTransactions, reconciliations, cashCounts: [], cashMovements: [] });
  const ms = performance.now() - t0; assert.equal(p.rowCounts['sales.csv'], N); assert.equal(p.rowCounts['bank-transactions.csv'], 15000); assert.equal(verifyExportPackage(p.zip).ok, true); assert.ok(ms < 6000, `${ms.toFixed(0)} ms`);
  console.log(`  accountant export volume: ${N} invoices, ${suppliers.length} supplier invoices, ${registry.length} payments, ${allocations.length} allocations, ${bankTransactions.length} bank transactions, ${reconciliations.length} reconciliations -> ${(p.size / 1024 / 1024).toFixed(1)} MB zip in ${ms.toFixed(0)} ms`);
  const reads = []; const store = new Proxy({}, { get: (_, k) => async () => { reads.push(String(k)); return []; } }); const svc = createAccountantExportService({ store, merchantId: 'm', clock: createMerchantClock({ now: () => NOW, timeZone: TZ }), finance: { listInvoices: async () => { reads.push('listInvoices'); return []; } }, inbox: { list: async () => { reads.push('inbox.list'); return []; } } });
  await svc.preview(Q3); assert.equal(reads.length, new Set(reads).size, 'each source is read exactly once'); assert.equal(reads.length, 9);
});
