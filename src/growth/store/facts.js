// Growth > Croissance magasin - per-order facts. Built only from the shared ledger and the shared channel semantics
// (metrics/channels.js: `pos` and `point_of_sale` are the same in-store channel). One entry per order of ONE merchant:
//   { at, weekday, channel: 'store' | 'online' | 'other', locationId, identified, net, units, unitsRefunded, lines: [{ productId, units, net }] }
// `net` = the order's net sales ex tax minus the refunds of its own lines, dated by the order (observed, never a prediction).
// There is NO footfall field anywhere in Nordla: orders are sales, never visitors.

import { buildLedger } from '../../metrics/ledger.js';
import { aggregate } from '../../metrics/sales.js';
import { buildWeekBuckets } from '../../metrics/windows.js';
import { isOnlineChannel, isPosChannel } from '../../metrics/channels.js';

export const WEEKS = 8;
const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Current 8 complete weeks and the 8 weeks before them (same bucket rule as Produits Potentiels). */
export function storeWindows(now, timeZone) {
  const all = buildWeekBuckets(now, timeZone, 2 * WEEKS);
  const prev = all.slice(0, WEEKS); const cur = all.slice(WEEKS);
  return { current: cur, previous: prev, start: cur[0].start, end: cur[WEEKS - 1].end, prevStart: prev[0].start };
}

export function storeFacts({ data, now, timeZone, config }) {
  const ledger = buildLedger(data, { config });
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
  const raw = new Map(data.orders.map((o) => [o.id, o]));
  const linesByOrder = new Map();
  for (const l of ledger.lineFacts) (linesByOrder.get(l.orderId) ?? linesByOrder.set(l.orderId, []).get(l.orderId)).push(l);
  const refundsByLine = new Map();
  for (const r of ledger.refundFacts) (refundsByLine.get(r.orderLineId) ?? refundsByLine.set(r.orderLineId, []).get(r.orderLineId)).push(r);

  const orders = [];
  for (const o of ledger.orders) {
    const r = raw.get(o.id);
    if (!r) continue;
    const handle = r.channel_handle ?? r.source_name ?? null; // same precedence as the marketing taxonomy
    const channel = isPosChannel(handle, config) ? 'store' : isOnlineChannel(handle, config) ? 'online' : 'other';
    const lines = (linesByOrder.get(o.id) ?? []).map((l) => {
      const a = aggregate([l], refundsByLine.get(l.orderLineId) ?? [], config);
      return { productId: l.productId ?? null, units: a.units_sold, unitsRefunded: a.units_refunded, net: a.net_sales_ex_tax };
    });
    orders.push({
      at: o.orderedAt, weekday: WEEKDAY_INDEX[weekdayFmt.format(o.orderedAt)], channel, locationId: r.location_id ?? null,
      identified: Boolean(r.customer_key),
      net: Math.round(lines.reduce((s, l) => s + l.net, 0) * 100) / 100,
      units: lines.reduce((s, l) => s + l.units, 0), unitsRefunded: lines.reduce((s, l) => s + l.unitsRefunded, 0),
      lines,
    });
  }
  orders.sort((a, b) => a.at - b.at);
  const products = new Map((data.products ?? []).map((p) => [p.id, { title: p.title, imageUrl: p.image_url || null, category: (p.product_type ?? '').trim() || null }]));
  return {
    orders, products, locations: data.locations ?? [], windows: storeWindows(now, timeZone),
    historyStart: data.firstOrderAt ? new Date(data.firstOrderAt) : (orders.length ? orders[0].at : null), currency: ledger.currency,
  };
}
