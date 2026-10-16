// Persistent storage of Stock / Achats on the hosted volume: the encrypted backup of the data directory carries procurement.json (stock ledger, orders, filed stock
// changes, photos) and a RESTORE into an empty directory brings the module back exactly - then it keeps working (a new receipt, a pending request still decidable).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { backup, verify, restore } from '../tools/sourcing-backup.mjs';
import { buildHostedProcurement } from '../src/procurement/server/hosted.js';

const ENV = { SOURCING_BACKUP_PASSPHRASE: 'a test passphrase, not a secret' };
const MERCHANT = randomUUID();
const human = (id, role = 'OWNER') => ({ kind: 'HUMAN', id, role });

test('backup -> restore of the hosted data directory brings Stock / Achats back exactly, and it keeps working', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nordla-proc-bk-'));
  try {
    const data = join(root, 'data'); await mkdir(data, { recursive: true });
    const a = await buildHostedProcurement({ dir: data, merchantId: MERCHANT, env: {} }); assert.match(a.status, /ON \(/);
    const { commands: c, queries: q } = a.procurement; const owner = { id: 'u-owner', role: 'OWNER' }; const buyer = { id: 'u-buyer', role: 'BUYER' }; const wh = { id: 'u-wh', role: 'WAREHOUSE' };
    const sup = (await c.createSupplier(buyer, 'bk-1', { name: 'Yiwu Co', currency: 'USD' })).supplier;
    const item = (await c.createItem(buyer, 'bk-2', { sku: 'KEY-1', name: 'Keychain' })).item;
    const quote = (await c.recordQuote(buyer, 'bk-3', { supplierId: sup.id, itemId: item.id, currency: 'USD', tiers: [{ minQty: 10, unitPrice: '0.5' }] })).quote;
    const dest = (await q.locations()).find((l) => l.type === 'WAREHOUSE').id;
    const po = (await c.createPurchaseOrder(buyer, 'bk-4', { supplierId: sup.id, currency: 'USD', expectedDate: '2026-12-01', destinationLocationId: dest, fx: { from: 'USD', to: 'EUR', rate: '0.9', date: '2026-10-20', source: 'test' }, lines: [{ itemId: item.id, qty: 100, quoteId: quote.id }] })).purchaseOrder;
    await c.submitPurchaseOrder(buyer, 'bk-5', { poId: po.id });
    await c.approvePurchaseOrder(owner, 'bk-6', { poId: po.id, approval: { id: 'bk-ap-1', action: 'BUYING.approve_purchase_plan', subject_ref: `nordla:purchase:${po.id}`, approver: human('owner'), approved_at: '2026-10-20T09:00:00.000Z' } });
    await c.placeOrder(owner, 'bk-7', { poId: po.id, approval: { id: 'bk-ap-2', action: 'BUYING.place_order', subject_ref: `nordla:purchase:${po.id}`, approver: human('owner'), approved_at: '2026-10-20T09:00:00.000Z' } });
    await c.receiveGoods(wh, 'bk-8', { poId: po.id, receivedAt: '2026-10-21', lines: [{ poLineId: po.lines[0].id, qtyAccepted: 100 }], approval: { id: 'bk-ap-3', action: 'STOCK_SALES.receive_goods', subject_ref: `nordla:purchase:${po.id}`, approver: human('owner'), approved_at: '2026-10-21T09:00:00.000Z' } });
    const { request } = await c.requestStockChange(wh, 'bk-9', { type: 'ADJUST', itemId: item.id, locationId: dest, delta: -2, reason: 'two crushed units found' });
    await mkdir(join(data, 'procurement', 'uploads'), { recursive: true }); await writeFile(join(data, 'procurement', 'uploads', 'x.jpg'), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    const before = JSON.stringify([(await q.stockPositions()).positions, (await q.events()).length, (await q.stockRequests()).map((r) => [r.requestId, r.status])]);

    const b = await backup(data, join(root, 'out'), { env: ENV, now: () => new Date('2026-10-21T08:00:00.000Z') });
    assert.ok(b.files >= 2, 'the data directory has procurement.json and the upload'); assert.equal((await verify(b.file, { env: ENV })).files, b.files);
    assert.ok(!(await readFile(b.file)).includes(Buffer.from('Yiwu Co')), 'the archive is encrypted: no supplier name in clear');
    await a.close();

    const back = join(root, 'restored'); await restore(b.file, back, { env: ENV });
    assert.deepEqual(await readFile(join(back, 'procurement', 'uploads', 'x.jpg')), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    assert.ok((await readdir(join(back, 'procurement'))).includes('procurement.json'));
    const r = await buildHostedProcurement({ dir: back, merchantId: MERCHANT, env: {} }); assert.match(r.status, /ON \(/);
    const q2 = r.procurement.queries;
    assert.equal(JSON.stringify([(await q2.stockPositions()).positions, (await q2.events()).length, (await q2.stockRequests()).map((x) => [x.requestId, x.status])]), before, 'every position, every journal event and the pending request are back, identical');
    // and it keeps working: the pending request can be decided, and the same receipt cannot be replayed with another key
    const out = await r.procurement.commands.decideStockChange(owner, 'bk-10', { requestId: request.requestId, decision: 'APPROVE', approval: { id: 'bk-ap-4', action: 'STOCK_SALES.adjust_on_hand', subject_ref: `nordla:product:${item.id}@${dest}`, approver: human('elidjan'), approved_at: '2026-10-22T09:00:00.000Z' } });
    assert.equal(out.request.status, 'APPROVED'); assert.equal((await q2.stockPosition(item.id)).physical, 98);
    await assert.rejects(r.procurement.commands.receiveGoods(wh, 'bk-11', { poId: po.id, receivedAt: '2026-10-21', lines: [{ poLineId: po.lines[0].id, qtyAccepted: 1 }], approval: { id: 'bk-ap-5', action: 'STOCK_SALES.receive_goods', subject_ref: `nordla:purchase:${po.id}`, approver: human('owner'), approved_at: '2026-10-21T09:00:00.000Z' } }), (e) => e.code === 'INVALID_TRANSITION' || e.code === 'OVER_RECEIPT', 'a fully received order cannot be received again after a restore');
    await r.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
