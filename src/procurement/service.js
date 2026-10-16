// Stock / Achats command service (WRITE side). Every command: validates its input, checks the actor's role, is idempotent (key + payload fingerprint),
// runs in ONE store transaction (all or nothing), consumes single-use human approvals for consequential steps, and leaves an audit event.
//
// What it never does: contact a supplier, pay, write to Shopify, or act on anything but an explicit, validated command. `ORDERED` records that a named human
// placed the order elsewhere; deposits are a schedule linked to a Finance payment reference (paying stays in Finance, FINANCE.pay_supplier).
import { fail, ProcurementError, StoreError } from './errors.js';
import {
  reqId, supplierKeyOf, reqStr, optStr, reqInt, optInt, reqEnum, reqCurrency, reqDate, optDate, microOf, lineTotalMinor, pctToBps, shareMinor, reqFx, microToEurMicro, fingerprint, deepFreeze,
} from './util.js';
import { LOCATION_TYPES, SELLABLE_TYPES, assertPostable } from './stock.js';
import { authorize } from '../integration/approval.js';
import { ref } from '../integration/ids.js';
import { ID_KIND as K } from '../integration/constants.js';

/**
 * Separation of duties. For these actions the human who APPROVES cannot be the person who PREPARED the thing (creator / submitter of an order, the actor who
 * posts an adjustment or a count). A single-person business can opt out explicitly with `soloOwner: { ownerIds, reason }`: the approval then goes through,
 * is flagged `separationWaived` in the journal, and nothing is waived silently.
 */
export const DEFAULT_POLICY = Object.freeze({ separation: Object.freeze({ 'BUYING.approve_purchase_plan': true, 'STOCK_SALES.adjust_on_hand': true }), soloOwner: null });

export const ROLES = ['OWNER', 'BUYER', 'WAREHOUSE', 'VIEWER'];
export const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];
export const PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ORDERED', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'];
/** The only legal moves. Anything else is refused with INVALID_TRANSITION. */
export const PO_TRANSITIONS = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'], PENDING_APPROVAL: ['APPROVED', 'DRAFT', 'CANCELLED'], APPROVED: ['ORDERED', 'CANCELLED'],
  ORDERED: ['CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'], CONFIRMED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'], RECEIVED: ['CLOSED'], CLOSED: [], CANCELLED: [],
};
export const DOCUMENT_TYPES = ['CERTIFICATE', 'CONTRACT', 'PRICE_LIST', 'INSURANCE', 'OTHER'];
/** Photos / documents are REFERENCES (a storage path or URL, optionally a hash): this module stores no file content. */
function attachmentsOf(list, name = 'attachments') {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 20) fail('INVALID_INPUT', `${name} must hold at most 20 entries`);
  return list.map((a, i) => ({
    kind: reqEnum(a.kind, `${name}[${i}].kind`, ['PHOTO', 'DOCUMENT']), ref: reqStr(a.ref, `${name}[${i}].ref`, { max: 300 }),
    sha256: a.sha256 === undefined || a.sha256 === null ? null : (/^[0-9a-f]{64}$/.test(a.sha256) ? a.sha256 : fail('INVALID_INPUT', `${name}[${i}].sha256 must be 64 hex characters`)),
    note: optStr(a.note, `${name}[${i}].note`, { max: 300 }),
  }));
}
export const QUOTE_ORIGINS = ['SUPPLIER_CLAIM', 'USER_PROVIDED', 'DOCUMENT_OBSERVED'];
const PERMISSION = {
  createItem: ['OWNER', 'BUYER'], updateItem: ['OWNER', 'BUYER'], createLocation: ['OWNER', 'WAREHOUSE'], createSupplier: ['OWNER', 'BUYER'], linkSupplierItem: ['OWNER', 'BUYER'],
  recordQuote: ['OWNER', 'BUYER'], selectQuote: ['OWNER', 'BUYER'], createPurchaseOrder: ['OWNER', 'BUYER'], submitPurchaseOrder: ['OWNER', 'BUYER'], rejectPurchaseOrder: ['OWNER'],
  approvePurchaseOrder: ['OWNER', 'BUYER'], placeOrder: ['OWNER', 'BUYER'], confirmOrder: ['OWNER', 'BUYER'], cancelPurchaseOrder: ['OWNER', 'BUYER'], linkPayment: ['OWNER', 'BUYER'],
  closePurchaseOrder: ['OWNER', 'BUYER'], receiveGoods: ['OWNER', 'WAREHOUSE'], adjustStock: ['OWNER', 'WAREHOUSE'], transferStock: ['OWNER', 'WAREHOUSE'],
  quarantineDefect: ['OWNER', 'WAREHOUSE'], recordCount: ['OWNER', 'WAREHOUSE'], reserveStock: ['OWNER', 'WAREHOUSE'], releaseStock: ['OWNER', 'WAREHOUSE'],
  recordIncident: ['OWNER', 'BUYER', 'WAREHOUSE'], addSupplierDocument: ['OWNER', 'BUYER'], startVisit: ['OWNER', 'BUYER'], captureProduct: ['OWNER', 'BUYER'], closeVisit: ['OWNER', 'BUYER'],
};

/**
 * @param {{ store: object, merchantId: string, now?: () => string, audit?: (event: object) => (void|Promise<void>) }} deps
 */
export function createProcurementService({ store, merchantId, now = () => new Date().toISOString(), audit = async () => {}, retryDelayMs = 25, policy = DEFAULT_POLICY }) {
  reqId(merchantId, 'merchantId');

  // ------------------------------------------------------------------ plumbing
  const mapStoreError = (e) => (e instanceof StoreError ? new ProcurementError(e.code, e.message, e.detail) : e);

  async function command(name, actor, idempotencyKey, payload, handler) {
    if (!actor || !isActor(actor)) fail('ACTOR_REQUIRED', 'a named actor { id, role } is required');
    if (!PERMISSION[name].includes(actor.role)) fail('FORBIDDEN', `role ${actor.role} cannot ${name}`, { command: name, role: actor.role });
    reqId(idempotencyKey, 'idempotencyKey');
    // the moment an approval was stamped is not part of the request: retrying the same approval later is the SAME request
    const fp = fingerprint({ name, payload: payload?.approval ? { ...payload, approval: { ...payload.approval, approved_at: undefined } } : payload });
    let out;
    // A transient store failure (connection lost, deadlock, serialization failure) is retried with the SAME idempotency key: if the first attempt had in fact
    // committed (commit acknowledged lost), the retry finds the stored result and replays it; otherwise it runs once. Never a double effect.
    for (let attempt = 0; ; attempt += 1) {
      try {
        out = await runOnce();
        break;
      } catch (e) {
        if (!(e instanceof StoreError && (e.code === 'STORE_UNAVAILABLE' || e.code === 'STORE_RETRYABLE')) || attempt >= 2) throw mapStoreError(e);
        await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
      }
    }
    const { _events: events = [], ...result } = out;
    for (const e of events) { try { await audit(e); } catch { /* the journal in the store is the record; a failing mirror never undoes a committed command */ } }
    return deepFreeze(result);

    async function runOnce() {
      return store.transaction(async (tx) => {
        const prior = await tx.getIdem(merchantId, idempotencyKey);
        if (prior) {
          if (prior.fingerprint !== fp) fail('IDEMPOTENCY_KEY_REUSED', 'this idempotency key was used for a different request', { idempotencyKey });
          return { ...prior.result, replayed: true };
        }
        const ctx = { tx, actor, at: now(), key: idempotencyKey, seq: 0, events: [] };
        const result = await handler(ctx);
        await tx.putIdem(merchantId, idempotencyKey, { fingerprint: fp, command: name, result });
        for (const e of ctx.events) await tx.appendEvent(e);
        return { ...result, replayed: false, _events: ctx.events };
      });
    }
  }
  const isActor = (a) => typeof a.id === 'string' && a.id.length > 0 && ROLES.includes(a.role);

  function emit(ctx, type, object, detail = {}, approval = null) {
    ctx.events.push({ id: store.newId(), merchantId, at: ctx.at, type, actor: { id: ctx.actor.id, role: ctx.actor.role }, object, approval, detail, idempotencyKey: ctx.key });
  }

  async function requireApproval(ctx, action, subjectRef, approval, makers = []) {
    if (!approval || typeof approval !== 'object') fail('APPROVAL_REQUIRED', `${action} needs a named human approval for ${subjectRef}`, { action, subject_ref: subjectRef });
    reqId(approval.id, 'approval.id');
    const d = authorize(action, { approvals: [approval], subject_ref: subjectRef });
    if (d.decision !== 'ALLOW') fail(d.code ?? 'APPROVAL_REQUIRED', d.reason, { action, subject_ref: subjectRef });
    let separationWaived = false;
    if (policy.separation?.[action] && makers.filter(Boolean).includes(approval.approver.id)) {
      const solo = policy.soloOwner;
      if (solo && solo.ownerIds.includes(approval.approver.id) && approval.approver.role === 'OWNER') separationWaived = true;
      else fail('SEPARATION_OF_DUTIES', `${approval.approver.id} prepared this and cannot approve it: another authorized person must`, { action, subject_ref: subjectRef });
    }
    await ctx.tx.consumeApproval(merchantId, approval.id);
    return { id: approval.id, approverId: approval.approver.id, action, subjectRef, separationWaived };
  }

  const must = async (ctx, coll, id, code) => (await ctx.tx.get(coll, merchantId, id)) ?? fail(code, `${coll} ${id} not found`, { id });
  const poRefOf = (po) => ref(K.PURCHASE, po.id);

  async function postMovement(ctx, movement) {
    const m = { ...movement, bucket: movement.bucket ?? 'ON_HAND' }; // the invariant check must see the bucket that will really be written
    const item = await must(ctx, 'items', m.itemId, 'ITEM_NOT_FOUND');
    if (item.status === 'ARCHIVED') fail('ITEM_ARCHIVED', `item ${item.sku} is archived`);
    await must(ctx, 'locations', m.locationId, 'LOCATION_NOT_FOUND');
    const current = await ctx.tx.balanceOf(merchantId, m.itemId, m.locationId);
    assertPostable(current, m);
    return ctx.tx.appendMovement({
      id: store.newId(), merchantId, idempotencyKey: `${ctx.key}#${ctx.seq++}`, groupId: m.groupId ?? null, at: ctx.at, itemId: m.itemId, locationId: m.locationId,
      bucket: m.bucket, delta: m.delta, kind: m.kind, reason: m.reason ?? null, reference: m.reference ?? null,
      costStatus: m.costStatus ?? 'UNKNOWN', unitCostEurMicro: m.unitCostEurMicro ?? null, actorId: ctx.actor.id, approvalId: m.approvalId ?? null,
    });
  }

  async function transition(ctx, po, to, patch = {}) {
    if (!PO_TRANSITIONS[po.status].includes(to)) fail('INVALID_TRANSITION', `a ${po.status} purchase order cannot become ${to}`, { from: po.status, to });
    return ctx.tx.update('purchaseOrders', merchantId, po.id, { ...patch, status: to }, po.version);
  }
  const poSummary = (po) => ({ id: po.id, number: po.number, status: po.status, version: po.version, totalMinor: po.totalMinor, currency: po.currency });

  async function createItemIn(ctx, p) {
    const row = {
      id: store.newId(), merchantId, sku: reqStr(p.sku, 'sku', { max: 64 }), name: reqStr(p.name, 'name', { max: 200 }), barcode: optStr(p.barcode, 'barcode', { max: 32 }),
      variantRef: optStr(p.variantRef, 'variantRef', { max: 128 }), status: reqEnum(p.status ?? 'ACTIVE', 'status', ['PROSPECT', 'ACTIVE']),
      reorderPoint: optInt(p.reorderPoint, 'reorderPoint', { min: 0 }), reorderQty: optInt(p.reorderQty, 'reorderQty'), attachments: attachmentsOf(p.attachments), createdAt: ctx.at,
    };
    const item = await ctx.tx.insert('items', row);
    emit(ctx, 'ITEM_CREATED', { kind: 'item', id: item.id }, { sku: item.sku });
    return { item };
  }

  async function createSupplierIn(ctx, p) {
    const dep = p.payment?.depositPct !== undefined ? pctToBps(p.payment.depositPct, 'payment.depositPct') : null;
    const bal = p.payment?.balancePct !== undefined ? pctToBps(p.payment.balancePct, 'payment.balancePct') : null;
    if (dep !== null && bal !== null && dep + bal !== 10000) fail('INVALID_INPUT', 'deposit and balance must add up to 100%');
    const row = {
      id: store.newId(), merchantId, name: reqStr(p.name, 'name', { max: 200 }), country: p.country === undefined ? null : reqStr(p.country, 'country', { min: 2, max: 2 }).toUpperCase(),
      currency: reqCurrency(p.currency), incotermDefault: p.incotermDefault === undefined ? null : reqEnum(p.incotermDefault, 'incotermDefault', INCOTERMS),
      depositBps: dep ?? (bal !== null ? 10000 - bal : null), leadTimeDays: optInt(p.leadTimeDays, 'leadTimeDays', { max: 730 }),
      financeCompanyId: optStr(p.financeCompanyId, 'financeCompanyId', { max: 64 }), contacts: (p.contacts ?? []).slice(0, 20).map((c) => ({ name: reqStr(c.name, 'contact.name', { max: 120 }), email: optStr(c.email, 'contact.email', { max: 160 }), phone: optStr(c.phone, 'contact.phone', { max: 40 }) })),
      documents: [], status: 'ACTIVE', createdAt: ctx.at,
    };
    const supplier = await ctx.tx.insert('suppliers', row);
    emit(ctx, 'SUPPLIER_CREATED', { kind: 'supplier', id: supplier.id }, { name: supplier.name });
    return { supplier };
  }

  async function recordQuoteIn(ctx, p) {
    const supplier = await must(ctx, 'suppliers', reqId(p.supplierId, 'supplierId'), 'SUPPLIER_NOT_FOUND');
    const item = await must(ctx, 'items', reqId(p.itemId, 'itemId'), 'ITEM_NOT_FOUND');
    if (!Array.isArray(p.tiers) || !p.tiers.length || p.tiers.length > 20) fail('INVALID_INPUT', 'tiers must hold 1-20 entries');
    const tiers = p.tiers.map((t, i) => ({ minQty: reqInt(t.minQty, `tiers[${i}].minQty`), unitPriceMicro: microOf(t.unitPrice, `tiers[${i}].unitPrice`) }));
    tiers.forEach((t, i) => {
      if (i && t.minQty <= tiers[i - 1].minQty) fail('TIER_ORDER', 'tier quantities must strictly increase');
      if (i && t.unitPriceMicro > tiers[i - 1].unitPriceMicro) fail('TIER_PRICE_INCREASES', 'a higher tier cannot cost more per unit than a lower tier');
    });
    const all = (await ctx.tx.list('quotes', merchantId)).filter((q) => q.supplierId === supplier.id && q.itemId === item.id);
    const revision = all.reduce((m, q) => Math.max(m, q.revision), 0) + 1;
    for (const q of all) if (q.status === 'RECEIVED' || q.status === 'SELECTED') await ctx.tx.update('quotes', merchantId, q.id, { status: 'SUPERSEDED' });
    const quote = await ctx.tx.insert('quotes', {
      id: store.newId(), merchantId, supplierId: supplier.id, itemId: item.id, revision, currency: reqCurrency(p.currency), tiers, moq: optInt(p.moq, 'moq'),
      incoterm: p.incoterm === undefined ? null : reqEnum(p.incoterm, 'incoterm', INCOTERMS), leadTimeDays: optInt(p.leadTimeDays, 'leadTimeDays', { max: 730 }),
      validUntil: optDate(p.validUntil, 'validUntil'), status: 'RECEIVED', provenance: reqEnum(p.provenance ?? 'SUPPLIER_CLAIM', 'provenance', QUOTE_ORIGINS),
      reason: optStr(p.reason, 'reason', { max: 300 }), evidence: attachmentsOf(p.evidence, 'evidence'), recordedBy: ctx.actor.id, createdAt: ctx.at,
    });
    emit(ctx, 'QUOTE_RECORDED', { kind: 'quote', id: quote.id }, { supplierId: supplier.id, itemId: item.id, revision, supersededRevisions: all.length });
    return { quote };
  }

  const cmd = {
    // ---------------------------------------------------------------- catalogue
    createItem: (actor, key, p) => command('createItem', actor, key, p, (ctx) => createItemIn(ctx, p)),
    updateItem: (actor, key, p) => command('updateItem', actor, key, p, async (ctx) => {
      const item = await must(ctx, 'items', reqId(p.itemId, 'itemId'), 'ITEM_NOT_FOUND');
      const q = p.patch ?? {}; const patch = {};
      if (q.name !== undefined) patch.name = reqStr(q.name, 'name', { max: 200 });
      if (q.status !== undefined) patch.status = reqEnum(q.status, 'status', ['PROSPECT', 'ACTIVE', 'ARCHIVED']);
      if (q.reorderPoint !== undefined) patch.reorderPoint = optInt(q.reorderPoint, 'reorderPoint', { min: 0 });
      if (q.reorderQty !== undefined) patch.reorderQty = optInt(q.reorderQty, 'reorderQty');
      if (q.attachments !== undefined) patch.attachments = attachmentsOf(q.attachments);
      if (q.barcode !== undefined) patch.barcode = optStr(q.barcode, 'barcode', { max: 32 });
      if (!Object.keys(patch).length) fail('INVALID_INPUT', 'nothing to update');
      const next = await ctx.tx.update('items', merchantId, item.id, patch, optInt(p.expectedVersion, 'expectedVersion') ?? item.version);
      emit(ctx, 'ITEM_UPDATED', { kind: 'item', id: item.id }, { fields: Object.keys(patch) });
      return { item: next };
    }),
    createLocation: (actor, key, p) => command('createLocation', actor, key, p, async (ctx) => {
      const location = await ctx.tx.insert('locations', { id: store.newId(), merchantId, name: reqStr(p.name, 'name', { max: 100 }), type: reqEnum(p.type, 'type', LOCATION_TYPES), createdAt: ctx.at });
      emit(ctx, 'LOCATION_CREATED', { kind: 'location', id: location.id }, { type: location.type });
      return { location };
    }),

    // ---------------------------------------------------------------- suppliers
    createSupplier: (actor, key, p) => command('createSupplier', actor, key, p, (ctx) => createSupplierIn(ctx, p)),
    linkSupplierItem: (actor, key, p) => command('linkSupplierItem', actor, key, p, async (ctx) => {
      const supplier = await must(ctx, 'suppliers', reqId(p.supplierId, 'supplierId'), 'SUPPLIER_NOT_FOUND');
      const item = await must(ctx, 'items', reqId(p.itemId, 'itemId'), 'ITEM_NOT_FOUND');
      const link = await ctx.tx.insert('supplierItems', { id: store.newId(), merchantId, supplierId: supplier.id, itemId: item.id, supplierSku: optStr(p.supplierSku, 'supplierSku', { max: 64 }), moq: optInt(p.moq, 'moq'), leadTimeDays: optInt(p.leadTimeDays, 'leadTimeDays', { max: 730 }), createdAt: ctx.at });
      emit(ctx, 'SUPPLIER_ITEM_LINKED', { kind: 'supplier_item', id: link.id }, { supplierId: supplier.id, itemId: item.id });
      return { link };
    }),

    // ---------------------------------------------------------------- quotes (every revision is kept = the negotiated-price history)
    recordQuote: (actor, key, p) => command('recordQuote', actor, key, p, (ctx) => recordQuoteIn(ctx, p)),
    selectQuote: (actor, key, p) => command('selectQuote', actor, key, p, async (ctx) => {
      const quote = await must(ctx, 'quotes', reqId(p.quoteId, 'quoteId'), 'QUOTE_NOT_FOUND');
      if (quote.status !== 'RECEIVED') fail('QUOTE_NOT_SELECTABLE', `a ${quote.status} quote cannot be selected`);
      if (quote.validUntil && quote.validUntil < ctx.at.slice(0, 10)) fail('QUOTE_EXPIRED', `quote expired on ${quote.validUntil}`);
      for (const q of await ctx.tx.list('quotes', merchantId)) if (q.itemId === quote.itemId && q.status === 'SELECTED') await ctx.tx.update('quotes', merchantId, q.id, { status: 'RECEIVED' });
      const next = await ctx.tx.update('quotes', merchantId, quote.id, { status: 'SELECTED' });
      emit(ctx, 'QUOTE_SELECTED', { kind: 'quote', id: quote.id }, { supplierId: quote.supplierId, itemId: quote.itemId });
      return { quote: next };
    }),

    // ---------------------------------------------------------------- purchase orders
    createPurchaseOrder: (actor, key, p) => command('createPurchaseOrder', actor, key, p, async (ctx) => {
      const supplier = await must(ctx, 'suppliers', reqId(p.supplierId, 'supplierId'), 'SUPPLIER_NOT_FOUND');
      if (supplier.status !== 'ACTIVE') fail('SUPPLIER_INACTIVE', 'the supplier is not active');
      const currency = reqCurrency(p.currency);
      const dest = await must(ctx, 'locations', reqId(p.destinationLocationId, 'destinationLocationId'), 'LOCATION_NOT_FOUND');
      if (!SELLABLE_TYPES.has(dest.type)) fail('INVALID_DESTINATION', 'goods are delivered to a store, back room or warehouse');
      const expectedDate = reqDate(p.expectedDate, 'expectedDate');
      if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 200) fail('INVALID_INPUT', 'a purchase order holds 1-200 lines');
      const seen = new Set(); const lines = [];
      for (const [i, l] of p.lines.entries()) {
        const itemId = reqId(l.itemId, `lines[${i}].itemId`); const qty = reqInt(l.qty, `lines[${i}].qty`);
        if (seen.has(itemId)) fail('DUPLICATE_LINE', `item ${itemId} appears twice`); seen.add(itemId);
        await must(ctx, 'items', itemId, 'ITEM_NOT_FOUND');
        let unitPriceMicro; let quoteId = null; let priceSource;
        if (l.quoteId !== undefined) {
          if (l.unitPrice !== undefined) fail('INVALID_INPUT', `lines[${i}]: give a quote OR a manual unit price, not both`);
          const q = await must(ctx, 'quotes', reqId(l.quoteId, `lines[${i}].quoteId`), 'QUOTE_NOT_FOUND');
          if (q.supplierId !== supplier.id || q.itemId !== itemId) fail('QUOTE_MISMATCH', 'the quote is for another supplier or item');
          if (!['RECEIVED', 'SELECTED'].includes(q.status)) fail('QUOTE_NOT_USABLE', `quote is ${q.status}`);
          if (q.validUntil && q.validUntil < ctx.at.slice(0, 10)) fail('QUOTE_EXPIRED', `quote expired on ${q.validUntil}`);
          if (q.currency !== currency) fail('CURRENCY_CONFLICT', `quote is in ${q.currency}, the order in ${currency}`);
          unitPriceMicro = resolveTierPrice(q, qty); quoteId = q.id; priceSource = 'QUOTE';
        } else { unitPriceMicro = microOf(l.unitPrice, `lines[${i}].unitPrice`); priceSource = 'MANUAL'; }
        lines.push({ id: `L${i + 1}`, itemId, qty, unitPriceMicro, totalMinor: lineTotalMinor(qty, unitPriceMicro), quoteId, priceSource, qtyReceived: 0, qtyDefective: 0 });
      }
      const fx = currency === 'EUR' ? null : p.fx === undefined ? null : reqFx(p.fx, currency);
      const totalMinor = lines.reduce((s, l) => s + l.totalMinor, 0);
      const depositBps = p.depositPct !== undefined ? pctToBps(p.depositPct, 'depositPct') : (supplier.depositBps ?? 0);
      const depositMinor = shareMinor(totalMinor, depositBps);
      const schedule = [];
      if (depositMinor > 0) schedule.push({ kind: 'DEPOSIT', amountMinor: depositMinor, dueEvent: 'ON_ORDER', status: 'PLANNED', paymentRef: null, paidAmountMinor: null });
      schedule.push({ kind: 'BALANCE', amountMinor: totalMinor - depositMinor, dueEvent: 'ON_RECEIPT', status: 'PLANNED', paymentRef: null, paidAmountMinor: null });
      const number = `PO-${ctx.at.slice(0, 4)}-${String(await ctx.tx.nextSeq(merchantId, `po-${ctx.at.slice(0, 4)}`)).padStart(4, '0')}`;
      const po = await ctx.tx.insert('purchaseOrders', {
        id: store.newId(), merchantId, number, supplierId: supplier.id, currency, incoterm: p.incoterm === undefined ? supplier.incotermDefault : reqEnum(p.incoterm, 'incoterm', INCOTERMS),
        expectedDate, originalExpectedDate: expectedDate, dateChanges: [], destinationLocationId: dest.id, depositBps, fx, lines, totalMinor, schedule, status: 'DRAFT',
        supplierReference: null, orderedAt: null, closedShort: false, createdBy: ctx.actor.id, submittedBy: null, createdAt: ctx.at,
      });
      emit(ctx, 'PO_CREATED', { kind: 'purchase_order', id: po.id }, { number, totalMinor, currency, lines: lines.length });
      return { purchaseOrder: po };
    }),
    submitPurchaseOrder: (actor, key, p) => command('submitPurchaseOrder', actor, key, p, async (ctx) => {
      const po = await must(ctx, 'purchaseOrders', reqId(p.poId, 'poId'), 'PO_NOT_FOUND');
      const next = await transition(ctx, po, 'PENDING_APPROVAL', { submittedBy: ctx.actor.id });
      emit(ctx, 'PO_SUBMITTED', { kind: 'purchase_order', id: po.id }, {});
      return { purchaseOrder: poSummary(next) };
    }),
    rejectPurchaseOrder: (actor, key, p) => command('rejectPurchaseOrder', actor, key, p, async (ctx) => {
      const po = await must(ctx, 'purchaseOrders', reqId(p.poId, 'poId'), 'PO_NOT_FOUND');
      const next = await transition(ctx, po, 'DRAFT');
      emit(ctx, 'PO_REJECTED', { kind: 'purchase_order', id: po.id }, { reason: reqStr(p.reason, 'reason', { min: 3, max: 300 }) });
      return { purchaseOrder: poSummary(next) };
    }),
    approvePurchaseOrder: (actor, key, p) => command('approvePurchaseOrder', actor, key, p, async (ctx) => {
      const po = await must(ctx, 'purchaseOrders', reqId(p.poId, 'poId'), 'PO_NOT_FOUND');
      if (po.status !== 'PENDING_APPROVAL') fail('INVALID_TRANSITION', `a ${po.status} purchase order cannot be approved`, { from: po.status, to: 'APPROVED' });
      const ap = await requireApproval(ctx, 'BUYING.approve_purchase_plan', poRefOf(po), p.approval, [po.createdBy, po.submittedBy]);
      const next = await transition(ctx, po, 'APPROVED');
      emit(ctx, 'PO_APPROVED', { kind: 'purchase_order', id: po.id }, { totalMinor: po.totalMinor }, ap);
      return { purchaseOrder: poSummary(next) };
    }),
    placeOrder: (actor, key, p) => command('placeOrder', actor, key, p, async (ctx) => {
      const po = await must(ctx, 'purchaseOrders', reqId(p.poId, 'poId'), 'PO_NOT_FOUND');
      if (po.status !== 'APPROVED') fail('INVALID_TRANSITION', `only an APPROVED purchase order can be ordered (it is ${po.status})`, { from: po.status, to: 'ORDERED' });
      const ap = await requireApproval(ctx, 'BUYING.place_order', poRefOf(po), p.approval);
      const schedule = po.schedule.map((s) => (s.kind === 'DEPOSIT' ? { ...s, status: 'DUE' } : s));
      const next = await transition(ctx, po, 'ORDERED', { orderedAt: ctx.at, supplierReference: optStr(p.supplierReference, 'supplierReference', { max: 80 }), schedule });
      emit(ctx, 'PO_ORDERED', { kind: 'purchase_order', id: po.id }, { note: 'a named human placed the order; Nordla sent nothing to the supplier' }, ap);
      return { purchaseOrder: poSummary(next) };
    }),
    confirmOrder: (actor, key, p) => command('confirmOrder', actor, key, p, async (ctx) => {
      const po = await must(ctx, 'purchaseOrders', reqId(p.poId, 'poId'), 'PO_NOT_FOUND');
      const date = optDate(p.confirmedDate, 'confirmedDate') ?? po.expectedDate;
      const dateChanges = date === po.expectedDate ? po.dateChanges : [...po.dateChanges, { at: ctx.at, from: po.expectedDate, to: date, by: ctx.actor.id }];
      const next = await transition(ctx, po, 'CONFIRMED', { expectedDate: date, dateChanges, supplierReference: optStr(p.supplierReference, 'supplierReference', { max: 80 }) ?? po.supplierReference });
      emit(ctx, 'PO_CONFIRMED', { kind: 'purchase_order', id: po.id }, { expectedDate: date, previous: po.expectedDate });
      return { purchaseOrder: poSummary(next) };
    }),
    cancelPurchaseOrder: (actor, key, p) => command('cancelPurchaseOrder', actor, key, p, async (ctx) => {
      const po = await must(ctx, 'purchaseOrders', reqId(p.poId, 'poId'), 'PO_NOT_FOUND');
      const reason = reqStr(p.reason, 'reason', { min: 3, max: 300 });
      if (po.lines.some((l) => l.qtyReceived > 0)) fail('HAS_RECEIPTS', 'goods were already received: close the order instead of cancelling it');
      if (['ORDERED', 'CONFIRMED'].includes(po.status) && ctx.actor.role !== 'OWNER') fail('FORBIDDEN', 'only the owner cancels an order already placed with the supplier');
      const next = await transition(ctx, po, 'CANCELLED', { cancelReason: reason });
      const paid = po.schedule.filter((s) => s.paymentRef);
      emit(ctx, 'PO_CANCELLED', { kind: 'purchase_order', id: po.id }, { reason, fromStatus: po.status, paymentsToReview: paid.map((s) => ({ kind: s.kind, paymentRef: s.paymentRef })) });
      return { purchaseOrder: poSummary(next), paymentsToReview: paid.map((s) => ({ kind: s.kind, paymentRef: s.paymentRef })) };
    }),
    linkPayment: (actor, key, p) => command('linkPayment', actor, key, p, async (ctx) => {
      const po = await must(ctx, 'purchaseOrders', reqId(p.poId, 'poId'), 'PO_NOT_FOUND');
      if (!['ORDERED', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status)) fail('INVALID_TRANSITION', `no payment can be linked to a ${po.status} purchase order`);
      const kind = reqEnum(p.kind, 'kind', ['DEPOSIT', 'BALANCE']);
      const entry = po.schedule.find((s) => s.kind === kind) ?? fail('NO_SUCH_INSTALMENT', `this order has no ${kind}`);
      if (entry.paymentRef) fail('ALREADY_LINKED', `${kind} is already linked to ${entry.paymentRef}`);
      const paid = reqInt(p.amountMinor, 'amountMinor');
      const schedule = po.schedule.map((s) => (s.kind === kind ? { ...s, status: 'PAID_LINKED', paymentRef: reqStr(p.paymentRef, 'paymentRef', { max: 80 }), paidAmountMinor: paid, paidAt: reqDate(p.paidAt, 'paidAt') } : s));
      const next = await ctx.tx.update('purchaseOrders', merchantId, po.id, { schedule }, po.version);
      emit(ctx, 'PO_PAYMENT_LINKED', { kind: 'purchase_order', id: po.id }, { instalment: kind, paymentRef: p.paymentRef, paidAmountMinor: paid, scheduledMinor: entry.amountMinor, matchesSchedule: paid === entry.amountMinor });
      return { purchaseOrder: poSummary(next), matchesSchedule: paid === entry.amountMinor };
    }),
    closePurchaseOrder: (actor, key, p) => command('closePurchaseOrder', actor, key, p, async (ctx) => {
      const po = await must(ctx, 'purchaseOrders', reqId(p.poId, 'poId'), 'PO_NOT_FOUND');
      if (!PO_TRANSITIONS[po.status].includes('CLOSED')) fail('INVALID_TRANSITION', `a ${po.status} purchase order cannot be closed`, { from: po.status, to: 'CLOSED' });
      const outstanding = po.lines.map((l) => ({ lineId: l.id, itemId: l.itemId, qty: l.qty - l.qtyReceived })).filter((l) => l.qty > 0);
      const short = outstanding.length > 0;
      const reason = short ? reqStr(p.reason, 'reason', { min: 5, max: 300 }) : optStr(p.reason, 'reason', { max: 300 });
      const next = await transition(ctx, po, 'CLOSED', { closedShort: short, closeReason: reason });
      emit(ctx, 'PO_CLOSED', { kind: 'purchase_order', id: po.id }, { short, abandoned: outstanding, reason });
      return { purchaseOrder: poSummary(next), closedShort: short, abandoned: outstanding };
    }),

    // ---------------------------------------------------------------- goods receipt (partial receipts are the normal case)
    receiveGoods: (actor, key, p) => command('receiveGoods', actor, key, p, async (ctx) => {
      const po = await must(ctx, 'purchaseOrders', reqId(p.poId, 'poId'), 'PO_NOT_FOUND');
      if (!['ORDERED', 'CONFIRMED', 'PARTIALLY_RECEIVED'].includes(po.status)) fail('INVALID_TRANSITION', `goods cannot be received on a ${po.status} purchase order`, { from: po.status });
      const receivedAt = reqDate(p.receivedAt, 'receivedAt');
      if (!Array.isArray(p.lines) || !p.lines.length) fail('INVALID_INPUT', 'lines are required');
      const loc = await must(ctx, 'locations', p.locationId === undefined ? po.destinationLocationId : reqId(p.locationId, 'locationId'), 'LOCATION_NOT_FOUND');
      if (!SELLABLE_TYPES.has(loc.type)) fail('INVALID_DESTINATION', 'accepted goods go to a store, back room or warehouse');
      const dup = new Set(); const parsed = [];
      for (const [i, l] of p.lines.entries()) {
        const line = po.lines.find((x) => x.id === l.poLineId) ?? fail('PO_LINE_NOT_FOUND', `line ${l.poLineId}`);
        if (dup.has(line.id)) fail('DUPLICATE_LINE', `line ${line.id} appears twice`); dup.add(line.id);
        const accepted = reqInt(l.qtyAccepted ?? 0, `lines[${i}].qtyAccepted`, { min: 0 }); const defective = reqInt(l.qtyDefective ?? 0, `lines[${i}].qtyDefective`, { min: 0 });
        if (accepted + defective === 0) fail('INVALID_INPUT', `lines[${i}]: nothing received`);
        if (line.qtyReceived + accepted + defective > line.qty) fail('OVER_RECEIPT', `line ${line.id}: ${line.qtyReceived + accepted + defective} would exceed the ${line.qty} ordered`, { lineId: line.id, ordered: line.qty, alreadyReceived: line.qtyReceived });
        parsed.push({ line, accepted, defective, landed: optInt(l.landedUnitCostEurMicro, `lines[${i}].landedUnitCostEurMicro`) });
      }
      let quarantine = null;
      if (parsed.some((x) => x.defective > 0)) {
        quarantine = await must(ctx, 'locations', reqId(p.quarantineLocationId, 'quarantineLocationId'), 'LOCATION_NOT_FOUND');
        if (quarantine.type !== 'QUARANTINE') fail('INVALID_DESTINATION', 'defective goods go to a QUARANTINE location');
      }
      const ap = await requireApproval(ctx, 'STOCK_SALES.receive_goods', poRefOf(po), p.approval);
      const groupId = store.newId(); const receiptLines = [];
      for (const x of parsed) {
        const cost = x.landed !== null ? { costStatus: 'CONFIRMED', unitCostEurMicro: x.landed }
          : po.currency === 'EUR' ? { costStatus: 'ESTIMATED', unitCostEurMicro: x.line.unitPriceMicro }
            : po.fx ? { costStatus: 'ESTIMATED', unitCostEurMicro: microToEurMicro(x.line.unitPriceMicro, po.fx) } : { costStatus: 'UNKNOWN', unitCostEurMicro: null };
        const base = { itemId: x.line.itemId, kind: 'RECEIPT', groupId, reference: { type: 'purchase_order', id: po.id, lineId: x.line.id }, approvalId: ap.id, ...cost };
        if (x.accepted > 0) await postMovement(ctx, { ...base, locationId: loc.id, delta: x.accepted });
        if (x.defective > 0) await postMovement(ctx, { ...base, locationId: quarantine.id, delta: x.defective, reason: 'DEFECTIVE_ON_RECEIPT' });
        receiptLines.push({ poLineId: x.line.id, itemId: x.line.itemId, qtyAccepted: x.accepted, qtyDefective: x.defective, costStatus: cost.costStatus });
      }
      const lines = po.lines.map((l) => { const x = parsed.find((y) => y.line.id === l.id); return x ? { ...l, qtyReceived: l.qtyReceived + x.accepted + x.defective, qtyDefective: l.qtyDefective + x.defective } : l; });
      const complete = lines.every((l) => l.qtyReceived >= l.qty);
      const receipt = await ctx.tx.insert('receipts', {
        id: store.newId(), merchantId, poId: po.id, supplierId: po.supplierId, receivedAt, lines: receiptLines, locationId: loc.id, quarantineLocationId: quarantine?.id ?? null,
        idempotencyKey: ctx.key, approvalId: ap.id, promisedDate: po.expectedDate, onTime: receivedAt <= po.expectedDate, recordedBy: ctx.actor.id, createdAt: ctx.at,
      });
      const next = await transition(ctx, po, complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED', { lines });
      emit(ctx, 'GOODS_RECEIVED', { kind: 'purchase_order', id: po.id }, { receiptId: receipt.id, lines: receiptLines, complete }, ap);
      return { receipt, purchaseOrder: poSummary(next), complete };
    }),

    // ---------------------------------------------------------------- stock operations
    adjustStock: (actor, key, p) => command('adjustStock', actor, key, p, async (ctx) => {
      const itemId = reqId(p.itemId, 'itemId'); const locationId = reqId(p.locationId, 'locationId');
      const delta = reqInt(p.delta, 'delta', { min: -1e6, max: 1e6 }); if (delta === 0) fail('INVALID_INPUT', 'delta cannot be zero');
      const reason = reqStr(p.reason, 'reason', { min: 5, max: 300 });
      await must(ctx, 'items', itemId, 'ITEM_NOT_FOUND'); await must(ctx, 'locations', locationId, 'LOCATION_NOT_FOUND');
      const ap = await requireApproval(ctx, 'STOCK_SALES.adjust_on_hand', ref(K.PRODUCT, `${itemId}@${locationId}`), p.approval, [ctx.actor.id]);
      const mv = await postMovement(ctx, { itemId, locationId, delta, kind: 'ADJUSTMENT', reason, approvalId: ap.id });
      emit(ctx, 'STOCK_ADJUSTED', { kind: 'item', id: itemId }, { locationId, delta, reason }, ap);
      return { movement: mv };
    }),
    transferStock: (actor, key, p) => command('transferStock', actor, key, p, async (ctx) => {
      const itemId = reqId(p.itemId, 'itemId'); const from = reqId(p.fromLocationId, 'fromLocationId'); const to = reqId(p.toLocationId, 'toLocationId'); const qty = reqInt(p.qty, 'qty');
      if (from === to) fail('INVALID_INPUT', 'source and destination are the same');
      const groupId = store.newId(); const reason = optStr(p.reason, 'reason', { max: 300 });
      const out = await postMovement(ctx, { itemId, locationId: from, delta: -qty, kind: 'TRANSFER_OUT', groupId, reason });
      const inn = await postMovement(ctx, { itemId, locationId: to, delta: qty, kind: 'TRANSFER_IN', groupId, reason });
      emit(ctx, 'STOCK_TRANSFERRED', { kind: 'item', id: itemId }, { from, to, qty, groupId });
      return { movements: [out, inn], groupId };
    }),
    quarantineDefect: (actor, key, p) => command('quarantineDefect', actor, key, p, async (ctx) => {
      const itemId = reqId(p.itemId, 'itemId'); const qty = reqInt(p.qty, 'qty'); const reason = reqStr(p.reason, 'reason', { min: 5, max: 300 });
      const from = await must(ctx, 'locations', reqId(p.fromLocationId, 'fromLocationId'), 'LOCATION_NOT_FOUND');
      const q = await must(ctx, 'locations', reqId(p.quarantineLocationId, 'quarantineLocationId'), 'LOCATION_NOT_FOUND');
      if (q.type !== 'QUARANTINE') fail('INVALID_DESTINATION', 'the target must be a QUARANTINE location');
      if (!SELLABLE_TYPES.has(from.type)) fail('INVALID_DESTINATION', 'only sellable stock can be quarantined');
      const groupId = store.newId();
      const out = await postMovement(ctx, { itemId, locationId: from.id, delta: -qty, kind: 'DEFECT_QUARANTINE_OUT', groupId, reason });
      const inn = await postMovement(ctx, { itemId, locationId: q.id, delta: qty, kind: 'DEFECT_QUARANTINE_IN', groupId, reason });
      emit(ctx, 'STOCK_QUARANTINED', { kind: 'item', id: itemId }, { from: from.id, qty, reason, groupId });
      return { movements: [out, inn], groupId };
    }),
    /** A physical count: variance = counted - ledger. Any variance needs a reason per line and ONE approval for the whole count. */
    recordCount: (actor, key, p) => command('recordCount', actor, key, p, async (ctx) => {
      const locationId = reqId(p.locationId, 'locationId'); const countId = reqId(p.countId, 'countId');
      await must(ctx, 'locations', locationId, 'LOCATION_NOT_FOUND');
      if (!Array.isArray(p.counts) || !p.counts.length || p.counts.length > 500) fail('INVALID_INPUT', 'counts must hold 1-500 lines');
      const seen = new Set(); const rows = [];
      for (const [i, c] of p.counts.entries()) {
        const itemId = reqId(c.itemId, `counts[${i}].itemId`); if (seen.has(itemId)) fail('DUPLICATE_LINE', `item ${itemId} counted twice`); seen.add(itemId);
        const counted = reqInt(c.counted, `counts[${i}].counted`, { min: 0 });
        const expected = (await ctx.tx.balanceOf(merchantId, itemId, locationId))?.onHand ?? 0;
        const variance = counted - expected;
        rows.push({ itemId, expected, counted, variance, reason: variance === 0 ? null : reqStr(c.reason, `counts[${i}].reason`, { min: 5, max: 300 }) });
      }
      const variances = rows.filter((r) => r.variance !== 0);
      let ap = null;
      if (variances.length) ap = await requireApproval(ctx, 'STOCK_SALES.adjust_on_hand', ref(K.PRODUCT, `count:${countId}`), p.approval, [ctx.actor.id]);
      const groupId = store.newId();
      for (const r of variances) await postMovement(ctx, { itemId: r.itemId, locationId, delta: r.variance, kind: 'COUNT_ADJUST', reason: r.reason, groupId, reference: { type: 'count', id: countId }, approvalId: ap.id });
      emit(ctx, variances.length ? 'COUNT_ADJUSTED' : 'COUNT_CONFIRMED', { kind: 'location', id: locationId }, { countId, lines: rows.length, variances: variances.length }, ap);
      return { countId, lines: rows, adjusted: variances.length };
    }),
    reserveStock: (actor, key, p) => command('reserveStock', actor, key, p, async (ctx) => {
      const loc = await must(ctx, 'locations', reqId(p.locationId, 'locationId'), 'LOCATION_NOT_FOUND');
      if (!SELLABLE_TYPES.has(loc.type)) fail('INVALID_DESTINATION', 'only sellable stock can be reserved');
      const mv = await postMovement(ctx, { itemId: reqId(p.itemId, 'itemId'), locationId: loc.id, bucket: 'RESERVED', delta: reqInt(p.qty, 'qty'), kind: 'RESERVE', reference: { type: reqStr(p.reference?.type, 'reference.type', { max: 40 }), id: reqStr(p.reference?.id, 'reference.id', { max: 80 }) } });
      emit(ctx, 'STOCK_RESERVED', { kind: 'item', id: mv.itemId }, { locationId: loc.id, qty: mv.delta });
      return { movement: mv };
    }),
    releaseStock: (actor, key, p) => command('releaseStock', actor, key, p, async (ctx) => {
      const mv = await postMovement(ctx, { itemId: reqId(p.itemId, 'itemId'), locationId: reqId(p.locationId, 'locationId'), bucket: 'RESERVED', delta: -reqInt(p.qty, 'qty'), kind: 'RELEASE', reference: { type: reqStr(p.reference?.type, 'reference.type', { max: 40 }), id: reqStr(p.reference?.id, 'reference.id', { max: 80 }) } });
      emit(ctx, 'STOCK_RELEASED', { kind: 'item', id: mv.itemId }, { locationId: mv.locationId, qty: -mv.delta });
      return { movement: mv };
    }),

    addSupplierDocument: (actor, key, p) => command('addSupplierDocument', actor, key, p, async (ctx) => {
      const supplier = await must(ctx, 'suppliers', reqId(p.supplierId, 'supplierId'), 'SUPPLIER_NOT_FOUND');
      if (supplier.documents.length >= 100) fail('LIMIT_REACHED', 'too many documents on this supplier');
      const doc = {
        id: `D${supplier.documents.length + 1}`, type: reqEnum(p.type, 'type', DOCUMENT_TYPES), name: reqStr(p.name, 'name', { max: 200 }), ref: reqStr(p.ref, 'ref', { max: 300 }),
        sha256: attachmentsOf([{ kind: 'DOCUMENT', ref: 'x', sha256: p.sha256 }])[0].sha256, expiresOn: optDate(p.expiresOn, 'expiresOn'), addedAt: ctx.at, addedBy: ctx.actor.id,
      };
      const next = await ctx.tx.update('suppliers', merchantId, supplier.id, { documents: [...supplier.documents, doc] }, supplier.version);
      emit(ctx, 'SUPPLIER_DOCUMENT_ADDED', { kind: 'supplier', id: supplier.id }, { documentId: doc.id, type: doc.type, expiresOn: doc.expiresOn });
      return { document: doc, supplierVersion: next.version };
    }),

    // ---------------------------------------------------------------- supplier visits (the mobile flow): start, capture products one tap at a time, close
    startVisit: (actor, key, p) => command('startVisit', actor, key, p, async (ctx) => {
      let supplier; let supplierCreated = false;
      if (p.supplierId !== undefined) supplier = await must(ctx, 'suppliers', reqId(p.supplierId, 'supplierId'), 'SUPPLIER_NOT_FOUND');
      else {
        const name = reqStr(p.supplierName, 'supplierName', { max: 200 });
        const same = (await ctx.tx.list('suppliers', merchantId)).filter((x) => supplierKeyOf(x.name) === supplierKeyOf(name));
        if (same.length > 1) fail('SUPPLIER_AMBIGUOUS', `${same.length} suppliers match "${name}": pick one`, { candidates: same.map((x) => ({ id: x.id, name: x.name })) });
        if (same.length === 1) supplier = same[0];
        else { supplier = (await createSupplierIn(ctx, { name, currency: p.currency, country: p.country })).supplier; supplierCreated = true; }
      }
      const visit = await ctx.tx.insert('visits', { id: store.newId(), merchantId, supplierId: supplier.id, visitDate: reqDate(p.date, 'date'), place: optStr(p.place, 'place', { max: 200 }), note: optStr(p.note, 'note', { max: 1000 }), status: 'OPEN', entries: [], createdBy: ctx.actor.id, createdAt: ctx.at });
      emit(ctx, 'VISIT_STARTED', { kind: 'visit', id: visit.id }, { supplierId: supplier.id, supplierCreated, place: visit.place });
      return { visit, supplier: { id: supplier.id, name: supplier.name, currency: supplier.currency, created: supplierCreated } };
    }),
    /**
     * ONE tap, ONE transaction: the product (a prospect item, reused when its barcode or id is known), its photos and - when a price was given - a quote revision,
     * all linked to the visit. The caller's idempotency key (a client-generated capture id) makes a retry after a lost connection harmless.
     */
    captureProduct: (actor, key, p) => command('captureProduct', actor, key, p, async (ctx) => {
      const visit = await must(ctx, 'visits', reqId(p.visitId, 'visitId'), 'VISIT_NOT_FOUND');
      if (visit.status !== 'OPEN') fail('VISIT_CLOSED', 'this visit is closed');
      if (visit.entries.length >= 500) fail('LIMIT_REACHED', 'too many products in one visit');
      const supplier = await must(ctx, 'suppliers', visit.supplierId, 'SUPPLIER_NOT_FOUND');
      const prod = p.product ?? {};
      let item; let itemCreated = false;
      if (p.itemId !== undefined) item = await must(ctx, 'items', reqId(p.itemId, 'itemId'), 'ITEM_NOT_FOUND');
      else {
        const barcode = optStr(prod.barcode, 'product.barcode', { max: 32 });
        const known = barcode ? (await ctx.tx.list('items', merchantId)).find((i) => i.barcode === barcode) : null;
        if (known) item = known;
        else {
          const n = visit.entries.filter((e) => e.itemCreated).length + 1;
          const sku = prod.sku !== undefined ? reqStr(prod.sku, 'product.sku', { max: 64 }) : `V${visit.visitDate.replace(/-/g, '')}-${visit.id.slice(0, 4)}-${n}`.toUpperCase();
          item = (await createItemIn(ctx, { sku, name: prod.name, barcode, status: 'PROSPECT', attachments: prod.photos })).item; itemCreated = true;
        }
      }
      const photos = attachmentsOf(prod.photos, 'product.photos');
      if (!itemCreated && photos.length) {
        const have = new Set((item.attachments ?? []).map((a) => a.ref)); const add = photos.filter((a) => !have.has(a.ref));
        if (add.length) item = await ctx.tx.update('items', merchantId, item.id, { attachments: [...(item.attachments ?? []), ...add].slice(0, 20) }, item.version);
      }
      let quote = null;
      if (p.quote !== undefined) {
        const q = p.quote;
        quote = (await recordQuoteIn(ctx, {
          supplierId: supplier.id, itemId: item.id, currency: q.currency ?? supplier.currency, tiers: q.tiers ?? [{ minQty: q.moq ?? 1, unitPrice: q.unitPrice }], moq: q.moq, incoterm: q.incoterm, leadTimeDays: q.leadTimeDays,
          validUntil: q.validUntil, provenance: 'SUPPLIER_CLAIM', reason: `visit ${visit.visitDate}${visit.place ? ` - ${visit.place}` : ''}${q.note ? ` - ${q.note}` : ''}`, evidence: q.photos,
        })).quote;
      }
      const entry = { id: store.newId(), at: ctx.at, itemId: item.id, quoteId: quote?.id ?? null, itemCreated, note: optStr(p.note, 'note', { max: 500 }) };
      const next = await ctx.tx.update('visits', merchantId, visit.id, { entries: [...visit.entries, entry] }, visit.version);
      emit(ctx, 'VISIT_PRODUCT_CAPTURED', { kind: 'visit', id: visit.id }, { itemId: item.id, quoteId: entry.quoteId, itemCreated });
      return { visit: next, item, quote, itemCreated, entry };
    }),
    closeVisit: (actor, key, p) => command('closeVisit', actor, key, p, async (ctx) => {
      const visit = await must(ctx, 'visits', reqId(p.visitId, 'visitId'), 'VISIT_NOT_FOUND');
      if (visit.status === 'CLOSED') fail('VISIT_CLOSED', 'this visit is already closed');
      const next = await ctx.tx.update('visits', merchantId, visit.id, { status: 'CLOSED', note: p.note !== undefined ? optStr(p.note, 'note', { max: 1000 }) : visit.note }, visit.version);
      emit(ctx, 'VISIT_CLOSED', { kind: 'visit', id: visit.id }, { products: visit.entries.length });
      return { visit: next };
    }),

    // ---------------------------------------------------------------- supplier incidents (inputs of the traceable reliability metrics)
    recordIncident: (actor, key, p) => command('recordIncident', actor, key, p, async (ctx) => {
      const supplier = await must(ctx, 'suppliers', reqId(p.supplierId, 'supplierId'), 'SUPPLIER_NOT_FOUND');
      if (p.poId !== undefined) { const po = await must(ctx, 'purchaseOrders', reqId(p.poId, 'poId'), 'PO_NOT_FOUND'); if (po.supplierId !== supplier.id) fail('PO_MISMATCH', 'that order belongs to another supplier'); }
      const incident = await ctx.tx.appendIncident({
        id: store.newId(), merchantId, supplierId: supplier.id, poId: p.poId ?? null, type: reqEnum(p.type, 'type', ['QUALITY', 'DELAY', 'DOCUMENT', 'OTHER']),
        severity: reqEnum(p.severity, 'severity', ['LOW', 'MEDIUM', 'HIGH']), description: reqStr(p.description, 'description', { min: 5, max: 1000 }), at: ctx.at, recordedBy: ctx.actor.id,
      });
      emit(ctx, 'SUPPLIER_INCIDENT', { kind: 'supplier', id: supplier.id }, { type: incident.type, severity: incident.severity, poId: incident.poId });
      return { incident };
    }),
  };
  return cmd;
}

/** Unit price (micro) for a quantity. Fails closed: below MOQ or below the first tier is an error, never an extrapolation. */
export function resolveTierPrice(quote, qty) {
  if (quote.moq && qty < quote.moq) fail('BELOW_MOQ', `quantity ${qty} is below the supplier MOQ ${quote.moq}`, { moq: quote.moq });
  const tier = [...quote.tiers].reverse().find((t) => qty >= t.minQty);
  if (!tier) fail('BELOW_FIRST_TIER', `quantity ${qty} is below the first price tier (${quote.tiers[0].minQty})`, { firstTier: quote.tiers[0].minQty });
  return tier.unitPriceMicro;
}
