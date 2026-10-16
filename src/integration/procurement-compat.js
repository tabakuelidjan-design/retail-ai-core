// Compatibility views between the integration objects of chantier A (PurchasePlan, IncomingExpectation, BUY_CANDIDATE references) and the persistent entities of
// chantier C (PurchaseOrder, order lines, quotes). ONE source of truth: the purchase order in src/procurement. These functions are PURE READERS: they build the
// objects A's code and A's pending tables expect FROM a purchase order, so nothing is stored twice and nothing here can write.
//
//   A: PurchasePlan   PLANNED -> APPROVED_TO_ORDER     (a preparation: order_placed is always false)
//   C: PurchaseOrder  DRAFT -> PENDING_APPROVAL -> APPROVED -> ORDERED -> CONFIRMED -> PARTIALLY_RECEIVED -> RECEIVED -> CLOSED | CANCELLED
//   => a purchase order that is still a PREPARATION (DRAFT, PENDING_APPROVAL, APPROVED) IS a purchase plan; from ORDERED on it is an order, no longer a plan.
//   A: IncomingExpectation  EXPECTED, created once a plan is approved, received_qty = 0 always
//   C: incoming = quantity ordered and not yet received, on orders that were really PLACED (ORDERED, CONFIRMED, PARTIALLY_RECEIVED). An approved-but-not-ordered
//      plan is not "incoming" (nothing was ordered). It never counts as available (counted_in_available: false), exactly as in A.
//
// Identifiers are the ones both sides already use: purchase_ref = nordla:purchase:<po.id> (the subject of BUYING.approve_purchase_plan), expectation_id = inc_<hash of
// the purchase_ref> (the formula of src/integration/handoffs.js), product_ref = nordla:product:<item id> or the PROSPECT ref of the Sourcing case (nordla:product:prospect-<case>).
import { createHash } from 'node:crypto';
import { ref } from './ids.js';
import { ID_KIND as K } from './constants.js';
import { deepFreeze } from './constants.js';

const hid = (prefix, body) => `${prefix}_${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12)}`; // same formula as handoffs.js

/** C status -> A plan status; null = no longer a plan. */
export const PLAN_STATUS_OF = Object.freeze({ DRAFT: 'PLANNED', PENDING_APPROVAL: 'PLANNED', APPROVED: 'APPROVED_TO_ORDER' });
export const INCOMING_STATUSES = Object.freeze(['ORDERED', 'CONFIRMED', 'PARTIALLY_RECEIVED']);

export const purchaseRefOf = (po) => ref(K.PURCHASE, po.id);
export const supplierRefOf = (supplier) => ref(K.SUPPLIER, supplier.id);
/** A PROSPECT item imported from China Sourcing (SKU SRC-<case id>) keeps the reference A's handoff uses; every other item is nordla:product:<item id>. */
export const productRefOf = (item) => (item.sku?.startsWith('SRC-') && item.status === 'PROSPECT' ? ref(K.PRODUCT, `prospect-${item.sku.slice(4)}`) : ref(K.PRODUCT, item.id));
export const sourcingCaseRefOf = (item) => (item.sku?.startsWith('SRC-') ? ref(K.SOURCING_CASE, item.sku.slice(4)) : null);

/**
 * A PurchasePlan, as chantier A's pending table (integration_purchase_plans) and handoffs.js model it, built from a purchase order that is still a preparation.
 * @param {{ po: object, supplier: object, items: Map<string, object>, approval?: object|null }} a   approval = the consumed approval record of BUYING.approve_purchase_plan, if any
 * @returns {object|null} null when the order is already placed (it is an order, not a plan) or cancelled
 */
export function purchasePlanView({ po, supplier, items, approval = null }) {
  const status = PLAN_STATUS_OF[po.status];
  if (!status) return null;
  const first = po.lines[0]; const item = items.get(first.itemId);
  const qty = po.lines.reduce((s, l) => s + l.qty, 0);
  return deepFreeze({
    purchase_ref: purchaseRefOf(po), handoff_id: null, // a plan born in Procurement has no Sourcing handoff; the case link is sourcing_case_ref
    sourcing_case_ref: item ? sourcingCaseRefOf(item) : null, product_ref: item ? productRefOf(item) : null, supplier_ref: supplierRefOf(supplier),
    status, owner_review: status === 'APPROVED_TO_ORDER' ? 'APPROVED' : 'PENDING', qty, eta: po.expectedDate, order_placed: false,
    approval: status === 'APPROVED_TO_ORDER' ? approval : null,
    body: { source: 'procurement', purchase_order_id: po.id, number: po.number, currency: po.currency, total_minor: po.totalMinor, lines: po.lines.map((l) => ({ line_id: l.id, item_id: l.itemId, qty: l.qty, unit_price_micro: l.unitPriceMicro })) },
    canonical: { entity: 'PurchaseOrder', id: po.id, status: po.status, version: po.version },
  });
}

/** The IncomingExpectations of ONE placed order: one per line with something still outstanding. */
export function incomingExpectationViews({ po, supplier, items }) {
  if (!INCOMING_STATUSES.includes(po.status)) return [];
  const purchase_ref = purchaseRefOf(po);
  return po.lines.filter((l) => l.qty > l.qtyReceived).map((l) => {
    const item = items.get(l.itemId);
    return deepFreeze({
      // a single-line order uses exactly A's formula (hash of the purchase_ref); a multi-line order adds the line so each expectation has its own id
      expectation_id: hid('inc', { p: po.lines.length === 1 ? purchase_ref : `${purchase_ref}#${l.id}` }), purchase_ref, product_ref: item ? productRefOf(item) : null, supplier_ref: supplierRefOf(supplier),
      qty: l.qty - l.qtyReceived, eta: po.expectedDate, state: 'EXPECTED', counted_in_available: false,
      received_qty: 0, // A's table pins received_qty = 0 (its phase has no receipts): the outstanding quantity is `qty`; what already arrived is in `procurement_received_qty`
      procurement_received_qty: l.qtyReceived, ordered_qty: l.qty, delayed: false,
      canonical: { entity: 'PurchaseOrderLine', purchase_order_id: po.id, line_id: l.id },
    });
  });
}

/**
 * Read-only access for the integration layer, over a procurement instance ({ queries }).
 * `approvalOf(po)` is optional: the journal event PO_APPROVED carries the consumed approval, so a plan view can show who approved it without a second store.
 */
export function createPlanReader({ queries }) {
  const maps = async () => ({ suppliers: new Map((await queries.suppliers()).map((s) => [s.id, s])), items: new Map((await queries.items()).map((i) => [i.id, i])) });
  const approvalOf = async (po) => {
    const e = (await queries.events({ objectId: po.id })).find((x) => x.type === 'PO_APPROVED');
    return e?.approval ? { action: e.approval.action, subject_ref: e.approval.subjectRef, approver: { kind: 'HUMAN', id: e.approval.approverId }, approved_at: e.at, separation_waived: Boolean(e.approval.separationWaived) } : null;
  };
  return Object.freeze({
    async listPlans() {
      const { suppliers, items } = await maps(); const out = [];
      for (const po of await queries.purchaseOrders()) { const s = suppliers.get(po.supplierId); const v = s ? purchasePlanView({ po, supplier: s, items, approval: po.status === 'APPROVED' ? await approvalOf(po) : null }) : null; if (v) out.push(v); }
      return out;
    },
    async getPlan(purchaseRef) { return (await this.listPlans()).find((p) => p.purchase_ref === purchaseRef) ?? null; },
    async listIncoming(productRef = null) {
      const { suppliers, items } = await maps(); const today = new Date().toISOString().slice(0, 10); const out = [];
      for (const po of await queries.purchaseOrders()) { const s = suppliers.get(po.supplierId); if (!s) continue; for (const e of incomingExpectationViews({ po, supplier: s, items })) if (!productRef || e.product_ref === productRef) out.push({ ...e, delayed: e.eta < today }); }
      return out;
    },
  });
}
