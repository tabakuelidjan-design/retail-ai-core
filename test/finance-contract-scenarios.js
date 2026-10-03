// Shared MEMORY <-> POSTGRES business contract (Phase 1). The scenarios are written ONCE against a 'world' = { storeFor(merchantId), svc, inboxFor(store) }.
// - test/finance-payment-contract.test.js runs them on the in-memory store (fast, part of npm test) and pins the results to EXPECTED.
// - test/pg/40-contract.pg.test.js runs the SAME scenarios on the production store code (supabase-store.js) over a real PostgreSQL 17 and pins the same EXPECTED.
// So memory == PostgreSQL == EXPECTED. Concurrency is PostgreSQL-specific and proven elsewhere (test/pg/30-p0-regression.pg.test.js).
import { createMemoryStore } from '../src/finance/memory-store.js';
import { createFinanceService } from '../src/finance/service.js';
import { createInboxService, createMemoryAttachmentStore } from '../src/finance/inbox.js';
import { CONFIG, MERCHANT_ACTOR, issueInvoice } from './finance-fixtures.js';
import { createTreasuryService } from '../src/finance/treasury-service.js';
import { loadDocsForReports } from '../src/finance/reports.js';

export const A = '11111111-1111-1111-1111-111111111111';
export const B = '22222222-2222-2222-2222-222222222222';
export const mkClock = () => { let t = 0; return { now: () => new Date(Date.UTC(2026, 8, 21, 10, 0, t++)).toISOString(), today: () => '2026-09-21' }; };

export async function memoryWorld() {
  const store = createMemoryStore(); const clock = mkClock();
  return { name: 'memory', storeFor: () => store, svc: createFinanceService({ store, config: { ...CONFIG, merchantId: A }, clock }), inboxFor: (s) => createInboxService({ store: s, attachments: createMemoryAttachmentStore(), merchantId: A, now: clock.now }), close: async () => {} };
}

const code = async (fn) => { try { await fn(); return 'OK'; } catch (e) { return e.code ?? String(e.message).slice(0, 60); } };
const view = async (svc, id) => { const v = await svc.view(id); const x = v.settlement; return { status: v.doc.status, paid: x.paidCents, remaining: x.remainingCents, credited: x.creditedCents, due: x.effectiveDueCents, refunded: x.refundedCents, retained: x.retainedCents, refundable: x.refundableCents }; };
const pay = (p) => ({ status: p.status, amount: p.amountCents, allocated: p.allocatedCents, unallocated: p.unallocatedCents, reversed: p.reversedCents, direction: p.direction });
const supplier = (over = {}) => ({ merchantId: A, supplierName: 'Fournisseur Exemple', invoiceNumber: `S-${Math.random().toString(36).slice(2, 8)}`, issueDate: '2026-09-01', netCents: 10000, vatCents: 2100, grossCents: 12100, currency: 'EUR', status: 'TO_PAY', source: 'manual', ...over });
const sup = (r) => ({ status: r.status, paymentStatus: r.paymentStatus, allocated: r.allocatedCents, paidAt: r.paidAt ?? null, paidAmount: r.paidAmountCents ?? null, paidReference: r.paidReference ?? null });

export const SCENARIOS = {
  async 'customer payments: partial, remaining, over-payment refused, paid, closed, audit events'(w) {
    const { svc } = w; const inv = await issueInvoice(svc); const out = [];
    await svc.recordPayment(inv.id, { amount: '30.00', paidOn: '2026-09-25', method: 'bank_transfer' }, MERCHANT_ACTOR); out.push(await view(svc, inv.id));
    out.push(await code(() => svc.recordPayment(inv.id, { amount: '50.00', paidOn: '2026-09-26' }, MERCHANT_ACTOR)));
    await svc.recordPayment(inv.id, { amount: '41.90', paidOn: '2026-09-30', method: 'cash' }, MERCHANT_ACTOR); out.push(await view(svc, inv.id));
    out.push(await code(() => svc.recordPayment(inv.id, { amount: '1.00', paidOn: '2026-10-01' }, MERCHANT_ACTOR)));
    out.push((await svc.events(inv.id)).filter((e) => e.action === 'RECORD_PAYMENT').length);
    return out;
  },
  async 'idempotency: a retry returns the committed payment, even once the invoice is PAID; a different request under the same key is refused'(w) {
    const { svc } = w; const inv = await issueInvoice(svc); const p = { amount: '71.90', paidOn: '2026-09-25', method: 'bank_transfer', idempotencyKey: 'contract-key-1' };
    const first = await svc.recordPayment(inv.id, p, MERCHANT_ACTOR); const retry = await svc.recordPayment(inv.id, p, MERCHANT_ACTOR);
    const reuse = await code(() => svc.recordPayment(inv.id, { ...p, amount: '10.00' }, MERCHANT_ACTOR));
    return [first.duplicate, retry.duplicate, first.id === retry.id, await view(svc, inv.id), reuse, (await w.storeFor(A).listAllocations({ customerDocumentId: inv.id })).length];
  },
  async 'corrections: a negative payment reverses the most recent allocations, is bounded by what was paid, and a retry does not correct twice'(w) {
    const { svc } = w; const inv = await issueInvoice(svc); await svc.recordPayment(inv.id, { amount: '30.00', paidOn: '2026-09-25' }, MERCHANT_ACTOR);
    const k = { idempotencyKey: 'contract-fix-1' }; const a = await svc.recordPayment(inv.id, { amount: '-10.00', paidOn: '2026-09-26', reference: 'oops', ...k }, MERCHANT_ACTOR); const b = await svc.recordPayment(inv.id, { amount: '-10.00', paidOn: '2026-09-26', reference: 'oops', ...k }, MERCHANT_ACTOR);
    return [a.duplicate, b.duplicate, await view(svc, inv.id), await code(() => svc.recordPayment(inv.id, { amount: '-30.00', paidOn: '2026-09-27', reference: 'too much' }, MERCHANT_ACTOR))];
  },
  async 'reversal and void: statuses are re-derived, reversals are idempotent and bounded, the history is kept'(w) {
    const { svc } = w; const st = w.storeFor(A); const inv = await issueInvoice(svc); const pay = await svc.recordPayment(inv.id, { amount: '71.90', paidOn: '2026-09-25', idempotencyKey: 'contract-rev-1' }, MERCHANT_ACTOR); const out = [await view(svc, inv.id)];
    const al = (await st.listAllocations({ customerDocumentId: inv.id }))[0];
    const r1 = await svc.reversePayment(inv.id, { allocationId: al.id, amountCents: 2000, reason: 'bank error', idempotencyKey: 'contract-undo-1' }, MERCHANT_ACTOR); const r2 = await svc.reversePayment(inv.id, { allocationId: al.id, amountCents: 2000, reason: 'bank error', idempotencyKey: 'contract-undo-1' }, MERCHANT_ACTOR);
    const retryAfterReversal = await svc.recordPayment(inv.id, { amount: '71.90', paidOn: '2026-09-25', idempotencyKey: 'contract-rev-1' }, MERCHANT_ACTOR); // the original request, repeated after a reversal: still the same committed payment
    out.push(retryAfterReversal.duplicate, retryAfterReversal.id === pay.id);
    out.push(r1.duplicate, r2.duplicate, await view(svc, inv.id), await code(() => svc.reversePayment(inv.id, { allocationId: al.id, amountCents: 9000, reason: 'x' }, MERCHANT_ACTOR)));
    const v = await svc.voidPayment(pay.id, { reason: 'entered by mistake', idempotencyKey: 'contract-void-1' }, MERCHANT_ACTOR); const v2 = await svc.voidPayment(pay.id, { reason: 'entered by mistake', idempotencyKey: 'contract-void-1' }, MERCHANT_ACTOR);
    out.push(v.duplicate, v2.duplicate, await view(svc, inv.id), await code(() => svc.voidPayment(pay.id, { reason: 'again' }, MERCHANT_ACTOR)), (await st.listAllocations({ customerDocumentId: inv.id })).map((a) => a.amountCents));
    return out;
  },
  async 'credit ceiling: the second full credit note cannot be issued, nor a third drafted; the invoice becomes CREDITED'(w) {
    const { svc } = w; const inv = await issueInvoice(svc); const mk = async () => { const cn = await svc.createCreditNote(inv.id, { reason: 'return' }, MERCHANT_ACTOR); await svc.submit(cn.id, MERCHANT_ACTOR); return cn; };
    const a = await mk(); const b = await mk(); const out = [];
    out.push(await code(() => svc.decide(a.id, 'APPROVE', MERCHANT_ACTOR))); out.push(await code(() => svc.decide(b.id, 'APPROVE', MERCHANT_ACTOR)));
    out.push(await code(() => svc.createCreditNote(inv.id, { reason: 'again' }, MERCHANT_ACTOR))); out.push((await view(svc, inv.id)).status);
    return out;
  },
  async 'merchant isolation: B can neither pay, reverse, reference nor annotate what belongs to A'(w) {
    const { svc } = w; const inv = await issueInvoice(svc); await svc.recordPayment(inv.id, { amount: '10.00', paidOn: '2026-09-25', idempotencyKey: 'contract-iso-a' }, MERCHANT_ACTOR);
    const sb = w.storeFor(B); const al = (await w.storeFor(A).listAllocations({ customerDocumentId: inv.id }))[0]; const out = [];
    out.push(await code(() => sb.recordPayment({ merchantId: B, key: 'contract-iso-b', direction: 'IN', amountCents: 100, currency: 'EUR', paidOn: '2026-09-25', allocations: [{ customerDocumentId: inv.id, amountCents: 100 }] })));
    out.push(await code(() => sb.reverseAllocations({ merchantId: B, key: 'contract-iso-r', items: [{ allocationId: al.id, amountCents: null }] })));
    out.push(await code(() => sb.saveDocument({ ...inv, id: sb.newId(), merchantId: B, type: 'credit_note', status: 'DRAFT', number: null, lockedAt: null, snapshotHash: null, version: 1, relatedDocumentId: inv.id, sourceOrderId: null }, null)));
    out.push(await code(() => sb.appendEvent({ documentId: inv.id, merchantId: B, actor: MERCHANT_ACTOR, action: 'X', fromStatus: null, toStatus: null, detail: {}, at: '2026-09-25T10:00:00Z' })));
    out.push((await sb.getPaymentByKey(B, 'contract-iso-a')) === null);
    return out;
  },
  async 'supplier truth: PAID is derived (unpaid -> partially paid -> paid -> back), never written, nothing financial changes under payments'(w) {
    const st = w.storeFor(A); const row = await st.saveSupplierInvoice(supplier()); const out = [sup(row)];
    out.push(await code(() => st.updateSupplierInvoice(row.id, { status: 'PAID' }, 'TO_PAY')), await code(() => st.saveSupplierInvoice(supplier({ status: 'PAID' }))));
    const pay = (key, cents, on, ref) => st.recordPayment({ merchantId: A, key, direction: 'OUT', amountCents: cents, currency: 'EUR', paidOn: on, method: 'bank_transfer', reference: ref, actor: MERCHANT_ACTOR, allocations: [{ supplierInvoiceId: row.id, amountCents: cents }] });
    await pay('contract-sp-1', 5000, '2026-09-30', 'part-1'); out.push(sup(await st.getSupplierInvoice(row.id)));
    out.push(await code(() => pay('contract-sp-x', 7101, '2026-10-01', 'over')));
    const p2 = await pay('contract-sp-2', 7100, '2026-10-02', 'part-2'); out.push(sup(await st.getSupplierInvoice(row.id)));
    const al = (await st.listAllocations({ supplierInvoiceId: row.id })).find((a) => a.paymentId === p2.payment.id);
    await st.reverseAllocations({ merchantId: A, key: 'contract-sp-undo', items: [{ allocationId: al.id, amountCents: 3000 }], reason: 'bounced' }); out.push(sup(await st.getSupplierInvoice(row.id)));
    out.push(await code(() => st.updateSupplierInvoice(row.id, { grossCents: 20000, netCents: 16529, vatCents: 3471 }, 'TO_PAY')), await code(() => st.updateSupplierInvoice(row.id, { status: 'TO_REVIEW' }, 'TO_PAY')));
    out.push((await st.listSupplierInvoices(A)).map((r) => r.allocatedCents));
    return out;
  },
  async 'supplier payment through the inbox service: partial then full derives PAID, a retry is the same operation, nothing left to pay afterwards'(w) {
    const st = w.storeFor(A); const inbox = w.inboxFor(st); const row = await st.saveSupplierInvoice(supplier()); const args = { paidOn: '2026-10-02', reference: 'virement' };
    const out = [sup(await inbox.pay(row.id, { ...args, amountCents: 5000, idempotencyKey: 'contract-inbox-0' }, MERCHANT_ACTOR))];
    out.push(await code(() => inbox.pay(row.id, { ...args, amountCents: 7101, idempotencyKey: 'contract-inbox-x' }, MERCHANT_ACTOR)));
    const paid = await inbox.pay(row.id, { ...args, amountCents: 7100, idempotencyKey: 'contract-inbox-1' }, MERCHANT_ACTOR); const retry = await inbox.pay(row.id, { ...args, amountCents: 7100, idempotencyKey: 'contract-inbox-1' }, MERCHANT_ACTOR);
    out.push(sup(paid), sup(retry), await code(() => inbox.pay(row.id, { ...args, amountCents: 1, idempotencyKey: 'contract-inbox-2' }, MERCHANT_ACTOR)), (await st.listRegistry(A)).length);
    return out;
  },
  async 'customer: one payment across several invoices, the surplus stays unallocated, later allocation, over-allocation refused, several payments to one invoice, currency'(w) {
    const { svc } = w; const P = svc.payments; const [a, b, c, d, e] = [await issueInvoice(svc), await issueInvoice(svc), await issueInvoice(svc), await issueInvoice(svc), await issueInvoice(svc)];
    const st = async (i) => (await view(svc, i.id)).status; const out = [];
    const r = await P.receive({ amountCents: 25000, paidOn: '2026-09-25', method: 'bank_transfer', idempotencyKey: 'contract-multi-1', allocations: [{ documentId: a.id, amountCents: 7190 }, { documentId: b.id, amountCents: 7190 }, { documentId: c.id, amountCents: 5000 }] }, MERCHANT_ACTOR);
    out.push(pay(r.payment), [await st(a), await st(b), await st(c)]);
    const retry = await P.receive({ amountCents: 25000, paidOn: '2026-09-25', method: 'bank_transfer', idempotencyKey: 'contract-multi-1', allocations: [{ documentId: a.id, amountCents: 7190 }, { documentId: b.id, amountCents: 7190 }, { documentId: c.id, amountCents: 5000 }] }, MERCHANT_ACTOR);
    out.push(retry.duplicate, retry.payment.id === r.payment.id);
    out.push(await code(() => P.allocate(r.payment.id, { allocations: [{ documentId: c.id, amountCents: 2191 }], idempotencyKey: 'contract-alloc-x' }, MERCHANT_ACTOR)));
    const l1 = await P.allocate(r.payment.id, { allocations: [{ documentId: c.id, amountCents: 2190 }], idempotencyKey: 'contract-alloc-1' }, MERCHANT_ACTOR); const l1b = await P.allocate(r.payment.id, { allocations: [{ documentId: c.id, amountCents: 2190 }], idempotencyKey: 'contract-alloc-1' }, MERCHANT_ACTOR);
    out.push(pay(l1.payment), l1b.duplicate, await st(c), await code(() => P.allocate(r.payment.id, { allocations: [{ documentId: d.id, amountCents: 3431 }], idempotencyKey: 'contract-alloc-2' }, MERCHANT_ACTOR)));
    out.push(pay((await P.allocate(r.payment.id, { allocations: [{ documentId: d.id, amountCents: 3430 }], idempotencyKey: 'contract-alloc-3' }, MERCHANT_ACTOR)).payment), await st(d));
    for (const [i, c1] of [[0, 3000], [1, 2000], [2, 2190]]) await P.receive({ amountCents: c1, paidOn: '2026-09-26', method: 'cash', idempotencyKey: `contract-many-${i}`, allocations: [{ documentId: e.id, amountCents: c1 }] }, MERCHANT_ACTOR);
    out.push(await view(svc, e.id), await code(() => P.receive({ amountCents: 100, currency: 'USD', paidOn: '2026-09-27', idempotencyKey: 'contract-ccy-1', allocations: [{ documentId: d.id, amountCents: 100 }] }, MERCHANT_ACTOR)));
    out.push(await code(() => P.receive({ amountCents: 100, paidOn: '2026-09-27', method: 'paypal', idempotencyKey: 'contract-method-1' }, MERCHANT_ACTOR)), (await P.list({ unallocated: true })).length);
    const adv = await P.receive({ amountCents: 4000, paidOn: '2026-09-28', method: 'bancontact', reference: 'avance', source: 'provider:sumup', externalReference: 'SU-123', idempotencyKey: 'contract-adv-1' }, MERCHANT_ACTOR);
    out.push(pay(adv.payment), adv.payment.source, adv.payment.externalReference, adv.payment.method, (await P.list({ unallocated: true })).length);
    return out;
  },
  async 'credit notes and refunds: credit before payment, after partial payment, after full payment, partial refund, bounded refunds, retry, reversal interaction'(w) {
    const { svc } = w; const P = svc.payments; const out = [];
    const partialCredit = async (inv, qty = '1') => { const cn = await svc.createCreditNote(inv.id, { reason: 'return', lines: [{ description: 'Item A', quantity: qty, unitPrice: '10.00', vatRate: '21' }] }, MERCHANT_ACTOR); await svc.submit(cn.id, MERCHANT_ACTOR); return svc.decide(cn.id, 'APPROVE', MERCHANT_ACTOR); };
    // credit BEFORE payment: the invoice is due for less
    const i1 = await issueInvoice(svc); await partialCredit(i1); out.push(await view(svc, i1.id));
    await P.receive({ amountCents: 5980, paidOn: '2026-09-25', method: 'bank_transfer', idempotencyKey: 'contract-cr-1', allocations: [{ documentId: i1.id, amountCents: 5980 }] }, MERCHANT_ACTOR); out.push(await view(svc, i1.id));
    out.push(await code(() => P.receive({ amountCents: 1, paidOn: '2026-09-25', idempotencyKey: 'contract-cr-1b', allocations: [{ documentId: i1.id, amountCents: 1 }] }, MERCHANT_ACTOR)));
    // credit AFTER a partial payment
    const i2 = await issueInvoice(svc); await P.receive({ amountCents: 3000, paidOn: '2026-09-25', idempotencyKey: 'contract-cr-2', allocations: [{ documentId: i2.id, amountCents: 3000 }] }, MERCHANT_ACTOR); await partialCredit(i2); out.push(await view(svc, i2.id));
    // credit AFTER full payment: the customer has paid too much, refundable appears; refunds are explicit, bounded and linked to the credit note
    const i3 = await issueInvoice(svc); const pay3 = await P.receive({ amountCents: 7190, paidOn: '2026-09-25', idempotencyKey: 'contract-cr-3', allocations: [{ documentId: i3.id, amountCents: 7190 }] }, MERCHANT_ACTOR);
    const cn3 = await partialCredit(i3); out.push(await view(svc, i3.id), (await svc.view(cn3.id)).refund.maxCents);
    const rf = (cents, key, extra = {}) => P.refund(cn3.id, { amountCents: cents, paidOn: '2026-09-26', method: 'bank_transfer', idempotencyKey: key, ...extra }, MERCHANT_ACTOR);
    const r1 = await rf(1000, 'contract-rf-1', { refundOfPaymentId: pay3.payment.id }); const r1b = await rf(1000, 'contract-rf-1', { refundOfPaymentId: pay3.payment.id });
    out.push(r1.duplicate, r1b.duplicate, r1.payment.id === r1b.payment.id, r1.payment.refundOfPaymentId === pay3.payment.id, await view(svc, i3.id), await code(() => rf(300, 'contract-rf-2')));
    await rf(210, 'contract-rf-3'); out.push(await view(svc, i3.id), await code(() => rf(1, 'contract-rf-4')), (await svc.view(cn3.id)).refund.maxCents);
    // reversal interaction: money already given back cannot be taken back; reversing the refund restores the refundable amount
    const al = (await w.storeFor(A).listAllocations({ customerDocumentId: i3.id })).find((x) => x.amountCents > 0);
    out.push(await code(() => P.reverseAllocation(al.id, { reason: 'wrong invoice', idempotencyKey: 'contract-rv-1' }, MERCHANT_ACTOR)));
    const refundAlloc = (await w.storeFor(A).listAllocations({ customerDocumentId: cn3.id })).find((x) => x.paymentId === r1.payment.id);
    await P.reverseAllocation(refundAlloc.id, { reason: 'refund bounced', idempotencyKey: 'contract-rv-2' }, MERCHANT_ACTOR); out.push(await view(svc, i3.id), (await svc.view(cn3.id)).refund.maxCents);
    // a refund can only be made for a credit note, never for an invoice or a payment of nothing
    out.push(await code(() => P.refund(i3.id, { amountCents: 1, paidOn: '2026-09-26', idempotencyKey: 'contract-rf-5' }, MERCHANT_ACTOR)));
    return out;
  },
  async 'supplier: one payment across several invoices, surplus unallocated, later allocation, partial and multiple payments, reversal, retry'(w) {
    const st = w.storeFor(A); const P = w.svc.payments; const s1 = await st.saveSupplierInvoice(supplier()); const s2 = await st.saveSupplierInvoice(supplier({ netCents: 5000, vatCents: 1050, grossCents: 6050 })); const s3 = await st.saveSupplierInvoice(supplier());
    const of = async (x) => sup(await st.getSupplierInvoice(x.id)); const out = [];
    const r = await P.pay({ amountCents: 20000, paidOn: '2026-10-01', method: 'bank_transfer', idempotencyKey: 'contract-sup-1', allocations: [{ supplierInvoiceId: s1.id, amountCents: 12100 }, { supplierInvoiceId: s2.id, amountCents: 5000 }] }, MERCHANT_ACTOR);
    out.push(pay(r.payment), await of(s1), await of(s2));
    const l = await P.allocate(r.payment.id, { allocations: [{ supplierInvoiceId: s2.id, amountCents: 1050 }], idempotencyKey: 'contract-sup-alloc-1' }, MERCHANT_ACTOR);
    out.push(pay(l.payment), await of(s2), await code(() => P.allocate(r.payment.id, { allocations: [{ supplierInvoiceId: s3.id, amountCents: 1851 }], idempotencyKey: 'contract-sup-alloc-2' }, MERCHANT_ACTOR)));
    await P.pay({ amountCents: 5000, paidOn: '2026-10-02', method: 'cash', idempotencyKey: 'contract-sup-2', allocations: [{ supplierInvoiceId: s3.id, amountCents: 5000 }] }, MERCHANT_ACTOR); out.push(await of(s3));
    const al = (await st.listAllocations({ supplierInvoiceId: s2.id })).find((x) => x.amountCents === 1050);
    const rv = await P.reverseAllocation(al.id, { reason: 'wrong supplier invoice', idempotencyKey: 'contract-sup-rv-1' }, MERCHANT_ACTOR); const rvb = await P.reverseAllocation(al.id, { reason: 'wrong supplier invoice', idempotencyKey: 'contract-sup-rv-1' }, MERCHANT_ACTOR);
    out.push(pay(rv.payment), rvb.duplicate, await of(s2), await code(() => P.receive({ amountCents: 100, paidOn: '2026-10-03', idempotencyKey: 'contract-sup-dir', allocations: [{ documentId: s1.id, amountCents: 100 }] }, MERCHANT_ACTOR)));
    return out;
  },
  async 'bank: accounts, identity, 1->1, 1->N, N->1, partial, unreconcile, ignore, ceilings, direction, currency, retries'(w) {
    const st = w.storeFor(A); const sb = w.storeFor(B); const out = []; const at = '2026-10-03T10:00:00.000Z';
    const row = (tag, amountCents, extra = {}) => ({ merchantId: A, accountId: 'csv-import', providerTxId: tag, date: '2026-09-01', amountCents, currency: 'EUR', source: 'csv', status: 'NEW', counterpartyName: 'Client', reference: tag, ...extra });
    const batch = await st.insertBankTransactionsBatch([row('t1', 10000), row('t2', 30000), row('t3a', 10000), row('t3b', 5000), row('t3c', 15000), row('t4', 50000), row('t5', -500), row('t6', 20000), row('t7', -700)]);
    const again = await st.insertBankTransactionsBatch([row('t1', 10000), row('t2', 30000)]); out.push([batch.created, again.created, again.duplicates]);
    out.push(await code(() => st.insertBankTransactionsBatch([row('tx-usd', 100, { currency: 'USD' })])), await code(() => st.insertBankTransactionsBatch([row('tx-zero', 0)])));
    const accounts = await st.listBankAccounts(A); out.push(accounts.map((x) => [x.externalId, x.origin, x.currency, x.status]));
    const tx = async (tag) => (await st.listBankTransactions({ merchantId: A })).find((t) => t.providerTxId === tag); const am = async (tag) => { const t = await tx(tag); return [t.reconciliationStatus, t.reconciledCents, t.ignoredCents, t.remainingCents, t.status]; };
    const pay = async (key, cents, direction = 'IN', extra = {}) => (await st.recordPayment({ merchantId: A, key, direction, amountCents: cents, currency: 'EUR', paidOn: '2026-09-02', method: 'bank_transfer', actor: MERCHANT_ACTOR, allocations: [], at, ...extra })).payment;
    const rec = (key, tag, items) => tx(tag).then((t) => st.reconcileBank({ merchantId: A, key, transactionId: t.id, items, actor: MERCHANT_ACTOR, at }));
    // 1 -> 1, and the retry is the same operation
    const p1 = await pay('bk-p1', 10000); const r1 = await rec('bk-r1', 't1', [{ paymentId: p1.id, amountCents: 10000 }]); const r1b = await rec('bk-r1', 't1', [{ paymentId: p1.id, amountCents: 10000 }]); out.push([r1.duplicate, r1b.duplicate, r1.reconciliations[0].id === r1b.reconciliations[0].id], await am('t1'));
    out.push(await code(() => rec('bk-r1', 't1', [{ paymentId: p1.id, amountCents: 9000 }])));
    // 1 -> N
    const p2a = await pay('bk-p2a', 10000); const p2b = await pay('bk-p2b', 20000); await rec('bk-r2', 't2', [{ paymentId: p2a.id, amountCents: 10000 }, { paymentId: p2b.id, amountCents: 20000 }]); out.push(await am('t2'));
    // N -> 1 (three bank movements fund one payment), then one cent more than the payment is refused
    const p3 = await pay('bk-p3', 30000); await rec('bk-r3a', 't3a', [{ paymentId: p3.id, amountCents: 10000 }]); await rec('bk-r3b', 't3b', [{ paymentId: p3.id, amountCents: 5000 }]); await rec('bk-r3c', 't3c', [{ paymentId: p3.id, amountCents: 15000 }]); out.push([await am('t3a'), await am('t3b'), await am('t3c')], await code(() => rec('bk-r3x', 't4', [{ paymentId: p3.id, amountCents: 1 }])));
    // partial, remaining stays visible, later completion, nothing beyond the transaction
    const p4 = await pay('bk-p4', 30000); await rec('bk-r4', 't4', [{ paymentId: p4.id, amountCents: 30000 }]); out.push(await am('t4'));
    const p4b = await pay('bk-p4b', 20000); await rec('bk-r4b', 't4', [{ paymentId: p4b.id, amountCents: 20000 }]); out.push(await am('t4'), await code(() => rec('bk-r4c', 't4', [{ paymentId: p4.id, amountCents: 1 }])));
    // unreconcile: explicit, bounded, idempotent, history kept, the payment itself untouched; a reconciled payment cannot be voided until it is unreconciled
    const recs1 = await st.listReconciliations({ bankTransactionId: (await tx('t1')).id }); const un = (key, t, items) => st.unreconcileBank({ merchantId: A, key, items, reason: 'wrong match', actor: MERCHANT_ACTOR, at });
    out.push(await code(() => st.voidPayment({ merchantId: A, key: 'bk-void1', paymentId: p1.id, on: '2026-10-03', reason: 'mistake', actor: MERCHANT_ACTOR, at })));
    const u1 = await un('bk-u1', 't1', [{ reconciliationId: recs1[0].id, amountCents: 4000 }]); out.push(await am('t1'), await code(() => un('bk-u2', 't1', [{ reconciliationId: recs1[0].id, amountCents: 6001 }])));
    const u1b = await un('bk-u1', 't1', [{ reconciliationId: recs1[0].id, amountCents: 4000 }]); out.push([u1.duplicate, u1b.duplicate], await am('t1'));
    await un('bk-u3', 't1', [{ reconciliationId: recs1[0].id, amountCents: null }]); out.push(await am('t1'), (await st.listReconciliations({ bankTransactionId: (await tx('t1')).id })).map((r) => r.amountCents).sort((x, y) => x - y));
    out.push((await st.voidPayment({ merchantId: A, key: 'bk-void2', paymentId: p1.id, on: '2026-10-03', reason: 'now fine', actor: MERCHANT_ACTOR, at })).duplicate);
    // ignore (reversible)
    const ig = await st.ignoreBank({ merchantId: A, key: 'bk-ig1', transactionId: (await tx('t5')).id, reason: 'bank fee booked elsewhere', actor: MERCHANT_ACTOR, at }); const igb = await st.ignoreBank({ merchantId: A, key: 'bk-ig1', transactionId: (await tx('t5')).id, reason: 'bank fee booked elsewhere', actor: MERCHANT_ACTOR, at });
    out.push([ig.duplicate, igb.duplicate], await am('t5'), await code(async () => st.ignoreBank({ merchantId: A, key: 'bk-ig2', transactionId: (await tx('t5')).id, actor: MERCHANT_ACTOR, at })));
    await un('bk-ig-undo', 't5', [{ reconciliationId: ig.reconciliation.id, amountCents: null }]); out.push(await am('t5'));
    // direction and currency
    const pOut = await pay('bk-pout', 700, 'OUT'); out.push(await code(() => rec('bk-dir', 't1', [{ paymentId: pOut.id, amountCents: 700 }])), await code(() => rec('bk-dir2', 't7', [{ paymentId: p3.id, amountCents: 700 }])));
    const pUsd = await pay('bk-pusd', 500, 'IN', { currency: 'USD' }); out.push(await code(() => rec('bk-ccy', 't1', [{ paymentId: pUsd.id, amountCents: 500 }])));
    // ATOMICITY: payment + reconciliation are one unit. A refused payment leaves the bank transaction untouched (the gap of the previous phase).
    const inv = await issueInvoice(w.svc); const t6 = await tx('t6'); const regBefore = (await st.listRegistry(A)).length;
    out.push(await code(() => st.reconcileAndPay({ merchantId: A, key: 'bk-atom-bad', transactionId: t6.id, actor: MERCHANT_ACTOR, at, payment: { amountCents: 20000, allocations: [{ customerDocumentId: inv.id, amountCents: 9999 }] } })), (await st.listRegistry(A)).length - regBefore, await am('t6'));
    const good = await st.reconcileAndPay({ merchantId: A, key: 'bk-atom-ok', transactionId: t6.id, actor: MERCHANT_ACTOR, at, payment: { amountCents: 20000, method: 'bancontact', allocations: [{ customerDocumentId: inv.id, amountCents: 7190 }] } });
    const goodb = await st.reconcileAndPay({ merchantId: A, key: 'bk-atom-ok', transactionId: t6.id, actor: MERCHANT_ACTOR, at, payment: { amountCents: 20000, method: 'bancontact', allocations: [{ customerDocumentId: inv.id, amountCents: 7190 }] } });
    out.push([good.duplicate, goodb.duplicate, good.payment.id === goodb.payment.id, good.payment.source, good.payment.bankReference, good.payment.direction], await am('t6'), (await st.listRegistry(A)).length - regBefore);
    const sameKeyOtherTx = await code(async () => st.reconcileAndPay({ merchantId: A, key: 'bk-atom-ok', transactionId: (await tx('t7')).id, actor: MERCHANT_ACTOR, at, payment: { amountCents: 20000, method: 'bancontact', allocations: [{ customerDocumentId: inv.id, amountCents: 7190 }] } })); out.push(sameKeyOtherTx);
    // merchant isolation
    const pB = (await sb.recordPayment({ merchantId: B, key: 'bk-pb', direction: 'IN', amountCents: 100, currency: 'EUR', paidOn: '2026-09-02', allocations: [], at })).payment;
    out.push(await code(() => sb.reconcileBank({ merchantId: B, key: 'bk-xa', transactionId: t6.id, items: [{ paymentId: pB.id, amountCents: 100 }], at })), await code(() => rec('bk-xb', 't4', [{ paymentId: pB.id, amountCents: 1 }])), (await sb.listBankTransactions({ merchantId: B })).length);
    // the legacy status cannot be written
    out.push(await code(() => st.updateBankTransaction(t6.id, { status: 'NEW' }, 'MATCHED')), (await st.getBankTransaction(t6.id)).status);
    return out;
  },
  // Treasury is a read model: the SAME facts read from either store must give the SAME position, forecast and risk (balances, later transactions, cash, remaining_due after real payments).
  async 'treasury: position, forecast 7/30/90 and risk from real store facts (bank, cash, invoices with partial payments)'(w) {
    const st = w.storeFor(A); const at = '2026-10-03T10:00:00.000Z';
    await st.upsertBankBalance({ merchantId: A, accountId: 'acc-1', iban: 'BE68539007547034', balanceCents: 842000, currency: 'EUR', asOf: '2026-10-02T08:00:00.000Z' });
    await st.insertBankTransactionsBatch([{ merchantId: A, accountId: 'acc-1', providerTxId: 'tr-old', date: '2026-10-01', amountCents: 999, currency: 'EUR', source: 'bank', status: 'NEW' }, { merchantId: A, accountId: 'acc-1', providerTxId: 'tr-same', date: '2026-10-02', amountCents: 777, currency: 'EUR', source: 'bank', status: 'NEW' }, { merchantId: A, accountId: 'acc-1', providerTxId: 'tr-later', date: '2026-10-03', amountCents: -12000, currency: 'EUR', source: 'bank', status: 'NEW' }]);
    await st.insertCashCount({ merchantId: A, amountCents: 35000, countedOn: '2026-10-01', note: null, createdAt: at }); await st.insertCashMovement({ merchantId: A, kind: 'CASH_OUT', amountCents: 5000, date: '2026-10-02', note: null, createdAt: at });
    const inv1 = await issueInvoice(w.svc); const inv2 = await issueInvoice(w.svc);
    await st.recordPayment({ merchantId: A, key: 'tr-pay1', direction: 'IN', amountCents: 4000, currency: 'EUR', paidOn: '2026-10-01', method: 'bank_transfer', actor: MERCHANT_ACTOR, allocations: [{ customerDocumentId: inv1.id, amountCents: 4000 }], at });
    const svc = createTreasuryService({ store: st, merchantId: A, clock: { now: () => at, today: () => '2026-10-03', timeZone: 'Europe/Brussels' }, currency: 'EUR', finance: { listInvoices: () => loadDocsForReports(st, A) }, inbox: { list: async () => [] } });
    const model = await svc.model(); const num = new Map([[inv1.id, 'INV1'], [inv2.id, 'INV2']]); const nm = (id) => id.replace(/CUSTOMER_INVOICE:([^#]+)/, (_, x) => `CUSTOMER_INVOICE:${num.get(x) ?? x}`);
    const fc = model.forecast.EUR; const sc = await svc.scenario([{ type: 'ADD_EXPENSE', amountCents: 500000, date: '2026-10-20', label: 'Machine' }]);
    return [model.position.EUR.observed.totalCents, model.position.EUR.calculated.totalCents, model.position.EUR.freshness, model.position.EUR.components.map((c) => [c.kind, c.amountCents]), model.position.EUR.warnings.map((x) => x.code),
      model.items.map((x) => [nm(x.id), x.amountCents, x.date, x.certainty, x.included, x.evidence.paidCents]).sort((p, q) => p[0].localeCompare(q[0])), // ids are random uuids: sort by number [7, 30, 90].map((d) => [fc.horizons[d].projectedCents, fc.horizons[d].receipts.committedCents, fc.horizons[d].excluded.overdueReceivablesCents]), fc.risk.negative, fc.risk.minimumCents,
      sc.delta.EUR.horizons[30].projectedDeltaCents, sc.persisted, (await st.listBankTransactions({ merchantId: A })).length];
  },
};
