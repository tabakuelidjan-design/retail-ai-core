// Synthetic customer dataset for the Growth Audience tests - entirely made up. NOW = 2026-09-21T09:00Z, timezone UTC, so the
// Audience window is [2026-06-23, 2026-09-21) and the previous one [2026-03-25, 2026-06-23).
// Customers carry a fake pseudonymous key (never a real hash); orders are journey-ready with a source order index unless stated.
//
// makeAudienceData(groups): groups = { loyal, returning, newReturned, new, reactivate, occasional, unknown, anonymous } counts, each
// with the order pattern below (days before NOW), and an optional price per group.

import { mergeConfig } from '../../src/metrics/config.js';

export const NOW = new Date('2026-09-21T09:00:00Z');
export const TZ = 'UTC';
export const CONFIG = mergeConfig();
const DAY = 86400000;

/** days-before-NOW of each order, and whether the source index is trusted. */
export const PATTERNS = {
  loyal: [200, 120, 30], // 3 orders, one recent
  returning: [150, 20], // 2 orders, one recent
  newReturned: [60, 15], // first order recent (index 1), came back
  new: [40], // first order recent (index 1)
  reactivate: [250, 130], // 2 orders, none in the last 90 days
  occasional: [150], // 1 old order
  unknown: [25], // 1 recent order without a trusted index (e.g. POS)
  anonymous: [10], // no customer key at all
};
export const DEFAULT_PRICES = { loyal: 80, returning: 60, newReturned: 50, new: 40, reactivate: 70, occasional: 45, unknown: 35, anonymous: 30 };

export function makeAudienceData(groups, { prices = {}, merchantId = null, tag = 'm' } = {}) {
  const products = [{ id: `${tag}-p1`, title: 'Produit A', product_type: 'Cat', source_created_at: '2025-01-01T00:00:00Z', source_status: 'ACTIVE' }, { id: `${tag}-p2`, title: 'Produit B', product_type: 'Cat', source_created_at: '2025-01-01T00:00:00Z', source_status: 'ACTIVE' }];
  const variants = products.map((p, i) => ({ id: `${tag}-v${i + 1}`, product_id: p.id, sku: `${tag}-SKU${i + 1}`, title: 'Default' }));
  const orders = []; const orderLines = [];
  let n = 0;
  for (const [group, count] of Object.entries(groups)) {
    const price = prices[group] ?? DEFAULT_PRICES[group];
    for (let c = 0; c < count; c += 1) {
      const key = group === 'anonymous' ? null : `${tag}-cust-${group}-${String(c).padStart(4, '0')}`;
      PATTERNS[group].forEach((daysAgo, i) => {
        n += 1;
        const id = `${tag}-o${n}`;
        const trusted = group !== 'unknown' && group !== 'anonymous';
        orders.push({
          id, ordered_at: new Date(NOW.getTime() - daysAgo * DAY - (c % 7) * 3600000).toISOString(), status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false,
          channel_handle: group === 'unknown' || group === 'anonymous' ? 'pos' : 'online_store', customer_key: key,
          customer_order_index: trusted ? i + 1 : null, journey_ready: trusted,
          ...(merchantId ? { merchant_id: merchantId } : {}),
        });
        const multi = c % 4 === 0;
        orderLines.push({ id: `${tag}-l${n}a`, order_id: id, variant_id: `${tag}-v1`, title_snapshot: 'A', sku_snapshot: `${tag}-SKU1`, quantity: 1, unit_price: multi ? price / 2 : price, discount_amount: 0, tax_amount: 0 });
        if (multi) orderLines.push({ id: `${tag}-l${n}b`, order_id: id, variant_id: `${tag}-v2`, title_snapshot: 'B', sku_snapshot: `${tag}-SKU2`, quantity: 1, unit_price: price / 2, discount_amount: 0, tax_amount: 0 });
      });
    }
  }
  const withM = (rows) => (merchantId ? rows.map((r) => ({ ...r, merchant_id: merchantId })) : rows);
  return { products: withM(products), variants: withM(variants), orders, orderLines: withM(orderLines), refunds: [], refundLines: [], costs: [], snapshots: [], collections: [] };
}

/** A realistic mix above every sample gate. */
export const FULL = { loyal: 60, returning: 45, newReturned: 32, new: 90, reactivate: 70, occasional: 80, unknown: 20, anonymous: 40 };
