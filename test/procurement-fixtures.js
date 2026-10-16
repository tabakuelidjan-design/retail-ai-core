// Shared fixtures for the Stock / Achats tests. In-memory store only: no database, no network, no production data.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcurement, createMemoryProcurementStore, createPgProcurementStore, openFileProcurementStore } from '../src/procurement/index.js';

// The SAME suites run on the memory store (default) and on a real PostgreSQL: PROCUREMENT_STORE=pg PROCUREMENT_PG_URL=postgres://... (a THROWAWAY database only;
// test/postgres/procurement-parity.mjs starts one). Merchants are random UUIDs, so suites never collide in a shared database.
export const STORE_KIND = ['pg', 'file'].includes(process.env.PROCUREMENT_STORE) ? process.env.PROCUREMENT_STORE : 'memory';
let pool = null;
export function pgPool() {
  if (!pool) {
    const { Pool } = createRequire(import.meta.url)('./pg/node_modules/pg');
    pool = new Pool({ connectionString: process.env.PROCUREMENT_PG_URL, max: 8, idleTimeoutMillis: 200, allowExitOnIdle: true });
  }
  return pool;
}
export async function newStore() {
  if (STORE_KIND === 'pg') return createPgProcurementStore({ pool: pgPool() });
  if (STORE_KIND === 'file') return openFileProcurementStore({ path: join(mkdtempSync(join(tmpdir(), 'nordla-proc-')), 'procurement.json') });
  return createMemoryProcurementStore();
}
export async function ensureMerchant(id) { if (STORE_KIND === 'pg') await pgPool().query('insert into merchants (id, name) values ($1, $2) on conflict do nothing', [id, `test ${id}`]); return id; }
export const newMerchant = () => randomUUID();

export const NOW = '2026-10-16T10:00:00.000Z';
export const owner = { id: 'u-owner', role: 'OWNER' };
export const buyer = { id: 'u-buyer', role: 'BUYER' };
export const wh = { id: 'u-wh', role: 'WAREHOUSE' };
export const viewer = { id: 'u-view', role: 'VIEWER' };

let n = 0;
export const key = (p = 'k') => `${p}-${++n}`;
export const approval = (action, subjectId, over = {}) => ({
  id: key('ap'), action, subject_ref: subjectId.startsWith('nordla:') ? subjectId : `nordla:purchase:${subjectId}`,
  approver: { kind: 'HUMAN', id: 'elidjan', role: 'OWNER' }, approved_at: NOW, ...over,
});
export const productApproval = (action, subject, over = {}) => ({ id: key('ap'), action, subject_ref: `nordla:product:${subject}`, approver: { kind: 'HUMAN', id: 'elidjan', role: 'OWNER' }, approved_at: NOW, ...over });

export async function makeWorld({ merchantId = randomUUID(), store = null, now = () => NOW, analyze, retryDelayMs = 1, policy } = {}) {
  store ??= await newStore();
  await ensureMerchant(merchantId);
  const audited = [];
  const proc = createProcurement({ store, merchantId, now, audit: async (e) => { audited.push(e); }, analyze, retryDelayMs, policy });
  const c = proc.commands;
  const mk = async (fn, who, payload) => (await fn(who, key(), payload));
  const storeLoc = (await mk(c.createLocation, owner, { name: 'Boutique', type: 'STORE' })).location;
  const warehouse = (await mk(c.createLocation, owner, { name: 'Réserve', type: 'WAREHOUSE' })).location;
  const quarantine = (await mk(c.createLocation, owner, { name: 'Quarantaine', type: 'QUARANTINE' })).location;
  const transit = (await mk(c.createLocation, owner, { name: 'En transit', type: 'TRANSIT' })).location;
  const itemA = (await mk(c.createItem, buyer, { sku: 'MAG-001', name: 'Aimant rond', barcode: '5400000000011' })).item;
  const itemB = (await mk(c.createItem, buyer, { sku: 'MAG-002', name: 'Aimant carré' })).item;
  const supplier = (await mk(c.createSupplier, buyer, { name: 'Shenzhen Gifts Co', country: 'cn', currency: 'USD', incotermDefault: 'FOB', payment: { depositPct: '30', balancePct: '70' }, leadTimeDays: 35 })).supplier;
  const quote = (await mk(c.recordQuote, buyer, {
    supplierId: supplier.id, itemId: itemA.id, currency: 'USD', tiers: [{ minQty: 100, unitPrice: '0.500' }, { minQty: 500, unitPrice: '0.420' }], moq: 100, incoterm: 'FOB', validUntil: '2026-12-31', leadTimeDays: 30,
  })).quote;
  return { proc, c, q: proc.queries, store, audited, merchantId, mk, locs: { store: storeLoc, warehouse, quarantine, transit }, itemA, itemB, supplier, quote };
}

/** PO of 200 x itemA at 0.50 USD (= 100.00 USD), 30% deposit, destination = warehouse, ORDERED. */
export async function orderedPo(w, { qty = 200, expectedDate = '2026-11-20' } = {}) {
  const { purchaseOrder: po } = await w.mk(w.c.createPurchaseOrder, w.buyerActor ?? buyer, {
    supplierId: w.supplier.id, currency: 'USD', expectedDate, destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty, ...(qty >= 100 ? { quoteId: w.quote.id } : { unitPrice: '0.500' }) }],
  });
  await w.mk(w.c.submitPurchaseOrder, buyer, { poId: po.id });
  await w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id) });
  await w.mk(w.c.placeOrder, buyer, { poId: po.id, approval: approval('BUYING.place_order', po.id), supplierReference: 'SG-2026-77' });
  return w.q.purchaseOrder(po.id);
}

export const receive = (w, po, lines, over = {}) => w.c.receiveGoods(wh, key('rcv'), {
  poId: po.id, receivedAt: '2026-11-18', lines, quarantineLocationId: w.locs.quarantine.id, approval: approval('STOCK_SALES.receive_goods', po.id), ...over,
});
export const rejects = async (promise, code) => {
  try { await promise; } catch (e) { if (e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`); return e; }
  throw new Error(`expected rejection ${code}, but it succeeded`);
};
