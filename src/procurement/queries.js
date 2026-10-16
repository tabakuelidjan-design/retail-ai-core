// Stock / Achats read side. Pure derivations over the store: nothing here writes, nothing is cached, every figure is recomputed from the ledger and the orders.
// Reliability and landed-cost answers carry their evidence (counts, ids, inputs) and say NOT_MEASURABLE / NOT_COMPUTED instead of guessing.
// Every query is async: the store may be in memory, a file, or PostgreSQL.
import { positionOf, valuationOf } from './stock.js';
import { resolveTierPrice } from './service.js';
import { analyzePurchase as financeAnalyze } from '../finance/purchase-analysis.js';
import { microToString, reqId, reqInt, reqDate, reqCurrency, pctToBps, deepFreeze } from './util.js';
import { fail, ProcurementError } from './errors.js';

const OPEN = new Set(['ORDERED', 'CONFIRMED', 'PARTIALLY_RECEIVED']);
export const MIN_SAMPLE = 3; // receipts needed before a reliability ratio is shown as a measurement

export function createProcurementQueries({ store, merchantId, now = () => new Date().toISOString(), analyze = financeAnalyze }) {
  const today = () => now().slice(0, 10);
  const locMap = async () => new Map((await store.list('locations', merchantId)).map((l) => [l.id, l]));
  const orders = () => store.list('purchaseOrders', merchantId);
  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

  /** Units ordered and not yet received, per open order line. Never part of `available`. */
  async function incomingFor(itemId) {
    const rows = [];
    for (const po of await orders()) {
      if (!OPEN.has(po.status)) continue;
      for (const l of po.lines) if (l.itemId === itemId && l.qty > l.qtyReceived) rows.push({ poId: po.id, number: po.number, status: po.status, qty: l.qty - l.qtyReceived, expectedDate: po.expectedDate, delayed: po.expectedDate < today() });
    }
    return { qty: rows.reduce((s, r) => s + r.qty, 0), orders: rows, countedAsAvailable: false };
  }

  async function stockPosition(itemId) {
    const item = (await store.get('items', merchantId, reqId(itemId, 'itemId'))) ?? fail('ITEM_NOT_FOUND', `item ${itemId}`);
    const mvs = await store.listMovements(merchantId, { itemId });
    const pos = positionOf(itemId, mvs, await locMap());
    return deepFreeze({ ...pos, sku: item.sku, incoming: await incomingFor(itemId), valuation: valuationOf(mvs, pos.physical) });
  }

  async function stockPositions() {
    const items = (await store.list('items', merchantId)).filter((i) => i.status !== 'ARCHIVED');
    const positions = [];
    for (const i of items) positions.push(await stockPosition(i.id));
    const total = { confirmedEurMinor: 0, estimatedEurMinor: 0, itemsWithUnknownCost: 0 };
    for (const p of positions) {
      if (p.physical <= 0) continue;
      if (p.valuation.status === 'CONFIRMED') total.confirmedEurMinor += p.valuation.valueEurMinor;
      else if (p.valuation.status === 'ESTIMATED') total.estimatedEurMinor += p.valuation.valueEurMinor;
      else total.itemsWithUnknownCost += 1;
    }
    return deepFreeze({ positions, valuation: { ...total, note: 'estimated = supplier goods price only (no freight, duty, fees); unknown-cost items are excluded, not valued at zero' } });
  }

  async function reorderAlerts() {
    const out = [];
    for (const item of await store.list('items', merchantId)) {
      if (item.status !== 'ACTIVE' || item.reorderPoint === null) continue;
      const p = await stockPosition(item.id); const projected = p.available + p.incoming.qty;
      if (p.available <= 0) out.push({ itemId: item.id, sku: item.sku, level: 'STOCKOUT', available: p.available, incoming: p.incoming.qty, reorderPoint: item.reorderPoint, suggestedQty: item.reorderQty });
      else if (projected <= item.reorderPoint) out.push({ itemId: item.id, sku: item.sku, level: 'REORDER', available: p.available, incoming: p.incoming.qty, reorderPoint: item.reorderPoint, suggestedQty: item.reorderQty });
    }
    return deepFreeze(out);
  }

  async function delayedOrders(asOf = today()) {
    reqDate(asOf, 'asOf');
    return deepFreeze((await orders()).filter((po) => OPEN.has(po.status) && po.expectedDate < asOf).map((po) => ({
      poId: po.id, number: po.number, supplierId: po.supplierId, expectedDate: po.expectedDate, originalExpectedDate: po.originalExpectedDate, daysLate: daysBetween(po.expectedDate, asOf),
      slippedDays: daysBetween(po.originalExpectedDate, po.expectedDate), outstanding: po.lines.filter((l) => l.qty > l.qtyReceived).map((l) => ({ lineId: l.id, itemId: l.itemId, qty: l.qty - l.qtyReceived })),
    })));
  }

  /** Goods ordered and not received (any open order) + units sitting in TRANSIT locations. Two distinct facts, reported apart. */
  async function inTransit() {
    const open = (await orders()).filter((po) => OPEN.has(po.status));
    const lines = open.flatMap((po) => po.lines.filter((l) => l.qty > l.qtyReceived).map((l) => ({ poId: po.id, number: po.number, supplierId: po.supplierId, itemId: l.itemId, qty: l.qty - l.qtyReceived, expectedDate: po.expectedDate, delayed: po.expectedDate < today() })));
    const locs = await locMap(); const transitUnits = {};
    for (const m of await store.listMovements(merchantId)) if (m.bucket === 'ON_HAND' && locs.get(m.locationId)?.type === 'TRANSIT') transitUnits[m.itemId] = (transitUnits[m.itemId] ?? 0) + m.delta;
    const goodsValueByCurrency = {};
    for (const po of open) { const outstanding = po.lines.reduce((s, l) => s + Math.round(((l.qty - l.qtyReceived) * l.unitPriceMicro) / 10000), 0); goodsValueByCurrency[po.currency] = (goodsValueByCurrency[po.currency] ?? 0) + outstanding; }
    return deepFreeze({ orderedNotReceived: { units: lines.reduce((s, l) => s + l.qty, 0), lines, goodsValueMinorByCurrency: goodsValueByCurrency, note: 'goods price only; currencies are never added together' }, inTransitLocationUnits: transitUnits });
  }

  async function priceHistory({ supplierId, itemId }) {
    return deepFreeze((await store.list('quotes', merchantId)).filter((q) => q.supplierId === supplierId && q.itemId === itemId).sort((a, b) => a.revision - b.revision)
      .map((q) => ({ quoteId: q.id, revision: q.revision, status: q.status, currency: q.currency, tiers: q.tiers.map((t) => ({ minQty: t.minQty, unitPrice: microToString(t.unitPriceMicro) })), moq: q.moq, incoterm: q.incoterm, validUntil: q.validUntil, provenance: q.provenance, reason: q.reason, at: q.createdAt })));
  }

  /**
   * Reliability of one supplier from TRACEABLE records only. Each ratio shows numerator, denominator and the ids behind it; below MIN_SAMPLE it is NOT_MEASURABLE.
   * There is deliberately no single score: on-time, defect rate and incidents are different facts.
   */
  async function supplierMetrics(supplierId) {
    const supplier = (await store.get('suppliers', merchantId, reqId(supplierId, 'supplierId'))) ?? fail('SUPPLIER_NOT_FOUND', `supplier ${supplierId}`);
    const receipts = (await store.list('receipts', merchantId)).filter((r) => r.supplierId === supplier.id);
    const onTime = receipts.filter((r) => r.onTime);
    const ratio = (num, den, refs) => (den >= MIN_SAMPLE ? { status: 'MEASURED', numerator: num, denominator: den, ratio: num / den, refs } : { status: 'NOT_MEASURABLE', numerator: num, denominator: den, minSample: MIN_SAMPLE, refs });
    let delivered = 0; let defective = 0;
    for (const r of receipts) for (const l of r.lines) { delivered += l.qtyAccepted + l.qtyDefective; defective += l.qtyDefective; }
    const incidents = (await store.listIncidents(merchantId)).filter((i) => i.supplierId === supplier.id);
    const byType = {}; for (const i of incidents) byType[i.type] = (byType[i.type] ?? 0) + 1;
    return deepFreeze({
      supplierId: supplier.id, name: supplier.name, basis: 'goods receipts (a partial delivery is one receipt)',
      onTimeReceipts: ratio(onTime.length, receipts.length, receipts.map((r) => r.id)),
      defectRateUnits: delivered >= MIN_SAMPLE ? { status: 'MEASURED', numerator: defective, denominator: delivered, ratio: defective / delivered } : { status: 'NOT_MEASURABLE', numerator: defective, denominator: delivered, minSample: MIN_SAMPLE },
      incidents: { total: incidents.length, byType, high: incidents.filter((i) => i.severity === 'HIGH').length, ids: incidents.map((i) => i.id) },
    });
  }

  /**
   * Which supplier offers an item at the best landed cost for a quantity? Only current quotes (RECEIVED/SELECTED, not expired, MOQ respected) compete.
   * Landed cost comes from Finance's analyzePurchase with the caller's freight/duty inputs; without them the ranking is on goods price and says so.
   * Foreign currency needs an explicit fx; without it the quote is listed but not ranked (NOT_COMPARABLE). Nothing is chosen or ordered here.
   */
  async function compareSuppliers({ itemId, qty, costInputs = {}, fx = {}, expectedSellingPriceGross, sellingVatRatePct = '21' }) {
    reqId(itemId, 'itemId'); reqInt(qty, 'qty');
    const quotes = (await store.list('quotes', merchantId)).filter((q) => q.itemId === itemId && ['RECEIVED', 'SELECTED'].includes(q.status) && (!q.validUntil || q.validUntil >= today()));
    const rows = [];
    for (const q of quotes) {
      const supplier = await store.get('suppliers', merchantId, q.supplierId);
      const base = { quoteId: q.id, supplierId: q.supplierId, supplier: supplier?.name ?? null, currency: q.currency, incoterm: q.incoterm, leadTimeDays: q.leadTimeDays ?? supplier?.leadTimeDays ?? null, provenance: q.provenance, revision: q.revision };
      let micro;
      try { micro = resolveTierPrice(q, qty); } catch (e) { if (e instanceof ProcurementError) { rows.push({ ...base, status: 'NOT_ELIGIBLE', reason: e.code }); continue; } throw e; }
      const unit = microToString(micro);
      const rate = q.currency === 'EUR' ? null : fx[q.currency];
      if (q.currency !== 'EUR' && !rate) { rows.push({ ...base, status: 'NOT_COMPARABLE', reason: 'FX_REQUIRED', unitPrice: unit }); continue; }
      if (!/^\d+(\.\d{1,4})?$/.test(unit)) { rows.push({ ...base, status: 'NOT_COMPARABLE', reason: 'PRICE_PRECISION_EXCEEDS_FINANCE_ENGINE', unitPrice: unit }); continue; }
      const inputs = costInputs[q.supplierId] ?? costInputs.default ?? null;
      if (!inputs) {
        const eur = q.currency === 'EUR' ? Number(unit) : Number(unit) * Number(rate.rate);
        rows.push({ ...base, status: 'GOODS_ONLY', unitPrice: unit, goodsUnitEur: Math.round(eur * 1e4) / 1e4, landed: 'NOT_COMPUTED', reason: 'no freight/duty inputs supplied' }); continue;
      }
      const a = analyze({
        supplier_unit_price: unit, currency: q.currency, qty, ...inputs, expected_selling_price_gross: expectedSellingPriceGross, selling_vat_rate_pct: sellingVatRatePct,
        ...(rate ? { fx: { rate: rate.rate, provenance: 'USER_PROVIDED' } } : {}),
      });
      if (a.status !== 'ANALYZED') { rows.push({ ...base, status: 'NOT_COMPARABLE', reason: a.status, unitPrice: unit, errors: a.errors ?? null }); continue; }
      rows.push({ ...base, status: 'LANDED', unitPrice: unit, landedPerUnit: a.landed_cost.per_unit, cashRequirement: a.cash_requirement?.total ?? null, margin: a.margin ?? null, estimated: Boolean(rate), analysisVersion: a.version, fx: rate ? { rate: rate.rate, date: rate.date, source: rate.source } : null });
    }
    const rankable = rows.filter((r) => r.status === 'LANDED' || r.status === 'GOODS_ONLY');
    const allLanded = rankable.length > 0 && rankable.every((r) => r.status === 'LANDED');
    const key = (r) => (r.status === 'LANDED' ? Number(r.landedPerUnit) : r.goodsUnitEur);
    const ranking = [...rankable].sort((a, b) => key(a) - key(b)).map((r, i) => ({ rank: i + 1, quoteId: r.quoteId }));
    return deepFreeze({ itemId, qty, basis: allLanded ? 'LANDED_COST' : 'GOODS_PRICE_ONLY', ranking, offers: rows, decision: 'NONE: this compares, it never selects or orders' });
  }

  /**
   * Planned margin of an existing order, line by line, from Finance's engine. Needs the caller's expected selling price (gross) per item and the freight/duty
   * inputs per item: without them a line is NOT_COMPUTED. The order's own fx (if any) is the only rate used. These are estimates, never definitive tax figures.
   */
  async function plannedMargin({ poId, sellingPricesGross = {}, costInputs = {}, sellingVatRatePct = '21' }) {
    const po = (await store.get('purchaseOrders', merchantId, reqId(poId, 'poId'))) ?? fail('PO_NOT_FOUND', `purchase order ${poId}`);
    const lines = po.lines.map((l) => {
      const base = { lineId: l.id, itemId: l.itemId, qty: l.qty };
      const price = sellingPricesGross[l.itemId]; const inputs = costInputs[l.itemId];
      if (!price) return { ...base, status: 'NOT_COMPUTED', reason: 'NO_SELLING_PRICE' };
      if (!inputs) return { ...base, status: 'NOT_COMPUTED', reason: 'NO_COST_INPUTS' };
      const unit = microToString(l.unitPriceMicro);
      if (!/^\d+(\.\d{1,4})?$/.test(unit)) return { ...base, status: 'NOT_COMPUTED', reason: 'PRICE_PRECISION_EXCEEDS_FINANCE_ENGINE' };
      const a = analyze({ supplier_unit_price: unit, currency: po.currency, qty: l.qty, ...inputs, expected_selling_price_gross: price, selling_vat_rate_pct: sellingVatRatePct, ...(po.fx ? { fx: { rate: po.fx.rate, provenance: 'USER_PROVIDED' } } : {}) });
      if (a.status !== 'ANALYZED') return { ...base, status: 'NOT_COMPUTED', reason: a.status, errors: a.errors ?? null };
      return { ...base, status: 'ESTIMATED', landedPerUnit: a.landed_cost.per_unit, margin: a.margin ?? null, analysisVersion: a.version, fx: po.fx };
    });
    return deepFreeze({ poId: po.id, number: po.number, lines, note: 'estimates from stated inputs; not a tax filing and not definitive' });
  }

  /** Certificates / contracts that expired or expire within `withinDays`. A document without an expiry date is never reported as expiring. */
  async function expiringDocuments({ asOf = today(), withinDays = 60 } = {}) {
    reqDate(asOf, 'asOf'); reqInt(withinDays, 'withinDays', { min: 0, max: 3650 });
    const limit = new Date(Date.parse(`${asOf}T00:00:00Z`) + withinDays * 86400000).toISOString().slice(0, 10);
    const out = [];
    for (const s of await store.list('suppliers', merchantId)) for (const d of s.documents) if (d.expiresOn && d.expiresOn <= limit) out.push({ supplierId: s.id, supplier: s.name, documentId: d.id, type: d.type, name: d.name, expiresOn: d.expiresOn, expired: d.expiresOn < asOf, daysLeft: daysBetween(asOf, d.expiresOn) });
    return deepFreeze(out.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn)));
  }

  /**
   * Highest supplier unit price (4 decimals, the Finance engine's precision) that still reaches a target gross margin, by bisection over analyzePurchase.
   * It is a ceiling to negotiate against, not a quote: every input is stated by the caller and the result is ESTIMATED. NOT_COMPUTED / NOT_ACHIEVABLE otherwise.
   */
  async function targetUnitPrice({ currency, qty, sellingPriceGross, targetMarginPct, costInputs, fx, sellingVatRatePct = '21' }) {
    reqCurrency(currency); reqInt(qty, 'qty');
    const bps = pctToBps(targetMarginPct, 'targetMarginPct');
    if (!sellingPriceGross || !costInputs) return deepFreeze({ status: 'NOT_COMPUTED', reason: !sellingPriceGross ? 'NO_SELLING_PRICE' : 'NO_COST_INPUTS' });
    if (currency !== 'EUR' && !fx) return deepFreeze({ status: 'NOT_COMPUTED', reason: 'FX_REQUIRED' });
    const price = (units) => `${Math.floor(units / 1e4)}.${String(units % 1e4).padStart(4, '0')}`;
    const at = (units) => analyze({ supplier_unit_price: price(units), currency, qty, ...costInputs, expected_selling_price_gross: sellingPriceGross, selling_vat_rate_pct: sellingVatRatePct, ...(fx ? { fx: { rate: fx.rate, provenance: 'USER_PROVIDED' } } : {}) });
    const ok = (a) => a.status === 'ANALYZED' && a.margin && a.margin.gross_margin_bp >= bps;
    const first = at(1);
    if (first.status !== 'ANALYZED') return deepFreeze({ status: 'NOT_COMPUTED', reason: first.status, errors: first.errors ?? null });
    if (!ok(first)) return deepFreeze({ status: 'NOT_ACHIEVABLE', reason: 'even a near-zero supplier price misses the target margin with these costs and this selling price' });
    let lo = 1; let hi = 99999999; // 0.0001 .. 9999.9999
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (ok(at(mid))) lo = mid; else hi = mid - 1; }
    const best = at(lo);
    return deepFreeze({ status: 'ESTIMATED', currency, maxUnitPrice: price(lo), grossMarginBpAtMax: best.margin.gross_margin_bp, targetMarginBp: bps, landedPerUnit: best.landed_cost.per_unit, fx: fx ?? null, analysisVersion: best.version, note: 'a negotiation ceiling from stated inputs, not an offer and not a tax figure' });
  }

  return deepFreeze({
    item: (id) => store.get('items', merchantId, id), items: () => store.list('items', merchantId),
    supplier: (id) => store.get('suppliers', merchantId, id), suppliers: () => store.list('suppliers', merchantId),
    quote: (id) => store.get('quotes', merchantId, id), quotes: () => store.list('quotes', merchantId),
    purchaseOrder: (id) => store.get('purchaseOrders', merchantId, id),
    purchaseOrders: async ({ status } = {}) => (await orders()).filter((po) => !status || po.status === status),
    locations: () => store.list('locations', merchantId),
    events: async ({ objectId } = {}) => (await store.listEvents(merchantId)).filter((e) => !objectId || e.object.id === objectId),
    currentQuote: async ({ supplierId, itemId }) => (await store.list('quotes', merchantId)).find((q) => q.supplierId === supplierId && q.itemId === itemId && ['RECEIVED', 'SELECTED'].includes(q.status) && (!q.validUntil || q.validUntil >= today())) ?? null,
    stockPosition, stockPositions, incomingFor, reorderAlerts, delayedOrders, inTransit, priceHistory, supplierMetrics, compareSuppliers, plannedMargin, expiringDocuments, targetUnitPrice,
  });
}
