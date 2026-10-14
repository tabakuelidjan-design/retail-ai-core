// Final acceptance scenarios (sections 3-20, 22-23, 27-29). Each scenario takes a world (memory OR PostgreSQL 17) and
//  - ASSERTS its own invariants (money reconciles to the cent across Invoice -> Payment -> Allocation -> Bank -> Reconciliation -> Treasury -> Export), and
//  - returns a small deterministic evidence object (no ids, no random values) so that memory == PostgreSQL can be compared.
import assert from 'node:assert/strict';
import { vcsValid, vcsFormat, vcsForInvoiceNumber } from '../src/finance/belgium-compliance.js';
import { readPdfText } from '../src/finance/pdf-text.js';
import { verifyExportPackage } from '../src/finance/accountant-export.js';
import { supplierInvoiceXml, BUYER_OF_SELLER } from './finance-legal-helpers.js';
import { MERCHANT_ACTOR, GROSS_1000, TWO_LINES, LINE_B, code, csv, independent, sha } from './finance-acceptance-world.js';

const eq = assert.deepStrictEqual;
const itemOf = (model, id) => model.items.find((i) => i.id.includes(id));
const salesRow = (pkg, number) => csv(pkg, 'sales.csv').find((r) => r.number === number);
const E = (c) => (c / 100).toFixed(2);

/** The same business fact read through every module must agree: settlement, independent recomputation, Treasury item, export row. */
async function crossCheck(w, inv, expectRemainingCents) {
  const v = await w.view(inv.id); const ind = (await independent(w)).customers[inv.id]; const pkg = await w.pkg(); const row = salesRow(pkg, inv.number);
  const model = await w.treasury().model(); const item = itemOf(model, inv.id);
  eq(v.remaining, expectRemainingCents, 'settlement'); eq(ind.remaining, expectRemainingCents, 'independent recomputation'); eq(row.remaining, E(expectRemainingCents), 'export row');
  eq(item ? item.amountCents : 0, expectRemainingCents, 'treasury item');
  return { remaining: v.remaining, status: v.status, paid: v.paid, exportRemaining: row.remaining, exportPaymentStatus: row.payment_status };
}

export const SCENARIOS = {
  // ---------------------------------------------------------------- 3. Belgian B2B happy path (invoice -> PDF/UBL -> Peppol -> payment -> bank -> reconciliation -> treasury -> export)
  async 'S3 customer invoice happy path (Belgian B2B), end to end'(w) {
    const inv = await w.invoice1000(); const doc = await w.st.getDocument(inv.id); const out = {};
    assert.match(doc.number, /^[A-Z0-9-]+$/); assert.ok(doc.lockedAt && doc.snapshotHash, 'immutable snapshot'); eq(doc.totals.grossCents, 100000); eq(doc.totals.vatCents, 17355); eq(doc.currency, 'EUR');
    eq([doc.seller.vatNumber, doc.seller.address.countryCode, doc.customer.vatNumber, doc.customer.kind], ['BE0000000097', 'BE', 'BE0000000196', 'business']); assert.ok(doc.issueDate && doc.dueDate && doc.dueDate >= doc.issueDate);
    const comp = await w.legal.compliance(doc.id); eq(comp.routing.route, 'PEPPOL_REQUIRED'); assert.match(comp.paymentReference, /^\d{12}$/); assert.ok(vcsValid(comp.paymentReference)); eq(comp.paymentReference, vcsForInvoiceNumber(doc.number));
    const pdf = await w.legal.originalPdf(doc.id); const ubl = await w.legal.structuredOriginal(doc.id);
    assert.ok(pdf.verified !== false && ubl.verified !== false); eq(comp.pdf.sha256, sha(pdf.data)); eq(comp.structured.sha256, sha(ubl.data)); eq(comp.snapshotHash, doc.snapshotHash);
    const xml = ubl.data.toString('utf8'); const text = (await readPdfText(pdf.data)).pages.flatMap((p) => p.lines.map((l) => l.text)).join(' ');
    for (const needle of ['1000.00', '826.45', '173.55', doc.number]) assert.ok(xml.includes(needle), `UBL has ${needle}`); for (const needle of ['1 000,00', doc.number]) assert.ok(text.includes(needle) || text.replace(/\s/g, '').includes(needle.replace(/\s/g, '')), `PDF has ${needle}`);
    assert.ok(xml.includes(`<cbc:PaymentID>${comp.paymentReference}</cbc:PaymentID>`)); assert.ok(text.replace(/\s+/g, '').includes(vcsFormat(comp.paymentReference)));
    eq(comp.validation.ok, true); assert.ok(comp.validation.ruleset.version.startsWith('3.0.')); out.validation = { ok: comp.validation.ok, bis: comp.validation.ruleset.version };
    // outbound Peppol: accepted by the provider is SUBMITTED, delivery comes from the provider status
    const q = await w.peppol.queue(doc, { actor: MERCHANT_ACTOR }); const d = await w.peppol.dispatch(q.message.id); eq(d.state, 'SUBMITTED'); eq(w.provider.calls.submit, 1);
    const again = await w.peppol.dispatch(q.message.id); eq([again.sent, w.provider.calls.submit], [false, 1]);
    w.provider.deliver(d.message.providerMessageId); eq((await w.peppol.refreshStatus(q.message.id)).state, 'DELIVERED');
    out.peppol = ['QUEUED', 'SUBMITTED', 'DELIVERED'];
    // payment -> allocation -> remaining_due, bank, reconciliation
    out.before = await crossCheck(w, inv, 100000);
    const pay = await w.receive(100000, [[inv.id, 100000]], { reference: comp.paymentReference, key: 'acc-s3-pay' }); const tx = await w.bankTx('s3-tx', 100000, '2026-09-20', { reference: comp.paymentReference });
    eq([tx.reconciliationStatus, tx.remainingCents], ['UNRECONCILED', 100000]); await w.reconcile(tx, pay.payment.id, 100000); const tx2 = await w.tx('s3-tx'); eq([tx2.reconciliationStatus, tx2.reconciledCents, tx2.remainingCents], ['RECONCILED', 100000, 0]);
    out.after = await crossCheck(w, inv, 0); eq(out.after.paid, 100000);
    const pkg = await w.pkg(); const pay1 = csv(pkg, 'payments.csv'); eq(pay1.length, 1); eq(pay1[0].amount, '1000.00'); eq(csv(pkg, 'bank-transactions.csv')[0].reconciliation_status, 'RECONCILED'); eq(verifyExportPackage(pkg.zip).ok, true);
    const fc = (await w.treasury().model()).position; void fc; out.bank = [tx2.reconciliationStatus, tx2.reconciledCents];
    return out;
  },

  // ---------------------------------------------------------------- 4. partial payment 400 + 600
  async 'S4 partial payment 400 then 600 (1 000.00 invoice)'(w) {
    const inv = await w.invoice1000(); const out = [];
    const p1 = await w.receive(40000, [[inv.id, 40000]]); const t1 = await w.bankTx('s4-t1', 40000); await w.reconcile(t1, p1.payment.id, 40000);
    out.push(await crossCheck(w, inv, 60000)); eq((await w.tx('s4-t1')).reconciliationStatus, 'RECONCILED');
        const p2 = await w.receive(60000, [[inv.id, 60000]]); const t2 = await w.bankTx('s4-t2', 60000, '2026-09-21'); await w.reconcile(t2, p2.payment.id, 60000);
    out.push(await crossCheck(w, inv, 0)); const over = await code(() => w.receive(1, [[inv.id, 1]])); assert.notEqual(over, 'OK', 'a settled invoice takes no further allocation');
    return out;
  },

  // ---------------------------------------------------------------- 5. several payments on one invoice: status is derived, never a stored flag
  async 'S5 four payments on one invoice; a reversal flips the derived status back'(w) {
    const inv = await w.invoice1000(); const out = []; const ps = [];
    for (let i = 0; i < 4; i++) { ps.push(await w.receive(25000, [[inv.id, 25000]], { paidOn: `2026-09-2${i}` })); out.push((await w.view(inv.id)).remaining); }
    eq(out, [75000, 50000, 25000, 0]); const full = await crossCheck(w, inv, 0);
    const al = (await w.st.listAllocations({ customerDocumentId: inv.id }))[3]; await w.P.reverseAllocation(al.id, { reason: 'bank returned the last transfer', idempotencyKey: 'acc-s5-rv' }, MERCHANT_ACTOR);
    const reopened = await crossCheck(w, inv, 25000); assert.notEqual(reopened.exportPaymentStatus, full.exportPaymentStatus, 'the derived status follows the allocations, not a stored flag');
    return { steps: out, reopened: reopened.remaining, reopenedPaid: reopened.paid };
  },

  // ---------------------------------------------------------------- 6. one 1 000.00 payment spread over several invoices
  async 'S6 one payment allocated across three invoices; over-allocation and cross-currency refused'(w) {
    const a = await w.invoice(400); const b = await w.invoice(350); const c = await w.invoice(250); const out = {};
    const p = await w.receive(100000, [[a.id, 40000], [b.id, 35000], [c.id, 25000]]); eq(p.payment.allocatedCents, 100000); eq(p.payment.unallocatedCents, 0);
    for (const x of [a, b, c]) await crossCheck(w, x, 0);
    const t = await w.bankTx('s6-t', 100000); await w.reconcile(t, p.payment.id, 100000); eq((await w.tx('s6-t')).reconciliationStatus, 'RECONCILED');
    const d = await w.invoice(300); out.over = await code(() => w.receive(100000, [[d.id, 30001]])); assert.notEqual(out.over, 'OK');
    const partial = await w.receive(100000, [[d.id, 30000]]); eq([partial.payment.allocatedCents, partial.payment.unallocatedCents], [30000, 70000]); out.unallocated = partial.payment.unallocatedCents;
    out.again = await code(() => w.P.allocate(partial.payment.id, { allocations: [{ documentId: d.id, amountCents: 1 }] }, MERCHANT_ACTOR)); assert.notEqual(out.again, 'OK', 'an invoice already settled takes no more'); assert.notEqual(out.again, 'PAYMENT_AMOUNT_INVALID', 'refused for the right reason');
    const rest = await w.invoice(400); const more = await w.P.allocate(partial.payment.id, { allocations: [{ documentId: rest.id, amountCents: 40000 }] }, MERCHANT_ACTOR); eq([more.payment.allocatedCents, more.payment.unallocatedCents], [70000, 30000]); out.later = more.payment.unallocatedCents;
    const ind = await independent(w); eq(Object.values(ind.customers).reduce((s, x) => s + x.paid, 0), 130000 + 40000); return out;
  },

  // ---------------------------------------------------------------- 7. partial credit note
  async 'S7 partial credit note (one of two lines): links, number, VAT, remaining_due, PDF + UBL CreditNote validated, no over-credit, export'(w) {
    const inv = await w.invoice1000({ lines: TWO_LINES }); const doc = await w.st.getDocument(inv.id); eq(doc.totals.grossCents, 96800);
    const cn = await w.creditNote(inv, LINE_B); const cdoc = await w.st.getDocument(cn.id);
    eq(cdoc.relatedDocumentId, inv.id); assert.ok(cdoc.number && cdoc.number !== doc.number); eq([cdoc.totals.grossCents, cdoc.totals.vatCents], [48400, 8400]);
    const comp = await w.legal.compliance(cdoc.id); eq(comp.validation.ok, true); assert.ok(comp.pdf && comp.structured); const xml = (await w.legal.structuredOriginal(cdoc.id)).data.toString('utf8');
    assert.ok(xml.includes('<CreditNote') && xml.includes(doc.number), 'UBL CreditNote referencing the invoice');
    eq((await w.legal.compliance(doc.id)).routing.route, comp.routing.route, 'the credit note follows the invoice route');
    const v = await crossCheck(w, inv, 48400); eq(await w.view(inv.id).then((x) => [x.credited, x.due]), [48400, 48400]);
    const pkg = await w.pkg(); const cr = csv(pkg, 'credit-notes.csv'); eq(cr.length, 1); eq(cr[0].original_invoice_number, doc.number); eq(cr[0].gross, '484.00');
    const second = await code(() => w.creditNote(inv, [{ description: 'Ligne A', quantity: '1', unitPrice: '400.01', vatRate: '21' }])); assert.notEqual(second, 'OK', 'crediting beyond the invoice is refused'); // 484.00 + 484.01 > 968.00
    return { remaining: v.remaining, credit: cr[0].gross, overCredit: second };
  },

  // ---------------------------------------------------------------- 8. refund: invoice -> payment -> credit note -> refund
  async 'S8 refund after a credit note on a paid invoice: linkage, bank OUT, reconciliation, treasury, export, no double reversal'(w) {
    const inv = await w.invoice1000({ lines: TWO_LINES }); const pay = await w.receive(96800, [[inv.id, 96800]]); const cn = await w.creditNote(inv, LINE_B);
    const v0 = await w.view(inv.id); eq([v0.paid, v0.credited, v0.remaining, v0.due], [96800, 48400, 0, 48400]);
    const rf = await w.P.refund(cn.id, { amountCents: 48400, paidOn: '2026-09-28', method: 'bank_transfer', refundOfPaymentId: pay.payment.id, idempotencyKey: 'acc-s8-rf' }, MERCHANT_ACTOR); eq([rf.payment.direction, rf.payment.amountCents], ['OUT', 48400]);
    const retry = await w.P.refund(cn.id, { amountCents: 48400, paidOn: '2026-09-28', method: 'bank_transfer', refundOfPaymentId: pay.payment.id, idempotencyKey: 'acc-s8-rf' }, MERCHANT_ACTOR); eq(retry.duplicate, true);
    const again = await code(() => w.P.refund(cn.id, { amountCents: 1, paidOn: '2026-09-29', idempotencyKey: 'acc-s8-rf2' }, MERCHANT_ACTOR)); eq(again, 'REFUND_EXCEEDS_CREDIT_NOTE', 'a second refund of the same credit note is refused');
    const v1 = await w.view(inv.id); eq([v1.refunded, v1.remaining], [48400, 0]);
    const t = await w.bankTx('s8-out', -48400, '2026-09-28'); await w.reconcile(t, rf.payment.id, 48400); eq((await w.tx('s8-out')).reconciliationStatus, 'RECONCILED');
    const pkg = await w.pkg(); const rows = csv(pkg, 'payments.csv'); eq(rows.map((r) => [r.direction, r.amount]).sort(), [['IN', '968.00'], ['OUT', '-484.00']]);
    const ind = (await independent(w)).customers[inv.id]; eq(ind.remaining, 0); eq(itemOf(await w.treasury().model(), inv.id) ?? null, null);
    const net = rows.reduce((s2, r) => s2 + Math.round(Number(r.amount) * 100), 0); eq(net, 48400, 'net cash kept = the 484.00 still due');
    return { before: v0, after: v1, again };
  },
};
