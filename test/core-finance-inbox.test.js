import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/finance/memory-store.js';
import { createInboxService, createMemoryAttachmentStore } from '../src/finance/inbox.js';
import { createFinanceReader } from '../src/core-pilot/finance-reader.js';
import { createFinanceHandoff } from '../src/procurement/finance-handoff.js';

const A = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb';
const B = '4159734e-27be-4772-bb7c-6c5f24fbafcc';
const NOW = () => '2026-11-16T12:00:00.000Z';
const mk = (store, merchantId) => ({
  inbox: createInboxService({ store, attachments: createMemoryAttachmentStore(), merchantId, now: NOW }),
  reader: createFinanceReader({ store, merchantId, timeZone: 'Europe/Brussels', now: NOW, source: `Finance · test ${merchantId.slice(0, 4)}` }),
});

test('the Finance reader lists the inbox of ONE merchant: a record from a purchase order shows with its order number and no invented amount', async () => {
  const store = createMemoryStore();
  const a = mk(store, A); const b = mk(store, B);
  await createFinanceHandoff({ inbox: a.inbox })({ po: { number: 'PO-2026-0001', currency: 'USD' }, supplierName: 'Fournisseur test Xiaomi' }, { id: 'owner' });
  await b.inbox.createManual({ supplierName: 'Autre SRL', invoiceNumber: 'FA-1', issueDate: '2026-11-01', netCents: 1000, vatCents: 210, grossCents: 1210, currency: 'EUR' }, { type: 'merchant', id: 'x' });

  const ia = await a.reader.inbox();
  assert.equal(ia.total, 1); assert.equal(ia.toReview, 1);
  assert.deepEqual(ia.items.map((r) => [r.status, r.supplier, r.orderReference, r.invoiceNumber, r.grossCents, r.currency]), [['TO_REVIEW', 'Fournisseur test Xiaomi', 'PO-2026-0001', null, null, 'USD']]);
  assert.equal(ia.merchantId, A);

  const ib = await b.reader.inbox(); // the other merchant sees only its own record, never the first one
  assert.equal(ib.total, 1); assert.equal(ib.items[0].supplier, 'Autre SRL'); assert.equal(ib.items.some((r) => r.orderReference === 'PO-2026-0001'), false);
});

test('records waiting for a person come first; the list is bounded', async () => {
  const store = createMemoryStore(); const w = mk(store, A);
  for (let i = 0; i < 3; i += 1) await w.inbox.createManual({ supplierName: `S${i}`, orderReference: `PO-${i}`, currency: 'EUR' }, { type: 'merchant', id: 'x' });
  const r = await w.reader.inbox({ limit: 2 });
  assert.equal(r.items.length, 2); assert.equal(r.total, 3); assert.ok(r.items.every((x) => x.status === 'TO_REVIEW'));
});
