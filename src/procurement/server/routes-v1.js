// Stock / Achats V1 routes that did not exist yet: suppliers and offers, order confirmation / closing, stock changes (filed adjustments and counts, their decision),
// transfers, count preview and the history of an item. They plug into the server's `api()` (app.js) and into the hosted mount (/api/procurement/*) identically.
// Every route: access control FIRST (permissions.js), then validation (the module's own commands validate every field), then the command (journaled, idempotent).
// Writes need an Idempotency-Key; the approval of a decision is built here from the authenticated person, never read from the request.
import { ProcurementError } from '../errors.js';
import { microToString } from '../util.js';
import { capabilitiesOf, stockActor } from './permissions.js';

const forbid = (message) => { throw new ProcurementError('FORBIDDEN', message); };
const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : v);

export function createV1Routes({ c, q, send, readJson, idemKey, now }) {
  const nameMaps = async () => ({ items: new Map((await q.items()).map((i) => [i.id, i])), locs: new Map((await q.locations()).map((l) => [l.id, l])) });

  async function requestView(r, maps) {
    const p = r.payload; const it = (id) => maps.items.get(id);
    const base = { requestId: r.requestId, type: r.type, status: r.status, requestedBy: r.requestedBy, requestedAt: r.requestedAt, decidedBy: r.decidedBy, decidedAt: r.decidedAt, reason: r.reason, selfApproved: r.selfApproved, location: maps.locs.get(p.locationId)?.name ?? null, locationId: p.locationId };
    if (r.type === 'ADJUST') return { ...base, itemId: p.itemId, sku: it(p.itemId)?.sku ?? null, name: it(p.itemId)?.name ?? null, delta: p.delta, why: p.reason };
    const now_ = r.status === 'PENDING' ? await q.countPreview({ locationId: p.locationId, counts: p.counts.map((x) => ({ itemId: x.itemId, counted: x.counted })) }) : null;
    return { ...base, countId: p.countId, lines: p.counts.map((x) => ({ itemId: x.itemId, sku: it(x.itemId)?.sku ?? null, name: it(x.itemId)?.name ?? null, counted: x.counted, reason: x.reason, expectedNow: now_?.find((n) => n.itemId === x.itemId)?.expected ?? null, varianceNow: now_?.find((n) => n.itemId === x.itemId)?.variance ?? null })) };
  }
  const approverOf = (user) => ({ kind: 'HUMAN', id: user.id, role: user.role === 'OWNER' ? 'OWNER' : 'AUTHORIZED_REVIEWER' });
  const approvalFor = (user, key, action, subject, body) => ({ id: `ap:${key}:${action}`, action, subject_ref: `nordla:product:${subject}`, approver: approverOf(user), approved_at: now().toISOString(), ...(body?.confirmSelfApproval === true && user.role === 'OWNER' ? { solo_owner_confirmed: true } : {}) });

  /** @returns {Promise<boolean>} true when the route was handled */
  return async function v1(req, res, p, m, user, actor) {
    const caps = capabilitiesOf(user); let mm;

    // ---------------------------------------------------------------- suppliers and offers
    if (p === '/api/suppliers' && m === 'GET') {
      const offers = (await q.quotes()).filter((x) => ['RECEIVED', 'SELECTED'].includes(x.status)); const pos = await q.purchaseOrders();
      send(res, 200, { suppliers: (await q.suppliers()).map((s) => ({ id: s.id, name: s.name, country: s.country, currency: s.currency, incotermDefault: s.incotermDefault, leadTimeDays: s.leadTimeDays, status: s.status, offers: offers.filter((x) => x.supplierId === s.id).length, openOrders: pos.filter((x) => x.supplierId === s.id && ['PENDING_APPROVAL', 'APPROVED', 'ORDERED', 'CONFIRMED', 'PARTIALLY_RECEIVED'].includes(x.status)).length })) });
      return true;
    }
    if (p === '/api/suppliers' && m === 'POST') {
      if (!caps.prepare) forbid('your access cannot create suppliers');
      const b = await readJson(req);
      const r = await c.createSupplier(actor, idemKey(req), { name: str(b.name, 200), country: b.country || undefined, currency: b.currency, incotermDefault: b.incotermDefault || undefined, leadTimeDays: b.leadTimeDays === '' || b.leadTimeDays == null ? undefined : Number(b.leadTimeDays) });
      send(res, 200, { supplier: r.supplier, replayed: r.replayed });
      return true;
    }
    mm = /^\/api\/suppliers\/([\w-]+)$/.exec(p);
    if (mm && m === 'GET') {
      const s = await q.supplier(mm[1]); if (!s) { send(res, 404, { error: 'SUPPLIER_NOT_FOUND', message: 'supplier not found' }); return true; }
      const maps = await nameMaps(); const quotes = (await q.quotes()).filter((x) => x.supplierId === s.id).sort((a, b) => b.revision - a.revision);
      send(res, 200, {
        supplier: { id: s.id, name: s.name, country: s.country, currency: s.currency, incotermDefault: s.incotermDefault, leadTimeDays: s.leadTimeDays, status: s.status, depositBps: s.depositBps },
        offers: quotes.map((x) => ({ id: x.id, itemId: x.itemId, sku: maps.items.get(x.itemId)?.sku ?? null, name: maps.items.get(x.itemId)?.name ?? null, revision: x.revision, status: x.status, currency: x.currency, moq: x.moq, incoterm: x.incoterm, leadTimeDays: x.leadTimeDays, validUntil: x.validUntil, tiers: x.tiers.map((t) => ({ minQty: t.minQty, unitPrice: microToString(t.unitPriceMicro) })) })),
        orders: (await q.purchaseOrders()).filter((x) => x.supplierId === s.id).map((x) => ({ id: x.id, number: x.number, status: x.status, currency: x.currency, totalMinor: x.totalMinor, expectedDate: x.expectedDate })),
        documents: (s.documents ?? []).map((d) => ({ id: d.id, type: d.type, name: d.name, expiresOn: d.expiresOn })),
        metrics: await q.supplierMetrics(s.id),
      });
      return true;
    }
    mm = /^\/api\/suppliers\/([\w-]+)\/offers$/.exec(p);
    if (mm && m === 'POST') {
      if (!caps.prepare) forbid('your access cannot record offers');
      const b = await readJson(req);
      const r = await c.recordQuote(actor, idemKey(req), { supplierId: mm[1], itemId: b.itemId, currency: b.currency, moq: b.moq === '' || b.moq == null ? undefined : Number(b.moq), incoterm: b.incoterm || undefined, leadTimeDays: b.leadTimeDays === '' || b.leadTimeDays == null ? undefined : Number(b.leadTimeDays), validUntil: b.validUntil || undefined, tiers: (Array.isArray(b.tiers) ? b.tiers : []).map((t) => ({ minQty: Number(t.minQty), unitPrice: String(t.unitPrice) })) });
      send(res, 200, { quote: r.quote, replayed: r.replayed });
      return true;
    }

    // ---------------------------------------------------------------- order follow-up
    mm = /^\/api\/purchase-orders\/([\w-]+)\/(confirm|close)$/.exec(p);
    if (mm && m === 'POST') {
      if (!caps.prepare) forbid('your access cannot follow up orders');
      const b = await readJson(req); const key = idemKey(req); const [, poId, act] = mm;
      const r = act === 'confirm' ? await c.confirmOrder(actor, key, { poId, confirmedDate: b.confirmedDate || undefined, supplierReference: b.supplierReference || undefined }) : await c.closePurchaseOrder(actor, key, { poId, reason: b.reason || undefined });
      send(res, 200, { purchaseOrder: r.purchaseOrder, ...(act === 'close' ? { closedShort: r.closedShort, abandoned: r.abandoned } : {}), replayed: r.replayed });
      return true;
    }

    // ---------------------------------------------------------------- stock changes: filed, then decided
    if (p === '/api/stock/requests' && m === 'GET') {
      if (!caps.read) forbid('no access'); const maps = await nameMaps(); const status = new URL(req.url, 'http://x').searchParams.get('status');
      const list = await q.stockRequests({ status: ['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? status : null });
      const out = []; for (const r of list.slice(0, 100)) out.push(await requestView(r, maps));
      send(res, 200, { requests: out });
      return true;
    }
    if (p === '/api/stock/requests' && m === 'POST') {
      if (!(caps.canReceive || caps.canAdjust)) forbid('your access cannot file stock changes: it needs a person explicitly authorized by the owner');
      const b = await readJson(req); const key = idemKey(req); const who = stockActor(user);
      if (b.type === 'COUNT') {
        const rows = await q.countPreview({ locationId: b.locationId, counts: Array.isArray(b.counts) ? b.counts.map((x) => ({ itemId: x.itemId, counted: x.counted })) : [] });
        if (!rows.some((x) => x.variance !== 0)) { // nothing differs from the ledger: recorded as confirmed, no approval needed
          const r = await c.recordCount(who, key, { locationId: b.locationId, countId: b.countId ?? `count-${key}`.slice(0, 80), counts: b.counts.map((x) => ({ itemId: x.itemId, counted: x.counted })) });
          send(res, 200, { status: 'CONFIRMED', lines: r.lines, replayed: r.replayed });
          return true;
        }
      }
      const r = await c.requestStockChange(who, key, b.type === 'COUNT' ? { type: 'COUNT', locationId: b.locationId, counts: (b.counts ?? []).map((x) => ({ itemId: x.itemId, counted: x.counted, reason: x.reason || undefined })) } : { type: b.type, itemId: b.itemId, locationId: b.locationId, delta: b.delta, reason: str(b.reason) });
      send(res, 200, { status: 'PENDING', request: await requestView({ ...r.request, requestedAt: now().toISOString(), decidedBy: null, decidedAt: null, reason: null, selfApproved: false }, await nameMaps()), replayed: r.replayed });
      return true;
    }
    mm = /^\/api\/stock\/requests\/([\w-]+)\/decision$/.exec(p);
    if (mm && m === 'POST') {
      const b = await readJson(req); const key = idemKey(req); const request = await q.stockRequest(mm[1]);
      if (!request) { send(res, 404, { error: 'REQUEST_NOT_FOUND', message: 'stock request not found' }); return true; }
      const who = stockActor(user);
      if (b.decision === 'REJECT') {
        if (!(caps.canAdjust || request.requestedBy === user.id)) forbid('only the person who filed it, or an authorized approver, can withdraw or reject this request');
        const r = await c.decideStockChange(who, key, { requestId: request.requestId, decision: 'REJECT', reason: str(b.reason) });
        send(res, 200, { request: await requestView(r.request, await nameMaps()), replayed: r.replayed });
        return true;
      }
      if (!caps.canAdjust) forbid('your access cannot approve stock changes: it needs the owner or a person explicitly authorized');
      const subject = request.type === 'ADJUST' ? `${request.payload.itemId}@${request.payload.locationId}` : `count:${request.payload.countId}`;
      const r = await c.decideStockChange(who, key, { requestId: request.requestId, decision: 'APPROVE', approval: approvalFor(user, key, 'STOCK_SALES.adjust_on_hand', subject, b) });
      send(res, 200, { request: await requestView({ ...request, ...r.request }, await nameMaps()), replayed: r.replayed });
      return true;
    }

    // ---------------------------------------------------------------- locations (structural: the owner only)
    if (p === '/api/locations' && m === 'POST') {
      if (!caps.canSelfApprove) forbid('only the owner creates stock locations');
      const b = await readJson(req); const r = await c.createLocation({ id: user.id, role: 'OWNER' }, idemKey(req), { name: str(b.name, 100), type: b.type });
      send(res, 200, { location: r.location, replayed: r.replayed });
      return true;
    }

    // ---------------------------------------------------------------- transfers, count preview, history
    if (p === '/api/stock/transfers' && m === 'POST') {
      if (!caps.canReceive) forbid('your access cannot move stock: it needs a person explicitly authorized by the owner');
      const b = await readJson(req);
      const r = await c.transferStock(stockActor(user), idemKey(req), { itemId: b.itemId, fromLocationId: b.fromLocationId, toLocationId: b.toLocationId, qty: b.qty, reason: b.reason ? str(b.reason) : undefined });
      send(res, 200, { groupId: r.groupId, movements: r.movements, replayed: r.replayed });
      return true;
    }
    if (p === '/api/stock/counts/preview' && m === 'POST') {
      if (!(caps.canReceive || caps.canAdjust)) forbid('your access cannot count stock');
      const b = await readJson(req); const maps = await nameMaps();
      const rows = await q.countPreview({ locationId: b.locationId, counts: Array.isArray(b.counts) ? b.counts.map((x) => ({ itemId: x.itemId, counted: x.counted })) : [] });
      send(res, 200, { locationId: b.locationId, lines: rows.map((x) => ({ ...x, sku: maps.items.get(x.itemId)?.sku ?? null, name: maps.items.get(x.itemId)?.name ?? null })), needsApproval: rows.some((x) => x.variance !== 0) });
      return true;
    }
    mm = /^\/api\/stock\/([\w-]+)\/history$/.exec(p);
    if (mm && m === 'GET') {
      if (!caps.read) forbid('no access');
      const item = await q.item(mm[1]); if (!item) { send(res, 404, { error: 'ITEM_NOT_FOUND', message: 'item not found' }); return true; }
      send(res, 200, { item: { id: item.id, sku: item.sku, name: item.name }, ...(await q.stockHistory(item.id)) });
      return true;
    }
    return false;
  };
}
