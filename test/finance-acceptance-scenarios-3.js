// Final acceptance scenarios, third part: civil dates / DST, artifact failures, security, cross-merchant isolation, mixed gift-shop-shaped dataset, export proof.
import assert from 'node:assert/strict';
import { createPeppolService } from '../src/finance/peppol-service.js';
import { safeFileName } from '../src/finance/peppol.js';
import { verifyExportPackage } from '../src/finance/accountant-export.js';
import { unzip, zip } from '../src/finance/xlsx.js';
import { createMemoryAttachmentStore } from '../src/finance/inbox.js';
import { supplierInvoiceXml } from './finance-legal-helpers.js';
import { accWorld, MERCHANT_ACTOR, CUSTOMER, code, csv, independent, sha } from './finance-acceptance-world.js';

const eq = assert.deepStrictEqual;
const sigOk = { 'x-fake-signature': 'fake-webhook-secret' };
const INDIVIDUAL = { kind: 'individual', name: 'Client Particulier (synthetic)', address: { street: 'Rue du Test 1', postalCode: '5000', city: 'Namur', countryCode: 'BE' } };
const COQUE = [{ description: 'Coque personnalisée (synthetic)', quantity: '1', unitPrice: '20.66', vatRate: '21' }];
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** a storage whose reads can be broken per reference */
const faultyStorage = () => { const inner = createMemoryAttachmentStore(); const broken = new Map(); return { broken, storage: { ...inner, name: 'faulty', get: async (ref) => { const how = broken.get(ref); if (how === 'missing') return null; if (how === 'throw') throw new Error('storage unavailable'); if (how === 'corrupt') { const f = await inner.get(ref); f.data[0] ^= 0xff; return f; } return inner.get(ref); } } }; };

/** The mixed, gift-shop-shaped dataset (synthetic): counter cash sales, online card sales, a B2B order paid in three steps, a return with a refund, an overdue corporate invoice, supplier invoices, cash and bank. */
export async function giftShopDataset(w) {
  const sold = []; let n = 0; const counter = async (qty, method) => { const inv = await w.issue({ customer: INDIVIDUAL, lines: [{ ...COQUE[0], quantity: String(qty) }], issueDate: '2026-09-1' + (n++ % 9) }); const g = (await w.st.getDocument(inv.id)).totals.grossCents; await w.receive(g, [[inv.id, g]], { method, paidOn: inv.issueDate }); sold.push(inv); return inv; };
  for (const q of [1, 1, 2, 3]) await counter(q, 'cash');
  const online = []; for (const q of [1, 2]) { const inv = await w.issue({ customer: INDIVIDUAL, lines: [{ ...COQUE[0], quantity: String(q) }], issueDate: '2026-09-15' }); const g = (await w.st.getDocument(inv.id)).totals.grossCents; const p = await w.receive(g, [[inv.id, g]], { method: 'bancontact', paidOn: '2026-09-15' }); const tx = await w.bankTx(`shop-card-${q}`, g, '2026-09-16'); await w.reconcile(tx, p.payment.id, g); online.push(inv); }
  const b2b = await w.issue({ lines: [{ ...COQUE[0], quantity: '40' }], issueDate: '2026-09-02' }); const bg = (await w.st.getDocument(b2b.id)).totals.grossCents; const parts = [Math.round(bg * 0.3), Math.round(bg * 0.4)];
  for (const [i, a] of parts.entries()) { const p = await w.receive(a, [[b2b.id, a]], { paidOn: `2026-09-0${5 + i}` }); const tx = await w.bankTx(`shop-b2b-${i}`, a, `2026-09-0${5 + i}`); await w.reconcile(tx, p.payment.id, a); } // the last 30 % is still open (no due_schedule storage in V1: three ordinary payments)
  const ret = await w.invoice(484, { lines: [{ ...COQUE[0], quantity: '4' }], issueDate: '2026-09-03' }); const rg = (await w.st.getDocument(ret.id)).totals.grossCents; const rp = await w.receive(rg, [[ret.id, rg]], { paidOn: '2026-09-03' });
  const cn = await w.creditNote(ret, [{ ...COQUE[0], quantity: '2' }]); const cg = (await w.st.getDocument(cn.id)).totals.grossCents; const rf = await w.P.refund(cn.id, { amountCents: cg, paidOn: '2026-09-20', method: 'bancontact', refundOfPaymentId: rp.payment.id, idempotencyKey: 'acc-shop-rf' }, MERCHANT_ACTOR); const rtx = await w.bankTx('shop-refund', -cg, '2026-09-20'); await w.reconcile(rtx, rf.payment.id, cg);
  const overdue = await w.invoice1000({ issueDate: '2026-07-15' });
  const s1 = await w.supplier(250000, { supplierName: 'Fournisseur import (synthetic)', dueDate: '2026-10-15' }); const sp = await w.paySupplier(100000, [[s1.id, 100000]], { paidOn: '2026-09-10' }); const stx = await w.bankTx('shop-supplier', -100000, '2026-09-10'); await w.reconcile(stx, sp.payment.id, 100000);
  const s2 = await w.supplier(12100, { dueDate: '2026-09-20' });
  await w.st.insertCashCount({ merchantId: w.mid, amountCents: 40000, countedOn: '2026-09-30', note: null, createdAt: w.at }); await w.st.insertCashMovement({ merchantId: w.mid, kind: 'DEPOSIT_TO_BANK', amountCents: 10000, date: '2026-10-02', note: null, createdAt: w.at });
  return { sold, online, b2b, ret, cn, overdue, s1, s2 };
}

/** every figure compared across modules; the sum of ALL absolute differences is the unexplained difference (expected 0 cents) */
export async function moneyDifference(w) {
  const ind = await independent(w); const pkg = await w.pkg(); const model = await w.treasury().model(); const diffs = []; const d = (label, a, b) => { if (a !== b) diffs.push({ label, a, b }); return Math.abs(a - b); }; let total = 0;
  const sales = new Map(csv(pkg, 'sales.csv').map((r) => [r.number, r])); const purchases = csv(pkg, 'purchases.csv');
  for (const [id, c] of Object.entries(ind.customers)) {
    const view = await w.view(id); total += d(`${c.number} settlement`, view.remaining, c.remaining); total += d(`${c.number} export`, Math.round(Number(sales.get(c.number).remaining) * 100), c.remaining);
    const item = model.items.find((i) => i.sourceId === id); total += d(`${c.number} treasury`, item ? item.amountCents : 0, Math.max(0, c.remaining));
  }
  for (const [id, s] of Object.entries(ind.suppliers)) { const row = purchases.find((r) => r.invoice_number === s.number); total += d(`${s.number} export`, Math.round(Number(row.remaining) * 100), s.remaining); const item = model.items.find((i) => i.sourceId === id); total += d(`${s.number} treasury`, item ? item.amountCents : 0, s.remaining); }
  const regIn = (await w.st.listRegistry(w.mid)).filter((p) => p.direction === 'IN' && p.status !== 'VOIDED').reduce((s, p) => s + p.amountCents - (p.reversedCents ?? 0), 0); void regIn;
  const exportNet = csv(pkg, 'payments.csv').reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0); const rawNet = Object.values(ind.customers).reduce((s, c) => s + c.paid - c.refunded, 0) + Object.values(ind.suppliers).reduce((s, x) => s - x.paid, 0); total += d('net payments export vs raw allocations', exportNet, rawNet);
  return { totalCents: total, diffs, customers: Object.keys(ind.customers).length, suppliers: Object.keys(ind.suppliers).length, exportNet };
}

export const SCENARIOS_3 = {
  // ---------------------------------------------------------------- 16. DST / civil date
  async 'S16 civil dates around the Europe/Brussels DST changes: an event after local midnight while UTC is still the previous day'(w0) {
    const out = [];
    for (const [label, start, civil] of [['dst-start', '2026-03-28T23:30:00.000Z', '2026-03-29'], ['dst-end-eve', '2026-10-24T22:30:00.000Z', '2026-10-25'], ['after-dst-end', '2026-10-25T23:30:00.000Z', '2026-10-26']]) {
      const w = await w0.spawn({ startIso: start, nowIso: start }); const inv = await w.invoice1000({ issueDate: undefined }); const doc = await w.st.getDocument(inv.id);
      eq([doc.issueDate, doc.dueDate], [civil, addDays(civil, 30)], `${label}: issue/due are Brussels civil dates (UTC is still the previous day)`);
      const pay = await w.P.receive({ amountCents: 40000, paidOn: civil, method: 'bank_transfer', idempotencyKey: `acc-dst-${label}`, allocations: [{ documentId: inv.id, amountCents: 40000 }] }, MERCHANT_ACTOR);
      const tx = await w.bankTx(`dst-${label}`, 40000, civil); await w.reconcile(tx, pay.payment.id, 40000);
      await w.st.upsertBankBalance({ merchantId: w.mid, accountId: 'acc-9', iban: 'BE68539007547034', balanceCents: 500000, currency: 'EUR', asOf: start });
      await w.st.insertBankTransactionsBatch([{ merchantId: w.mid, accountId: 'acc-9', providerTxId: `dst-same-${label}`, date: civil, amountCents: -1000, currency: 'EUR', source: 'bank', status: 'NEW' }]);
      const late = await w.invoice1000({ issueDate: addDays(civil, -40), customer: CUSTOMER }); void late;
      const odd = await w.invoice1000({ issueDate: addDays(civil, -31) }); // due = civil - 1: overdue by Brussels date, NOT overdue by the UTC date
      const model = await w.treasury({ now: start }).model(); const pos = model.position.EUR; const item = model.items.find((i) => i.sourceId === odd.id);
      eq(model.asOf, civil, `${label}: treasury as-of is the merchant civil date`); eq([item.overdue, item.overdueDays], [true, 1], `${label}: overdue by civil date`);
      eq([pos.observed.totalCents, pos.calculated.laterCents], [500000, 0], `${label}: a transaction on the civil day of the balance is already in it (by UTC date it would look later and be double counted)`); assert.ok(pos.warnings.some((x) => /SAME/.test(x.code)));
      const pkg = await w.pkg({ kind: 'custom', from: civil, to: civil }, { now: start }); const sales = csv(pkg, 'sales.csv'); eq(sales.map((r) => r.number), [doc.number], `${label}: the export period of that civil day holds exactly that invoice`);
      eq([csv(pkg, 'payments.csv').length, csv(pkg, 'bank-transactions.csv').filter((r) => r.date === civil).length >= 1], [1, true]);
      const ind = (await independent(w)).customers[inv.id]; eq([ind.remaining, sales[0].remaining], [60000, '600.00']); out.push([label, civil, item.overdueDays, pos.calculated.laterCents]);
    }
    return out;
  },

  // ---------------------------------------------------------------- 23. artifact failures
  async 'S23 artifact failures: corrupted / missing / unavailable bytes are detected, never sent, never claimed as originals'(w0) {
    const { broken, storage } = faultyStorage(); const w = await w0.spawn({ storage }); const inv = await w.invoice1000(); const doc = await w.st.getDocument(inv.id);
    const arts = await w.st.listArtifacts({ merchantId: w.mid, documentId: doc.id }); const pdf = arts.find((a) => a.kind === 'PDF_ORIGINAL'); const ubl = arts.find((a) => a.kind === 'STRUCTURED_ORIGINAL'); const out = {};
    eq((await w.legal.read(pdf.id)).verified, true);
    broken.set(pdf.storageRef, 'corrupt'); let r = await w.legal.read(pdf.id); eq([r.verified, r.problem], [false, 'HASH_MISMATCH']); broken.set(pdf.storageRef, 'missing'); r = await w.legal.read(pdf.id); eq([r.verified, r.problem, r.data], [false, 'STORAGE_OBJECT_MISSING', null]);
    broken.delete(pdf.storageRef); eq((await w.legal.compliance(doc.id)).pdf.sha256, pdf.sha256, 'the recorded hash (the truth) never changes with the bytes');
    // a corrupted UBL is never sent to the provider
    const q = await w.peppol.queue(doc, { actor: MERCHANT_ACTOR }); broken.set(ubl.storageRef, 'corrupt'); const d = await w.peppol.dispatch(q.message.id); out.corruptSend = [d.state, d.message.errorCode]; eq(out.corruptSend, ['SUBMISSION_FAILED', 'ARTIFACT_INTEGRITY_FAILED']); eq(w.provider.calls.submit, 0);
    // storage unavailable at send time: the attempt fails safely (stays SUBMITTING, unknown), nothing reached the provider; after repair a restarted worker sends exactly once
    broken.delete(ubl.storageRef); const inv2 = await w.invoice1000(); const doc2 = await w.st.getDocument(inv2.id); const u2 = (await w.st.listArtifacts({ merchantId: w.mid, documentId: doc2.id, kind: 'STRUCTURED_ORIGINAL' }))[0]; const q2 = await w.peppol.queue(doc2, { actor: MERCHANT_ACTOR });
    broken.set(u2.storageRef, 'throw'); out.unavailable = await code(() => w.peppol.dispatch(q2.message.id)); assert.notEqual(out.unavailable, 'OK'); eq(w.provider.calls.submit, 0); eq((await w.st.getPeppolMessage(w.mid, q2.message.id)).state, 'SUBMITTING');
    broken.delete(u2.storageRef); const again = createPeppolService({ store: w.st, merchantId: w.mid, provider: w.provider, legal: w.legal, storage, inbox: w.inbox, clock: w.clock, ownEndpoints: [], leaseMs: 0 }); await again.dispatchQueued(); eq((await w.st.getPeppolMessage(w.mid, q2.message.id)).state, 'SUBMITTED'); eq(w.provider.calls.submit, 1);
    // the export reports the truth (its own test file proves each case; here: the damaged original is listed as missing with its reason)
    broken.set(pdf.storageRef, 'corrupt'); const pkg = await w.exporter().generate({ kind: 'custom', from: '2026-01-01', to: '2026-12-31' }, { includeDocuments: true });
    const missing = csv(pkg, 'missing-artifacts.csv').find((x) => x.source_id === doc.id && x.expected_artifact === 'PDF_ARCHIVED_ORIGINAL'); eq(missing.reason, 'ARTIFACT_HASH_MISMATCH'); out.export = missing.reason;
    // a missing original is never replaced silently: no PDF_ORIGINAL row -> ARTIFACT_NOT_FOUND
    const bare = await w0.spawn(); eq(await code(() => bare.legal.originalPdf('00000000-0000-4000-8000-000000000000')), 'ARTIFACT_NOT_FOUND'); return out;
  },

  // ---------------------------------------------------------------- 24. security
  async 'S24 security: XXE / entity bombs, malformed XML, oversized, unsafe attachments, path traversal, bad webhook auth, wrong recipient'(w) {
    const out = {}; const { xml } = await supplierInvoiceXml({}); const text = xml.toString('utf8');
    const xxe = Buffer.from(text.replace(/^<\?xml[^>]*\?>/, '').replace('<Invoice', '<?xml version="1.0"?><!DOCTYPE Invoice [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><Invoice'));
    const r1 = await w.peppol.receive({ providerMessageId: 'sec-xxe', payload: xxe }); out.xxe = [r1.message.state, r1.supplierInvoiceId]; eq(r1.message.state, 'VALIDATION_FAILED'); eq(r1.supplierInvoiceId, null);
    const bytes = (await w.storage.get(r1.original.storageRef)).data; assert.ok(!bytes.toString('utf8').includes('root:'), 'nothing was resolved from the file system'); eq(sha(bytes), sha(xxe), 'only the raw bytes were archived');
    const r2 = await w.peppol.receive({ providerMessageId: 'sec-bad', payload: Buffer.from('<Invoice><unclosed') }); out.malformed = r2.message.state; eq(r2.message.state, 'VALIDATION_FAILED'); eq(r2.supplierInvoiceId, null);
    out.oversized = await code(() => w.peppol.receive({ providerMessageId: 'sec-big', payload: Buffer.alloc(5 * 1024 * 1024 + 1, 0x20) })); eq(out.oversized, 'PAYLOAD_TOO_LARGE'); out.empty = await code(() => w.peppol.receive({ providerMessageId: 'sec-empty', payload: Buffer.alloc(0) })); eq(out.empty, 'PAYLOAD_EMPTY');
    out.webhook = await code(() => w.peppol.handleWebhook({ headers: { 'x-fake-signature': 'wrong' }, body: xml, providerMessageId: 'sec-auth' })); eq(out.webhook, 'WEBHOOK_AUTHENTICATION_FAILED');
    const other = text.replace(/(<cac:AccountingCustomerParty>[\s\S]*?<cbc:EndpointID schemeID=")0208(">)\d+/, '$10208$2999999999'); out.wrongRecipient = await code(() => w.peppol.handleWebhook({ headers: sigOk, body: Buffer.from(other), providerMessageId: 'sec-recipient' })); eq(out.wrongRecipient, 'WRONG_RECIPIENT');
    const att = (name, mime) => text.replace('<cac:AccountingSupplierParty>', `<cac:AdditionalDocumentReference><cbc:ID>att</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="${mime}" filename="${name}">QUJD</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference><cac:AccountingSupplierParty>`);
    const before = (await w.st.listArtifacts({ merchantId: w.mid, kind: 'ATTACHMENT' })).length;
    for (const [i, [name, mime]] of [['../../evil.pdf', 'application/pdf'], ['run.exe', 'application/x-msdownload'], ['ok.pdf', 'text/html']].entries()) await w.peppol.receive({ providerMessageId: `sec-att-${i}`, payload: Buffer.from(att(name, mime)) });
    eq((await w.st.listArtifacts({ merchantId: w.mid, kind: 'ATTACHMENT' })).length, before, 'no unsafe attachment is archived'); out.attachments = 'none archived';
    out.traversal = ['../../x.pdf', '/etc/passwd', 'a/b.pdf', 'a\\b.pdf', 'x\u0000.pdf', '', null, '..'].map((n) => safeFileName(n)); eq(out.traversal.every((x) => !x), true);
    const ev = (await w.st.listEventsForMerchant({ merchantId: w.mid, limit: 500 })).map((e) => e.action); for (const a of ['PEPPOL_INBOUND_ATTACHMENT_SKIPPED', 'PEPPOL_INBOUND_REJECTED']) assert.ok(ev.includes(a), a);
    return out;
  },

  async 'S24b merchant isolation: another merchant sees and changes nothing of this one (documents, artifacts, payments, bank, Peppol, treasury, export)'(w) {
    const other = w.otherWorld(); const inv = await w.invoice1000(); const pay = await w.receive(40000, [[inv.id, 40000]]); const tx = await w.bankTx('iso-tx', 40000); const q = await w.peppol.queue(await w.st.getDocument(inv.id), { actor: MERCHANT_ACTOR }); const out = {};
    out.view = await code(() => other.svc.view(inv.id)); assert.notEqual(out.view, 'OK'); out.compliance = await code(async () => { const c = await other.legal.compliance(inv.id); if (c?.pdf) throw new Error('LEAK'); if (c) throw Object.assign(new Error('x'), { code: 'EMPTY' }); }); assert.notEqual(out.compliance, 'LEAK');
    out.pay = await code(() => other.receive(1000, [[inv.id, 1000]])); assert.notEqual(out.pay, 'OK'); out.reconcile = await code(() => other.st.reconcileBank({ merchantId: other.mid, key: 'iso-r', transactionId: tx.id, items: [{ paymentId: pay.payment.id, amountCents: 100 }], actor: MERCHANT_ACTOR, at: w.at })); assert.notEqual(out.reconcile, 'OK');
    out.dispatch = await code(() => other.peppol.dispatch(q.message.id)); assert.notEqual(out.dispatch, 'OK'); eq((await other.st.listPeppolMessages({ merchantId: other.mid })).length, 0); eq((await other.st.listBankTransactions({ merchantId: other.mid })).length, 0);
    eq((await other.st.listArtifacts({ merchantId: other.mid, documentId: inv.id })).length, 0);
    eq((await other.treasury().model()).items.length, 0); const pkg = await other.pkg(); eq([csv(pkg, 'sales.csv').length, csv(pkg, 'payments.csv').length, csv(pkg, 'bank-transactions.csv').length], [0, 0, 0]);
    eq(await w.view(inv.id).then((x) => x.paid), 40000, 'the owner is unaffected'); return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v === 'OK' ? 'OK' : 'REFUSED']));
  },

  // ---------------------------------------------------------------- 27 + 28 + 29 mixed gift-shop-shaped dataset: reconciliation to the cent, export package proof
  async 'S28 S29 gift-shop-shaped mixed dataset: every module agrees to the cent (unexplained difference = 0), the package verifies, tampering fails'(w) {
    await giftShopDataset(w); const diff = await moneyDifference(w); eq(diff.diffs, [], JSON.stringify(diff.diffs)); eq(diff.totalCents, 0);
    const pkg = await w.pkg(undefined, { includeDocuments: true }); eq(verifyExportPackage(pkg.zip).ok, true); const entries = unzip(pkg.zip); const root = [...entries.keys()][0].split('/')[0];
    const rebuild = (mut) => { const m = new Map(entries); mut(m); return zip([...m].map(([name, data]) => ({ name, data }))); }; const bad = (z, c) => { const v = verifyExportPackage(z); eq(v.ok, false); assert.ok(v.problems.some((p) => p.code === c), JSON.stringify(v.problems)); };
    bad(rebuild((m) => m.set(`${root}/sales.csv`, Buffer.concat([m.get(`${root}/sales.csv`), Buffer.from('x')]))), 'FILE_MODIFIED');
    const doc = [...entries.keys()].find((k) => k.includes('/documents/') && k.endsWith('.pdf')); assert.ok(doc, 'documents are part of the package'); bad(rebuild((m) => { const b = Buffer.from(m.get(doc)); b[b.length - 2] ^= 1; m.set(doc, b); }), 'FILE_MODIFIED'); bad(rebuild((m) => m.delete(doc)), 'FILE_MISSING');
    const t = await w.treasury().model(); return { customers: diff.customers, suppliers: diff.suppliers, exportNet: diff.exportNet, rows: pkg.rowCounts, currencies: t.currencies, files: entries.size };
  },
};

export { zip, unzip };
