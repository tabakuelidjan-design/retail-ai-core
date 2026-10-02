// Shared MEMORY <-> POSTGRES business contract (Phase 1). The scenarios are written ONCE against a 'world' = { storeFor(merchantId), svc, inboxFor(store) }.
// - test/finance-payment-contract.test.js runs them on the in-memory store (fast, part of npm test) and pins the results to EXPECTED.
// - test/pg/40-contract.pg.test.js runs the SAME scenarios on the production store code (supabase-store.js) over a real PostgreSQL 17 and pins the same EXPECTED.
// So memory == PostgreSQL == EXPECTED. Concurrency is PostgreSQL-specific and proven elsewhere (test/pg/30-p0-regression.pg.test.js).
import { createMemoryStore } from '../src/finance/memory-store.js';
import { createFinanceService } from '../src/finance/service.js';
import { createInboxService, createMemoryAttachmentStore } from '../src/finance/inbox.js';
import { CONFIG, MERCHANT_ACTOR, issueInvoice } from './finance-fixtures.js';

export const A = '11111111-1111-1111-1111-111111111111';
export const B = '22222222-2222-2222-2222-222222222222';
export const mkClock = () => { let t = 0; return { now: () => new Date(Date.UTC(2026, 8, 21, 10, 0, t++)).toISOString(), today: () => '2026-09-21' }; };

export async function memoryWorld() {
  const store = createMemoryStore(); const clock = mkClock();
  return { name: 'memory', storeFor: () => store, svc: createFinanceService({ store, config: { ...CONFIG, merchantId: A }, clock }), inboxFor: (s) => createInboxService({ store: s, attachments: createMemoryAttachmentStore(), merchantId: A, now: clock.now }), close: async () => {} };
}

const code = async (fn) => { try { await fn(); return 'OK'; } catch (e) { return e.code ?? String(e.message).slice(0, 60); } };
const view = async (svc, id) => { const v = await svc.view(id); return { status: v.doc.status, paid: v.settlement.paidCents, remaining: v.settlement.remainingCents, credited: v.settlement.creditedCents }; };
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
  async 'supplier payment through the inbox service: full payment derives PAID, a retry is the same operation, partial/duplicate refused'(w) {
    const st = w.storeFor(A); const inbox = w.inboxFor(st); const row = await st.saveSupplierInvoice(supplier()); const args = { paidOn: '2026-10-02', amountCents: 12100, reference: 'virement', idempotencyKey: 'contract-inbox-1' };
    const out = [await code(() => inbox.pay(row.id, { ...args, amountCents: 5000, idempotencyKey: 'contract-inbox-0' }, MERCHANT_ACTOR))];
    const paid = await inbox.pay(row.id, args, MERCHANT_ACTOR); const retry = await inbox.pay(row.id, args, MERCHANT_ACTOR);
    out.push(sup(paid), sup(retry), await code(() => inbox.pay(row.id, { ...args, idempotencyKey: 'contract-inbox-2' }, MERCHANT_ACTOR)), (await st.listRegistry(A)).length);
    return out;
  },
  async 'bank transaction claim: one claim wins, the loser gets nothing, a handled transaction is frozen'(w) {
    const st = w.storeFor(A); const target = await st.saveSupplierInvoice(supplier()); const other = await st.saveSupplierInvoice(supplier());
    const { row: tx } = await st.insertBankTransaction({ merchantId: A, accountId: 'csv-import', providerTxId: 'contract-t1', date: '2026-09-01', amountCents: -12100, currency: 'EUR', source: 'csv', status: 'NEW' });
    const claim = (id) => ({ status: 'MATCHED', matchedKind: 'SUPPLIER_INVOICE', matchedDocumentId: id, matchedAmountCents: 12100, matchedAt: '2026-09-30T10:00:00.000Z' });
    const out = [(await st.updateBankTransaction(tx.id, claim(target.id), 'NEW'))?.status, await st.updateBankTransaction(tx.id, claim(other.id), 'NEW')];
    out.push(await code(() => st.updateBankTransaction(tx.id, { matchedDocumentId: other.id }, 'MATCHED')), await code(() => st.updateBankTransaction(tx.id, { matchedAmountCents: 100 }, 'MATCHED')));
    const p = await st.recordPayment({ merchantId: A, key: 'bank:contract-t1', direction: 'OUT', amountCents: 12100, currency: 'EUR', paidOn: '2026-09-01', actor: MERCHANT_ACTOR, allocations: [{ supplierInvoiceId: target.id, amountCents: 12100 }] });
    out.push((await st.updateBankTransaction(tx.id, { matchedPaymentId: p.payment.id }, 'MATCHED'))?.matchedPaymentId === p.payment.id, await code(() => st.updateBankTransaction(tx.id, { matchedPaymentId: other.id }, 'MATCHED')));
    const { row: tx2 } = await st.insertBankTransaction({ merchantId: A, accountId: 'csv-import', providerTxId: 'contract-t2', date: '2026-09-02', amountCents: -100, currency: 'EUR', source: 'csv', status: 'NEW' });
    out.push(await code(() => st.updateBankTransaction(tx2.id, { ...claim(target.id), matchedAmountCents: 999 }, 'NEW')));
    return out;
  },
};

