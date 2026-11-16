import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { createInboxService, createMemoryAttachmentStore } from '../src/finance/inbox.js';
import { createFinanceHandoff } from '../src/procurement/finance-handoff.js';

const M = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb';
const other = 'merchant-two';
const world = (merchantId = M, store = createMemoryStore()) => {
  const inbox = createInboxService({ store, attachments: createMemoryAttachmentStore(), merchantId });
  return { store, inbox, handoff: createFinanceHandoff({ inbox }) };
};
const po = (over = {}) => ({ number: 'PO-2026-0001', currency: 'USD', ...over });
const owner = { id: 'user-owner' };

test('a received order becomes ONE supplier-invoice record to review, carrying the order number; nothing is invented', async () => {
  const w = world();
  const r = await w.handoff({ po: po(), supplierName: 'Fournisseur test Xiaomi' }, owner);
  assert.equal(r.created, true);
  assert.equal(r.financeItem.status, 'TO_REVIEW'); assert.equal(r.financeItem.source, 'manual');
  assert.equal(r.financeItem.orderReference, 'PO-2026-0001'); assert.equal(r.financeItem.supplierName, 'Fournisseur test Xiaomi'); assert.equal(r.financeItem.currency, 'USD');
  const row = await w.inbox.get(r.financeItem.id);
  assert.ok(row.invoiceNumber == null && row.issueDate == null && row.grossCents == null, 'the invoice number, date and amounts are on the supplier invoice, not on the order');
  // Finance itself refuses to validate it until a person reads those from the real document
  assert.ok(r.stillNeededFromTheInvoice.includes('INVOICE_NUMBER_MISSING') && r.stillNeededFromTheInvoice.includes('ISSUE_DATE_INVALID'));
  await assert.rejects(w.inbox.validate(row.id, { type: 'merchant', id: 'x' }), (e) => /INVOICE_NUMBER|VALIDATION|MISSING|INVALID/i.test(`${e.code} ${e.message}`));
});

test('a second hand-off of the same order returns the record already created (no duplicate)', async () => {
  const w = world();
  const a = await w.handoff({ po: po(), supplierName: 'Fournisseur test Xiaomi' }, owner);
  const b = await w.handoff({ po: po(), supplierName: 'Fournisseur test Xiaomi' }, owner);
  assert.equal(b.created, false); assert.equal(b.financeItem.id, a.financeItem.id);
  assert.equal((await w.inbox.list({ source: 'manual' })).length, 1);
  const c = await w.handoff({ po: po({ number: 'PO-2026-0002' }), supplierName: 'Fournisseur test Xiaomi' }, owner); // another order = another record
  assert.notEqual(c.financeItem.id, a.financeItem.id); assert.equal((await w.inbox.list({ source: 'manual' })).length, 2);
});

test('the record stays in its own merchant: a second merchant on the same store does not see it, and gets its own', async () => {
  const store = createMemoryStore();
  const one = world(M, store); const two = world(other, store);
  const a = await one.handoff({ po: po(), supplierName: 'Fournisseur test Xiaomi' }, owner);
  assert.equal((await two.inbox.list({ source: 'manual' })).length, 0);
  const b = await two.handoff({ po: po(), supplierName: 'Autre fournisseur' }, owner);
  assert.equal(b.created, true); assert.notEqual(b.financeItem.id, a.financeItem.id);
  assert.equal((await one.inbox.list({ source: 'manual' })).length, 1);
});

test('an order without a number or a supplier name is refused, never guessed', async () => {
  const w = world();
  await assert.rejects(w.handoff({ po: po(), supplierName: '  ' }, owner), (e) => e.code === 'HANDOFF_INCOMPLETE');
  await assert.rejects(w.handoff({ po: po({ number: '' }), supplierName: 'X Supplier' }, owner), (e) => e.code === 'HANDOFF_INCOMPLETE');
  assert.equal((await w.inbox.list({})).length, 0);
});
