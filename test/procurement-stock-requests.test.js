// Filed stock changes (adjustment / count): the person who files is not the person who approves, the exception for a one-person business is explicit and
// journaled, an AI never approves, a request is decided ONCE (also under concurrency), and the whole trail of an item can be read back.
// Runs on the memory store by default; PROCUREMENT_STORE=file|pg runs the same checks on the file store / a real PostgreSQL (test/postgres/procurement-parity.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, orderedPo, receive, rejects, key, approval, productApproval, owner, wh, buyer, viewer } from './procurement-fixtures.js';

const SOLO = { separation: { 'BUYING.approve_purchase_plan': true, 'STOCK_SALES.adjust_on_hand': true }, soloOwner: { perOperationConfirmation: true } };
const human = (id, role = 'AUTHORIZED_REVIEWER', extra = {}) => ({ kind: 'HUMAN', id, role, ...extra });
const withStock = async (opts = {}) => { const w = await makeWorld(opts); const po = await orderedPo(w, { qty: 100 }); await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 100 }]); return w; };
const adjustApproval = (w, approver, extra = {}) => productApproval('STOCK_SALES.adjust_on_hand', `${w.itemA.id}@${w.locs.warehouse.id}`, { approver, ...extra });
const file = (w, actor, delta = -3, reason = 'three units broken on the shelf') => w.c.requestStockChange(actor, key('req'), { type: 'ADJUST', itemId: w.itemA.id, locationId: w.locs.warehouse.id, delta, reason });
const onHand = async (w) => (await w.q.stockPosition(w.itemA.id)).physical;

test('filing changes nothing: the request waits, visible as PENDING, the ledger is untouched', async () => {
  const w = await withStock(); const before = await onHand(w);
  const { request } = await file(w, wh);
  assert.equal(request.status, 'PENDING'); assert.equal(request.requestedBy, 'u-wh');
  assert.equal(await onHand(w), before, 'nothing moved');
  const pending = await w.q.stockRequests({ status: 'PENDING' }); assert.equal(pending.length, 1); assert.equal(pending[0].requestId, request.requestId);
  await rejects(w.c.requestStockChange(wh, key(), { type: 'ADJUST', itemId: w.itemA.id, locationId: w.locs.warehouse.id, delta: 0, reason: 'zero is not a change' }), 'INVALID_INPUT');
  await rejects(w.c.requestStockChange(wh, key(), { type: 'ADJUST', itemId: w.itemA.id, locationId: w.locs.warehouse.id, delta: -1, reason: 'bad' }), 'INVALID_INPUT'); // reason too short
  await rejects(w.c.requestStockChange(buyer, key(), { type: 'ADJUST', itemId: w.itemA.id, locationId: w.locs.warehouse.id, delta: -1, reason: 'a buyer cannot file stock changes' }), 'FORBIDDEN');
  await rejects(w.c.requestStockChange(viewer, key(), { type: 'ADJUST', itemId: w.itemA.id, locationId: w.locs.warehouse.id, delta: -1, reason: 'a viewer cannot file stock changes' }), 'FORBIDDEN');
});

test('another authorized human approves: the adjustment is posted, the request closes, the journal names both people', async () => {
  const w = await withStock(); const { request } = await file(w, wh);
  const out = await w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE', approval: adjustApproval(w, human('elidjan', 'OWNER')) });
  assert.equal(out.request.status, 'APPROVED'); assert.equal(out.request.decidedBy, 'elidjan'); assert.equal(out.movement.delta, -3);
  assert.equal(await onHand(w), 97);
  const done = await w.q.stockRequest(request.requestId); assert.equal(done.status, 'APPROVED'); assert.equal(done.selfApproved, false);
  assert.equal((await w.q.stockRequests({ status: 'PENDING' })).length, 0);
  const types = (await w.q.events({ objectId: request.requestId })).map((e) => e.type); assert.deepEqual(types, ['STOCK_CHANGE_REQUESTED', 'STOCK_CHANGE_APPROVED']);
  assert.ok((await w.q.events({ objectId: w.itemA.id })).some((e) => e.type === 'STOCK_ADJUSTED' && e.approval.approverId === 'elidjan'));
});

test('a request is decided ONCE: a second approval, a reject after an approval and a replay of a different decision are all refused', async () => {
  const w = await withStock(); const { request } = await file(w, wh);
  const ap = () => adjustApproval(w, human('elidjan', 'OWNER'));
  await w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE', approval: ap() });
  await rejects(w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE', approval: ap() }), 'REQUEST_ALREADY_DECIDED');
  await rejects(w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'REJECT', reason: 'changed my mind after the fact' }), 'REQUEST_ALREADY_DECIDED');
  assert.equal(await onHand(w), 97, 'applied exactly once');
  await rejects(w.c.decideStockChange(owner, key(), { requestId: 'a1111111-1111-4111-8111-111111111111', decision: 'APPROVE', approval: ap() }), 'REQUEST_NOT_FOUND');
});

test('two simultaneous approvals of the same request: exactly one is applied', async () => {
  const w = await withStock(); const { request } = await file(w, wh);
  const go = () => w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE', approval: adjustApproval(w, human('elidjan', 'OWNER')) });
  const results = await Promise.allSettled([go(), go(), go()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status === 'rejected' ? r.reason.code : 'ok')));
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => ['REQUEST_ALREADY_DECIDED', 'IDEMPOTENCY_KEY_REUSED'].includes(r.reason.code) || r.reason.code === 'APPROVAL_ALREADY_USED'), JSON.stringify(results.map((r) => r.reason?.code)));
  assert.equal(await onHand(w), 97);
});

test('rejecting needs a reason, posts nothing, and keeps the reason in the journal', async () => {
  const w = await withStock(); const { request } = await file(w, wh);
  await rejects(w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'REJECT', reason: 'no' }), 'INVALID_INPUT');
  const out = await w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'REJECT', reason: 'recount the shelf first, then file again' });
  assert.equal(out.request.status, 'REJECTED'); assert.equal(await onHand(w), 100);
  const r = await w.q.stockRequest(request.requestId); assert.equal(r.status, 'REJECTED'); assert.match(r.reason, /recount/);
});

test('separation of duties holds: the person who filed cannot approve, even with an owner approval record; no silent waiver', async () => {
  const w = await withStock(); const { request } = await file(w, owner); // the owner files it themselves
  await rejects(w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE', approval: adjustApproval(w, human('u-owner', 'OWNER')) }), 'SEPARATION_OF_DUTIES');
  await rejects(w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE', approval: adjustApproval(w, human('u-owner', 'OWNER'), { solo_owner_confirmed: true }) }), 'SEPARATION_OF_DUTIES'); // the policy of this world has no exception
  assert.equal(await onHand(w), 100); assert.equal((await w.q.stockRequest(request.requestId)).status, 'PENDING', 'a refused decision leaves the request open');
});

test('the one-person exception: only the OWNER, only with the explicit confirmation for THIS operation, and the journal says so', async () => {
  const w = await withStock({ policy: SOLO }); const { request } = await file(w, owner);
  const self = (role, extra) => adjustApproval(w, human('u-owner', role), extra);
  await rejects(w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE', approval: self('OWNER') }), 'SEPARATION_OF_DUTIES'); // no confirmation
  await rejects(w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE', approval: self('OWNER', { solo_owner_confirmed: 'yes' }) }), 'SEPARATION_OF_DUTIES'); // only the boolean true counts
  await rejects(w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE', approval: self('AUTHORIZED_REVIEWER', { solo_owner_confirmed: true }) }), 'SEPARATION_OF_DUTIES'); // a reviewer is not the owner
  assert.equal(await onHand(w), 100);
  const out = await w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE', approval: self('OWNER', { solo_owner_confirmed: true }) });
  assert.equal(out.request.selfApproved, true); assert.equal(await onHand(w), 97);
  const ev = (await w.q.events({ objectId: request.requestId })).find((e) => e.type === 'STOCK_CHANGE_APPROVED');
  assert.equal(ev.approval.separationWaived, true); assert.equal(ev.approval.waiver, 'CONFIRMED_FOR_THIS_OPERATION');
  assert.equal((await w.q.events({ objectId: w.itemA.id })).find((e) => e.type === 'STOCK_ADJUSTED' && e.approval.separationWaived).approval.waiver, 'CONFIRMED_FOR_THIS_OPERATION');
  // the confirmation does not turn a different person's work into a waiver, and does not leak into the next operation
  const second = await file(w, owner, -1, 'one more broken unit found today');
  await rejects(w.c.decideStockChange(owner, key(), { requestId: second.request.requestId, decision: 'APPROVE', approval: self('OWNER') }), 'SEPARATION_OF_DUTIES');
});

test('an AI or a machine never approves: a non-human approver, a machine name and an unknown role are refused', async () => {
  const w = await withStock({ policy: SOLO }); const { request } = await file(w, wh);
  const go = (approver) => w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE', approval: adjustApproval(w, approver) });
  await rejects(go({ kind: 'AI', id: 'nordla-assistant', role: 'OWNER' }), 'APPROVER_NOT_HUMAN');
  await rejects(go({ kind: 'HUMAN', id: 'system', role: 'OWNER' }), 'APPROVER_NOT_HUMAN');
  await rejects(go({ kind: 'HUMAN', id: 'nordla', role: 'OWNER' }), 'APPROVER_NOT_HUMAN');
  await rejects(go({ kind: 'HUMAN', id: 'someone', role: 'BUYER' }), 'APPROVER_NOT_HUMAN');
  await assert.rejects(w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE' }), (e) => e.code === 'APPROVAL_REQUIRED');
  assert.equal(await onHand(w), 100);
});

test('a filed count: the variance is computed when it is approved; no variance needs no approval at all', async () => {
  const w = await withStock(); const A = w.itemA.id; const W = w.locs.warehouse.id;
  const none = await w.c.recordCount(wh, key(), { locationId: W, countId: 'c1111111-1111-4111-8111-111111111111', counts: [{ itemId: A, counted: 100 }] });
  assert.equal(none.adjusted, 0);
  assert.deepEqual(await w.q.countPreview({ locationId: W, counts: [{ itemId: A, counted: 96 }] }), [{ itemId: A, expected: 100, counted: 96, variance: -4 }]);
  const { request } = await w.c.requestStockChange(wh, key(), { type: 'COUNT', locationId: W, counts: [{ itemId: A, counted: 96, reason: 'four missing at the shelf count' }] });
  assert.equal(await onHand(w), 100);
  await rejects(w.c.decideStockChange(wh, key(), { requestId: request.requestId, decision: 'APPROVE', approval: productApproval('STOCK_SALES.adjust_on_hand', `count:${request.payload.countId}`, { approver: human('u-wh') }) }), 'SEPARATION_OF_DUTIES');
  const out = await w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE', approval: productApproval('STOCK_SALES.adjust_on_hand', `count:${request.payload.countId}`, { approver: human('elidjan', 'OWNER') }) });
  assert.equal(out.adjusted, 1); assert.equal(await onHand(w), 96);
  await rejects(w.c.requestStockChange(wh, key(), { type: 'COUNT', locationId: W, counts: [{ itemId: A, counted: 1 }, { itemId: A, counted: 2 }] }), 'DUPLICATE_LINE');
});

test('traceability: the history of an item lists every movement with its actor, reason and approval, and the journal events', async () => {
  const w = await withStock(); const { request } = await file(w, wh);
  await w.c.decideStockChange(owner, key(), { requestId: request.requestId, decision: 'APPROVE', approval: adjustApproval(w, human('elidjan', 'OWNER')) });
  await w.c.transferStock(wh, key(), { itemId: w.itemA.id, fromLocationId: w.locs.warehouse.id, toLocationId: w.locs.store.id, qty: 10, reason: 'refill the shop shelf' });
  const h = await w.q.stockHistory(w.itemA.id);
  assert.deepEqual(h.movements.map((m) => m.kind), ['RECEIPT', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN']);
  const adj = h.movements.find((m) => m.kind === 'ADJUSTMENT'); assert.equal(adj.delta, -3); assert.match(adj.reason, /broken/); assert.ok(adj.approvalId && adj.actorId === 'u-owner');
  assert.ok(h.events.some((e) => e.type === 'STOCK_ADJUSTED') && h.events.some((e) => e.type === 'STOCK_TRANSFERRED'));
  assert.equal(h.movements.reduce((n, m) => n + (m.bucket === 'ON_HAND' ? m.delta : 0), 0), 97, 'the trail adds up to the balance');
  assert.ok(approval && wh);
});
