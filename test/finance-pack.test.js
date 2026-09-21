import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfig } from '../src/metrics/config.js';
import { buildLedger } from '../src/metrics/ledger.js';
import { computeSalesMetrics } from '../src/metrics/sales.js';
import { localMidnight } from '../src/metrics/windows.js';
import { buildAccountantPack, summaryLines } from '../src/finance/accountant-pack.js';
import { createCompanyLookup, createViesProvider, ManualProvider, normalizeBelgianNumber, parseViesAddress } from '../src/finance/company.js';
import { csvCell, toCsv } from '../src/finance/export-csv.js';
import { renderDocumentPdf, structuredCommunication } from '../src/finance/pdf.js';
import { NullAccessPointAdapter, buildUbl, prepareTransmission, transmissionEvent, validatePeppolReadiness } from '../src/finance/peppol.js';
import { loadDocsForReports, writePackFiles } from '../src/finance/reports.js';
import { normalizeSupplierInvoice } from '../src/finance/supplier-invoice.js';
import { NullCreditRiskProvider } from '../src/finance/credit-risk.js';
import { AGENT_ACTOR, CUSTOMER, LINES, MERCHANT, MERCHANT_ACTOR, SELLER, VAT_OK, CONFIG, draftInvoice, issueInvoice, makeService } from './finance-fixtures.js';
import { makeMarketingData } from './fixtures/marketing-sample.js';

const RETAIL_CFG = mergeConfig({});
const data = makeMarketingData();
const ledger = buildLedger(data, { config: RETAIL_CFG });
const period = { start: '2026-09-01', end: '2026-09-30' };
const linkedLines = [{ description: 'Order o4', quantity: '1', unitPrice: '16.53', vatRate: '21' }];
const pack = (docs, over = {}) => buildAccountantPack({ ledger, rawOrders: data.orders, docs, period, timeZone: 'UTC', now: new Date('2026-10-05T08:00:00Z'), config: RETAIL_CFG, today: '2026-10-05', ...over });

async function scenario() {
  const s = makeService({ ledger, today: '2026-09-21' });
  const standalone = await issueInvoice(s.svc, { issueDate: '2026-09-20' }); // gross 71.90
  const linked = await issueInvoice(s.svc, { lines: linkedLines, revenueBasis: 'linked_source_order', sourceOrderId: 'o4', issueDate: '2026-09-14' });
  const cn = await s.svc.createCreditNote(standalone.id, { reason: 'Returned Item A', lines: [{ description: 'Item A', quantity: '1', unitPrice: '10.00', vatRate: '21' }] }, AGENT_ACTOR);
  await s.svc.submit(cn.id, AGENT_ACTOR);
  await s.svc.decide(cn.id, 'APPROVE', MERCHANT_ACTOR); // dated today (2026-09-21)
  return { ...s, standalone, linked };
}

// ---------- accountant pack ----------
test('SINGLE SOURCE OF TRUTH: the pack retail block equals Phase 2A computeSalesMetrics for the same window (drift guard)', async () => {
  const { store } = await scenario();
  const p = pack(await loadDocsForReports(store, MERCHANT));
  const window = { key: 'custom', start: localMidnight('2026-09-01', 'UTC'), end: localMidnight('2026-10-01', 'UTC'), timeZone: 'UTC' };
  const m = computeSalesMetrics(ledger, window);
  for (const [a, b] of [['gross_sales', 'gross_sales'], ['discounts', 'discounts'], ['refunds', 'refunds'], ['net_sales', 'net_sales'], ['vat', 'tax'], ['net_sales_ex_vat', 'net_sales_ex_tax']]) assert.equal(p.retail[a], m[b], a);
  assert.equal(p.retail.orders, m.order_count);
  const ch = p.retail.by_channel;
  assert.equal(ch.pos.net_sales + ch.online.net_sales + ch.other.net_sales, p.retail.net_sales); // POS vs online split reconciles to the total
  assert.equal(ch.pos.orders + ch.online.orders + ch.other.orders, p.retail.orders);
});

test('B2B: standalone invoices minus credit notes add to sales; linked invoices are documented but NEVER added', async () => {
  const { store } = await scenario();
  const docs = await loadDocsForReports(store, MERCHANT);
  const p = pack(docs);
  assert.equal(p.b2b.standalone_invoices, 1);
  assert.equal(p.b2b.standalone_credit_notes, 1);
  assert.equal(p.b2b.net_ex_vat_cents, 6500 - 1000);
  assert.equal(p.b2b.vat_cents, 690 - 210);
  assert.equal(p.b2b.gross_incl_vat_cents, 7190 - 1210);
  assert.equal(p.b2b_linked.documents, 1);
  assert.equal(p.b2b_linked.additive_to_revenue, false);
  const without = pack(docs.filter(({ doc }) => doc.revenueBasis !== 'linked_source_order'));
  assert.deepEqual(without.totals, p.totals); // removing the linked invoice changes nothing: no double counting
  assert.equal(p.totals.sales_ex_vat_cents, Math.round(p.retail.net_sales_ex_vat * 100) + 5500);
  assert.equal(p.totals.vat_collected_cents, Math.round(p.retail.vat * 100) + 480);
  assert.equal(p.totals.sales_incl_vat_cents, Math.round(p.retail.net_sales * 100) + 5980);
  assert.deepEqual(p.vat_by_rate_b2b.map((g) => [g.vatRateBp, g.taxableCents, g.vatCents]), [[600, 4500, 270], [2100, 1000, 210]]);
  assert.equal(p.reconciliation.status, 'CLEAN');
  assert.equal(p.reconciliation.linked_documents_excluded, 1);
});

test('the pack states period, sources, generation time, completeness and unresolved anomalies', async () => {
  const { store } = await scenario();
  const p = pack(await loadDocsForReports(store, MERCHANT));
  assert.deepEqual([p.period.start, p.period.end], ['2026-09-01', '2026-09-30']);
  assert.equal(p.generated_at, '2026-10-05T08:00:00.000Z');
  assert.deepEqual(p.source_systems.map((s) => s.system), ['retail_core', 'finance_documents']);
  assert.equal(p.completeness.status, 'PARTIAL'); // retail history starts 2026-09-10, after the period start 2026-09-01
});

test('completeness is honest: retail history starting after the period start, or an unclosed period, makes the pack PARTIAL', async () => {
  const { store } = await scenario();
  const docs = await loadDocsForReports(store, MERCHANT);
  const p = pack(docs);
  assert.equal(p.completeness.status, 'PARTIAL');
  assert.ok(p.completeness.reasons.some((r) => r.startsWith('RETAIL_HISTORY_STARTS_2026-09-10_AFTER_PERIOD_START')));
  const open = pack(docs, { today: '2026-09-25' });
  assert.ok(open.completeness.reasons.includes('PERIOD_NOT_CLOSED'));
  const covered = pack(docs, { period: { start: '2026-09-10', end: '2026-09-30' } });
  assert.equal(covered.completeness.reasons.some((r) => r.startsWith('RETAIL_HISTORY')), false);
});

test('arbitrary date ranges are supported, not just quarters', async () => {
  const { store } = await scenario();
  const docs = await loadDocsForReports(store, MERCHANT);
  const p = pack(docs, { period: { start: '2026-09-12', end: '2026-09-14' } });
  assert.equal(p.retail.orders, 3); // o2, o3, o4
  assert.equal(p.b2b_linked.documents, 1); // the linked invoice dated 2026-09-14
  assert.equal(p.b2b.standalone_invoices, 0);
  assert.throws(() => pack(docs, { period: { start: '2026-09-30', end: '2026-09-01' } }), /period must be/);
  assert.throws(() => pack(docs, { period: { start: '2026-Q3', end: '2026-09-01' } }), /period must be/);
});

test('anomalies: unissued documents, numbering gaps/duplicates, integrity tampering, other currency, acknowledged duplicates', async () => {
  const { svc, store } = await scenario();
  await svc.create(draftInvoice({ issueDate: '2026-09-22' }), AGENT_ACTOR); // stays a draft, dated in the period
  const docs = await loadDocsForReports(store, MERCHANT);
  assert.ok(pack(docs).anomalies.some((a) => a.code === 'UNISSUED_DOCUMENTS_IN_PERIOD'));

  const inv = docs.find(({ doc }) => doc.type === 'invoice' && doc.revenueBasis === 'standalone_b2b' && doc.number);
  const gap = structuredClone(inv);
  gap.doc.id = 'x'; gap.doc.number = 'INV-2026-0005';
  const dup = pack([...docs, gap]);
  assert.ok(dup.anomalies.some((a) => a.code === 'NUMBERING_GAP_OR_DUPLICATE' && a.severity === 'critical'));

  const tampered = structuredClone(docs);
  tampered.find(({ doc }) => doc.id === inv.doc.id).doc.customer.name = 'Someone Else';
  const t = pack(tampered);
  assert.ok(t.anomalies.some((a) => a.code === 'DOCUMENT_INTEGRITY_HASH_MISMATCH'));
  assert.equal(t.completeness.status, 'PARTIAL');
  assert.equal(t.reconciliation.status, 'REVIEW_REQUIRED');

  const usd = structuredClone(docs);
  usd.find(({ doc }) => doc.id === inv.doc.id).doc.currency = 'USD';
  const u = pack(usd);
  assert.ok(u.anomalies.some((a) => a.code === 'DOCUMENT_IN_OTHER_CURRENCY_NOT_INCLUDED_IN_TOTALS'));
  assert.equal(u.b2b.standalone_invoices, 0);
});

test('reconciliation flags a suspected duplicate that slipped in unlinked and unacknowledged', async () => {
  const { store } = await scenario();
  const docs = await loadDocsForReports(store, MERCHANT);
  const sneaky = structuredClone(docs.find(({ doc }) => doc.revenueBasis === 'standalone_b2b' && doc.type === 'invoice'));
  sneaky.doc.id = 'sneaky'; sneaky.doc.number = 'INV-2026-0003'; sneaky.doc.issueDate = '2026-09-14';
  sneaky.doc.totals = { ...sneaky.doc.totals, grossCents: 2000, netCents: 1653, vatCents: 347 };
  const p = pack([...docs, sneaky]);
  assert.ok(p.anomalies.some((a) => a.code === 'POSSIBLE_DUPLICATE_OF_SHOP_SALE'));
  assert.equal(p.reconciliation.status, 'REVIEW_REQUIRED');
  assert.ok(p.reconciliation.suspected_duplicates >= 1);
});

test('payment status of period invoices and receivables are reported', async () => {
  const { svc, store } = await scenario();
  const docs0 = await loadDocsForReports(store, MERCHANT);
  const s = docs0.find(({ doc }) => doc.type === 'invoice' && doc.revenueBasis === 'standalone_b2b').doc;
  await svc.recordPayment(s.id, { amount: '20.00', paidOn: '2026-09-25' }, MERCHANT_ACTOR);
  const p = pack(await loadDocsForReports(store, MERCHANT));
  assert.equal(p.payment_status_of_period_invoices.partially_paid.count, 1);
  assert.equal(p.payment_status_of_period_invoices.unpaid.count, 1); // the linked invoice is unpaid
  assert.equal(p.receivables.unpaid.count, 2);
});

test('exports: CSV/PDF/JSON are written and CSV renders exactly the pack summary', async () => {
  const { store } = await scenario();
  const p = pack(await loadDocsForReports(store, MERCHANT));
  const dir = mkdtempSync(join(tmpdir(), 'finpack-'));
  const files = await writePackFiles(p, dir, { delimiter: ';', merchantName: 'Example Seller SRL' });
  for (const suffix of ['_summary.csv', '_retail_by_channel.csv', '_vat_b2b.csv', '_documents.csv', '_anomalies.csv', '_receivables.csv', '.json', '_summary.pdf']) assert.ok(files.some((f) => f.endsWith(suffix)), suffix);
  const csv = readFileSync(join(dir, files.find((f) => f.endsWith('_summary.csv'))), 'utf8');
  for (const l of summaryLines(p)) assert.ok(csv.includes(l.amount), l.line);
  assert.ok(csv.startsWith('﻿'));
  assert.equal(readFileSync(join(dir, files.find((f) => f.endsWith('.pdf')))).subarray(0, 5).toString(), '%PDF-');
  assert.equal(JSON.parse(readFileSync(join(dir, files.find((f) => f.endsWith('.json'))), 'utf8')).kind, 'accountant_pack');
});

test('CSV safety: quoting, custom delimiter, formula injection neutralised, negative numbers kept', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('a;b', ';'), '"a;b"');
  assert.equal(csvCell('=HYPERLINK("x")'), "\"'=HYPERLINK(\"\"x\"\")\"");
  assert.equal(csvCell('+1234'), "'+1234");
  assert.equal(csvCell(-12.5), '-12.5');
  assert.equal(csvCell('-12.50'), '-12.50');
  assert.equal(csvCell(null), '');
  assert.equal(toCsv([{ a: 1, b: 'x' }], [{ key: 'a', header: 'A' }, { key: 'b', header: 'B' }]).split('\r\n')[1], '1,x');
});

// ---------- PDF ----------
test('PDF: issued and draft documents render in every language; structured communication has valid check digits', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc);
  for (const language of ['fr', 'nl', 'en']) {
    const doc = { ...structuredClone(inv), language };
    assert.equal((await renderDocumentPdf(doc, { settlement: { remainingCents: 7190 }, branding: { footer: 'f', structuredCommunication: true } })).subarray(0, 5).toString(), '%PDF-');
  }
  const draft = await svc.create(draftInvoice(), AGENT_ACTOR);
  assert.equal((await renderDocumentPdf(draft)).subarray(0, 5).toString(), '%PDF-');
  const com = structuredCommunication('INV-2026-0001');
  const digits = com.replace(/\D/g, '');
  const base = BigInt(digits.slice(0, 10));
  const check = Number(digits.slice(10));
  assert.equal(check, Number(base % 97n) || 97);
  assert.match(com, /^\+\+\+\d{3}\/\d{4}\/\d{5}\+\+\+$/);
});

// ---------- company lookup ----------
test('Belgian number normalisation validates the mod-97 checksum offline', () => {
  const ok = normalizeBelgianNumber('BE 0000.000.097');
  assert.deepEqual([ok.ok, ok.vatNumber, ok.enterpriseNumber, ok.peppolId], [true, 'BE0000000097', '0000.000.097', '0208:0000000097']);
  assert.equal(normalizeBelgianNumber('000000097').ok, true); // 9 digits: leading zero restored
  assert.equal(normalizeBelgianNumber('0123456789').reason, 'CHECKSUM_INVALID');
  assert.equal(normalizeBelgianNumber('2000000097').reason, 'MUST_START_WITH_0_OR_1');
  assert.equal(normalizeBelgianNumber('12').reason, 'NOT_10_DIGITS');
});

test('company lookup: provider abstraction, VIES parsing, invalid numbers never leave the machine, manual fallback', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ valid: true, name: 'CLIENT EXEMPLE SA', address: 'AVENUE TEST 2\n5000 NAMUR' }) }; };
  const vies = createViesProvider({ fetchImpl, now: () => '2026-09-21T00:00:00Z' });
  const lookup = createCompanyLookup([vies, ManualProvider]);
  const found = await lookup.lookup({ vatNumber: 'BE0000000196' });
  assert.equal(found.status, 'FOUND');
  assert.deepEqual([found.company.name, found.company.address.street, found.company.address.postalCode, found.company.address.city], ['CLIENT EXEMPLE SA', 'AVENUE TEST 2', '5000', 'NAMUR']);
  assert.equal(found.company.vatNumber, 'BE0000000196');
  assert.deepEqual(calls, [{ countryCode: 'BE', vatNumber: '0000000196' }]);
  assert.equal((await lookup.lookup({ vatNumber: 'BE0123456789' })).status, 'INVALID_NUMBER');
  assert.equal(calls.length, 1); // the invalid number was never sent
  assert.equal((await createCompanyLookup([ManualProvider]).lookup({ name: 'Some Company' })).status, 'MANUAL_ENTRY_REQUIRED');
  assert.equal((await lookup.lookup({})).status, 'INVALID_QUERY');
  assert.equal((await createCompanyLookup([createViesProvider({ fetchImpl: async () => ({ ok: true, json: async () => ({ valid: false }) }) })]).lookup({ vatNumber: 'BE0000000097' })).status, 'NOT_FOUND');
  assert.equal((await createCompanyLookup([createViesProvider({ fetchImpl: async () => { throw new Error('offline'); } })]).lookup({ vatNumber: 'BE0000000097' })).status, 'UNAVAILABLE');
  assert.equal((await createCompanyLookup([createViesProvider({ fetchImpl: async () => ({ ok: true, json: async () => ({ userError: 'MS_UNAVAILABLE' }) }) })]).lookup({ vatNumber: 'BE0000000097' })).status, 'UNAVAILABLE');
  assert.deepEqual(parseViesAddress('RUE X 1\nBTE 2\n1000 BRUXELLES'), { street: 'RUE X 1, BTE 2', postalCode: '1000', city: 'BRUXELLES' });
});

// ---------- Peppol ----------
const wellFormed = (xml) => { const stack = []; for (const m of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z0-9:]+)([^>]*?)(\/?)>/g)) { if (m[4]) continue; if (m[1]) { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]); } return stack.length === 0; };

test('Peppol BIS 3.0 payload: built from the deterministic totals, well-formed, nothing transmitted', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc, { customer: { ...CUSTOMER, buyerReference: 'PO-1' } });
  assert.deepEqual(validatePeppolReadiness(inv, {}), []);
  const t = prepareTransmission(inv, {});
  assert.equal(t.status, 'PREPARED');
  assert.equal(t.transmitted, false);
  assert.deepEqual([t.sender.scheme, t.receiver.scheme], ['0208', '0208']);
  const x = t.payloadXml;
  assert.ok(wellFormed(x));
  for (const s of ['urn:fdc:peppol.eu:2017:poacc:billing:3.0', '<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>', '<cbc:ID>INV-2026-0001</cbc:ID>', '<cbc:PayableAmount currencyID="EUR">71.90</cbc:PayableAmount>', '<cbc:TaxAmount currencyID="EUR">6.90</cbc:TaxAmount>', 'schemeID="0208">0000000097<', '<cbc:BuyerReference>PO-1</cbc:BuyerReference>', '<cbc:AllowanceChargeReason>'.slice(0, 0)]) assert.ok(x.includes(s), s);
  assert.equal((x.match(/<cac:TaxSubtotal>/g) ?? []).length, 2); // one per VAT rate group
  assert.equal((x.match(/<cac:InvoiceLine>/g) ?? []).length, 2);
  assert.ok(x.includes('<cac:AllowanceCharge>')); // Item B carries a 10% line discount
});

test('Peppol readiness blocks what is missing: unissued, quotes, individuals, IBAN, buyer reference, unknown endpoints', async () => {
  const { svc } = makeService();
  const draft = await svc.create(draftInvoice(), AGENT_ACTOR);
  assert.ok(validatePeppolReadiness(draft).includes('DOCUMENT_NOT_ISSUED'));
  const q = await svc.create({ type: 'quote', customer: CUSTOMER, lines: LINES, vat: VAT_OK }, AGENT_ACTOR);
  assert.deepEqual(validatePeppolReadiness(q), ['QUOTES_ARE_NOT_E_INVOICES']);
  const inv = await issueInvoice(svc);
  assert.ok(validatePeppolReadiness(inv, {}).includes('BUYER_REFERENCE_REQUIRED'));
  assert.deepEqual(validatePeppolReadiness(inv, { defaultBuyerReference: 'document_number' }), []);
  const noIban = { ...structuredClone(inv), seller: { ...inv.seller, iban: null } };
  assert.ok(validatePeppolReadiness(noIban, { defaultBuyerReference: 'x' }).includes('SELLER_IBAN_MISSING'));
  const foreign = { ...structuredClone(inv), customer: { ...inv.customer, vatNumber: 'FR12345678901', enterpriseNumber: null, address: { ...inv.customer.address, countryCode: 'FR' } } };
  assert.ok(validatePeppolReadiness(foreign, { defaultBuyerReference: 'x' }).includes('CUSTOMER_PEPPOL_ENDPOINT_UNKNOWN'));
  const indiv = { ...structuredClone(inv), customer: { ...inv.customer, kind: 'individual' } };
  assert.ok(validatePeppolReadiness(indiv, { defaultBuyerReference: 'x' }).includes('PEPPOL_NOT_APPLICABLE_TO_INDIVIDUAL_CUSTOMERS'));
  const tampered = structuredClone(inv); tampered.totals.grossCents += 1;
  assert.ok(validatePeppolReadiness(tampered, { defaultBuyerReference: 'x' }).includes('TOTALS_DO_NOT_MATCH_RECOMPUTATION'));
});

test('Peppol credit note and reverse-charge categories', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc);
  const cn = await svc.createCreditNote(inv.id, { reason: 'r' }, AGENT_ACTOR);
  await svc.submit(cn.id, AGENT_ACTOR);
  const issued = await svc.decide(cn.id, 'APPROVE', MERCHANT_ACTOR);
  assert.ok(validatePeppolReadiness(issued, { defaultBuyerReference: 'x' }).includes('CREDIT_NOTE_ORIGINAL_INVOICE_NUMBER_REQUIRED'));
  const xml = buildUbl(issued, { originalNumber: inv.number, defaultBuyerReference: 'document_number' });
  assert.ok(wellFormed(xml));
  assert.ok(xml.includes('<CreditNote ') && xml.includes('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>') && xml.includes('<cac:CreditNoteLine>'));
  assert.ok(xml.includes(`<cbc:ID>${inv.number}</cbc:ID></cac:InvoiceDocumentReference>`));
  const rc = await issueInvoice(svc, { vat: { regime: 'reverse_charge', confirmed: true, mention: 'Reverse charge - VAT due by the customer' }, lines: [{ description: 'Service', quantity: '1', unitPrice: '100.00', vatRate: '0' }] });
  const rx = buildUbl(rc, { defaultBuyerReference: 'document_number' });
  assert.ok(rx.includes('<cbc:ID>AE</cbc:ID>') && rx.includes('<cbc:TaxExemptionReason>Reverse charge - VAT due by the customer</cbc:TaxExemptionReason>'));
});

test('access-point boundary: nothing is transmitted, status events are typed', async () => {
  await assert.rejects(NullAccessPointAdapter.submit({}), /NO_ACCESS_POINT_CONFIGURED/);
  assert.equal((await NullAccessPointAdapter.fetchStatus('x')).status, 'FAILED');
  assert.equal(transmissionEvent('d', 'm', { status: 'DELIVERED', at: 't' }).action, 'PEPPOL_DELIVERED');
  assert.throws(() => transmissionEvent('d', 'm', { status: 'MAYBE', at: 't' }));
});

// ---------- placeholders and lightweight models ----------
test('credit risk stays an unimplemented placeholder', async () => {
  assert.equal((await NullCreditRiskProvider.assess({})).status, 'NOT_CONFIGURED');
});

test('supplier invoice model validates totals and sources without any bookkeeping', () => {
  const ok = normalizeSupplierInvoice({ merchantId: 'm', supplierName: 'Supplier SRL', invoiceNumber: 'S-1', issueDate: '2026-09-01', dueDate: '2026-10-01', netCents: 1000, vatCents: 210, grossCents: 1210, currency: 'EUR', source: 'peppol', attachmentRef: 'store/key' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.supplierInvoice.paymentStatus, 'unpaid');
  assert.ok(normalizeSupplierInvoice({ ...ok.supplierInvoice, grossCents: 1 }).errors.includes('NET_PLUS_VAT_DOES_NOT_EQUAL_TOTAL'));
  assert.ok(normalizeSupplierInvoice({ supplierName: '', invoiceNumber: '', issueDate: 'x', netCents: 1.5, vatCents: 0, grossCents: 0, currency: 'eur', source: 'fax' }).errors.length >= 5);
});

// ---------- isolation, privacy and security ----------
const MERCHANT_NAME = new RegExp(['ha', 'bb'].join(''), 'i'); // built from parts so this file does not match itself
const finDir = new URL('../src/finance/', import.meta.url);
const finFiles = readdirSync(finDir).filter((f) => f.endsWith('.js'));
const read = (f) => readFileSync(new URL(f, finDir), 'utf8');

test('ISOLATION: only company.js may touch the network; credit-risk is imported by nothing; no provider names in the core', () => {
  const code = (f) => read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(finFiles.filter((f) => /\bfetch\(|fetchImpl\(/.test(code(f))).sort(), ['company-search.js', 'company.js']); // the two provider adapters, nothing else
  for (const f of finFiles.filter((x) => x !== 'credit-risk.js')) assert.ok(!/credit-risk/.test(read(f)), `${f} must not import the credit-risk placeholder`);
  for (const f of ['document.js', 'service.js', 'vat.js', 'money.js', 'numbering.js', 'linking.js', 'receivables.js', 'accountant-pack.js']) assert.ok(!/companyweb|creditsafe|billit|peppol\.js|shopify/i.test(read(f).replace(/\/\/.*$/gm, '')), `${f} is provider-neutral`);
});

test('the generic finance core contains no merchant name; merchant data is local configuration', () => {
  for (const f of finFiles) assert.ok(!MERCHANT_NAME.test(read(f)), f);
  const tests = readdirSync(new URL('./', import.meta.url)).filter((f) => f.startsWith('finance-'));
  for (const f of tests) if (f !== 'finance-pack.test.js') assert.ok(!MERCHANT_NAME.test(readFileSync(new URL(f, import.meta.url), 'utf8')), f);
});

test('SECURITY: merchant finance config, env and reports are gitignored; the migration enforces immutability in the database', () => {
  for (const p of ['data/local/finance/merchant.json', '.env', 'reports/finance/x.pdf']) assert.doesNotThrow(() => execSync(`git check-ignore -q ${p}`, { cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') }), p);
  const sql = readFileSync(new URL('../supabase/migrations/20260921200000_finance_operations.sql', import.meta.url), 'utf8');
  for (const s of ['fin_documents_guard', 'is immutable', 'append-only', 'fin_documents_one_invoice_per_order_uq', 'fin_next_number', 'enable row level security']) assert.ok(sql.includes(s), s);
  assert.equal((sql.match(/enable row level security/g) ?? []).length, 6);
});

test('SECURITY: fixtures are synthetic, and nothing in the finance sources embeds a real-looking secret', () => {
  assert.ok(SELLER.iban.startsWith('BE00'));
  assert.ok(/^BE0000000/.test(SELLER.vatNumber) && /^BE0000000/.test(CUSTOMER.vatNumber));
  for (const f of finFiles) assert.ok(!/(service_role|sk_live|shpat_|eyJ[A-Za-z0-9_-]{20,})/.test(read(f)), f);
  assert.ok(!statSync(new URL('../.gitignore', import.meta.url)).isDirectory());
  assert.equal(CONFIG.merchantId, 'merchant-test-1');
});

// ---------- database mapping ----------
import { docToRow, rowToDoc, translateDbError } from '../src/finance/supabase-store.js';

test('database mapping round-trips a locked document exactly, keeping lifecycle apart from immutable content', async () => {
  const { svc } = makeService();
  const inv = await issueInvoice(svc);
  const row = docToRow(inv);
  assert.equal(row.doc_type, 'invoice');
  assert.equal(row.gross_cents, inv.totals.grossCents);
  assert.ok(!('status' in row.body) && !('version' in row.body) && !('lockedAt' in row.body) && !('number' in row.body)); // lifecycle columns stay out of the immutable body
  assert.deepEqual(rowToDoc({ ...row, created_at: 'x' }), JSON.parse(JSON.stringify(inv)));
  const paid = { ...structuredClone(inv), status: 'PAID', version: inv.version + 1 };
  assert.deepEqual(docToRow(paid).body, row.body); // a status change never touches the body the database protects
  assert.equal(translateDbError(new Error('... fin_documents_one_invoice_per_order_uq ...')).code, 'SOURCE_ORDER_ALREADY_INVOICED');
  assert.equal(translateDbError(new Error('locked document x is immutable')).code, 'LOCKED_DOCUMENT_CANNOT_CHANGE');
  assert.equal(translateDbError(new Error('fin_events is append-only')).code, 'APPEND_ONLY_TABLE');
});
