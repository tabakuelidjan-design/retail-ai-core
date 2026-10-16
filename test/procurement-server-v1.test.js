// Stock / Achats V1 routes: suppliers and offers, order follow-up, filed stock changes and their decision, transfers, count preview, item history - and the
// permission rules around them (explicit grants, no self-approval, the owner's per-operation exception, no approval taken from the request).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProcurement, createMemoryProcurementStore } from '../src/procurement/index.js';
import { createProcurementApp, listen } from '../src/procurement/server/app.js';
import { SERVER_POLICY, capabilitiesOf } from '../src/procurement/server/permissions.js';

const tok = (c) => c.repeat(32);
const OWNER = { id: 'owner', role: 'OWNER', canApprove: true, approverRole: 'OWNER', token: tok('o') };
const FIELD = { id: 'terrain', role: 'BUYER', canApprove: false, token: tok('f') };
const EMPLOYEE = { id: 'employe', role: 'WAREHOUSE', grants: [], token: tok('e') };            // a warehouse employee with NO explicit authorization
const HANDLER = { id: 'magasinier', role: 'WAREHOUSE', grants: ['RECEIVE'], token: tok('h') };  // may receive / move / count / file changes
const RESP = { id: 'responsable', role: 'WAREHOUSE', grants: ['RECEIVE', 'ADJUST'], token: tok('r') }; // may also decide stock changes
const VIEWER = { id: 'lecteur', role: 'VIEWER', grants: ['RECEIVE', 'ADJUST'], token: tok('v') };    // grants on a reader are ignored
let n = 0; const idem = () => `v1-${Date.now()}-${++n}`;

async function boot() {
  const procurement = createProcurement({ store: createMemoryProcurementStore(), merchantId: randomUUID(), now: () => '2026-10-20T09:00:00.000Z', policy: SERVER_POLICY });
  const sys = { id: 'system', role: 'OWNER' };
  await procurement.commands.createLocation(sys, 'b1', { name: 'Entrepôt', type: 'WAREHOUSE' }); await procurement.commands.createLocation(sys, 'b2', { name: 'Quarantaine', type: 'QUARANTINE' }); await procurement.commands.createLocation(sys, 'b3', { name: 'Magasin', type: 'STORE' });
  const handler = createProcurementApp({ procurement, users: [OWNER, FIELD, EMPLOYEE, HANDLER, RESP, VIEWER], uploadsDir: join(mkdtempSync(join(tmpdir(), 'nordla-v1-')), 'u'), now: () => new Date('2026-10-20T09:00:00Z') });
  const { server, port } = await listen(handler);
  const call = async (method, path, { user = OWNER, body, key } = {}) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(user ? { 'x-nordla-token': user.token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'idempotency-key': key ?? idem() } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); let json = null; try { json = await r.json(); } catch { /* none */ } return { status: r.status, json }; };
  return { procurement, call, close: () => new Promise((r) => server.close(r)) };
}
/** 100 units of one item, ordered (owner approves what the field person prepared) and received by a handler: returns ids */
async function stocked(s) {
  const v = (await s.call('POST', '/api/visits', { user: FIELD, body: { supplierName: 'Yiwu Co', currency: 'USD', date: '2026-10-20' } })).json;
  const c = (await s.call('POST', `/api/visits/${v.visit.id}/products`, { user: FIELD, body: { product: { name: 'Keychain' }, quote: { unitPrice: '0.5', moq: 10 } } })).json;
  const po = (await s.call('POST', '/api/purchase-orders', { user: FIELD, body: { lines: [{ quoteId: c.quoteId, qty: 100 }], expectedDate: '2026-12-01', fx: { from: 'USD', to: 'EUR', rate: '0.9', date: '2026-10-20', source: 'test' } } })).json.purchaseOrder;
  await s.call('POST', `/api/purchase-orders/${po.id}/submit`, { user: FIELD }); await s.call('POST', `/api/purchase-orders/${po.id}/approve`, { user: OWNER }); await s.call('POST', `/api/purchase-orders/${po.id}/order`, { user: OWNER, body: {} });
  const rcv = await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: HANDLER, body: { lines: [{ poLineId: po.lines[0].id, qtyAccepted: 100 }] } });
  assert.equal(rcv.status, 200, JSON.stringify(rcv.json));
  const stock = (await s.call('GET', '/api/stock')).json; const loc = (t) => stock.locations.find((l) => l.type === t).id;
  return { po, itemId: c.itemId, W: loc('WAREHOUSE'), S: loc('STORE'), Q: loc('QUARANTINE') };
}
const onHand = async (s, itemId) => (await s.call('GET', '/api/stock')).json.items.find((i) => i.itemId === itemId).physical;

test('capabilities: the owner has everything; a grant gives exactly what it names; a reader never has a grant; legacy token users keep their old rights', () => {
  assert.deepEqual(capabilitiesOf(OWNER).grants.sort(), ['ADJUST', 'APPROVE_PO', 'RECEIVE']); assert.equal(capabilitiesOf(OWNER).canSelfApprove, true);
  assert.deepEqual(capabilitiesOf(EMPLOYEE), { read: true, prepare: false, canApprove: false, canReceive: false, canAdjust: false, canSelfApprove: false, grants: [] });
  assert.deepEqual([capabilitiesOf(HANDLER).canReceive, capabilitiesOf(HANDLER).canAdjust, capabilitiesOf(RESP).canAdjust, capabilitiesOf(RESP).canSelfApprove], [true, false, true, false]);
  assert.deepEqual(capabilitiesOf(VIEWER).grants, [], 'a viewer holds no grant');
  const legacyWarehouse = { id: 'w', role: 'WAREHOUSE', canApprove: true }; const legacyBuyer = { id: 'b', role: 'BUYER', canApprove: true };
  assert.deepEqual([capabilitiesOf(legacyWarehouse).canReceive, capabilitiesOf(legacyWarehouse).canAdjust, capabilitiesOf(legacyBuyer).canReceive, capabilitiesOf(legacyBuyer).canApprove], [true, true, false, true]);
  assert.equal(capabilitiesOf(null).read, false);
});

test('suppliers and offers: create, list, detail with offers, orders and metrics; a reader and an ungranted employee cannot write', async (t) => {
  const s = await boot(); t.after(() => s.close());
  assert.equal((await s.call('POST', '/api/suppliers', { user: VIEWER, body: { name: 'X Co', currency: 'USD' } })).status, 403);
  assert.equal((await s.call('POST', '/api/suppliers', { user: EMPLOYEE, body: { name: 'X Co', currency: 'USD' } })).status, 403);
  assert.equal((await s.call('POST', '/api/suppliers', { user: FIELD, body: { name: '', currency: 'USD' } })).status, 400);
  assert.equal((await s.call('POST', '/api/suppliers', { user: FIELD, body: { name: 'Ningbo Souvenir Co', currency: 'jpy-nonsense' } })).status, 400, 'bad currency refused');
  const key = idem(); const mk = await s.call('POST', '/api/suppliers', { user: FIELD, key, body: { name: 'Ningbo Souvenir Co', country: 'cn', currency: 'USD', incotermDefault: 'FOB', leadTimeDays: 25 } });
  assert.equal(mk.status, 200); assert.equal(mk.json.supplier.country, 'CN');
  const again = await s.call('POST', '/api/suppliers', { user: FIELD, key, body: { name: 'Ningbo Souvenir Co', country: 'cn', currency: 'USD', incotermDefault: 'FOB', leadTimeDays: 25 } });
  assert.equal(again.json.replayed, true); assert.equal((await s.call('GET', '/api/suppliers', { user: VIEWER })).json.suppliers.length, 1, 'a retry created no second supplier');
  const sup = mk.json.supplier.id; const { itemId } = await stocked(s);
  const off = await s.call('POST', `/api/suppliers/${sup}/offers`, { user: FIELD, body: { itemId, currency: 'USD', moq: 500, incoterm: 'FOB', leadTimeDays: 20, tiers: [{ minQty: 500, unitPrice: '0.40' }, { minQty: 2000, unitPrice: '0.35' }] } });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.equal((await s.call('POST', `/api/suppliers/${sup}/offers`, { user: FIELD, body: { itemId, currency: 'USD', tiers: [{ minQty: 500, unitPrice: '0.40' }, { minQty: 100, unitPrice: '0.35' }] } })).status, 400, 'tier quantities must increase');
  assert.equal((await s.call('POST', `/api/suppliers/${sup}/offers`, { user: VIEWER, body: { itemId, currency: 'USD', tiers: [{ minQty: 1, unitPrice: '1' }] } })).status, 403);
  assert.equal((await s.call('POST', `/api/suppliers/${randomUUID()}/offers`, { user: FIELD, body: { itemId, currency: 'USD', tiers: [{ minQty: 1, unitPrice: '1' }] } })).status, 404);
  const d = (await s.call('GET', `/api/suppliers/${sup}`, { user: VIEWER })).json;
  assert.equal(d.offers.length, 1); assert.deepEqual(d.offers[0].tiers, [{ minQty: 500, unitPrice: '0.4' }, { minQty: 2000, unitPrice: '0.35' }]); assert.equal(d.offers[0].name, 'Keychain'); assert.ok(d.metrics);
  const list = (await s.call('GET', '/api/suppliers')).json.suppliers.find((x) => x.id === sup); assert.equal(list.offers, 1);
  assert.equal((await s.call('GET', `/api/suppliers/${randomUUID()}`)).status, 404);
});

test('order follow-up: confirm and close; a reader cannot; a short close needs a reason', async (t) => {
  const s = await boot(); t.after(() => s.close());
  const v = (await s.call('POST', '/api/visits', { user: FIELD, body: { supplierName: 'Yiwu Co', currency: 'USD', date: '2026-10-20' } })).json;
  const c = (await s.call('POST', `/api/visits/${v.visit.id}/products`, { user: FIELD, body: { product: { name: 'Pen' }, quote: { unitPrice: '0.5', moq: 10 } } })).json;
  const po = (await s.call('POST', '/api/purchase-orders', { user: FIELD, body: { lines: [{ quoteId: c.quoteId, qty: 100 }], expectedDate: '2026-12-01', fx: { from: 'USD', to: 'EUR', rate: '0.9', date: '2026-10-20', source: 'test' } } })).json.purchaseOrder;
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/confirm`, { user: FIELD, body: {} })).status, 409, 'a draft cannot be confirmed');
  await s.call('POST', `/api/purchase-orders/${po.id}/submit`, { user: FIELD }); await s.call('POST', `/api/purchase-orders/${po.id}/approve`, { user: OWNER }); await s.call('POST', `/api/purchase-orders/${po.id}/order`, { user: OWNER, body: {} });
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/confirm`, { user: VIEWER, body: {} })).status, 403);
  const conf = await s.call('POST', `/api/purchase-orders/${po.id}/confirm`, { user: FIELD, body: { confirmedDate: '2026-12-10', supplierReference: 'SUP-77' } });
  assert.equal(conf.status, 200); assert.equal(conf.json.purchaseOrder.status, 'CONFIRMED');
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/close`, { user: FIELD, body: {} })).status, 409, 'outstanding goods: closing short needs a reason / a status that allows it');
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/cancel`, { user: FIELD, body: { reason: 'supplier stopped the line' } })).status, 403, 'only the owner cancels an order already placed');
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/cancel`, { user: OWNER, body: { reason: 'supplier stopped the line' } })).status, 200);
});

test('receipt: an employee WITHOUT explicit authorization cannot receive; with the grant (and no approval power) they can; a viewer with a grant still cannot', async (t) => {
  const s = await boot(); t.after(() => s.close());
  const v = (await s.call('POST', '/api/visits', { user: FIELD, body: { supplierName: 'Yiwu Co', currency: 'USD', date: '2026-10-20' } })).json;
  const c = (await s.call('POST', `/api/visits/${v.visit.id}/products`, { user: FIELD, body: { product: { name: 'Pen' }, quote: { unitPrice: '0.5', moq: 10 } } })).json;
  const po = (await s.call('POST', '/api/purchase-orders', { user: FIELD, body: { lines: [{ quoteId: c.quoteId, qty: 50 }], expectedDate: '2026-12-01', fx: { from: 'USD', to: 'EUR', rate: '0.9', date: '2026-10-20', source: 'test' } } })).json.purchaseOrder;
  await s.call('POST', `/api/purchase-orders/${po.id}/submit`, { user: FIELD }); await s.call('POST', `/api/purchase-orders/${po.id}/approve`, { user: OWNER }); await s.call('POST', `/api/purchase-orders/${po.id}/order`, { user: OWNER, body: {} });
  const body = { lines: [{ poLineId: po.lines[0].id, qtyAccepted: 50 }] };
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: EMPLOYEE, body })).status, 403);
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: VIEWER, body })).status, 403);
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: FIELD, body })).status, 403, 'a buyer does not receive');
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/approve`, { user: HANDLER })).status, 403, 'the receive grant does not approve orders');
  assert.equal((await s.call('POST', `/api/purchase-orders/${po.id}/receive`, { user: HANDLER, body })).status, 200);
  assert.equal((await s.call('GET', '/api/me', { user: HANDLER })).json.canApprove, false);
});

test('adjustment: filed by an authorized handler, decided by another authorized person; nothing moves before the decision', async (t) => {
  const s = await boot(); t.after(() => s.close()); const { itemId, W } = await stocked(s);
  const body = { type: 'ADJUST', itemId, locationId: W, delta: -4, reason: 'four keychains broken in handling' };
  assert.equal((await s.call('POST', '/api/stock/requests', { user: EMPLOYEE, body })).status, 403, 'no grant: cannot even file');
  assert.equal((await s.call('POST', '/api/stock/requests', { user: VIEWER, body })).status, 403);
  assert.equal((await s.call('POST', '/api/stock/requests', { user: HANDLER, body: { ...body, delta: 0 } })).status, 400);
  const filed = await s.call('POST', '/api/stock/requests', { user: HANDLER, body });
  assert.equal(filed.status, 200, JSON.stringify(filed.json)); assert.equal(filed.json.status, 'PENDING'); assert.equal(filed.json.request.name, 'Keychain'); const id = filed.json.request.requestId;
  assert.equal(await onHand(s, itemId), 100);
  const decide = (user, b, key) => s.call('POST', `/api/stock/requests/${id}/decision`, { user, body: b, key });
  assert.equal((await decide(HANDLER, { decision: 'APPROVE' })).status, 403, 'RECEIVE alone does not approve adjustments');
  assert.equal((await decide(EMPLOYEE, { decision: 'APPROVE' })).status, 403);
  assert.equal((await decide(VIEWER, { decision: 'APPROVE' })).status, 403);
  const ok = await decide(RESP, { decision: 'APPROVE' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.json.request.status, 'APPROVED'); assert.equal(await onHand(s, itemId), 96);
  assert.equal((await decide(RESP, { decision: 'APPROVE' })).status, 409, 'decided once');
  assert.equal((await s.call('GET', '/api/stock/requests?status=PENDING')).json.requests.length, 0); assert.equal((await s.call('GET', '/api/stock/requests?status=APPROVED')).json.requests.length, 1);
});

test('the person who filed a change cannot approve it - not even the authorized responsable; the OWNER may, only with the explicit confirmation, and it is journaled', async (t) => {
  const s = await boot(); t.after(() => s.close()); const { itemId, W } = await stocked(s);
  const file = async (user, delta = -1) => (await s.call('POST', '/api/stock/requests', { user, body: { type: 'ADJUST', itemId, locationId: W, delta, reason: 'a unit found damaged on the shelf' } })).json.request.requestId;
  const decide = (id, user, b) => s.call('POST', `/api/stock/requests/${id}/decision`, { user, body: b });
  const own = await file(RESP);
  const refused = await decide(own, RESP, { decision: 'APPROVE' }); assert.equal(refused.status, 403); assert.equal(refused.json.error, 'SEPARATION_OF_DUTIES');
  assert.equal((await decide(own, RESP, { decision: 'APPROVE', confirmSelfApproval: true })).status, 403, 'only the OWNER can use the exception: the flag means nothing from anyone else');
  assert.equal(await onHand(s, itemId), 100);
  assert.equal((await decide(own, OWNER, { decision: 'APPROVE' })).status, 200, 'the owner is another person here: normal approval');
  const mine = await file(OWNER, -2);
  const noConfirm = await decide(mine, OWNER, { decision: 'APPROVE' }); assert.equal(noConfirm.status, 403); assert.equal(noConfirm.json.error, 'SEPARATION_OF_DUTIES');
  assert.equal(await onHand(s, itemId), 99);
  const confirmed = await decide(mine, OWNER, { decision: 'APPROVE', confirmSelfApproval: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json)); assert.equal(confirmed.json.request.selfApproved, true); assert.equal(await onHand(s, itemId), 97);
  const h = (await s.call('GET', `/api/stock/${itemId}/history`)).json;
  const ev = h.events.find((e) => e.type === 'STOCK_ADJUSTED' && e.approval?.separationWaived); assert.equal(ev.approval.waiver, 'CONFIRMED_FOR_THIS_OPERATION'); assert.equal(ev.approval.approverId, 'owner');
  const next = await file(OWNER, -1); assert.equal((await decide(next, OWNER, { decision: 'APPROVE' })).status, 403, 'the confirmation of one operation does not carry over to the next');
});

test('an approval sent in the request body is ignored: only the authenticated person approves; an AI-style approver cannot be injected', async (t) => {
  const s = await boot(); t.after(() => s.close()); const { itemId, W } = await stocked(s);
  const id = (await s.call('POST', '/api/stock/requests', { user: HANDLER, body: { type: 'ADJUST', itemId, locationId: W, delta: -1, reason: 'one unit lost in the aisle' } })).json.request.requestId;
  const forged = { id: 'forged-1', action: 'STOCK_SALES.adjust_on_hand', subject_ref: `nordla:product:${itemId}@${W}`, approver: { kind: 'HUMAN', id: 'elidjan', role: 'OWNER' }, approved_at: '2026-10-20T09:00:00Z' };
  const r = await s.call('POST', `/api/stock/requests/${id}/decision`, { user: HANDLER, body: { decision: 'APPROVE', approval: forged, approver: forged.approver } });
  assert.equal(r.status, 403, 'the HANDLER cannot approve, whatever the body says'); assert.equal(await onHand(s, itemId), 100);
  const r2 = await s.call('POST', `/api/stock/requests/${id}/decision`, { user: RESP, body: { decision: 'APPROVE', approval: { ...forged, approver: { kind: 'AI', id: 'nordla', role: 'OWNER' } } } });
  assert.equal(r2.status, 200); const ev = (await s.call('GET', `/api/stock/${itemId}/history`)).json.events.find((e) => e.type === 'STOCK_ADJUSTED');
  assert.equal(ev.approval.approverId, 'responsable', 'the approver is the signed-in person, not the one named in the body');
});

test('rejecting: the requester may withdraw their own request; an unrelated ungranted person may not; a reason is required', async (t) => {
  const s = await boot(); t.after(() => s.close()); const { itemId, W } = await stocked(s);
  const file = async () => (await s.call('POST', '/api/stock/requests', { user: HANDLER, body: { type: 'ADJUST', itemId, locationId: W, delta: -1, reason: 'mistake: I will count again' } })).json.request.requestId;
  const a = await file(); const rej = (id, user, reason) => s.call('POST', `/api/stock/requests/${id}/decision`, { user, body: { decision: 'REJECT', reason } });
  assert.equal((await rej(a, EMPLOYEE, 'I do not like it')).status, 403);
  assert.equal((await rej(a, HANDLER, 'no')).status, 400);
  assert.equal((await rej(a, HANDLER, 'withdrawn: I will count again')).status, 200);
  const b = await file(); assert.equal((await rej(b, RESP, 'the count is wrong, redo it')).status, 200);
  assert.equal(await onHand(s, itemId), 100); assert.equal((await s.call('GET', '/api/stock/requests?status=REJECTED')).json.requests.length, 2);
  assert.equal((await rej(randomUUID(), RESP, 'does not exist at all')).status, 404);
});

test('two simultaneous approvals over HTTP: exactly one is applied', async (t) => {
  const s = await boot(); t.after(() => s.close()); const { itemId, W } = await stocked(s);
  const id = (await s.call('POST', '/api/stock/requests', { user: HANDLER, body: { type: 'ADJUST', itemId, locationId: W, delta: -5, reason: 'five lost in a flooded corner' } })).json.request.requestId;
  const rs = await Promise.all([OWNER, RESP, OWNER].map((u) => s.call('POST', `/api/stock/requests/${id}/decision`, { user: u, body: { decision: 'APPROVE' } })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status))); assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
  assert.equal(await onHand(s, itemId), 95);
});

test('counts: preview changes nothing; no variance is confirmed without approval; a variance is filed and needs a decision', async (t) => {
  const s = await boot(); t.after(() => s.close()); const { itemId, W } = await stocked(s);
  const before = JSON.stringify((await s.call('GET', '/api/stock')).json);
  const pv = await s.call('POST', '/api/stock/counts/preview', { user: HANDLER, body: { locationId: W, counts: [{ itemId, counted: 93 }] } });
  assert.equal(pv.status, 200); assert.deepEqual(pv.json.lines[0], { itemId, expected: 100, counted: 93, variance: -7, sku: pv.json.lines[0].sku, name: 'Keychain' }); assert.equal(pv.json.needsApproval, true);
  assert.equal(JSON.stringify((await s.call('GET', '/api/stock')).json), before, 'a preview writes nothing');
  assert.equal((await s.call('POST', '/api/stock/counts/preview', { user: EMPLOYEE, body: { locationId: W, counts: [{ itemId, counted: 1 }] } })).status, 403);
  const same = await s.call('POST', '/api/stock/requests', { user: HANDLER, body: { type: 'COUNT', locationId: W, counts: [{ itemId, counted: 100 }] } });
  assert.equal(same.json.status, 'CONFIRMED'); assert.equal((await s.call('GET', '/api/stock/requests?status=PENDING')).json.requests.length, 0);
  const diff = await s.call('POST', '/api/stock/requests', { user: HANDLER, body: { type: 'COUNT', locationId: W, counts: [{ itemId, counted: 93, reason: 'seven missing at the count' }] } });
  assert.equal(diff.json.status, 'PENDING'); assert.equal(await onHand(s, itemId), 100);
  const list = (await s.call('GET', '/api/stock/requests?status=PENDING')).json.requests; assert.equal(list[0].lines[0].varianceNow, -7);
  assert.equal((await s.call('POST', `/api/stock/requests/${diff.json.request.requestId}/decision`, { user: RESP, body: { decision: 'APPROVE' } })).status, 200); assert.equal(await onHand(s, itemId), 93);
  assert.equal((await s.call('POST', '/api/stock/requests', { user: HANDLER, body: { type: 'COUNT', locationId: W, counts: [{ itemId, counted: -1 }] } })).status, 400);
  assert.equal((await s.call('POST', '/api/stock/requests', { user: HANDLER, body: { type: 'NOPE', locationId: W } })).status, 400);
});

test('transfers: only an authorized handler; moves stock between locations; a retry moves it once; too much is refused', async (t) => {
  const s = await boot(); t.after(() => s.close()); const { itemId, W, S } = await stocked(s);
  const b = { itemId, fromLocationId: W, toLocationId: S, qty: 30, reason: 'refill the shop shelf' };
  assert.equal((await s.call('POST', '/api/stock/transfers', { user: EMPLOYEE, body: b })).status, 403); assert.equal((await s.call('POST', '/api/stock/transfers', { user: FIELD, body: b })).status, 403); assert.equal((await s.call('POST', '/api/stock/transfers', { user: VIEWER, body: b })).status, 403);
  const key = idem(); const r1 = await s.call('POST', '/api/stock/transfers', { user: HANDLER, body: b, key }); assert.equal(r1.status, 200);
  const r2 = await s.call('POST', '/api/stock/transfers', { user: HANDLER, body: b, key }); assert.equal(r2.json.replayed, true);
  const it = (await s.call('GET', '/api/stock')).json.items.find((i) => i.itemId === itemId); assert.deepEqual(it.perLocation.map((l) => [l.type, l.onHand]).sort(), [['STORE', 30], ['WAREHOUSE', 70]]);
  assert.equal((await s.call('POST', '/api/stock/transfers', { user: HANDLER, body: { ...b, qty: 1000 } })).status, 409, 'cannot move more than is there');
  assert.equal((await s.call('POST', '/api/stock/transfers', { user: HANDLER, body: { ...b, toLocationId: W } })).status, 400, 'same location');
});

test('history: every movement with its actor, reason and approval, plus the journal; readers can read, nobody is told internals', async (t) => {
  const s = await boot(); t.after(() => s.close()); const { itemId, W, S } = await stocked(s);
  await s.call('POST', '/api/stock/transfers', { user: HANDLER, body: { itemId, fromLocationId: W, toLocationId: S, qty: 10, reason: 'refill the shelf' } });
  const h = await s.call('GET', `/api/stock/${itemId}/history`, { user: VIEWER }); assert.equal(h.status, 200);
  assert.deepEqual(h.json.movements.map((m) => m.kind), ['RECEIPT', 'TRANSFER_OUT', 'TRANSFER_IN']); assert.equal(h.json.movements[0].location, 'Entrepôt'); assert.equal(h.json.movements[1].actorId, 'magasinier');
  assert.equal(h.json.movements.reduce((n, m) => n + m.delta, 0), 100);
  assert.equal((await s.call('GET', `/api/stock/${randomUUID()}/history`)).status, 404);
  assert.equal((await s.call('GET', `/api/stock/${itemId}/history`, { user: null })).status, 401);
  const bad = await s.call('POST', '/api/stock/requests', { user: HANDLER, body: { type: 'ADJUST', itemId: randomUUID(), locationId: W, delta: 1, reason: 'unknown item on purpose' } });
  assert.equal(bad.status, 404); assert.doesNotMatch(String(bad.json.message), /stockLocations|purchaseOrders|supplierItems|proc_/);
});

test('locations: only the owner creates one; a type must be valid; a retry creates one; it appears in the stock answer and can receive a transfer', async (t) => {
  const s = await boot(); t.after(() => s.close()); const { itemId, W } = await stocked(s);
  for (const user of [RESP, HANDLER, EMPLOYEE, FIELD, VIEWER]) assert.equal((await s.call('POST', '/api/locations', { user, body: { name: 'Réserve', type: 'BACKROOM' } })).status, 403, user.id);
  assert.equal((await s.call('POST', '/api/locations', { body: { name: 'Réserve', type: 'SECRET_ROOM' } })).status, 400); assert.equal((await s.call('POST', '/api/locations', { body: { name: '', type: 'BACKROOM' } })).status, 400);
  const key = idem(); const mk = await s.call('POST', '/api/locations', { key, body: { name: 'Réserve arrière', type: 'BACKROOM' } }); assert.equal(mk.status, 200);
  assert.equal((await s.call('POST', '/api/locations', { key, body: { name: 'Réserve arrière', type: 'BACKROOM' } })).json.replayed, true);
  const locs = (await s.call('GET', '/api/stock')).json.locations; assert.equal(locs.filter((l) => l.name === 'Réserve arrière').length, 1);
  assert.equal((await s.call('POST', '/api/stock/transfers', { user: HANDLER, body: { itemId, fromLocationId: W, toLocationId: mk.json.location.id, qty: 5 } })).status, 200);
});
