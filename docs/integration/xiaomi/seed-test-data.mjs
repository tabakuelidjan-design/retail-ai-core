// Labelled TEST data for the Xiaomi rehearsal of Parle à Nordla: a catalogue, one supplier, one quote and one purchase order WAITING FOR APPROVAL in Stock / Achats.
// Everything is named "[TEST]" / "TEST-..." so nobody can mistake it for real stock. It fakes NO approval: ordering and receiving are done by the tester, on the phone, with the real
// owner approval (that is the thing being tested). Idempotent: fixed idempotency keys, so running it twice creates nothing twice.
//   node docs/integration/xiaomi/seed-test-data.mjs <data dir> <merchantId>        (the hosted server's <data dir>/procurement/procurement.json is used)
// NOT run on any shared environment by this commit: running it on staging is a separate, explicit step (Railway shell or a one-off job) decided by the owner.
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dirArg, merchantId, rootArg] = process.argv.slice(2);
if (!dirArg || !merchantId) { console.error('usage: seed-test-data.mjs <data dir> <merchantId>'); process.exit(2); }
const root = resolve(rootArg ?? '.');
const { createProcurement, openFileProcurementStore } = await import(pathToFileURL(join(root, 'src/procurement/index.js')).href);
const base = join(resolve(dirArg), 'procurement'); await mkdir(base, { recursive: true });
const store = await openFileProcurementStore({ path: join(base, 'procurement.json') });
const p = createProcurement({ store, merchantId }); const c = p.commands;
const owner = { id: 'seed-test', role: 'OWNER' }; const buyer = { id: 'seed-test', role: 'BUYER' };
const k = (n) => `seed-test-parle-a-nordla:${merchantId}:${n}`;
const once = async (fn) => { try { return await fn(); } catch (e) { if (e.code === 'UNIQUE_VIOLATION' || e.code === 'IDEMPOTENCY_REPLAY') return null; throw e; } };

const have = new Set((await p.queries.locations()).map((l) => l.type));
if (!have.has('WAREHOUSE')) await once(() => c.createLocation(owner, k('loc-wh'), { name: '[TEST] Réserve', type: 'WAREHOUSE' }));
const items = await p.queries.items();
const itemA = items.find((i) => i.sku === 'TEST-MAG-001') ?? (await c.createItem(buyer, k('item-a'), { sku: 'TEST-MAG-001', name: '[TEST] Aimant rond', reorderPoint: 50, reorderQty: 200 })).item;
if (!items.find((i) => i.sku === 'TEST-MAG-002')) await once(() => c.createItem(buyer, k('item-b'), { sku: 'TEST-MAG-002', name: '[TEST] Aimant carré' }));
const suppliers = await p.queries.suppliers();
const supplier = suppliers.find((s) => s.name === '[TEST] Fournisseur Shenzhen') ?? (await c.createSupplier(buyer, k('supplier'), { name: '[TEST] Fournisseur Shenzhen', country: 'cn', currency: 'USD', incotermDefault: 'FOB', payment: { depositPct: '30', balancePct: '70' }, leadTimeDays: 35 })).supplier;
const quotes = (await p.queries.quotes?.({ supplierId: supplier.id })) ?? [];
const quote = quotes[0] ?? (await c.recordQuote(buyer, k('quote'), { supplierId: supplier.id, itemId: itemA.id, currency: 'USD', tiers: [{ minQty: 100, unitPrice: '0.500' }, { minQty: 500, unitPrice: '0.420' }], moq: 100, incoterm: 'FOB', validUntil: '2026-12-31', leadTimeDays: 30 })).quote;
const pos = await p.queries.purchaseOrders({});
if (!pos.some((o) => o.status === 'PENDING_APPROVAL')) {
  const dest = (await p.queries.locations()).find((l) => l.type === 'WAREHOUSE');
  await once(async () => { const { purchaseOrder } = await c.createPurchaseOrder(buyer, k('po'), { supplierId: supplier.id, currency: 'USD', expectedDate: '2026-12-01', destinationLocationId: dest.id, lines: [{ itemId: itemA.id, qty: 100, quoteId: quote.id }] }); await c.submitPurchaseOrder(buyer, k('po-submit'), { poId: purchaseOrder.id }); });
}
const out = { items: (await p.queries.items()).filter((i) => i.sku.startsWith('TEST-')).length, suppliers: (await p.queries.suppliers()).filter((s) => s.name.startsWith('[TEST]')).length, pendingPurchaseOrders: (await p.queries.purchaseOrders({})).filter((o) => o.status === 'PENDING_APPROVAL').length };
console.log(JSON.stringify({ seeded: out, merchantId, file: join(base, 'procurement.json'), note: 'TEST data only; no approval was faked' }));
