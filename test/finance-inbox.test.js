import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { MAX_ATTACHMENT_BYTES, UblExtractor, createInboxService, createMemoryAttachmentStore, createSupabaseAttachmentStore, filterFinanceMessage, sniffType, validationErrors } from '../src/finance/inbox.js';
import { validateSettings } from '../src/finance/settings.js';
import { baseSettings, startApp } from './finance-dashboard-helpers.js';

// SYNTHETIC documents only: invented supplier, invented numbers.
const PDF = Buffer.from('%PDF-1.4\n% synthetic supplier invoice\n1 0 obj<<>>endobj\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic')]);
const ubl = (over = {}) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>${over.id ?? 'F-2026-0042'}</cbc:ID><cbc:IssueDate>2026-09-10</cbc:IssueDate><cbc:DueDate>2026-10-10</cbc:DueDate><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyTaxScheme><cbc:CompanyID>BE0000000097</cbc:CompanyID></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>Fournisseur Exemple SRL</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
  <cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode><cbc:PaymentID>+++000/0000/00097+++</cbc:PaymentID></cac:PaymentMeans>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">${over.vat ?? '21.00'}</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">121.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">121.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount></cac:InvoiceLine>
</Invoice>`, 'utf8');
const b64 = (b) => b.toString('base64');
async function harness() { const a = await startApp(); return { a, c: await a.authed(), close: () => a.close() }; }
const withH = (fn) => async () => { const h = await harness(); try { await fn(h); } finally { await h.close(); } };
const upload = (h, name, buf) => h.c.post('/api/inbox/upload', { fileName: name, dataBase64: b64(buf) });

test('structured invoice (UBL / Peppol): extracted with per-field confidence, but ALWAYS left TO_REVIEW for a person', withH(async (h) => {
  const r = await upload(h, 'facture.xml', ubl());
  assert.equal(r.status, 201); const it = r.data.item;
  assert.equal(it.status, 'TO_REVIEW'); assert.equal(it.source, 'upload');
  assert.deepEqual([it.supplierName, it.supplierVatNumber, it.invoiceNumber, it.issueDate, it.dueDate, it.currency, it.netCents, it.vatCents, it.grossCents, it.paymentReference], ['Fournisseur Exemple SRL', 'BE0000000097', 'F-2026-0042', '2026-09-10', '2026-10-10', 'EUR', 10000, 2100, 12100, '+++000/0000/00097+++']);
  assert.equal(it.extraction.extractor, 'ubl'); assert.ok(it.extraction.fields.netCents >= 0.9); assert.ok(it.extraction.fields.paymentReference < it.extraction.fields.netCents, 'less certain fields have lower confidence');
  assert.equal(it.hasFile, true); assert.deepEqual(it.errors, [], 'complete extraction, still not validated');
}));
test('a PDF or an image: stored privately, no extraction is trusted or invented, the merchant enters the fields', withH(async (h) => {
  const it = (await upload(h, 'scan.pdf', PDF)).data.item;
  assert.equal(it.status, 'TO_REVIEW'); assert.equal(it.supplierName, null); assert.equal(it.extraction.extractor, 'none'); assert.deepEqual(it.extraction.fields, {});
  assert.ok(it.errors.includes('SUPPLIER_NAME_MISSING') && it.errors.includes('GROSS_AMOUNT_INVALID'));
  assert.equal((await upload(h, 'photo.png', PNG)).data.item.contentType, 'image/png');
}));
test('the same file twice is one record (idempotent intake)', withH(async (h) => {
  const a = (await upload(h, 'x.xml', ubl())).data; const b = await upload(h, 'renamed.xml', ubl());
  assert.equal(b.status, 200); assert.equal(b.data.duplicate, true); assert.equal(b.data.item.id, a.item.id);
  assert.equal((await h.c.get('/api/inbox')).data.rows.length, 1);
}));
test('files are sniffed, not trusted: wrong types, empty and oversized files are refused', withH(async (h) => {
  assert.equal((await upload(h, 'evil.pdf', Buffer.from('<html><script>alert(1)</script></html>'))).status, 422);
  assert.equal((await upload(h, 'run.exe', Buffer.from('MZ\x90\x00'))).status, 422);
  assert.equal((await h.c.post('/api/inbox/upload', { fileName: 'a.pdf', dataBase64: '' })).status, 422);
  assert.equal((await upload(h, 'huge.pdf', Buffer.concat([PDF, Buffer.alloc(MAX_ATTACHMENT_BYTES)]))).status, 422);
  assert.equal(sniffType(PDF), 'application/pdf'); assert.equal(sniffType(PNG), 'image/png'); assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg'); assert.equal(sniffType(ubl()), 'application/xml'); assert.equal(sniffType(Buffer.from('hello')), null);
}));

test('WORKFLOW: TO_REVIEW -> VALIDATED -> TO_PAY -> PAID, only by the merchant, with rules at every step', withH(async (h) => {
  const id = (await upload(h, 'f.xml', ubl())).data.item.id;
  assert.equal((await h.c.post(`/api/inbox/${id}/to-pay`, {})).status, 409, 'cannot skip validation');
  let r = await h.c.post(`/api/inbox/${id}/validate`, {}); assert.equal(r.status, 200); assert.equal(r.data.status, 'VALIDATED'); assert.ok(r.data.validatedAt);
  assert.equal((await h.c.put(`/api/inbox/${id}`, { supplierName: 'Changed' })).status, 409, 'a validated item is not edited in place');
  r = await h.c.post(`/api/inbox/${id}/to-pay`, {}); assert.equal(r.data.status, 'TO_PAY');
  assert.equal((await h.c.post(`/api/inbox/${id}/pay`, { paidOn: '2026-09-25', amount: '100.00' })).status, 409, 'partial supplier payments are not supported yet');
  assert.equal((await h.c.post(`/api/inbox/${id}/pay`, { amount: '121.00' })).status, 422);
  r = await h.c.post(`/api/inbox/${id}/pay`, { paidOn: '2026-09-25', amount: '121.00', reference: 'Virement 25/09' }); assert.equal(r.data.status, 'PAID'); assert.equal(r.data.paidAt, '2026-09-25');
  assert.equal((await h.c.post(`/api/inbox/${id}/reopen`, {})).status, 409, 'PAID is final');
  assert.equal((await h.c.get('/api/inbox?scope=purchases')).data.rows.length, 1); assert.equal((await h.c.get('/api/inbox?scope=inbox')).data.rows.length, 0);
  assert.equal((await h.c.get('/api/inbox/status')).data.counts.PAID, 1);
}));
test('a document that does not add up cannot be validated until a person fixes it; edits are audited', withH(async (h) => {
  const id = (await upload(h, 'f.xml', ubl({ vat: '25.00', id: 'F-BAD' }))).data.item.id;
  const it = (await h.c.get(`/api/inbox/${id}`)).data; assert.ok(it.errors.includes('NET_PLUS_VAT_DOES_NOT_EQUAL_TOTAL')); assert.ok(it.extraction.warnings.includes('TOTALS_DO_NOT_ADD_UP')); assert.ok(it.extraction.fields.netCents < 0.5);
  const blocked = await h.c.post(`/api/inbox/${id}/validate`, {}); assert.equal(blocked.status, 409); assert.match(JSON.stringify(blocked.data), /NET_PLUS_VAT_DOES_NOT_EQUAL_TOTAL/);
  assert.equal((await h.c.put(`/api/inbox/${id}`, { vat: '21.00' })).status, 200);
  assert.equal((await h.c.post(`/api/inbox/${id}/validate`, {})).data.status, 'VALIDATED');
}));
test('manual entry, rejection with a reason, reopening to correct, and duplicate supplier invoices', withH(async (h) => {
  const man = await h.c.post('/api/inbox/manual', { supplierName: 'Fournisseur Manuel SA', invoiceNumber: 'M-1', issueDate: '2026-09-01', net: '10.00', vat: '2.10', gross: '12.10', currency: 'eur' });
  assert.equal(man.status, 201); assert.equal(man.data.source, 'manual'); assert.equal(man.data.currency, 'EUR');
  assert.equal((await h.c.post(`/api/inbox/${man.data.id}/validate`, {})).status, 200);
  assert.equal((await h.c.post(`/api/inbox/${man.data.id}/reopen`, {})).data.status, 'TO_REVIEW');
  assert.equal((await h.c.post(`/api/inbox/${man.data.id}/validate`, {})).status, 200);
  // same supplier + number + type: refused at creation, as the database unique index does (fin_supplier_invoice_type_uq)
  const d = await h.c.post('/api/inbox/manual', { supplierName: 'Fournisseur Manuel SA', invoiceNumber: 'M-1', issueDate: '2026-09-01', net: '10.00', vat: '2.10', gross: '12.10', currency: 'EUR' });
  assert.equal(d.status, 409); assert.match(JSON.stringify(d.data), /DUPLICATE_SUPPLIER_INVOICE/);
  // a record whose number is still missing cannot be completed into a duplicate either
  const dup = await h.c.post('/api/inbox/manual', { supplierName: 'Fournisseur Manuel SA', issueDate: '2026-09-01', net: '10.00', vat: '2.10', gross: '12.10', currency: 'EUR' });
  assert.equal((await h.c.put(`/api/inbox/${dup.data.id}`, { invoiceNumber: 'M-1' })).status, 409, 'the edit itself is refused by the same unique rule');
  assert.equal((await h.c.post(`/api/inbox/${dup.data.id}/reject`, {})).status, 422, 'a reason is required');
  const rj = await h.c.post(`/api/inbox/${dup.data.id}/reject`, { reason: 'Doublon' }); assert.equal(rj.data.status, 'REJECTED'); assert.equal(rj.data.rejectedReason, 'Doublon');
  assert.equal((await h.c.post('/api/inbox/manual', { net: 'abc' })).status, 422);
}));

test('the attachment is private: served only to an authenticated session, never publicly, with safe headers', async () => {
  const h = await harness();
  try {
    const it = (await upload(h, 'f.pdf', PDF)).data.item;
    const f = await h.c.get(`/api/inbox/${it.id}/file`); assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'application/pdf'); assert.match(f.headers.get('cache-control'), /private, no-store/); assert.equal(f.headers.get('x-content-type-options'), 'nosniff'); assert.equal(f.data.subarray(0, 5).toString(), '%PDF-');
    const anon = h.a.client(); assert.equal((await anon.raw('GET', `/api/inbox/${it.id}/file`)).status, 401); assert.equal((await anon.raw('GET', '/api/inbox')).status, 401);
    assert.equal((await h.c.get('/api/inbox/00000000-0000-0000-0000-000000000000/file')).status, 404);
  } finally { await h.close(); }
});
test('tenant isolation: another merchant cannot read, edit or validate an item, and attachments are stored under the merchant path', async () => {
  const store = createMemoryStore(); const att = createMemoryAttachmentStore();
  const mk = (merchantId) => createInboxService({ store, attachments: att, merchantId });
  const a = mk('m1'); const b = mk('m2'); const merchant = { type: 'merchant' };
  const { item } = await a.ingest({ fileName: 'x.pdf', data: PDF });
  assert.match(item.attachmentRef, /^m1\/[0-9a-f]{64}\/x\.pdf$/);
  await assert.rejects(() => b.get(item.id), /INBOX_ITEM_NOT_FOUND`?|INBOX_ITEM_NOT_FOUND/); await assert.rejects(() => b.validate(item.id, merchant), /INBOX_ITEM_NOT_FOUND/); await assert.rejects(() => b.file(item.id), /INBOX_ITEM_NOT_FOUND/);
  assert.equal((await b.list()).length, 0);
  assert.equal((await b.ingest({ fileName: 'x.pdf', data: PDF })).duplicate, false, 'duplicates are detected per merchant, never across tenants');
});
test('the agent may ingest and prepare, but validating, paying and rejecting need a merchant actor', async () => {
  const svc = createInboxService({ store: createMemoryStore(), attachments: createMemoryAttachmentStore(), merchantId: 'm1' });
  const { item } = await svc.ingest({ fileName: 'u.xml', data: ubl() });
  for (const step of [() => svc.validate(item.id, { type: 'agent' }), () => svc.markToPay(item.id, { type: 'agent' }), () => svc.reject(item.id, 'x', { type: 'agent' }), () => svc.update(item.id, {}, undefined)]) await assert.rejects(step, /THIS_STEP_REQUIRES_A_MERCHANT_ACTOR/);
});

test('ONLY finance-specific messages may enter: addressed to the dedicated finance address, from an allowed sender; nothing else is read', () => {
  const cfg = { financeAddress: 'finance@societe.example', allowedSenders: ['invoices@fournisseur.example'] };
  assert.equal(filterFinanceMessage({ to: ['finance@societe.example'], from: 'invoices@fournisseur.example' }, cfg).accept, true);
  assert.equal(filterFinanceMessage({ to: ['Finance <finance@societe.example>'], from: 'invoices@fournisseur.example' }, cfg).accept, true);
  assert.deepEqual(filterFinanceMessage({ to: ['perso@gmail.example'], from: 'invoices@fournisseur.example' }, cfg), { accept: false, reason: 'NOT_ADDRESSED_TO_FINANCE' });
  assert.deepEqual(filterFinanceMessage({ to: ['finance@societe.example'], from: 'friend@example.com' }, cfg), { accept: false, reason: 'SENDER_NOT_ALLOWED' });
  assert.deepEqual(filterFinanceMessage({ to: ['finance@societe.example'], from: 'x@y.example' }, { financeAddress: '' }), { accept: false, reason: 'FINANCE_ADDRESS_NOT_CONFIGURED' });
  assert.equal(filterFinanceMessage({ deliveredTo: ['finance@societe.example'], from: 'any@any.example' }, { financeAddress: 'finance@societe.example' }).accept, true);
});
test('the dedicated address and sender allow-list are merchant-local settings; email and Peppol sources are listed as NOT CONFIGURED', async () => {
  assert.equal(validateSettings({}, undefined).settings.inbox.financeAddress, '');
  assert.ok(validateSettings({ inbox: { financeAddress: 'nope' } }, undefined).errors.some((e) => e.code === 'EMAIL_INVALID'));
  assert.deepEqual(validateSettings({ inbox: { financeAddress: 'finance@societe.example', allowedSenders: ['a@b.example'] } }, undefined).settings.inbox, { financeAddress: 'finance@societe.example', allowedSenders: ['a@b.example'] });
  const h = await harness();
  try { const st = (await h.c.get('/api/inbox/status')).data; assert.deepEqual(st.adapters.map((a) => [a.name, a.configured]), [['upload', true], ['email', false], ['peppol', false]]); } finally { await h.close(); }
  const src = readFileSync(new URL('../src/finance/inbox.js', import.meta.url), 'utf8');
  assert.ok(!/imap|pop3|gmail|outlook|nodemailer/i.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'no mailbox client exists in the finance code');
});
test('UBL reader: a credit note is read as CREDIT_NOTE with positive amounts; garbage yields nothing rather than a guess', async () => {
  const cn = await UblExtractor.extract({ data: Buffer.from(ubl().toString().replace(/<Invoice/, '<CreditNote').replace('</Invoice>', '</CreditNote>')) });
  assert.equal(cn.fields.documentType.value, 'CREDIT_NOTE'); assert.equal(cn.fields.grossCents.value, 12100);
  assert.deepEqual((await UblExtractor.extract({ data: Buffer.from('<?xml version="1.0"?><nothing/>') })).fields, {});
  assert.deepEqual(validationErrors({ supplierName: 'X', invoiceNumber: '1', issueDate: '2026-09-01', netCents: 100, vatCents: 21, grossCents: 121, currency: 'EUR' }), []);
});
test('private storage adapter: private bucket, service-role auth from the server, tenant path, never a public URL', async () => {
  const calls = [];
  const s = createSupabaseAttachmentStore({ url: 'https://project.example.test', serviceKey: 'service-key-synthetic', fetchImpl: async (u, i) => { calls.push({ u, i }); return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => PDF }; } });
  await s.put('m1/abc/x y.pdf', PDF, { contentType: 'application/pdf' });
  assert.equal(calls[0].u, 'https://project.example.test/storage/v1/object/finance-inbox/m1/abc/x%20y.pdf'); assert.equal(calls[0].i.headers['x-upsert'], 'false'); assert.match(calls[0].i.headers.Authorization, /^Bearer /);
  assert.equal((await s.get('m1/abc/x y.pdf')).data.subarray(0, 5).toString(), '%PDF-');
  assert.ok(!/public\//.test(calls.map((c) => c.u).join()), 'the public object endpoint is never used');
  const sql = readFileSync(new URL('../supabase/migrations/20260922200000_finance_inbox_purchases.sql', import.meta.url), 'utf8');
  assert.match(sql, /'finance-inbox', 'finance-inbox', false/); assert.match(sql, /set public = false/);
});
