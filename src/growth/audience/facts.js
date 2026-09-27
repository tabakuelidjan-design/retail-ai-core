// Growth > Audience - per-order facts. Built only from the shared ledger primitives and the customers engine's own order
// classification (orderGroup): nothing is re-defined here. One entry per order of the loaded history of ONE merchant:
//   { at, net, multiProduct, group, key, idx }
// `key` is the pseudonymous customer key (keyed hash) or null; it stays inside the Growth engine (audience.js never outputs it).
// `idx` is the source's customer order index, used only when the order is journey-ready (same rule as the Clients workspace).
// `net` = the order's net sales ex tax minus the refunds of its own lines, dated by the order (observed value, not a prediction).

import { buildLedger } from '../../metrics/ledger.js';
import { aggregate } from '../../metrics/sales.js';
import { addDays, localDateString, localMidnight } from '../../metrics/windows.js';
import { orderGroup } from '../../customers/facts.js';

/** The page's fixed window: the last 90 complete days (customers.shortHistoryDays, Explorer's last recency cut-off). */
export const WINDOW_DAYS = 90;

export function audienceWindow(now, timeZone, days = WINDOW_DAYS) {
  const today = localDateString(now, timeZone);
  const end = localMidnight(today, timeZone);
  const start = localMidnight(addDays(today, -days), timeZone);
  const prevStart = localMidnight(addDays(today, -2 * days), timeZone);
  return { start, end, prevStart, days };
}

/**
 * @param {{ data: object, now: Date, timeZone: string, config: object }} p  data = loadDataset() rows of ONE merchant
 * @returns {{ orders: object[], window: object, historyStart: Date|null, currency: string }}
 */
export function audienceFacts({ data, now, timeZone, config }) {
  const ledger = buildLedger(data, { config });
  const online = new Set(config.marketing.onlineChannelHandles);
  const pos = new Set(config.marketing.posChannelHandles);
  const raw = new Map(data.orders.map((o) => [o.id, o]));
  const linesByOrder = new Map();
  for (const l of ledger.lineFacts) (linesByOrder.get(l.orderId) ?? linesByOrder.set(l.orderId, []).get(l.orderId)).push(l);
  const orderOfLine = new Map(ledger.lineFacts.map((l) => [l.orderLineId, l.orderId]));
  const refundsByOrder = new Map();
  for (const r of ledger.refundFacts) { const o = orderOfLine.get(r.orderLineId); if (o) (refundsByOrder.get(o) ?? refundsByOrder.set(o, []).get(o)).push(r); }

  const orders = [];
  for (const o of ledger.orders) {
    const r = raw.get(o.id);
    if (!r) continue;
    const lines = linesByOrder.get(o.id) ?? [];
    const idx = r.journey_ready === true && Number.isFinite(Number(r.customer_order_index)) && r.customer_order_index != null ? Number(r.customer_order_index) : null;
    orders.push({
      at: o.orderedAt,
      net: aggregate(lines, refundsByOrder.get(o.id) ?? [], config).net_sales_ex_tax,
      multiProduct: new Set(lines.map((l) => l.productId).filter(Boolean)).size >= 2,
      group: orderGroup(r, { online: online.has(r.channel_handle), pos: pos.has(r.channel_handle) }),
      key: r.customer_key || null,
      idx,
    });
  }
  orders.sort((a, b) => a.at - b.at);
  return { orders, window: audienceWindow(now, timeZone), historyStart: orders.length ? orders[0].at : null, currency: ledger.currency };
}
