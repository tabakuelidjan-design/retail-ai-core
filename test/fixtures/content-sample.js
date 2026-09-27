// Synthetic catalog for the Growth Contenu tests - entirely made up. NOW = 2026-09-21T09:00Z (UTC).
// makeContentData(products): each product spec { id, title?, type?, image?, alt?, status?, collection?, skus?, units? }.

import { mergeConfig } from '../../src/metrics/config.js';

export const NOW = new Date('2026-09-21T09:00:00Z');
export const TZ = 'UTC';
export const CONFIG = mergeConfig();

export function makeContentData(specs, { merchantId = null, withImagesElsewhere = true } = {}) {
  const m = (r) => (merchantId ? { ...r, merchant_id: merchantId } : r);
  const products = []; const variants = []; const collections = []; const orders = []; const orderLines = [];
  const all = withImagesElsewhere ? [...specs, { id: 'ref', title: 'Référence avec image', type: 'Réf', image: 'https://cdn.shopify.com/ref.jpg', alt: 'Réf', collection: true, skus: ['REF-1'] }] : specs;
  let n = 0;
  for (const s of all) {
    products.push(m({ id: s.id, title: s.title ?? `Produit ${s.id}`, handle: s.id, product_type: s.type ?? null, source_created_at: '2025-01-01T00:00:00Z', source_status: s.status ?? 'ACTIVE', image_url: s.image ?? null, image_alt_text: s.alt ?? null, source_id: `gid-${s.id}` }));
    (s.skus ?? ['SKU-' + s.id]).forEach((sku, i) => variants.push(m({ id: `${s.id}-v${i}`, product_id: s.id, sku, title: 'Default', source_id: `gid-${s.id}-v${i}` })));
    if (s.collection) collections.push(m({ product_id: s.id, source_id: `col-${s.id}`, title: 'Collection', is_current: true }));
    for (let u = 0; u < (s.units ?? 0); u += 1) {
      n += 1;
      orders.push(m({ id: `o${n}`, ordered_at: new Date(NOW.getTime() - (3 + (u % 40)) * 86400000).toISOString(), status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false, channel_handle: 'online_store' }));
      orderLines.push(m({ id: `l${n}`, order_id: `o${n}`, variant_id: `${s.id}-v0`, title_snapshot: 't', sku_snapshot: null, quantity: 1, unit_price: 20, discount_amount: 0, tax_amount: 0 }));
    }
  }
  return { products, variants, orders, orderLines, refunds: [], refundLines: [], costs: [], snapshots: [], collections };
}
