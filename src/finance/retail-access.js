// Read-only window onto Retail Core for the finance dashboard: order search for linking, and the validated ledger for
// linkage checks and the accountant pack. It exposes NO customer data: an order is shown by reference, date, channel, total and
// item titles only. Nothing here recomputes sales: totals come from the Phase 2A ledger via orderTotalsFromLedger.

import { orderTotalsFromLedger } from './linking.js';

const CHANNEL_LABEL = { pos: 'POS', web: 'Online', online_store: 'Online' };
const cents = (n) => (n / 100).toFixed(2);

/** @param {{loadRetail: (sinceDate?: string) => Promise<{ledger: object, data: object}>, listOrderRefs?: () => Promise<Map<string,string>>, ttlMs?: number, nowMs?: () => number}} deps */
export function createRetailAccess({ loadRetail, listOrderRefs = async () => new Map(), ttlMs = 60_000, nowMs = () => Date.now() }) {
  let cache = null;
  const get = async (sinceDate) => {
    if (cache && cache.since === (sinceDate ?? null) && nowMs() - cache.at < ttlMs) return cache.value;
    const value = await loadRetail(sinceDate);
    cache = { at: nowMs(), since: sinceDate ?? null, value };
    return value;
  };
  return {
    ledgerData: get,
    clearCache: () => { cache = null; },

    /**
     * Search shop/POS orders to link an invoice to. Filters: free text (reference or item title), date range, amount range.
     * @param {{q?: string, from?: string, to?: string, minCents?: number, maxCents?: number, limit?: number}} f
     * @param {Map<string, {id: string, number: string|null, status: string}>} invoicedByOrder orders already covered by an active invoice
     */
    async searchOrders(f = {}, invoicedByOrder = new Map()) {
      const { ledger, data } = await get();
      const totals = orderTotalsFromLedger(ledger);
      const refs = await listOrderRefs();
      const channelOf = new Map(data.orders.map((o) => [o.id, o.channel_handle]));
      const itemsOf = new Map();
      for (const l of ledger.lineFacts) (itemsOf.get(l.orderId) ?? itemsOf.set(l.orderId, []).get(l.orderId)).push(l.title);
      const q = (f.q ?? '').trim().toLowerCase();
      const rows = [...totals.values()].map((t) => {
        const items = itemsOf.get(t.orderId) ?? [];
        const date = t.at.toISOString().slice(0, 10);
        return {
          sourceOrderId: t.orderId, ref: refs.get(t.orderId) ?? t.orderId.slice(0, 8), date,
          channel: CHANNEL_LABEL[channelOf.get(t.orderId)] ?? String(channelOf.get(t.orderId) ?? 'Other'),
          totalCents: t.grossCents, total: cents(t.grossCents), refunded: t.refundedCents > 0 ? cents(t.refundedCents) : null,
          items: items.slice(0, 3), moreItems: Math.max(0, items.length - 3),
          invoiced: invoicedByOrder.get(t.orderId) ?? null,
        };
      }).filter((r) => (!f.from || r.date >= f.from) && (!f.to || r.date <= f.to)
        && (f.minCents == null || r.totalCents >= f.minCents) && (f.maxCents == null || r.totalCents <= f.maxCents)
        && (!q || String(r.ref).toLowerCase().includes(q) || r.items.some((i) => String(i).toLowerCase().includes(q)) || r.total === q.replace(',', '.')));
      rows.sort((a, b) => b.date.localeCompare(a.date) || String(b.ref).localeCompare(String(a.ref)));
      return rows.slice(0, Math.min(f.limit ?? 30, 100));
    },

    async getOrder(sourceOrderId, invoicedByOrder = new Map()) {
      return (await this.searchOrders({ limit: 100000 }, invoicedByOrder)).find((o) => o.sourceOrderId === sourceOrderId) ?? null;
    },
  };
}
