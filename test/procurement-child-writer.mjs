// Child process for the durability test: records a supplier visit, a draft order, an approval path and a partial receipt into a file store, then DIES WITHOUT
// CLOSING ANYTHING (SIGKILL-like). Usage: node procurement-child-writer.mjs <data-file> <merchant-id>
import { openFileProcurementStore, createProcurement, importSourcingCase, draftOrderFromCase } from '../src/procurement/index.js';

const [path, merchantId] = process.argv.slice(2);
const store = await openFileProcurementStore({ path });
const NOW = '2026-10-20T09:00:00.000Z';
const { commands: c, queries: q } = createProcurement({ store, merchantId, now: () => NOW });
const buyer = { id: 'u-buyer', role: 'BUYER' }; const wh = { id: 'u-wh', role: 'WAREHOUSE' };
const loc = (await c.createLocation({ id: 'u-owner', role: 'OWNER' }, 'k-loc', { name: 'Yiwu warehouse', type: 'WAREHOUSE' })).location;
const quarantine = (await c.createLocation({ id: 'u-owner', role: 'OWNER' }, 'k-loc2', { name: 'Quarantine', type: 'QUARANTINE' })).location;
const visit = { schema: 2, id: 'case-yiwu1', identity: { workingName: 'Acrylic keychain 5cm', photos: [{ ref: 'upload://aaa.jpg' }] }, supplier: { name: 'Yiwu Bright Gifts Ltd' },
  quotes: [{ at: 't1', currency: 'USD', unitPrice: '0.085', moq: 1000, incoterm: 'FOB', payment: { depositPct: '30' }, tiers: [{ minQty: 1000, unitPrice: '0.085' }, { minQty: 5000, unitPrice: '0.072' }] }] };
const d = await draftOrderFromCase({ commands: c, queries: q, actor: buyer, caseState: visit, qty: 5000, destinationLocationId: loc.id, expectedDate: '2026-12-10' });
const ap = (action, id, who = 'reviewer-1') => ({ id: `ap-${action}-${id}`, action, subject_ref: `nordla:purchase:${id}`, approver: { kind: 'HUMAN', id: who, role: 'AUTHORIZED_REVIEWER' }, approved_at: NOW });
await c.submitPurchaseOrder(buyer, 'k-submit', { poId: d.purchaseOrder.id });
await c.approvePurchaseOrder(buyer, 'k-approve', { poId: d.purchaseOrder.id, approval: ap('BUYING.approve_purchase_plan', d.purchaseOrder.id) });
await c.placeOrder(buyer, 'k-order', { poId: d.purchaseOrder.id, approval: ap('BUYING.place_order', d.purchaseOrder.id) });
await c.receiveGoods(wh, 'k-receive', { poId: d.purchaseOrder.id, receivedAt: '2026-12-09', lines: [{ poLineId: 'L1', qtyAccepted: 1990, qtyDefective: 10 }], quarantineLocationId: quarantine.id, approval: ap('STOCK_SALES.receive_goods', d.purchaseOrder.id) });
console.log(JSON.stringify({ poId: d.purchaseOrder.id, number: d.purchaseOrder.number, itemId: d.item.id, supplierId: d.supplier.id, locationId: loc.id }));
process.kill(process.pid, 'SIGKILL'); // no close(), no flush, no goodbye
