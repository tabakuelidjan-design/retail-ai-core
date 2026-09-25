import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { crc32, unzip } from '../src/finance/xlsx.js';
import { changesSince, documentFileName, fingerprintOf, namePart, packLabel } from '../src/finance/pack-comptable.js';
import { imageToPdf, jpegOrientation, expenseValidationErrors } from '../src/finance/expense-capture.js';
import { validatePeppolReadiness } from '../src/finance/peppol.js';
import { baseSettings, invoiceBody, startApp } from './finance-dashboard-helpers.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const Q3 = { kind: 'quarter', year: 2026, quarter: 3 };
const HIST = { history: { completeFrom: '2026-05-11', storeCreatedOn: '2026-05-11', lastSyncedAt: '2026-10-05T00:00:00.000Z' }, today: '2026-10-05' };
const withApp = (opts, fn) => async () => { const a = await startApp(opts); try { await fn(a, await a.authed()); } finally { await a.close(); } };

// ---- synthetic files (no real document, no real merchant data) ----
function makePng(w = 6, h = 4) {
  const chunk = (type, data) => { const t = Buffer.from(type, 'latin1'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 40 + x * 20; raw[o + 1] = 90 + y * 30; raw[o + 2] = 160; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const tinyPdf = (tag = 'a') => Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${tag}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1');
const b64 = (b) => b.toString('base64');

async function issue(c, over = {}) {
  const d = (await c.post('/api/documents', invoiceBody(over))).data; await c.post(`/api/documents/${d.id}/submit`, {});
  const r = await c.post(`/api/documents/${d.id}/approve`, {}); assert.equal(r.status, 200, JSON.stringify(r.data)); return d.id;
}
/** A validated supplier document typed in by hand (amounts in the given currency). */
async function purchase(c, over = {}) {
  const body = { supplierName: 'Fournisseur Exemple', supplierVatNumber: 'BE0000000097', invoiceNumber: 'F-100', issueDate: '2026-08-14', net: '100.00', vat: '21.00', gross: '121.00', currency: 'EUR', ...over };
  const r = await c.post('/api/inbox/manual', body); assert.equal(r.status, 201, JSON.stringify(r.data));
  const v = await c.post(`/api/inbox/${r.data.id}/validate`, {}); assert.equal(v.status, 200, JSON.stringify(v.data)); return r.data.id;
}
async function capture(c, { file = makePng(), name = 'ticket.png', origin = 'camera', fields = {}, meta = {} } = {}) {
  return c.post('/api/inbox/capture', { fileName: name, dataBase64: b64(file), origin, fields: { supplierName: 'Hôtel Exemple', issueDate: '2026-08-20', gross: '100.00', currency: 'EUR', ...fields }, capture: meta });
}
const status = async (c, period = Q3) => (await c.post('/api/pack-comptable/status', period)).data;
const codes = (m) => m.issues.map((i) => i.code);

// ---------- naming ----------
test('file naming: YYYY-MM-DD_Tiers_Numero_MontantDEVISE.ext, sanitised and collision-free', () => {
  assert.equal(documentFileName({ date: '2026-05-14', party: 'TotalEnergies', number: 'INV-8831', grossCents: 7840, currency: 'EUR', ext: 'pdf' }), '2026-05-14_TotalEnergies_INV-8831_78.40EUR.pdf');
  assert.equal(namePart('Café  de l’Été / SPRL*'), 'CafeDeLEteSPRL');
  assert.equal(documentFileName({ date: '2026-05-14', party: '???', number: '', grossCents: -1250, currency: 'CNY', ext: 'jpg' }), '2026-05-14_Tiers_SN_12.50CNY.jpg');
  assert.ok(!/[\\/:*?"<>|\s]/.test(documentFileName({ date: '2026-01-01', party: 'A/B: C*D', number: 'N°1/2', grossCents: 100, currency: 'EUR', ext: 'pdf' })));
  assert.equal(packLabel({ label: 'Q2_2026' }), '2026_Q2'); assert.equal(packLabel({ label: '2026-05' }), '2026-05');
});

// ---------- pack state, blocking vs warning ----------
test('STATE: an unreadable period is BLOCKING; an open period is INCOMPLETE but generates; warnings need an explicit acknowledgement', withApp({}, async (a, c) => {
  await issue(c);
  // default fake history starts after 2026-07-01: the retail data does not cover Q3 -> the one structural blocking rule
  let m = (await status(c)).model;
  assert.equal(m.verdict, 'incomplete'); assert.equal(m.counts.blocking, 1); assert.ok(codes(m).includes('PERIOD_NOT_COVERED_BY_DATA'));
  const g = await c.post('/api/pack-comptable/generate', { period: Q3, acknowledgeWarnings: true });
  assert.equal(g.status, 422); assert.equal(g.data.error.code, 'PACK_HAS_BLOCKING_ISSUES');
}));

test('STATE: COMPLETE + no issue = ready; a missing receipt is a WARNING (review) that never blocks; generating needs acknowledgement', withApp(HIST, async (a, c) => {
  await issue(c, { issueDate: '2026-09-20' });
  let s = await status(c); assert.equal(s.model.completeness, 'COMPLETE'); assert.equal(s.model.verdict, 'ready'); assert.equal(s.model.counts.items, 0);
  await purchase(c); // validated, no attachment
  s = await status(c); const m = s.model;
  assert.equal(m.verdict, 'review'); assert.equal(m.counts.blocking, 0); assert.deepEqual(codes(m), ['MISSING_RECEIPT']);
  assert.equal(m.facts.purchasesWithReceipt, 0); assert.equal(m.facts.purchasesTotal, 1);
  const refused = await c.post('/api/pack-comptable/generate', { period: Q3 });
  assert.equal(refused.status, 422); assert.equal(refused.data.error.code, 'WARNINGS_NOT_ACKNOWLEDGED');
  const ok = await c.post('/api/pack-comptable/generate', { period: Q3, acknowledgeWarnings: true });
  assert.equal(ok.status, 200); assert.equal(ok.data.record.verdict, 'review');
}));

test('STATE: the open period keeps its PARTIAL meaning (incomplete), without blocking', withApp({ ...HIST, today: '2026-09-21' }, async (a, c) => {
  await issue(c);
  const m = (await status(c)).model;
  assert.equal(m.completeness, 'PARTIAL'); assert.equal(m.verdict, 'incomplete'); assert.equal(m.counts.blocking, 0);
  assert.ok(m.issues.some((i) => i.partial && i.category === 'sales'));
  assert.equal((await c.post('/api/pack-comptable/generate', { period: Q3, acknowledgeWarnings: true })).status, 200);
}));

// ---------- categories ----------
test('CATEGORIES: real counts per accounting category, empty ones stay empty (never a fake zero), issues attach to their category', withApp(HIST, async (a, c) => {
  await issue(c, { issueDate: '2026-09-20' });
  const withReceipt = await c.post('/api/inbox/upload', { fileName: 'facture.pdf', dataBase64: b64(tinyPdf('one')) });
  await c.put(`/api/inbox/${withReceipt.data.item.id}`, { supplierName: 'Fournisseur Un', invoiceNumber: 'U-1', issueDate: '2026-08-02', net: '10.00', vat: '2.10', gross: '12.10', currency: 'EUR', supplierVatNumber: 'BE0000000097' });
  assert.equal((await c.post(`/api/inbox/${withReceipt.data.item.id}/validate`, {})).status, 200);
  await purchase(c, { invoiceNumber: 'NO-DOC', issueDate: '2026-08-03' });
  await a.store.insertBankTransaction({ merchantId: 'merchant-test-1', accountId: 'acc', providerTxId: 't1', date: '2026-08-05', amountCents: -5000, currency: 'EUR', counterpartyName: 'Fournisseur Un', reference: 'ref1', structuredReference: null, source: 'csv', status: 'NEW' });
  await a.store.insertBankTransaction({ merchantId: 'merchant-test-1', accountId: 'acc', providerTxId: 't2', date: '2026-09-05', amountCents: 12100, currency: 'EUR', counterpartyName: 'Client', reference: 'ref2', structuredReference: null, source: 'csv', status: 'MATCHED' });
  const m = (await status(c)).model; const cat = (id) => m.categories.find((x) => x.id === id);
  assert.equal(cat('clients').count, 1); assert.equal(cat('clients').status, 'ready');
  assert.equal(cat('credit_notes').count, 0); assert.equal(cat('credit_notes').status, 'empty'); assert.equal(cat('credit_notes').downloadable, false);
  assert.equal(cat('purchases').count, 2); assert.equal(cat('receipts').count, 1);
  assert.equal(cat('receipts').status, 'review'); assert.equal(m.issues.filter((i) => i.category === 'receipts').length, 1);
  assert.equal(cat('bank').count, 2); assert.equal(cat('bank').status, 'review');
  assert.deepEqual(m.bank.counts, { NEW: 1, MATCHED: 1, IGNORED: 0 }); assert.equal(m.bank.codaSupported, false);
  assert.equal(m.bank.coverage, 'partial'); // transactions only cover 2026-08-05 .. 2026-09-05, not the whole quarter
  assert.ok(m.issues.some((i) => i.code === 'TRANSACTION_UNMATCHED' && i.amountCents === -5000 && i.action.type === 'open_bank'));
  assert.equal(cat('pos').note, 'CASH_RECONCILIATION_NOT_SUPPORTED'); assert.equal(m.pos.cashReconciliation, 'NOT_SUPPORTED');
}));

test('BANK: no bank data at all is reported as none (not as reconciled), and creates no issue', withApp(HIST, async (a, c) => {
  await issue(c, { issueDate: '2026-09-20' });
  const m = (await status(c)).model;
  assert.equal(m.bank.coverage, 'none'); assert.equal(m.categories.find((x) => x.id === 'bank').count, 0); assert.equal(m.categories.find((x) => x.id === 'bank').note, 'NO_BANK_DATA');
  assert.ok(!m.issues.some((i) => i.category === 'bank'));
}));

// ---------- downloads ----------
test('CATEGORY DOWNLOAD: each category is its own ZIP with standard names and a matching SHA-256 manifest; an empty category is refused', withApp(HIST, async (a, c) => {
  const id = await issue(c, { issueDate: '2026-09-20' }); const doc = (await c.get(`/api/documents/${id}`)).data;
  const r = await c.get('/api/pack-comptable/category?kind=quarter&year=2026&quarter=3&category=clients');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /_FacturesClients_2026_Q3\.zip"/);
  const z = unzip(r.data); const names = [...z.keys()]; const root = names[0].split('/')[0];
  const pdf = names.filter((n) => n.endsWith('.pdf')); assert.equal(pdf.length, 1);
  assert.match(pdf[0].slice(root.length + 1), new RegExp(`^2026-09-20_ClientExempleSA_${doc.number.replace(/[^A-Za-z0-9._-]/g, '-')}_\\d+\\.\\d{2}EUR\\.pdf$`));
  assert.equal(z.get(pdf[0]).subarray(0, 4).toString(), '%PDF');
  const manifest = JSON.parse(z.get(`${root}/manifest.json`).toString('utf8'));
  for (const f of manifest.files) assert.equal(sha(z.get(`${root}/${f.path}`)), f.sha256, f.path);
  assert.ok(names.some((n) => /Liste_factures_clients_2026_Q3\.csv$/.test(n)) && names.some((n) => /\.xlsx$/.test(n)));
  const empty = await c.get('/api/pack-comptable/category?kind=quarter&year=2026&quarter=3&category=credit_notes');
  assert.equal(empty.status, 422); assert.equal(empty.data.error.code, 'CATEGORY_EMPTY');
  assert.equal((await c.get('/api/pack-comptable/category?kind=quarter&year=2026&quarter=3&category=nope')).status, 422);
}));

test('COMPLETE PACK: numbered folders (no empty folder), control report + LISEZMOI + manifest whose SHA-256 match every file, optional formats really optional', withApp(HIST, async (a, c) => {
  await issue(c, { issueDate: '2026-09-20' });
  const g = await c.post('/api/pack-comptable/generate', { period: Q3, include: { xlsx: false, ubl: false } });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  const zipBuf = (await c.get(g.data.record.downloadUrl)).data; assert.equal(sha(zipBuf), g.data.record.sha256);
  const z = unzip(zipBuf); const names = [...z.keys()]; const root = names[0].split('/')[0]; assert.equal(root, 'Example_Seller_SRL_Pack_Comptable_2026_Q3'.replace(/_/g, '_').replace('Example_Seller_SRL', root.replace(/_Pack_Comptable_2026_Q3$/, '')));
  const rel = names.map((n) => n.slice(root.length + 1));
  for (const need of ['00_CONTROLE/Rapport_Controle_Nordla.pdf', '00_CONTROLE/LISEZMOI.txt', '00_CONTROLE/manifest.json']) assert.ok(rel.includes(need), need);
  const folders = new Set(rel.map((n) => n.split('/')[0]));
  for (const f of ['00_CONTROLE', '01_FACTURES_CLIENTS', '04_VENTES', '06_CAISSE_POS', '08_TVA']) assert.ok(folders.has(f), f);
  for (const f of ['02_NOTES_DE_CREDIT', '03_ACHATS_FOURNISSEURS', '05_BANQUE', '07_JUSTIFICATIFS']) assert.ok(!folders.has(f), `${f} would be empty`);
  assert.ok(!rel.some((n) => n.endsWith('.xlsx')) && !rel.some((n) => n.includes('/UBL/')));
  for (const n of rel.filter((x) => x.endsWith('.pdf'))) assert.equal(z.get(`${root}/${n}`).subarray(0, 4).toString(), '%PDF', n);
  const manifest = JSON.parse(z.get(`${root}/00_CONTROLE/manifest.json`).toString('utf8'));
  for (const f of manifest.files) assert.equal(sha(z.get(`${root}/${f.path}`)), f.sha256, f.path);
  assert.equal(manifest.files.length, rel.length - 1); assert.equal(manifest.version, 'v1.0'); assert.equal(manifest.verdict, 'ready');
  const readme = z.get(`${root}/00_CONTROLE/LISEZMOI.txt`).toString('utf8');
  assert.match(readme, /Ceci n’est pas une déclaration TVA officielle/); assert.match(readme, /pas au format d’import natif/);
  assert.ok(g.data.send.downloadUrl && g.data.send.requiresApproval === true && g.data.send.sent === false, 'the existing approval-gated send step can pick the pack up');
}));

// ---------- UBL: never fabricated ----------
test('UBL: only documents that are structurally Peppol-ready get an XML; nothing is invented otherwise', withApp(HIST, async (a, c) => {
  const id = await issue(c, { issueDate: '2026-09-20' }); const doc = await a.store.getDocument(id);
  const ready = validatePeppolReadiness(doc).length === 0;
  const z = unzip((await c.get((await c.post('/api/pack-comptable/generate', { period: Q3 })).data.record.downloadUrl)).data);
  const xml = [...z.keys()].filter((n) => n.includes('/UBL/'));
  assert.equal(xml.length, ready ? 1 : 0);
  for (const n of xml) assert.match(z.get(n).toString('utf8'), /<Invoice|<CreditNote/);
}));

// ---------- expense capture ----------
test('CAPTURE: image -> PDF container, the ORIGINAL bytes are kept and served unchanged, timestamps and metadata preserved', withApp(HIST, async (a, c) => {
  const png = makePng(); const r = await capture(c, { file: png, name: 'ticket hôtel.png', origin: 'camera', meta: { category: 'hotel', paymentMethod: 'card', note: 'Salon de Canton' } });
  assert.equal(r.status, 201, JSON.stringify(r.data)); const it = r.data.item;
  assert.equal(it.status, 'TO_REVIEW'); assert.equal(it.contentType, 'application/pdf'); assert.match(it.fileName, /\.pdf$/);
  assert.deepEqual({ ...it.capture, capturedAt: 'x' }, { kind: 'expense', origin: 'camera', capturedAt: 'x', category: 'hotel', paymentMethod: 'card', note: 'Salon de Canton', eurAmountCents: null, eurAmountSource: null, vatRateBp: null, hasOriginal: true, originalContentType: 'image/png', originalFileName: 'ticket_h_tel.png', pdfGenerated: true });
  assert.ok(Date.parse(it.capture.capturedAt) > 0 && it.receivedAt);
  const original = await c.get(`/api/inbox/${it.id}/original`); assert.equal(original.status, 200); assert.ok(original.data.equals(png), 'the original is byte-identical');
  const pdf = await c.get(`/api/inbox/${it.id}/file`); assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-'); assert.ok(pdf.data.includes(Buffer.from('/Subject')));
  const row = (await a.store.listSupplierInvoices('merchant-test-1'))[0];
  assert.equal(row.sha256, sha(png), 'the record is identified by the hash of the ORIGINAL');
  assert.equal(row.extraction.capture.original.sha256, sha(png)); assert.notEqual(row.extraction.capture.pdf.sha256, sha(png));
  // same photo twice = same record
  const again = await capture(c, { file: png }); assert.equal(again.status, 200); assert.equal(again.data.duplicate, true);
}));

test('CAPTURE: a PDF is kept as is (no conversion, nothing generated); unsupported or oversized files are refused', withApp(HIST, async (a, c) => {
  const pdf = tinyPdf('receipt'); const r = await capture(c, { file: pdf, name: 'recu.pdf', origin: 'pdf' });
  assert.equal(r.status, 201); assert.equal(r.data.item.capture.pdfGenerated, false);
  assert.ok((await c.get(`/api/inbox/${r.data.item.id}/original`)).data.equals(pdf)); assert.ok((await c.get(`/api/inbox/${r.data.item.id}/file`)).data.equals(pdf));
  const heic = await capture(c, { file: Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(40)]), name: 'photo.heic' });
  assert.equal(heic.status, 422); assert.match(JSON.stringify(heic.data), /ATTACHMENT_TYPE_NOT_ALLOWED|INPUT_INVALID|ERROR/);
  assert.equal((await capture(c, { file: makePng(), name: 'x.png', origin: 'satellite' })).status >= 400, true);
}));

test('PDF generation: imageToPdf embeds the image unchanged in a valid PDF; EXIF orientation is read, only true rotations are applied', async () => {
  const png = makePng(20, 10); const pdf = await imageToPdf({ data: png, contentType: 'image/png', title: 't', originalName: 'a.png', originalSha256: sha(png) });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.ok(pdf.length > png.length / 2); assert.ok(pdf.includes(Buffer.from(`sha256:${sha(png)}`)));
  const exif = (o) => { const t = Buffer.alloc(8 + 2 + 12 + 4); t.write('MM', 0); t.writeUInt16BE(42, 2); t.writeUInt32BE(8, 4); t.writeUInt16BE(1, 8); t.writeUInt16BE(0x0112, 10); t.writeUInt16BE(3, 12); t.writeUInt32BE(1, 14); t.writeUInt16BE(o, 18);
    const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]); const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2); return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xd9])]); };
  for (const o of [1, 3, 6, 8]) assert.equal(jpegOrientation(exif(o)), o);
  assert.equal(jpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), 1); assert.equal(jpegOrientation(Buffer.from('nope')), 1);
  await assert.rejects(() => imageToPdf({ data: Buffer.alloc(10), contentType: 'image/gif' }), /only JPEG and PNG/);
});

test('FOREIGN CURRENCY: the original currency is stored as typed, never replaced; no rate is invented; a typed EUR amount is labelled as the merchant\'s', withApp(HIST, async (a, c) => {
  const r = await capture(c, { fields: { supplierName: 'Shenzhen Hotel', issueDate: '2026-08-21', gross: '880.00', currency: 'cny' }, meta: { category: 'hotel', paymentMethod: 'card' } });
  assert.equal(r.status, 201); const it = r.data.item;
  assert.equal(it.currency, 'CNY'); assert.equal(it.grossCents, 88000); assert.equal(it.netCents, null); assert.equal(it.vatCents, null); assert.equal(it.capture.eurAmountCents, null);
  assert.deepEqual(it.errors, [], 'a receipt without invoice number or VAT is valid as an expense');
  assert.equal((await c.post(`/api/inbox/${it.id}/validate`, {})).status, 200);
  let m = (await status(c)).model;
  assert.ok(m.issues.some((i) => i.code === 'FOREIGN_CURRENCY_NOT_CONVERTED' && i.currency === 'CNY'));
  assert.equal(m.vat.deductibleCents, 0, 'a foreign-currency document is never added to EUR VAT totals'); assert.equal(m.vat.purchases.excluded.foreign, 1); assert.equal(m.vat.status, 'PARTIAL');
  // the merchant types the EUR amount actually charged on the bank statement: kept beside the original, labelled, never a computed rate
  const r2 = await capture(c, { file: makePng(7, 5), name: 'taxi.png', fields: { supplierName: 'Taxi Shenzhen', issueDate: '2026-08-22', gross: '120.00', currency: 'CNY' }, meta: { category: 'transport', paymentMethod: 'cash', eur: '15.20' } });
  assert.equal(r2.data.item.capture.eurAmountCents, 1520); assert.equal(r2.data.item.capture.eurAmountSource, 'merchant'); assert.equal(r2.data.item.currency, 'CNY');
  await c.post(`/api/inbox/${r2.data.item.id}/validate`, {});
  m = (await status(c)).model; assert.equal(m.issues.filter((i) => i.code === 'FOREIGN_CURRENCY_NOT_CONVERTED').length, 1, 'only the one without a typed EUR amount');
  assert.equal(m.captured.foreignCurrency, 2);
}));

test('EXPENSE REVIEW: expense rules are lighter than invoice rules but still exact; nothing is guessed', () => {
  assert.deepEqual(expenseValidationErrors({ supplierName: 'A', issueDate: '2026-08-01', grossCents: 100, currency: 'EUR' }), []);
  assert.deepEqual(expenseValidationErrors({}), ['SUPPLIER_NAME_MISSING', 'ISSUE_DATE_INVALID', 'GROSS_AMOUNT_INVALID', 'CURRENCY_INVALID']);
  assert.deepEqual(expenseValidationErrors({ supplierName: 'A', issueDate: '2026-08-01', grossCents: 100, netCents: 80, vatCents: 10, currency: 'EUR' }), ['NET_PLUS_VAT_DOES_NOT_EQUAL_TOTAL']);
  assert.deepEqual(expenseValidationErrors({ supplierName: 'A', issueDate: '2026-08-01', grossCents: 100, vatCents: 150, currency: 'EUR' }), ['VAT_EXCEEDS_TOTAL']);
});

test('PACK INCLUSION: captured expenses feed Achats and Justificatifs (PDF + original), with counts of captured / unvalidated / missing metadata', withApp(HIST, async (a, c) => {
  await issue(c, { issueDate: '2026-09-20' });
  const png = makePng(9, 6);
  const ok = (await capture(c, { file: png, name: 'resto.png', fields: { supplierName: 'Restaurant Exemple', issueDate: '2026-08-25', gross: '64.50', currency: 'EUR', vat: '3.65', net: '60.85' }, meta: { category: 'meal', paymentMethod: 'card' } })).data.item;
  await c.post(`/api/inbox/${ok.id}/validate`, {});
  await capture(c, { file: makePng(5, 5), name: 'inconnu.png', fields: { supplierName: 'Sans Metadonnees', issueDate: '2026-08-26', gross: '10.00', currency: 'EUR' } }); // not validated, no category
  const m = (await status(c)).model;
  assert.deepEqual(m.captured, { total: 2, notValidated: 1, missingMetadata: 1, withPdf: 2, foreignCurrency: 0 });
  assert.ok(codes(m).includes('DOCUMENT_NOT_VALIDATED') && codes(m).includes('CAPTURE_METADATA_MISSING'));
  const z = unzip((await c.get((await c.post('/api/pack-comptable/generate', { period: Q3, acknowledgeWarnings: true })).data.record.downloadUrl)).data); const names = [...z.keys()];
  const csv = names.find((n) => n.includes('03_ACHATS_FOURNISSEURS/Liste_achats_')); const list = z.get(csv).toString('utf8');
  assert.match(list, /Restaurant Exemple/); assert.ok(!/Sans Metadonnees/.test(list), 'only validated purchases are listed as purchases');
  const receipts = names.filter((n) => n.includes('/07_JUSTIFICATIFS/')); assert.equal(receipts.length, 4, 'two PDFs + two originals');
  const orig = receipts.find((n) => n.includes('/Originaux/') && n.includes('RestaurantExemple')); assert.ok(z.get(orig).equals(png), 'the original image travels byte-identical');
  assert.match(orig, /2026-08-25_RestaurantExemple_SN_64\.50EUR\.png$/);
}));

// ---------- history and soft versioning ----------
test('HISTORY: every generation is kept as a version; the stored ZIP is downloadable and identical; a category can be cut from a stored pack', withApp(HIST, async (a, c) => {
  await issue(c, { issueDate: '2026-09-20' });
  const g1 = (await c.post('/api/pack-comptable/generate', { period: Q3 })).data.record; const g2 = (await c.post('/api/pack-comptable/generate', { period: Q3 })).data.record;
  assert.equal(g1.versionLabel, 'v1.0'); assert.equal(g2.versionLabel, 'v2.0'); assert.equal(g1.generatedBy, 'merchant');
  const list = (await c.get('/api/pack-comptable/history')).data.rows; assert.deepEqual(list.map((r) => r.versionLabel), ['v2.0', 'v1.0']);
  const dl = await c.get(g1.downloadUrl); assert.equal(sha(dl.data), g1.sha256);
  const cat = await c.get(g1.categories.find((x) => x.id === 'clients').url); assert.equal(cat.status, 200);
  const z = unzip(cat.data); assert.ok([...z.keys()].some((n) => /_FacturesClients_2026_Q3\/.*\.pdf$/.test(n)) && [...z.keys()].some((n) => n.endsWith('/manifest.json')));
  assert.equal((await c.get(g1.categories.find((x) => x.id === 'credit_notes').url)).status, 422);
  assert.equal((await c.get('/api/pack-comptable/history/nope/download')).status, 404);
  assert.ok(a.audits.some((e) => e.action === 'PACK_COMPTABLE_GENERATED'));
}));

test('SOFT VERSIONING: no hard lock; after a pack, new documents are detected against the last version and reported', withApp(HIST, async (a, c) => {
  await issue(c, { issueDate: '2026-09-20' });
  let s = await status(c); assert.equal(s.history.latest, null); assert.equal(s.history.changed, null);
  await c.post('/api/pack-comptable/generate', { period: Q3 });
  s = await status(c); assert.equal(s.history.latest.versionLabel, 'v1.0'); assert.equal(s.history.changed, null, 'nothing changed since v1.0');
  await purchase(c, { invoiceNumber: 'LATE-1' }); await issue(c, { issueDate: '2026-09-25' });
  s = await status(c); assert.equal(s.history.changed.newPurchases, 1); assert.equal(s.history.changed.newInvoices, 1); assert.equal(s.history.changed.newDocuments, 2);
  const again = await c.post('/api/pack-comptable/generate', { period: Q3, acknowledgeWarnings: true }); assert.equal(again.status, 200, 'the period is never locked'); assert.equal(again.data.record.versionLabel, 'v2.0');
  assert.equal((await status(c)).history.changed, null);
}));

test('changesSince / fingerprint: unit behaviour (added, changed, retail figures, nothing)', () => {
  const base = { invoices: ['a'], creditNotes: [], purchases: ['p1:VALIDATED'], bankTransactions: 2, retail: { orders: 5, netCents: 1000 }, refunds: 1 };
  assert.equal(changesSince(null, base), null); assert.equal(changesSince(base, structuredClone(base)), null);
  assert.equal(changesSince(base, { ...base, invoices: ['a', 'b'] }).newInvoices, 1);
  assert.equal(changesSince(base, { ...base, purchases: ['p1:VALIDATED', 'p2:TO_REVIEW'] }).newPurchases, 1);
  assert.equal(changesSince(base, { ...base, purchases: ['p1:PAID'] }).changedPurchases, 1);
  assert.equal(changesSince(base, { ...base, retail: { orders: 6, netCents: 1200 } }).retailChanged, true);
  assert.equal(changesSince(base, { ...base, bankTransactions: 5 }).newBankTransactions, 3);
  const fp = fingerprintOf({ invoices: [{ doc: { id: 'x' } }], creditNotes: [], purchases: [{ id: 'p', status: 'PAID' }], bank: { transactions: [] }, pack: { retail: { orders: 1, net_sales: 10.5 } }, refunds: [] });
  assert.deepEqual(fp, { invoices: ['x'], creditNotes: [], purchases: ['p:PAID'], bankTransactions: 0, retail: { orders: 1, netCents: 1050 }, refunds: 0 });
});

// ---------- VAT (indicative) ----------
test('VAT: indicative, per real documents only; the mandatory wording is in the model, the ZIP and the readme; partial reasons are explicit', withApp(HIST, async (a, c) => {
  await issue(c, { issueDate: '2026-09-20' });
  await purchase(c, { invoiceNumber: 'V-1', net: '100.00', vat: '21.00', gross: '121.00' });
  await purchase(c, { invoiceNumber: 'V-2', net: '50.00', vat: '10.50', gross: '60.50', issueDate: '2026-08-16' });
  const m = (await status(c)).model; const v = m.vat;
  assert.equal(v.wording, 'Estimation indicative basée sur les données disponibles. Ceci n’est pas une déclaration TVA officielle.');
  assert.equal(v.deductibleCents, 3150); assert.equal(v.balanceCents, v.collectedCents - 3150); assert.equal(v.purchases.documents, 2);
  assert.match(v.purchases.note, /right to deduct is not assessed/);
  const z = unzip((await c.get((await c.post('/api/pack-comptable/generate', { period: Q3, acknowledgeWarnings: true })).data.record.downloadUrl)).data);
  assert.ok([...z.keys()].some((n) => /08_TVA\/TVA_indicative_2026_Q3\.pdf$/.test(n)));
  assert.match(z.get([...z.keys()].find((n) => n.endsWith('LISEZMOI.txt'))).toString('utf8'), /Ceci n’est pas une déclaration TVA officielle/);
  await c.post('/api/inbox/manual', { supplierName: 'Pas de tva', invoiceNumber: 'NV', issueDate: '2026-08-17', net: '10.00', vat: '', gross: '10.00', currency: 'EUR' }); // not validated: excluded and reported
  const p = (await status(c)).model.vat; assert.equal(p.status, 'PARTIAL'); assert.ok(p.reasons.includes('UNVALIDATED_PURCHASES_EXCLUDED')); assert.equal(p.deductibleCents, 3150);
}));

// ---------- dependencies stay intact ----------
test('the legacy approval-gated accountant flow and its manifest are untouched by the new pack', withApp(HIST, async (a, c) => {
  await issue(c, { issueDate: '2026-09-20' });
  const p = (await c.post('/api/accountant/prepare', Q3)).data;
  const z = unzip((await c.get(p.downloadUrl)).data); const root = [...z.keys()][0].split('/')[0];
  assert.ok(z.has(`${root}/manifest.json`) && z.has(`${root}/00_Resume_Q3_2026.pdf`));
  assert.equal(baseSettings().accountant !== undefined, true);
}));

test('ATTACH: "Ajouter le justificatif" adds a first document to a record without one, keeps the original, and never replaces an existing attachment', withApp(HIST, async (a, c) => {
  await issue(c, { issueDate: '2026-09-20' });
  const id = await purchase(c, { invoiceNumber: 'ATT-1', issueDate: '2026-08-10' });
  let m = (await status(c)).model; assert.ok(codes(m).includes('MISSING_RECEIPT'));
  const png = makePng(8, 8);
  const r = await c.post(`/api/inbox/${id}/attach`, { fileName: 'scan.png', dataBase64: b64(png) });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.hasFile, true); assert.equal(r.data.contentType, 'application/pdf'); assert.equal(r.data.receipt.hasOriginal, true); assert.equal(r.data.receipt.pdfGenerated, true);
  assert.ok((await c.get(`/api/inbox/${id}/original`)).data.equals(png));
  m = (await status(c)).model; assert.ok(!codes(m).includes('MISSING_RECEIPT')); assert.equal(m.categories.find((x) => x.id === 'receipts').count, 1);
  const second = await c.post(`/api/inbox/${id}/attach`, { fileName: 'other.png', dataBase64: b64(makePng(9, 9)) }); assert.equal(second.status >= 400, true, 'an existing attachment is never replaced');
  const z = unzip((await c.get((await c.post('/api/pack-comptable/generate', { period: Q3 })).data.record.downloadUrl)).data);
  assert.ok([...z.keys()].some((n) => n.includes('/07_JUSTIFICATIFS/Originaux/') && z.get(n).equals(png)));
}));
