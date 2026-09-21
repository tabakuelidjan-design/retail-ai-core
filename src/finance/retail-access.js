// Read-only window onto Retail Core for the finance dashboard: order search for linking, and the validated ledger for
// linkage checks and the accountant pack. It exposes NO customer data: an order is shown by reference, date, channel, total and
// item titles only. Nothing here recomputes sales: totals come from the Phase 2A ledger via orderTotalsFromLedger.

import { orderTotalsFromLedger } from './linking.js';

const CHANNEL_LABEL = { pos: 'POS', web: 'Online', online_store: 'Online' };
const cents = (n) => (n / 100).toFixed(2);

const isDefaultTitle = (t) => !t || /^default title$/i.test(String(t).trim());
/** Flatten products x variants (read-only copy). vatRateBp is set only when every sale of that variant used the same rate. */
function catalogRows(data, onlyVariantId = null) {
  const products = new Map((data.products ?? []).map((p) => [p.id, p]));
  const rates = new Map();
  for (const l of data.orderLines ?? []) {
    if (!l.variant_id || l.tax_rate_bp == null) continue;
    (rates.get(l.variant_id) ?? rates.set(l.variant_id, new Set()).get(l.variant_id)).add(Number(l.tax_rate_bp));
  }
  // available stock = latest snapshot per location, summed; null when the variant has never been counted
  const latest = new Map();
  for (const sn of data.snapshots ?? []) {
    const k = `${sn.variant_id}|${sn.location_id}`; const cur = latest.get(k);
    if (!cur || String(sn.synced_at) > String(cur.synced_at)) latest.set(k, sn);
  }
  const stock = new Map();
  for (const sn of latest.values()) stock.set(sn.variant_id, (stock.get(sn.variant_id) ?? 0) + Number(sn.quantity ?? 0));
  const out = [];
  for (const v of data.variants ?? []) {
    if (onlyVariantId && v.id !== onlyVariantId) continue;
    const p = products.get(v.product_id);
    if (!p) continue;
    const set = rates.get(v.id);
    out.push({
      productId: p.id, variantId: v.id, productSourceId: p.source_id ?? null, variantSourceId: v.source_id ?? null,
      productTitle: p.title, variantTitle: isDefaultTitle(v.title) ? null : v.title, handle: p.handle ?? null, sku: v.sku || null,
      status: p.source_status ?? null, vatRateBp: set && set.size === 1 ? [...set][0] : null, stock: stock.has(v.id) ? stock.get(v.id) : null,
    });
  }
  return out;
}

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

    /**
     * READ-ONLY catalogue search over the Retail Core products/variants (never a second catalogue, never written to).
     * Matches product title, variant title, handle and SKU; every word must match. SKU is descriptive only, never an identity:
     * the canonical ids are the Retail Core product and variant ids.
     */
    async searchCatalog(q, limit = 20) {
      const { data } = await get();
      const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
      if (!words.length) return [];
      const rows = catalogRows(data);
      const scored = [];
      for (const r of rows) {
        const hay = `${r.productTitle} ${r.variantTitle ?? ''} ${r.handle ?? ''} ${r.sku ?? ''}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
        const sku = String(r.sku ?? '').toLowerCase();
        const score = (sku && words.some((w) => sku === w) ? 0 : sku && words.some((w) => sku.startsWith(w)) ? 1 : 2) + (r.status === 'ACTIVE' || r.status == null ? 0 : 3);
        scored.push({ score, r });
      }
      scored.sort((a, b) => a.score - b.score || a.r.productTitle.localeCompare(b.r.productTitle) || String(a.r.variantTitle ?? '').localeCompare(String(b.r.variantTitle ?? '')));
      return scored.slice(0, Math.min(limit, 50)).map((x) => x.r);
    },

    async getCatalogVariant(variantId) {
      const { data } = await get();
      return catalogRows(data, variantId)[0] ?? null;
    },

    async getOrder(sourceOrderId, invoicedByOrder = new Map()) {
      return (await this.searchOrders({ limit: 100000 }, invoicedByOrder)).find((o) => o.sourceOrderId === sourceOrderId) ?? null;
    },
  };
}
