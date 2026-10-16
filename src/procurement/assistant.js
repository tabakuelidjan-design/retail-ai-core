// Stock / Achats tool contract for "Parle à Nordla" (or any assistant). READ tools answer from the ledger and the orders; PROPOSAL tools only describe what a
// human could do and what approval it would need. This module is built from the READ side (queries) alone: it holds no store, no command service and no
// approval, so no tool call - however ambiguous the request - can buy, pay, receive, adjust or write. (NDR-009, NDR-011.)
import { resolveTierPrice } from './service.js';
import { ProcurementError } from './errors.js';
import { deepFreeze, microToString } from './util.js';

const READ = 'READ_ONLY';
const PROPOSE = 'PROPOSE_ONLY';

export function createProcurementAssistantTools({ queries }) {
  const bySku = (sku) => (typeof sku === 'string' ? queries.items().find((i) => i.sku === sku.trim()) ?? null : null);
  const clarify = (question, extra = {}) => ({ status: 'NEED_CLARIFICATION', executed: false, question, ...extra });

  function itemMatches(text) {
    const t = String(text ?? '').trim().toLowerCase(); if (!t) return [];
    return queries.items().filter((i) => i.sku.toLowerCase() === t || i.barcode === text || i.name.toLowerCase().includes(t)).map((i) => ({ itemId: i.id, sku: i.sku, name: i.name }));
  }

  const tools = {
    find_item: { authority: READ, description: 'Find catalogue items by SKU, barcode or name. Several matches are returned as candidates, never silently narrowed.',
      run: ({ text }) => { const m = itemMatches(text); return { status: m.length === 1 ? 'OK' : m.length ? 'AMBIGUOUS' : 'NOT_FOUND', candidates: m }; } },
    stock_position: { authority: READ, description: 'On hand, reserved, available, incoming, in transit, quarantine and valuation of one item.',
      run: ({ sku }) => { const it = bySku(sku); return it ? { status: 'OK', position: queries.stockPosition(it.id) } : clarify('Which item (exact SKU)?', { candidates: itemMatches(sku) }); } },
    stock_overview: { authority: READ, description: 'Positions and valuation of every active item.', run: () => ({ status: 'OK', ...queries.stockPositions() }) },
    goods_in_transit: { authority: READ, description: 'Goods ordered and not received, and units in TRANSIT locations (two separate facts).', run: () => ({ status: 'OK', ...queries.inTransit() }) },
    open_purchase_orders: { authority: READ, description: 'Purchase orders by status.', run: ({ status } = {}) => ({ status: 'OK', orders: queries.purchaseOrders({ status }).map((p) => ({ id: p.id, number: p.number, status: p.status, supplierId: p.supplierId, totalMinor: p.totalMinor, currency: p.currency, expectedDate: p.expectedDate })) }) },
    delayed_orders: { authority: READ, description: 'Open orders past their expected date.', run: ({ asOf } = {}) => ({ status: 'OK', delayed: queries.delayedOrders(asOf) }) },
    reorder_alerts: { authority: READ, description: 'Items at or below their reorder point, counting incoming but never as available.', run: () => ({ status: 'OK', alerts: queries.reorderAlerts() }) },
    price_history: { authority: READ, description: 'Every quote revision for a supplier and item (negotiated-price history).',
      run: ({ supplierId, sku }) => { const it = bySku(sku); return it && supplierId ? { status: 'OK', history: queries.priceHistory({ supplierId, itemId: it.id }) } : clarify('Which supplier and exact SKU?'); } },
    supplier_reliability: { authority: READ, description: 'Traceable reliability facts (on-time receipts, defect rate, incidents). NOT_MEASURABLE below the minimum sample; no composite score.',
      run: ({ supplierId }) => (supplierId ? { status: 'OK', metrics: queries.supplierMetrics(supplierId) } : clarify('Which supplier?')) },
    best_landed_cost_supplier: { authority: READ, description: 'Compare current quotes for an item and quantity on landed cost (Finance engine) or, without cost inputs, on goods price. Compares only; selects nothing.',
      run: ({ sku, qty, costInputs, fx, expectedSellingPriceGross }) => {
        const it = bySku(sku); if (!it || !Number.isInteger(qty)) return clarify('Which exact SKU and which quantity?', { candidates: itemMatches(sku) });
        return { status: 'OK', comparison: queries.compareSuppliers({ itemId: it.id, qty, costInputs, fx, expectedSellingPriceGross }) };
      } },
    planned_margin: { authority: READ, description: 'Estimated margin of a purchase order from stated selling prices and cost inputs.',
      run: (a) => (a?.poId ? { status: 'OK', margin: queries.plannedMargin(a) } : clarify('Which purchase order?')) },

    target_price: { authority: READ, description: 'Highest supplier unit price that still reaches a target gross margin (negotiation ceiling from stated inputs; not an offer).',
      run: (a) => (a?.currency && Number.isInteger(a.qty) && a.sellingPriceGross && a.targetMarginPct ? { status: 'OK', target: queries.targetUnitPrice(a) } : clarify('Which currency, quantity, selling price (gross) and target margin?')) },
    expiring_supplier_documents: { authority: READ, description: 'Supplier certificates / contracts expired or expiring soon.', run: (a = {}) => ({ status: 'OK', documents: queries.expiringDocuments(a) }) },
    propose_purchase_order: { authority: PROPOSE, description: 'Check a purchase request against current quotes (MOQ, tiers, validity). Creates nothing.',
      run: ({ supplierId, lines = [] }) => {
        if (!supplierId || !lines.length) return clarify('Which supplier, and which items and quantities?');
        const checked = lines.map((l) => {
          const it = bySku(l.sku); if (!it) return { sku: l.sku, status: 'NEED_CLARIFICATION', question: 'Unknown SKU', candidates: itemMatches(l.sku) };
          const q = queries.currentQuote({ supplierId, itemId: it.id });
          if (!q) return { sku: l.sku, itemId: it.id, status: 'NO_CURRENT_QUOTE' };
          try { return { sku: l.sku, itemId: it.id, quoteId: q.id, qty: l.qty, unitPrice: microToString(resolveTierPrice(q, l.qty)), currency: q.currency, status: 'OK' }; } catch (e) { if (e instanceof ProcurementError) return { sku: l.sku, itemId: it.id, status: 'BLOCKED', code: e.code, reason: e.message }; throw e; }
        });
        return { status: checked.every((c) => c.status === 'OK') ? 'PROPOSED' : 'PROPOSAL_HAS_ISSUES', executed: false, lines: checked, requires_approval: ['BUYING.approve_purchase_plan', 'BUYING.place_order', 'STOCK_SALES.receive_goods (on arrival)'], next: 'a human creates the order with createPurchaseOrder and approves it by name' };
      } },
    propose_stock_adjustment: { authority: PROPOSE, description: 'Describe a stock adjustment and whether the ledger would accept it. Changes nothing.',
      run: ({ sku, locationId, delta, reason }) => {
        const it = bySku(sku); if (!it || !locationId || !Number.isInteger(delta) || delta === 0 || !reason) return clarify('Which exact SKU, location, non-zero quantity change and reason?', { candidates: itemMatches(sku) });
        const loc = queries.stockPosition(it.id).locations.find((l) => l.locationId === locationId);
        const onHand = loc?.onHand ?? 0; const reserved = loc?.reserved ?? 0; const after = onHand + delta;
        const refusal = after < 0 ? 'INSUFFICIENT_STOCK' : after < reserved ? 'RESERVED_STOCK' : null;
        return { status: refusal ? 'WOULD_BE_REFUSED' : 'PROPOSED', executed: false, itemId: it.id, locationId, onHand, afterOnHand: after, code: refusal, requires_approval: ['STOCK_SALES.adjust_on_hand'], next: 'a human posts adjustStock with a named approval' };
      } },
  };
  const catalog = Object.entries(tools).map(([name, t]) => ({ name, authority: t.authority, description: t.description }));
  return deepFreeze({
    catalog,
    /** Run one tool. Unknown tool -> explicit refusal. A tool failure is returned as data; nothing is retried or escalated. */
    call(name, args = {}) {
      const t = tools[name]; if (!t) return { status: 'UNKNOWN_TOOL', executed: false };
      try { return deepFreeze({ tool: name, authority: t.authority, ...t.run(args) }); } catch (e) { return { tool: name, status: 'ERROR', executed: false, code: e.code ?? 'ERROR', message: e.message }; }
    },
  });
}
