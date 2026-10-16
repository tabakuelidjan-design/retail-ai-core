// Chantier A <-> chantier C: ONE source of truth (the purchase order). The views below must satisfy the constraints of A's pending table (integration_purchase_plans,
// integration_incoming_expectations - written here as JS predicates, copied from supabase/migrations-pending of the A line) and must agree with A's real builders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntegration, MODULE as M, handoffs, validateApproval } from '../src/integration/index.js';
import { purchasePlanView, incomingExpectationViews, createPlanReader, PLAN_STATUS_OF, INCOMING_STATUSES, purchaseRefOf, productRefOf } from '../src/integration/procurement-compat.js';
import { makeWorld, orderedPo, receive, approval, buyer, key } from './procurement-fixtures.js';
import { importSourcingCase } from '../src/procurement/sourcing-bridge.js';

// A's CHECK constraints, as predicates
const PLAN_OK = (p) => ['PLANNED', 'APPROVED_TO_ORDER'].includes(p.status) && ['PENDING', 'APPROVED'].includes(p.owner_review) && p.qty > 0 && /^\d{4}-\d{2}-\d{2}$/.test(p.eta)
  && p.order_placed === false && ((p.status === 'APPROVED_TO_ORDER') === (p.approval !== null && p.owner_review === 'APPROVED')) && typeof p.purchase_ref === 'string';
const INC_OK = (e) => e.state === 'EXPECTED' && e.qty > 0 && /^\d{4}-\d{2}-\d{2}$/.test(e.eta) && e.counted_in_available === false && e.received_qty === 0 && typeof e.purchase_ref === 'string';

const draftPo = async (w, over = {}) => (await w.mk(w.c.createPurchaseOrder, buyer, { supplierId: w.supplier.id, currency: 'USD', expectedDate: '2026-11-20', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: w.itemA.id, qty: 200, quoteId: w.quote.id }], ...over })).purchaseOrder;
const maps = async (w) => ({ supplier: await w.q.supplier(w.supplier.id), items: new Map((await w.q.items()).map((i) => [i.id, i])) });

test('status mapping: a preparation is a plan; a placed order is an order (never a plan), cancelled is neither', async () => {
  assert.deepEqual(PLAN_STATUS_OF, { DRAFT: 'PLANNED', PENDING_APPROVAL: 'PLANNED', APPROVED: 'APPROVED_TO_ORDER' });
  const w = await makeWorld(); const m = await maps(w);
  const po = await draftPo(w);
  const seen = [];
  const plan = (p) => purchasePlanView({ po: p, ...m, approval: null });
  seen.push(plan(po)?.status);                                               // DRAFT
  await w.mk(w.c.submitPurchaseOrder, buyer, { poId: po.id }); seen.push(plan(await w.q.purchaseOrder(po.id))?.status); // PENDING_APPROVAL
  await w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id) });
  const approved = await w.q.purchaseOrder(po.id);
  const ap = { action: 'BUYING.approve_purchase_plan', subject_ref: purchaseRefOf(po), approver: { kind: 'HUMAN', id: 'elidjan', role: 'OWNER' }, approved_at: '2026-10-16T10:00:00Z' };
  seen.push(purchasePlanView({ po: approved, ...m, approval: ap })?.status);  // APPROVED
  await w.mk(w.c.placeOrder, buyer, { poId: po.id, approval: approval('BUYING.place_order', po.id) });
  seen.push(plan(await w.q.purchaseOrder(po.id)));                            // ORDERED: no longer a plan
  assert.deepEqual(seen, ['PLANNED', 'PLANNED', 'APPROVED_TO_ORDER', null]);
});

test('every plan view satisfies the constraints of A\'s purchase-plan table, and its approval is a valid A approval for the same action and subject', async () => {
  const w = await makeWorld(); const m = await maps(w); const po = await draftPo(w);
  assert.ok(PLAN_OK(purchasePlanView({ po, ...m })), 'PLANNED view');
  await w.mk(w.c.submitPurchaseOrder, buyer, { poId: po.id });
  await w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id) });
  const reader = createPlanReader({ queries: w.q });
  const [plan] = await reader.listPlans();
  assert.ok(PLAN_OK(plan), JSON.stringify(plan)); assert.equal(plan.status, 'APPROVED_TO_ORDER'); assert.equal(plan.order_placed, false);
  assert.equal(plan.purchase_ref, purchaseRefOf(po)); assert.equal(plan.qty, 200); assert.equal(plan.eta, '2026-11-20');
  assert.equal(plan.approval.action, 'BUYING.approve_purchase_plan'); assert.equal(plan.approval.subject_ref, plan.purchase_ref);
  assert.equal(validateApproval(plan.approval).ok, true, 'A\'s own validator accepts the approval C recorded');
  assert.equal((await reader.getPlan(plan.purchase_ref)).canonical.id, po.id);
  assert.equal((await reader.getPlan('nordla:purchase:unknown')), null);
});

test('incoming expectations: only goods really ordered and not yet received; never available; A\'s constraints; A\'s id formula for a single-line order', async () => {
  const w = await makeWorld(); const reader = createPlanReader({ queries: w.q });
  const po = await draftPo(w); await w.mk(w.c.submitPurchaseOrder, buyer, { poId: po.id });
  await w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id) });
  assert.deepEqual(await reader.listIncoming(), [], 'approved but not ordered: nothing is incoming yet');
  await w.mk(w.c.placeOrder, buyer, { poId: po.id, approval: approval('BUYING.place_order', po.id) });
  let inc = await reader.listIncoming(); assert.equal(inc.length, 1); assert.ok(INC_OK(inc[0]), JSON.stringify(inc[0])); assert.equal(inc[0].qty, 200);
  // A's real builder applied to an approved plan with the same purchase_ref gives the SAME expectation id
  const aPlan = { ...(await reader.getPlan(purchaseRefOf(po)) ?? { purchase_ref: purchaseRefOf(po) }), status: 'APPROVED_TO_ORDER', product_ref: inc[0].product_ref, supplier_ref: inc[0].supplier_ref, qty: 200, eta: '2026-11-20', destination: { location_ref: 'x' }, unit_cost: null };
  assert.equal(handoffs.buildIncomingExpectation(aPlan).expectation_id, inc[0].expectation_id, 'same id as chantier A computes for the same purchase_ref');
  await receive(w, await w.q.purchaseOrder(po.id), [{ poLineId: 'L1', qtyAccepted: 120 }]);
  inc = await reader.listIncoming(); assert.equal(inc[0].qty, 80); assert.equal(inc[0].procurement_received_qty, 120); assert.equal(inc[0].received_qty, 0); assert.ok(INC_OK(inc[0]));
  await receive(w, await w.q.purchaseOrder(po.id), [{ poLineId: 'L1', qtyAccepted: 80 }]);
  assert.deepEqual(await reader.listIncoming(), [], 'fully received: no longer expected');
  const pos = await w.q.stockPosition(w.itemA.id); assert.equal(pos.incoming.qty, 0); assert.equal(pos.available, 200);
});

test('multi-line orders give one expectation per line with distinct ids; delayed is derived from the date; product filter works', async () => {
  const w = await makeWorld(); const reader = createPlanReader({ queries: w.q });
  const q2 = (await w.mk(w.c.recordQuote, buyer, { supplierId: w.supplier.id, itemId: w.itemB.id, currency: 'USD', tiers: [{ minQty: 10, unitPrice: '0.9' }] })).quote;
  const po = await draftPo(w, { expectedDate: '2026-01-05', lines: [{ itemId: w.itemA.id, qty: 200, quoteId: w.quote.id }, { itemId: w.itemB.id, qty: 30, quoteId: q2.id }] });
  await w.mk(w.c.submitPurchaseOrder, buyer, { poId: po.id });
  await w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id) });
  await w.mk(w.c.placeOrder, buyer, { poId: po.id, approval: approval('BUYING.place_order', po.id) });
  const inc = await reader.listIncoming(); assert.equal(inc.length, 2); assert.equal(new Set(inc.map((e) => e.expectation_id)).size, 2);
  assert.ok(inc.every(INC_OK)); assert.ok(inc.every((e) => e.delayed === true), 'the date 2026-01-05 is in the past');
  const [only] = await reader.listIncoming(productRefOf(w.itemB)); assert.equal(only.qty, 30);
});

test('a PROSPECT imported from China Sourcing keeps the product and case references A uses', async () => {
  const w = await makeWorld();
  const imp = await importSourcingCase({ commands: w.c, queries: w.q, actor: buyer, caseState: { schema: 2, id: 'case-abc', identity: { workingName: 'Keychain', photos: [] }, supplier: { name: 'Yiwu Co' }, quotes: [{ at: 't', currency: 'USD', unitPrice: '0.1', moq: 100 }] } });
  const item = await w.q.item(imp.item.id);
  assert.equal(productRefOf(item), 'nordla:product:prospect-case-abc', 'the ref buildBuyingHandoff gives the same prospect');
  const supplier = await w.q.supplier(imp.supplier.id); const po = (await w.mk(w.c.createPurchaseOrder, buyer, { supplierId: supplier.id, currency: 'USD', expectedDate: '2026-12-01', destinationLocationId: w.locs.warehouse.id, lines: [{ itemId: item.id, qty: 100, unitPrice: '0.1' }] })).purchaseOrder;
  const plan = purchasePlanView({ po, supplier, items: new Map([[item.id, item]]) });
  assert.equal(plan.sourcing_case_ref, 'nordla:sourcing_case:case-abc'); assert.equal(plan.product_ref, 'nordla:product:prospect-case-abc'); assert.ok(PLAN_OK(plan));
});

test('through the hub: read-only commands, policy READ_ONLY, traced; they change nothing', async () => {
  const w = await makeWorld(); const po = await orderedPo(w, { qty: 200 }); await receive(w, po, [{ poLineId: 'L1', qtyAccepted: 50 }]);
  const before = JSON.stringify(await w.store.snapshot());
  const integ = createIntegration({ tenant_id: '00000000-0000-0000-0000-0000000000f2', procurement: { assistant: w.proc.assistant, planReader: createPlanReader({ queries: w.q }) } });
  const inc = await integ.call(M.STOCK_SALES, 'proc_incoming_expectations', {}, { workflow_id: 'c1', initiated_by: 't' });
  assert.equal(inc.ok, true); assert.equal(inc.level, 'READ_ONLY'); assert.equal(inc.result.incoming[0].qty, 150);
  const plans = await integ.call(M.BUYING, 'proc_purchase_plans', {}, { workflow_id: 'c2', initiated_by: 't' });
  assert.equal(plans.ok, true); assert.deepEqual(plans.result.plans, [], 'the order is placed: it is not a plan any more');
  assert.equal(JSON.stringify(await w.store.snapshot()), before);
  assert.equal(integ.ledger.list().length, 2); assert.equal(integ.ledger.verify().ok, true);
  // without a reader the commands do not exist (opt-in)
  const bare = createIntegration({ tenant_id: '00000000-0000-0000-0000-0000000000f3', procurement: w.proc.assistant });
  assert.equal((await bare.call(M.BUYING, 'proc_purchase_plans', {}, { workflow_id: 'c3' })).status, 'COMMAND_NOT_AVAILABLE');
  assert.ok(INCOMING_STATUSES.includes('ORDERED') && key);
});

test('NO DOUBLE COUNTING: at every status an order is exactly one of {plan, incoming expectation, neither}; incoming views always sum to the stock position\'s incoming', async () => {
  const w = await makeWorld(); const reader = createPlanReader({ queries: w.q });
  const po = await draftPo(w);
  const state = async (label) => {
    const plans = await reader.listPlans(); const inc = await reader.listIncoming(w.itemA && productRefOf(w.itemA));
    const asPlan = plans.filter((p) => p.purchase_ref === purchaseRefOf(po)).length; const asInc = inc.filter((e) => e.purchase_ref === purchaseRefOf(po)).length;
    assert.ok(asPlan + asInc <= 1, `${label}: the same order is both a plan and an incoming expectation`);
    const pos = await w.q.stockPosition(w.itemA.id);
    assert.equal(inc.reduce((n, e) => n + e.qty, 0), pos.incoming.qty, `${label}: incoming views must equal the stock position's incoming`);
    assert.ok(inc.every((e) => e.counted_in_available === false), `${label}: incoming is never available`);
    return asPlan ? 'PLAN' : asInc ? 'INCOMING' : 'NEITHER';
  };
  const seen = [await state('DRAFT')];
  await w.mk(w.c.submitPurchaseOrder, buyer, { poId: po.id }); seen.push(await state('PENDING'));
  await w.mk(w.c.approvePurchaseOrder, buyer, { poId: po.id, approval: approval('BUYING.approve_purchase_plan', po.id) }); seen.push(await state('APPROVED'));
  await w.mk(w.c.placeOrder, buyer, { poId: po.id, approval: approval('BUYING.place_order', po.id) }); seen.push(await state('ORDERED'));
  await receive(w, await w.q.purchaseOrder(po.id), [{ poLineId: 'L1', qtyAccepted: 120 }]); seen.push(await state('PARTIAL'));
  await receive(w, await w.q.purchaseOrder(po.id), [{ poLineId: 'L1', qtyAccepted: 80 }]); seen.push(await state('RECEIVED'));
  assert.deepEqual(seen, ['PLAN', 'PLAN', 'PLAN', 'INCOMING', 'INCOMING', 'NEITHER']);
  assert.equal((await w.q.stockPosition(w.itemA.id)).available, 200, 'the goods are counted once: on hand, not also expected');
  // a cancelled order is neither
  const c = await draftPo(w); await w.mk(w.c.cancelPurchaseOrder, buyer, { poId: c.id, reason: 'test' });
  assert.equal((await reader.listPlans()).filter((p) => p.purchase_ref === purchaseRefOf(c)).length, 0); assert.equal((await reader.listIncoming()).filter((e) => e.purchase_ref === purchaseRefOf(c)).length, 0);
});
