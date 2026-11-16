// Synthetic store/online sales for the Growth Croissance magasin tests - entirely made up. NOW = 2026-09-21T09:00Z (a Monday,
// UTC): the current window is the 8 complete weeks [2026-07-27, 2026-09-21), the previous one [2026-06-01, 2026-07-27).
// makeStoreData(spec): spec = { store: { cur, prev, price, prevPrice, weekday?, handle?, location? }, online: { cur, prev, price },
//   products?: [...ids] , history? } - counts of orders per window; every order has one line of one product (round robin).

import { mergeConfig } from '../../src/metrics/config.js';

export const NOW = new Date('2026-09-21T09:00:00Z');
export const TZ = 'UTC';
export const CONFIG = mergeConfig();
const DAY = 86400000;
const CUR_START = Date.UTC(2026, 6, 27); const PREV_START = Date.UTC(2026, 5, 1);

export function makeStoreData(spec, { merchantId = null, tag = 's' } = {}) {
  const m = (r) => (merchantId ? { ...r, merchant_id: merchantId } : r);
  const productIds = spec.products ?? ['p1', 'p2', 'p3'];
  const products = productIds.map((id) => m({ id: `${tag}-${id}`, title: `Produit ${id}`, product_type: id === 'p1' ? 'Cat A' : 'Cat B', source_created_at: '2025-01-01T00:00:00Z', source_status: 'ACTIVE', image_url: null, image_alt_text: null, source_id: `gid-${tag}-${id}` }));
  const variants = products.map((p) => m({ id: `${p.id}-v`, product_id: p.id, sku: `${p.id}-SKU`, title: 'Default', source_id: `gid-${p.id}-v` }));
  const locations = (spec.locations ?? ['L1']).map((l) => m({ id: `${tag}-${l}`, name: `Magasin ${l}`, type: 'retail', source_id: `gid-${tag}-${l}` }));
  const orders = []; const orderLines = []; let n = 0;
  const add = (channel, count, start, price, { weekday = null, handle = null, location = undefined, productPick = null } = {}) => {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      const dayOffset = weekday != null ? (weekday + 7 * (i % 8)) : (i * 5) % 56; // weekday: 0 = Monday
      const at = new Date(start + dayOffset * DAY + 11 * 3600000).toISOString();
      const pid = productPick ? productPick(i) : products[i % products.length].id;
      orders.push(m({ id: `${tag}-o${n}`, ordered_at: at, status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false,
        channel_handle: channel === 'store' ? (handle ?? 'pos') : 'online_store', source_name: channel === 'store' ? 'pos' : 'web',
        location_id: channel === 'store' ? (location === undefined ? locations[0]?.id ?? null : location) : null, customer_key: null }));
      orderLines.push(m({ id: `${tag}-l${n}`, order_id: `${tag}-o${n}`, variant_id: `${pid}-v`, title_snapshot: 't', sku_snapshot: null, quantity: 1, unit_price: price, discount_amount: 0, tax_amount: 0 }));
    }
  };
  const s = spec.store ?? {}; const o = spec.online ?? {};
  const pick = s.productWeights ? (i) => products[s.productWeights[i % s.productWeights.length]].id : null;
  if (s.cur) add('store', s.cur, CUR_START, s.price ?? 40, { weekday: s.weekday ?? null, handle: s.handle, location: s.location, productPick: pick });
  if (s.prev) add('store', s.prev, PREV_START, s.prevPrice ?? s.price ?? 40, { handle: s.handle, location: s.location });
  if (o.cur) add('online', o.cur, CUR_START, o.price ?? 60);
  if (o.prev) add('online', o.prev, PREV_START, o.prevPrice ?? o.price ?? 60);
  const firstOrderAt = spec.history === false ? (orders.length ? orders.map((x) => x.ordered_at).sort()[0] : null) : new Date(PREV_START - 30 * DAY).toISOString();
  return { products, variants, orders, orderLines, refunds: [], refundLines: [], costs: [], snapshots: [], collections: [], locations, firstOrderAt };
}

/** Above every sample gate on both channels and both windows. */
export const FULL = { store: { cur: 48, prev: 36, price: 40, prevPrice: 45 }, online: { cur: 40, prev: 40, price: 60 } };
