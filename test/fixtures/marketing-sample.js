// Synthetic marketing dataset - entirely made up. UTC, NOW = 2026-09-21T09:00Z, available window starts 2026-07-23.
//
// order  when        kind      last visit                                            customer idx
// o1     09-10       POS       -                                                     (n/a)
// o2     09-12       online    Google / SEO / www.google.com / landing /products/widget      1   (refunded: 1 unit)
// o3     09-13       online    utm newsletter/email/launch-1 / landing /en/products/gadget    2
// o4     09-14       online    NO recorded visit (unattributed)                       1
// o5     09-15       online    utm chatgpt.com only (no medium/campaign) / /collections/things 1
// o6     09-16       online    utm google/cpc/brand-search, source_type SEO (contradiction)    1
// o7     09-17       online    recorded direct / landing /                             1
// o8     09-18       POS       has a visit row (contradiction)

import { mergeConfig } from '../../src/metrics/config.js';
import { buildLedger } from '../../src/metrics/ledger.js';

export const NOW = new Date('2026-09-21T09:00:00Z');
export const TZ = 'UTC';

const visit = (o, touch, v) => ({ order_id: o, touch, occurred_at: null, source: null, source_type: null, source_description: null, referrer_host: null, landing_path: null, utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null, ...v });

export function makeMarketingData() {
  const products = [
    { id: 'p1', title: 'Widget', handle: 'widget', product_type: 'Alpha', source_status: 'ACTIVE', source_created_at: '2026-03-01T00:00:00Z' },
    { id: 'p2', title: 'Gadget', handle: 'gadget', product_type: 'Beta', source_status: 'ACTIVE', source_created_at: '2026-03-01T00:00:00Z' },
  ];
  const variants = [{ id: 'v1', product_id: 'p1', sku: 'SAME', title: 'Default' }, { id: 'v2', product_id: 'p2', sku: 'SAME', title: 'Default' }];
  const order = (id, day, channel, idx = 1) => ({
    id, ordered_at: `2026-09-${day}T10:00:00Z`, status: 'PAID', currency: 'EUR', taxes_included: true, is_test: false,
    source_name: channel, channel_handle: channel, customer_order_index: idx, journey_ready: true,
  });
  const orders = [order('o1', '10', 'pos'), order('o2', '12', 'web'), order('o3', '13', 'web', 2), order('o4', '14', 'web'), order('o5', '15', 'web'), order('o6', '16', 'web'), order('o7', '17', 'web'), order('o8', '18', 'pos')];
  const line = (id, order_id, variant_id, quantity, unit_price, discount_amount, tax_amount) => ({ id, order_id, variant_id, title_snapshot: id, sku_snapshot: 'SAME', quantity, unit_price, discount_amount, tax_amount });
  const orderLines = [
    line('l1', 'o1', 'v1', 2, 25, 5, 7.81), line('l2', 'o2', 'v1', 1, 20, 0, 3.47), line('l3', 'o3', 'v2', 1, 10, 0, 1.74), line('l4', 'o4', 'v1', 1, 20, 0, 3.47),
    line('l5', 'o5', 'v2', 1, 10, 0, 1.74), line('l6', 'o6', 'v1', 1, 20, 0, 3.47), line('l7', 'o7', 'v2', 1, 10, 0, 1.74), line('l8', 'o8', 'v1', 1, 20, 0, 3.47),
  ];
  const orderAttribution = [
    visit('o2', 'last_visit', { source: 'Google', source_type: 'SEO', referrer_host: 'www.google.com', landing_path: '/products/widget' }),
    visit('o3', 'last_visit', { source: 'newsletter', utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'launch-1', landing_path: '/en/products/gadget' }),
    visit('o5', 'last_visit', { source: 'chatgpt.com', utm_source: 'chatgpt.com', landing_path: '/collections/things' }),
    visit('o6', 'last_visit', { source: 'google', source_type: 'SEO', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'brand-search', landing_path: '/products/widget' }),
    visit('o7', 'last_visit', { source: 'direct', landing_path: '/' }),
    visit('o8', 'last_visit', { source: 'Google', landing_path: '/' }),
  ];
  return {
    products, variants, orders, orderLines, orderAttribution,
    refunds: [{ id: 'r1', order_id: 'o2', amount: 20, refunded_at: '2026-09-15T09:00:00Z' }],
    refundLines: [{ id: 'rl1', refund_id: 'r1', order_line_id: 'l2', quantity: 1, amount: 20, tax_amount: 3.47 }],
    costs: [], snapshots: [], collections: [{ product_id: 'p1', source_id: 'c1', title: 'Featured', is_current: true }],
  };
}

export const config = (overrides = {}) => mergeConfig({ marketing: { targetMarkets: ['Belgium', 'France'], ...overrides } });
export const ledgerOf = (data, cfg = config()) => buildLedger(data, { config: cfg });

export function cleanTrafficRaw(over = {}) {
  return {
    source_system: 'test_analytics', method: 'manual_export', scope: 'online_store', window: { start: '2026-09-10', end: '2026-09-21' },
    dimensions: [
      { dimension: 'channel', complete: true, rows: [{ key: 'direct/', sessions: 600, completed_checkout_sessions: 2 }, { key: 'search/google', sessions: 300, completed_checkout_sessions: 2 }, { key: 'social/instagram', sessions: 100, completed_checkout_sessions: 2 }] },
      { dimension: 'country', complete: true, rows: [{ key: 'Belgium', sessions: 900 }, { key: 'France', sessions: 100 }] },
      { dimension: 'landing_page', complete: false, rows: [{ key: '/', sessions: 800 }, { key: '/products/widget', sessions: 120 }, { key: '/en/products/widget', sessions: 30 }, { key: '/products/gadget', sessions: 50 }] },
    ],
    ...over,
  };
}
