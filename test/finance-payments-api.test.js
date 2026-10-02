// HTTP level of the payment commands (Essential Payments): intentions in, derived truth out. The interface never writes a financial field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { invoiceBody, startApp } from './finance-dashboard-helpers.js';

const withApp = (fn) => async () => { const store = createMemoryStore(); const a = await startApp({ store }); try { await fn(a, store); } finally { await a.close(); } };
const issue = async (c, over = {}) => { const d = (await c.post('/api/documents', invoiceBody(over))).data; await c.post(`/api/documents/${d.id}/submit`, {}); return (await c.post(`/api/documents/${d.id}/approve`, {})).data; }; // 71,90
const key = (n) => `api-key-${String(n).padStart(4, '0')}`;

test('RECEIVE one payment across two invoices: surplus stays unallocated and visible; invoice statuses follow; the answer carries the whole truth', withApp(async (a) => {
  const c = await a.authed(); const i1 = await issue(c); const i2 = await issue(c);
  const r = await c.post('/api/payments', { amount: '200.00', paidOn: '2026-09-25', method: 'bancontact', source: 'provider:sumup', externalReference: 'SU-77', idempotencyKey: key(1), allocations: [{ documentId: i1.id, amount: '71.90' }, { documentId: i2.id, amount: '71.90' }] });
  assert.equal(r.status, 201, JSON.stringify(r.data)); const p = r.data.payment;
  assert.deepEqual([p.kind, p.status, p.allocatedCents, p.unallocatedCents, p.method, p.source, p.externalReference, p.canAllocate, p.canVoid], ['RECEIPT', 'PARTIALLY_ALLOCATED', 14380, 5620, 'bancontact', 'provider:sumup', 'SU-77', true, true]);
  assert.deepEqual(p.allocations.map((x) => [x.number != null, x.party, x.amount]).sort(), [[true, 'Client Exemple SA', '71,90'], [true, 'Client Exemple SA', '71,90']].sort());
  assert.equal((await c.get(`/api/documents/${i1.id}`)).data.status, 'PAID');
  const open = await c.get('/api/payments?unallocated=1'); assert.equal(open.data.rows.length, 1); assert.equal(open.data.rows[0].unallocated, '56,20');
  assert.equal((await c.get(`/api/payments/${p.id}`)).data.payment.id, p.id);
  const retry = await c.post('/api/payments', { amount: '200.00', paidOn: '2026-09-25', method: 'bancontact', source: 'provider:sumup', externalReference: 'SU-77', idempotencyKey: key(1), allocations: [{ documentId: i1.id, amount: '71.90' }, { documentId: i2.id, amount: '71.90' }] });
  assert.deepEqual([retry.data.duplicate, retry.data.payment.id === p.id], [true, true]);
}));

test('ALLOCATE later: only what is unallocated, only to the documents named; over-allocation is a readable 422; the same key is the same allocation', withApp(async (a) => {
  const c = await a.authed(); const i1 = await issue(c); const i2 = await issue(c);
  const p = (await c.post('/api/payments', { amount: '100.00', paidOn: '2026-09-25', method: 'cash', idempotencyKey: key(2), allocations: [{ documentId: i1.id, amount: '71.90' }] })).data.payment;
  const over = await c.post(`/api/payments/${p.id}/allocate`, { allocations: [{ documentId: i2.id, amount: '28.11' }], idempotencyKey: key(3) }); assert.equal(over.status, 422); assert.equal(over.data.error.code, 'PAYMENT_OVER_ALLOCATED');
  const ok = await c.post(`/api/payments/${p.id}/allocate`, { allocations: [{ documentId: i2.id, amount: '28.10' }], idempotencyKey: key(4) }); assert.equal(ok.status, 200); assert.deepEqual([ok.data.payment.status, ok.data.payment.unallocatedCents], ['ALLOCATED', 0]);
  assert.equal((await c.post(`/api/payments/${p.id}/allocate`, { allocations: [{ documentId: i2.id, amount: '28.10' }], idempotencyKey: key(4) })).data.duplicate, true);
  assert.equal((await c.get(`/api/documents/${i2.id}`)).data.status, 'PARTIALLY_PAID');
  assert.equal((await c.post(`/api/payments/${p.id}/allocate`, { allocations: [] })).status, 422);
}));

test('REFUND: a credit note creates no money; the refund is explicit, bounded, retried safely, reversible; the invoice detail carries refundable / refunded', withApp(async (a) => {
  const c = await a.authed(); const inv = await issue(c);
  await c.post(`/api/documents/${inv.id}/payments`, { amount: '71.90', paidOn: '2026-09-25', method: 'bank_transfer' });
  const cn = (await c.post(`/api/documents/${inv.id}/credit-note`, { reason: 'returned goods' })).data; await c.post(`/api/documents/${cn.id}/submit`, {}); const cnIssued = (await c.post(`/api/documents/${cn.id}/approve`, {})).data;
  const d0 = (await c.get(`/api/documents/${cnIssued.id}`)).data; assert.ok(d0.actions.includes('refund')); assert.equal(d0.refund.maxCents, 7190);
  const invD = (await c.get(`/api/documents/${inv.id}`)).data; assert.deepEqual([invD.settlementView.refundable, invD.settlementView.refunded], ['71,90', '0,00']);
  const body = { amount: '20.00', paidOn: '2026-09-26', method: 'bank_transfer', reference: 'Remboursement', idempotencyKey: key(5) };
  const r1 = await c.post(`/api/documents/${cn.id}/refund`, body); assert.equal(r1.status, 201, JSON.stringify(r1.data)); assert.deepEqual([r1.data.payment.kind, r1.data.payment.direction, r1.data.payment.allocations[0].documentType], ['REFUND', 'OUT', 'credit_note']);
  assert.equal((await c.post(`/api/documents/${cn.id}/refund`, body)).data.duplicate, true);
  assert.equal((await c.get(`/api/documents/${inv.id}`)).data.settlementView.refunded, '20,00');
  const tooMuch = await c.post(`/api/documents/${cn.id}/refund`, { ...body, amount: '51.91', idempotencyKey: key(6) }); assert.equal(tooMuch.status, 422); assert.equal(tooMuch.data.error.code, 'REFUND_EXCEEDS_CREDIT_NOTE');
  assert.equal((await c.post(`/api/documents/${inv.id}/refund`, { ...body, idempotencyKey: key(7) })).status, 422, 'a refund is only for a credit note');
  const rev = await c.post(`/api/payment-allocations/${r1.data.payment.allocations[0].id}/reverse`, { reason: 'refund bounced', idempotencyKey: key(8) }); assert.equal(rev.status, 200);
  assert.equal((await c.get(`/api/documents/${cn.id}`)).data.refund.maxCents, 7190);
}));

test('REVERSE / VOID: a reason is mandatory, the history is kept, the status returns, and refunded money cannot be un-paid', withApp(async (a) => {
  const c = await a.authed(); const inv = await issue(c);
  const p = (await c.post('/api/payments', { amount: '71.90', paidOn: '2026-09-25', method: 'cash', idempotencyKey: key(9), allocations: [{ documentId: inv.id, amount: '71.90' }] })).data.payment;
  assert.equal((await c.post(`/api/payments/${p.id}/void`, { idempotencyKey: key(10) })).status, 422, 'a reason is required');
  const v = await c.post(`/api/payments/${p.id}/void`, { reason: 'entered by mistake', idempotencyKey: key(10) }); assert.equal(v.status, 200); assert.deepEqual([v.data.payment.status, v.data.payment.reversals.length], ['REVERSED', 1]);
  assert.equal((await c.get(`/api/documents/${inv.id}`)).data.status, 'SENT'); assert.equal((await c.post(`/api/payments/${p.id}/void`, { reason: 'again', idempotencyKey: key(11) })).status, 409);
  const hist = (await c.get(`/api/payments/${p.id}`)).data.payment; assert.ok(hist.allocations.length === 2 && hist.allocations.some((x) => x.amountCents < 0 && x.reversesAllocationId), 'nothing deleted: a negative allocation linked to the original');
}));

test('SUPPLIER payments over HTTP: partial then rest, derived status; a client can never post a direction, a status or a PAID', withApp(async (a, store) => {
  const c = await a.authed(); const s = await store.saveSupplierInvoice({ merchantId: 'merchant-test-1', supplierName: 'Fournisseur', invoiceNumber: 'S-1', issueDate: '2026-09-01', netCents: 10000, vatCents: 2100, grossCents: 12100, currency: 'EUR', status: 'TO_PAY', source: 'manual' });
  const r1 = await c.post('/api/supplier-payments', { amount: '50.00', paidOn: '2026-09-30', method: 'bank_transfer', idempotencyKey: key(12), allocations: [{ supplierInvoiceId: s.id, amount: '50.00' }] }); assert.equal(r1.status, 201, JSON.stringify(r1.data)); assert.equal(r1.data.payment.kind, 'SUPPLIER_PAYMENT');
  let row = await store.getSupplierInvoice(s.id); assert.deepEqual([row.status, row.paymentStatus, row.allocatedCents], ['TO_PAY', 'partially_paid', 5000]);
  await c.post('/api/supplier-payments', { amount: '71.00', paidOn: '2026-10-01', method: 'bank_transfer', idempotencyKey: key(13), allocations: [{ supplierInvoiceId: s.id, amount: '71.00' }] });
  row = await store.getSupplierInvoice(s.id); assert.deepEqual([row.status, row.paymentStatus, row.allocatedCents], ['PAID', 'paid', 12100]);
  const forged = await c.post('/api/supplier-payments', { amount: '1.00', paidOn: '2026-10-01', direction: 'IN', status: 'PAID', paymentStatus: 'paid', merchantId: 'other', idempotencyKey: key(14), allocations: [{ supplierInvoiceId: s.id, amount: '1.00' }] });
  assert.ok([409, 422].includes(forged.status), 'the extra fields are ignored; the overpayment is refused'); assert.equal((await store.getSupplierInvoice(s.id)).allocatedCents, 12100);
}));

test('INPUT: methods, sources, keys, amounts and identifiers are strictly validated; unknown keys are dropped', withApp(async (a) => {
  const c = await a.authed(); const inv = await issue(c); const base = { amount: '10.00', paidOn: '2026-09-25', method: 'cash', allocations: [{ documentId: inv.id, amount: '10.00' }] };
  for (const [over, field] of [[{ method: 'paypal' }, 'method'], [{ source: 'Bad Source' }, 'source'], [{ idempotencyKey: 'short' }, 'idempotencyKey'], [{ amount: '-5' }, 'amount'], [{ amount: 'abc' }, 'amount'], [{ paidOn: '25/09/2026' }, 'paidOn'], [{ allocations: 'x' }, 'allocations']]) {
    const r = await c.post('/api/payments', { ...base, ...over }); assert.equal(r.status, 422, JSON.stringify(over)); assert.ok(r.data.error.fields.some((f) => f.field === field), `${field}: ${JSON.stringify(r.data.error.fields)}`);
  }
  assert.equal((await c.post('/api/payments', { ...base, allocations: [{ documentId: 'nope!', amount: '10.00' }] })).status, 422);
  assert.equal((await c.post('/api/payments', { ...base, allocations: [{ documentId: 'doesnotexist1', amount: '10.00' }], idempotencyKey: key(20) })).status, 404, 'another merchant or unknown document: not found, never enumerated');
}));
