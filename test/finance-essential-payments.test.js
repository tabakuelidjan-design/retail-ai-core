// Essential Payments - the business examples of the specification, on the in-memory store (fast, no Docker). The same rules are proven on real PostgreSQL 17 in test/pg.
import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceAmounts, amountViolations } from '../src/finance/amounts.js';
import { settlement } from '../src/finance/document.js';
import { PAYMENT_METHODS, isPaymentMethod, isPaymentSource } from '../src/finance/payment-methods.js';
import { MERCHANT_ACTOR, CUSTOMER, VAT_OK, makeService, issueInvoice } from './finance-fixtures.js';

const hundred = (n = 1) => ({ lines: [{ description: `Service ${n}`, quantity: '1', unitPrice: '100.00', vatRate: '0' }], vat: VAT_OK });
const invoiceOf = async (svc, euros) => issueInvoice(svc, { lines: [{ description: 'Service', quantity: '1', unitPrice: String(euros.toFixed(2)), vatRate: '0' }] });
const view = async (svc, id) => { const v = await svc.view(id); return { status: v.doc.status, ...Object.fromEntries(['paidCents', 'remainingCents', 'creditedCents', 'refundedCents', 'retainedCents', 'refundableCents', 'effectiveDueCents'].map((k) => [k, v.settlement[k]])) }; };
const credit = async (svc, inv, euros) => { const cn = await svc.createCreditNote(inv.id, { reason: 'return', lines: [{ description: 'Service', quantity: '1', unitPrice: euros.toFixed(2), vatRate: '0' }] }, MERCHANT_ACTOR); await svc.submit(cn.id, MERCHANT_ACTOR); return svc.decide(cn.id, 'APPROVE', MERCHANT_ACTOR); };

// ---------- the single definition of the amounts ----------
test('AMOUNTS: the formulas and their worked examples (integer cents)', () => {
  const a = (o) => invoiceAmounts({ documentTotal: 10000, ...o });
  assert.deepEqual(a({}), { documentTotal: 10000, credited: 0, effectiveDue: 10000, allocated: 0, refunded: 0, retained: 0, remainingDue: 10000, refundable: 0 });
  assert.equal(a({ allocated: 4000 }).remainingDue, 6000);
  assert.deepEqual(a({ allocated: 10000, credited: 3000 }), { documentTotal: 10000, credited: 3000, effectiveDue: 7000, allocated: 10000, refunded: 0, retained: 10000, remainingDue: 0, refundable: 3000 }, 'paid then credited: the customer is owed 30,00');
  assert.deepEqual(a({ allocated: 10000, credited: 3000, refunded: 3000 }), { documentTotal: 10000, credited: 3000, effectiveDue: 7000, allocated: 10000, refunded: 3000, retained: 7000, remainingDue: 0, refundable: 0 }, 'refunded: economically settled');
  assert.equal(a({ credited: 3000, allocated: 7000 }).remainingDue, 0, 'credit before payment: due for less');
  assert.equal(a({ credited: 10000 }).effectiveDue, 0, 'fully credited');
  assert.equal(a({ credited: 12000 }).effectiveDue, 0, 'never negative');
  assert.equal(a({ allocated: 10000, refunded: 0 }).refundable, 0, 'paid in full, nothing credited: nothing to refund');
  assert.deepEqual(amountViolations(a({ allocated: 1000, refunded: 3000 })), ['RETAINED_NEGATIVE']);
  assert.throws(() => invoiceAmounts({ documentTotal: 100.5 }), TypeError, 'no float');
  assert.throws(() => invoiceAmounts({ documentTotal: 100, allocated: '10' }), TypeError);
});

test('AMOUNTS: settlement() carries both the new names and the legacy ones, derived from the same formulas', () => {
  const inv = { totals: { grossCents: 10000, roundingCents: 0 } }; const cn = { status: 'ISSUED', totals: { grossCents: 3000, roundingCents: 0 } };
  const s = settlement(inv, [{ amountCents: 10000 }], [cn], [{ amountCents: 1000 }]);
  assert.deepEqual([s.documentTotalCents, s.creditedCents, s.effectiveDueCents, s.allocatedCents, s.refundedCents, s.retainedCents, s.remainingCents, s.refundableCents], [10000, 3000, 7000, 10000, 1000, 9000, 0, 2000]);
  assert.deepEqual([s.grossCents, s.payableCents, s.paidCents, s.overpaidCents], [10000, 7000, 10000, 2000], 'legacy names unchanged in meaning');
});

test('METHODS: a stable vocabulary; providers are provenance, never the business type', () => {
  assert.deepEqual(PAYMENT_METHODS, ['cash', 'bank_transfer', 'card', 'bancontact', 'direct_debit', 'other']);
  for (const m of PAYMENT_METHODS) assert.ok(isPaymentMethod(m)); assert.ok(isPaymentMethod('unspecified'));
  for (const m of ['sumup', 'shopify', 'paypal', 'Cash', '']) assert.ok(!isPaymentMethod(m), m);
  assert.ok(isPaymentSource('manual') && isPaymentSource('provider:sumup') && isPaymentSource('bank'));
  assert.ok(!isPaymentSource('Provider Sumup') && !isPaymentSource('') && !isPaymentSource('x'.repeat(41)));
});

// ---------- CUSTOMER: the examples of the specification ----------
test('CUSTOMER full payment: invoice 100,00, payment 100,00 -> PAID', async () => {
  const { svc } = makeService(); const inv = await invoiceOf(svc, 100);
  assert.equal((await view(svc, inv.id)).status, 'ISSUED');
  await svc.payments.receive({ amount: '100.00', paidOn: '2026-09-25', method: 'bank_transfer', idempotencyKey: 'ep-full-0001', allocations: [{ documentId: inv.id, amount: '100.00' }] }, MERCHANT_ACTOR);
  assert.deepEqual(await view(svc, inv.id), { status: 'PAID', paidCents: 10000, remainingCents: 0, creditedCents: 0, refundedCents: 0, retainedCents: 10000, refundableCents: 0, effectiveDueCents: 10000 });
});

test('CUSTOMER partial and multiple payments: 40 -> 40 paid, 60 left, PARTIALLY_PAID; 40 + 20 + 40 -> PAID', async () => {
  const { svc } = makeService(); const inv = await invoiceOf(svc, 100); const P = svc.payments;
  await P.receive({ amount: '40.00', paidOn: '2026-09-25', idempotencyKey: 'ep-part-0001', allocations: [{ documentId: inv.id, amount: '40.00' }] }, MERCHANT_ACTOR);
  let v = await view(svc, inv.id); assert.deepEqual([v.status, v.paidCents, v.remainingCents], ['PARTIALLY_PAID', 4000, 6000]);
  await P.receive({ amount: '20.00', paidOn: '2026-09-26', idempotencyKey: 'ep-part-0002', allocations: [{ documentId: inv.id, amount: '20.00' }] }, MERCHANT_ACTOR);
  await P.receive({ amount: '40.00', paidOn: '2026-09-27', idempotencyKey: 'ep-part-0003', allocations: [{ documentId: inv.id, amount: '40.00' }] }, MERCHANT_ACTOR);
  v = await view(svc, inv.id); assert.deepEqual([v.status, v.paidCents, v.remainingCents], ['PAID', 10000, 0]);
  await assert.rejects(P.receive({ amount: '1.00', paidOn: '2026-09-28', idempotencyKey: 'ep-part-0004', allocations: [{ documentId: inv.id, amount: '1.00' }] }, MERCHANT_ACTOR), (e) => ['TARGET_NOT_OPEN', 'PAYMENT_EXCEEDS_REMAINING'].includes(e.code), 'over-payment by allocation is impossible');
});

test('CUSTOMER unallocated surplus: 150 received, 100 allocated to A, 50 stay unallocated, never applied by themselves, allocated later on request', async () => {
  const { svc } = makeService(); const a = await invoiceOf(svc, 100); const b = await invoiceOf(svc, 80); const P = svc.payments;
  const r = await P.receive({ amount: '150.00', paidOn: '2026-09-25', idempotencyKey: 'ep-surplus-1', allocations: [{ documentId: a.id, amount: '100.00' }] }, MERCHANT_ACTOR);
  assert.deepEqual([r.payment.status, r.payment.allocatedCents, r.payment.unallocatedCents], ['PARTIALLY_ALLOCATED', 10000, 5000]);
  assert.equal((await view(svc, b.id)).paidCents, 0, 'the surplus is not applied to another invoice by itself');
  assert.equal((await P.list({ unallocated: true })).length, 1);
  await assert.rejects(P.allocate(r.payment.id, { allocations: [{ documentId: b.id, amount: '50.01' }], idempotencyKey: 'ep-surplus-2' }, MERCHANT_ACTOR), (e) => e.code === 'PAYMENT_OVER_ALLOCATED');
  const l = await P.allocate(r.payment.id, { allocations: [{ documentId: b.id, amount: '50.00' }], idempotencyKey: 'ep-surplus-3' }, MERCHANT_ACTOR);
  assert.deepEqual([l.payment.status, l.payment.unallocatedCents], ['ALLOCATED', 0]); assert.deepEqual((await view(svc, b.id)).paidCents, 5000);
  assert.equal((await P.list({ unallocated: true })).length, 0);
});

test('CUSTOMER one payment -> several invoices: 300 -> 100 + 120 + 50 = 270, 30 unallocated', async () => {
  const { svc } = makeService(); const [a, b, c] = [await invoiceOf(svc, 100), await invoiceOf(svc, 120), await invoiceOf(svc, 50)];
  const r = await svc.payments.receive({ amount: '300.00', paidOn: '2026-09-25', method: 'cash', idempotencyKey: 'ep-multi-0001', allocations: [{ documentId: a.id, amount: '100.00' }, { documentId: b.id, amount: '120.00' }, { documentId: c.id, amount: '50.00' }] }, MERCHANT_ACTOR);
  assert.deepEqual([r.payment.allocatedCents, r.payment.unallocatedCents, r.payment.allocations.length], [27000, 3000, 3]);
  for (const i of [a, b, c]) assert.equal((await view(svc, i.id)).status, 'PAID');
});

test('CUSTOMER several payments -> one invoice: 100 + 50 + 150 = 300 -> PAID', async () => {
  const { svc } = makeService(); const inv = await invoiceOf(svc, 300);
  for (const [i, x] of [['0', '100.00'], ['1', '50.00'], ['2', '150.00']]) await svc.payments.receive({ amount: x, paidOn: '2026-09-25', idempotencyKey: `ep-many-000${i}`, allocations: [{ documentId: inv.id, amount: x }] }, MERCHANT_ACTOR);
  assert.deepEqual(await view(svc, inv.id), { status: 'PAID', paidCents: 30000, remainingCents: 0, creditedCents: 0, refundedCents: 0, retainedCents: 30000, refundableCents: 0, effectiveDueCents: 30000 });
});

test('CUSTOMER idempotency: a retry returns the same payment, a changed request under the same key is refused, an unknown method is refused', async () => {
  const { svc } = makeService(); const inv = await invoiceOf(svc, 100); const p = { amount: '40.00', paidOn: '2026-09-25', method: 'bancontact', source: 'provider:sumup', externalReference: 'SU-1', idempotencyKey: 'ep-idem-0001', allocations: [{ documentId: inv.id, amount: '40.00' }] };
  const a = await svc.payments.receive(p, MERCHANT_ACTOR); const b = await svc.payments.receive(p, MERCHANT_ACTOR);
  assert.deepEqual([a.duplicate, b.duplicate, a.payment.id === b.payment.id, (await view(svc, inv.id)).paidCents], [false, true, true, 4000]);
  assert.deepEqual([a.payment.method, a.payment.source, a.payment.externalReference], ['bancontact', 'provider:sumup', 'SU-1']);
  await assert.rejects(svc.payments.receive({ ...p, amount: '41.00', allocations: [{ documentId: inv.id, amount: '41.00' }] }, MERCHANT_ACTOR), (e) => e.code === 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(svc.payments.receive({ ...p, idempotencyKey: 'ep-idem-0002', method: 'paypal' }, MERCHANT_ACTOR), (e) => e.code === 'PAYMENT_METHOD_INVALID');
  await assert.rejects(svc.payments.receive({ ...p, idempotencyKey: 'bad key' }, MERCHANT_ACTOR), (e) => e.code === 'IDEMPOTENCY_KEY_INVALID');
});

// ---------- CREDIT NOTES / REFUNDS ----------
test('CREDIT x REFUND: invoice 100, paid 100, credit note 30 -> 30 refundable; refund 30 -> economically settled; credit note alone invents no money movement', async () => {
  const { svc, store } = makeService(); const inv = await invoiceOf(svc, 100); const P = svc.payments;
  const pay = await P.receive({ amount: '100.00', paidOn: '2026-09-25', idempotencyKey: 'ep-cn-pay-1', allocations: [{ documentId: inv.id, amount: '100.00' }] }, MERCHANT_ACTOR);
  const cn = await credit(svc, inv, 30); const registryBefore = (await store.listRegistry('merchant-test-1')).length;
  assert.deepEqual(await view(svc, inv.id), { status: 'PAID', paidCents: 10000, remainingCents: 0, creditedCents: 3000, refundedCents: 0, retainedCents: 10000, refundableCents: 3000, effectiveDueCents: 7000 });
  assert.equal((await svc.view(cn.id)).refund.maxCents, 3000); assert.equal(registryBefore, 1, 'the credit note created no payment');
  const r = await P.refund(cn.id, { amount: '30.00', paidOn: '2026-09-26', method: 'bank_transfer', refundOfPaymentId: pay.payment.id, idempotencyKey: 'ep-cn-rf-0001' }, MERCHANT_ACTOR);
  assert.deepEqual([r.payment.direction, r.payment.refundOfPaymentId, r.payment.allocations[0].customerDocumentId], ['OUT', pay.payment.id, cn.id]);
  assert.deepEqual(await view(svc, inv.id), { status: 'PAID', paidCents: 10000, remainingCents: 0, creditedCents: 3000, refundedCents: 3000, retainedCents: 7000, refundableCents: 0, effectiveDueCents: 7000 });
  assert.equal((await svc.view(cn.id)).refund.maxCents, 0);
});

test('REFUND bounds: partial then exact remainder, nothing more; a retry is the same refund; a credit note is never an invoice', async () => {
  const { svc } = makeService(); const inv = await invoiceOf(svc, 100); const P = svc.payments;
  await P.receive({ amount: '100.00', paidOn: '2026-09-25', idempotencyKey: 'ep-rb-pay-01', allocations: [{ documentId: inv.id, amount: '100.00' }] }, MERCHANT_ACTOR); const cn = await credit(svc, inv, 30);
  const rf = (amount, key) => P.refund(cn.id, { amount, paidOn: '2026-09-26', idempotencyKey: key }, MERCHANT_ACTOR);
  const a = await rf('10.00', 'ep-rb-rf-0001'); const b = await rf('10.00', 'ep-rb-rf-0001'); assert.deepEqual([a.duplicate, b.duplicate, a.payment.id === b.payment.id], [false, true, true]);
  await assert.rejects(rf('20.01', 'ep-rb-rf-0002'), (e) => e.code === 'REFUND_EXCEEDS_CREDIT_NOTE');
  await rf('20.00', 'ep-rb-rf-0003'); await assert.rejects(rf('0.01', 'ep-rb-rf-0004'), (e) => e.code === 'REFUND_EXCEEDS_CREDIT_NOTE');
  await assert.rejects(P.refund(inv.id, { amount: '1.00', paidOn: '2026-09-26', idempotencyKey: 'ep-rb-rf-0005' }, MERCHANT_ACTOR), (e) => e.code === 'REFUND_REQUIRES_AN_ISSUED_CREDIT_NOTE');
  assert.equal((await view(svc, inv.id)).refundedCents, 3000);
});

test('REFUND needs money to give back: credit before payment leaves nothing refundable', async () => {
  const { svc } = makeService(); const inv = await invoiceOf(svc, 100); const cn = await credit(svc, inv, 30);
  await svc.payments.receive({ amount: '70.00', paidOn: '2026-09-25', idempotencyKey: 'ep-nr-pay-01', allocations: [{ documentId: inv.id, amount: '70.00' }] }, MERCHANT_ACTOR);
  assert.equal((await view(svc, inv.id)).status, 'PAID'); assert.equal((await view(svc, inv.id)).refundableCents, 0);
  await assert.rejects(svc.payments.refund(cn.id, { amount: '1.00', paidOn: '2026-09-26', idempotencyKey: 'ep-nr-rf-0001' }, MERCHANT_ACTOR), (e) => e.code === 'REFUND_EXCEEDS_REFUNDABLE');
});

test('REVERSAL interaction: money already refunded cannot be un-paid; reversing the refund restores the refundable amount; reversing a payment restores the remaining due', async () => {
  const { svc, store } = makeService(); const inv = await invoiceOf(svc, 100); const P = svc.payments;
  const pay = await P.receive({ amount: '100.00', paidOn: '2026-09-25', idempotencyKey: 'ep-rv-pay-01', allocations: [{ documentId: inv.id, amount: '100.00' }] }, MERCHANT_ACTOR); const cn = await credit(svc, inv, 30);
  const rf = await P.refund(cn.id, { amount: '30.00', paidOn: '2026-09-26', idempotencyKey: 'ep-rv-rf-0001' }, MERCHANT_ACTOR);
  const payAlloc = (await store.listAllocations({ customerDocumentId: inv.id })).find((a) => a.amountCents > 0);
  await assert.rejects(P.reverseAllocation(payAlloc.id, { reason: 'wrong invoice', idempotencyKey: 'ep-rv-un-0001' }, MERCHANT_ACTOR), (e) => e.code === 'REVERSAL_BREAKS_REFUND');
  await assert.rejects(P.voidPayment(pay.payment.id, { reason: 'mistake', idempotencyKey: 'ep-rv-vd-0001' }, MERCHANT_ACTOR), (e) => e.code === 'REVERSAL_BREAKS_REFUND');
  await P.voidPayment(rf.payment.id, { reason: 'bounced', idempotencyKey: 'ep-rv-vd-0002' }, MERCHANT_ACTOR);
  assert.deepEqual([(await view(svc, inv.id)).refundableCents, (await view(svc, inv.id)).refundedCents], [3000, 0]);
  const v = await P.voidPayment(pay.payment.id, { reason: 'mistake', idempotencyKey: 'ep-rv-vd-0003' }, MERCHANT_ACTOR); assert.equal(v.payment.status, 'REVERSED');
  assert.deepEqual(await view(svc, inv.id), { status: 'SENT', paidCents: 0, remainingCents: 7000, creditedCents: 3000, refundedCents: 0, retainedCents: 0, refundableCents: 0, effectiveDueCents: 7000 });
});

test('REVERSAL of a partial payment restores the exact remaining amount and the status', async () => {
  const { svc, store } = makeService(); const inv = await invoiceOf(svc, 100); const P = svc.payments;
  await P.receive({ amount: '100.00', paidOn: '2026-09-25', idempotencyKey: 'ep-rp-pay-01', allocations: [{ documentId: inv.id, amount: '100.00' }] }, MERCHANT_ACTOR);
  const al = (await store.listAllocations({ customerDocumentId: inv.id }))[0];
  const r = await P.reverseAllocation(al.id, { amountCents: 4000, reason: 'bank error', idempotencyKey: 'ep-rp-rv-0001' }, MERCHANT_ACTOR);
  assert.deepEqual([r.payment.allocatedCents, r.payment.unallocatedCents], [6000, 4000], 'the reversed 40 are back on the payment, unallocated, not lost');
  assert.deepEqual(await view(svc, inv.id), { status: 'PARTIALLY_PAID', paidCents: 6000, remainingCents: 4000, creditedCents: 0, refundedCents: 0, retainedCents: 6000, refundableCents: 0, effectiveDueCents: 10000 });
});

// ---------- SUPPLIER ----------
test('SUPPLIER partial, multiple, one payment across several documents, derived status, reversal; PAID is never an input', async () => {
  const { svc, store } = makeService(); const P = svc.payments; const M = 'merchant-test-1';
  const mk = (gross) => store.saveSupplierInvoice({ merchantId: M, supplierName: 'Fournisseur', invoiceNumber: `S-${gross}`, issueDate: '2026-09-01', netCents: Math.round(gross / 1.21), vatCents: gross - Math.round(gross / 1.21), grossCents: gross, currency: 'EUR', status: 'TO_PAY', source: 'manual' });
  const [s1, s2] = [await mk(12100), await mk(6050)]; const of = async (x) => { const r = await store.getSupplierInvoice(x.id); return [r.status, r.paymentStatus, r.allocatedCents]; };
  assert.deepEqual(await of(s1), ['TO_PAY', 'unpaid', 0]);
  const r = await P.pay({ amount: '200.00', paidOn: '2026-10-01', method: 'bank_transfer', idempotencyKey: 'ep-sup-0001', allocations: [{ supplierInvoiceId: s1.id, amount: '121.00' }, { supplierInvoiceId: s2.id, amount: '50.00' }] }, MERCHANT_ACTOR);
  assert.deepEqual([r.payment.unallocatedCents, await of(s1), await of(s2)], [2900, ['PAID', 'paid', 12100], ['TO_PAY', 'partially_paid', 5000]]);
  await P.allocate(r.payment.id, { allocations: [{ supplierInvoiceId: s2.id, amount: '10.50' }], idempotencyKey: 'ep-sup-0002' }, MERCHANT_ACTOR); assert.deepEqual(await of(s2), ['PAID', 'paid', 6050]);
  await assert.rejects(store.updateSupplierInvoice(s2.id, { status: 'TO_PAY' }, 'PAID'), (e) => e.code === 'INVOICE_HAS_PAYMENTS', 'fully allocated: nobody can write it away from PAID');
  const al = (await store.listAllocations({ supplierInvoiceId: s2.id })).find((a) => a.amountCents === 1050);
  await P.reverseAllocation(al.id, { reason: 'wrong document', idempotencyKey: 'ep-sup-0003' }, MERCHANT_ACTOR); assert.deepEqual(await of(s2), ['TO_PAY', 'partially_paid', 5000]);
  await assert.rejects(P.pay({ amount: '1.00', paidOn: '2026-10-01', idempotencyKey: 'ep-sup-0004', allocations: [{ supplierInvoiceId: s1.id, amount: '1.00' }] }, MERCHANT_ACTOR), (e) => ['PAYMENT_EXCEEDS_REMAINING', 'TARGET_NOT_OPEN'].includes(e.code));
});

// ---------- the API never lets the interface write a financial field ----------
test('API: the service exposes intentions only; customer statuses are derived after each command', async () => {
  const { svc } = makeService();
  for (const f of ['receive', 'pay', 'allocate', 'reverseAllocation', 'voidPayment', 'refund', 'get', 'list']) assert.equal(typeof svc.payments[f], 'function', f);
  const inv = await invoiceOf(svc, 100); assert.equal(hundred().lines.length, 1);
  await svc.payments.receive({ amount: '100.00', paidOn: '2026-09-25', idempotencyKey: 'ep-api-0001', allocations: [{ documentId: inv.id, amount: '100.00' }] }, MERCHANT_ACTOR);
  assert.equal((await svc.get(inv.id)).status, 'PAID', 'the stored lifecycle status followed the allocations'); assert.ok(CUSTOMER.name);
});
