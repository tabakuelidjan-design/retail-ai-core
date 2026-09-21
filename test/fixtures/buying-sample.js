// Synthetic Phase 2B-shaped facts for the Buying Intelligence tests. Everything
// here is made up. Only the fields the buying layer reads are populated.

import { mergeConfig } from '../../src/metrics/config.js';

export const NOW = new Date('2026-09-21T09:00:00Z');
export const SNAPSHOT = '2026-09-21T06:00:00Z';

/** A catalog product fact. */
export function peer({ id, type = null, collections = [], observable = 8, units = 0, velocity = null, price = null, stock = 0, cls = 'NO_SALE_IN_WINDOW', status = 'ACTIVE' }) {
  return {
    kind: 'product', product_key: id, shopify_product_id: `gid://shopify/Product/${id}`, matched: true, title: `Peer ${id}`, product_type: type, category: type ?? 'UNCLASSIFIED',
    source_status: status, collections: collections.map((c) => ({ source_id: c, title: c })), observable_weeks: observable,
    demand: { units_8w: units, velocity_8w: velocity, avg_net_unit_price_ex_tax: price },
    inventory: { stock_units: stock, inventory_class: cls },
  };
}

/** A variant fact (stock only). `quality` is the Phase 2B stock_quality. */
export function stockVariant(productKey, id, units, quality = 'UNVERIFIED') {
  return { kind: 'variant', variant_id: id, product_key: productKey, product_title: `Peer ${productKey}`, variant_title: id, inventory: { stock_units: units, stock_quality: quality, snapshot_at: SNAPSHOT } };
}

export function mkFacts({ products, variants }) {
  return {
    schema_version: '2B.1', generated_at: NOW.toISOString(), currency: 'EUR',
    window: { history_days: 55 },
    input_status: { sales_history: 'PARTIAL', sales_reconciliation: { all_match: true } },
    gates: {
      demand: { status: 'OPEN', reasons: [] },
      margin: { status: 'GATED', reasons: ['COST_NOT_VERIFIED'] },
      capital_exposure_value: { status: 'GATED', reasons: ['COST_NOT_VERIFIED'] },
      cover: { status: 'LIMITED', reasons: [] },
    },
    products, variants,
  };
}

/** Merchant policy used across the tests (illustrative numbers, not any real merchant's). */
export function policy(overrides = {}) {
  return mergeConfig({
    buying: {
      testBudget: 500, minUnitMarginPct: 0.5, paymentCostPct: 0.025, maxSellThroughWeeks: 12, maxLeadTimeDays: 45,
      ...overrides,
    },
  });
}

/** Five selling peers with velocities [0.3, 0.6, 1.2, 2.0, 3.0] (p25 0.6, median 1.2, p75 2.0), prices 12..30, plus non-sellers. */
export function healthyPeerFacts({ collection = 'c-main', noSaleUnits = 100, otherStock = 400, quality = 'UNVERIFIED' } = {}) {
  const velocities = [0.3, 0.6, 1.2, 2.0, 3.0];
  const prices = [12, 16, 20, 24, 30];
  const products = velocities.map((v, i) => peer({ id: `s${i}`, collections: [collection], units: Math.round(v * 8), velocity: v, price: prices[i], stock: otherStock / 5, cls: 'ACTIVE_COVER' }));
  products.push(peer({ id: 'n1', collections: [collection], stock: noSaleUnits / 2 }), peer({ id: 'n2', collections: [collection], stock: noSaleUnits / 2 }), peer({ id: 'new', collections: [collection], observable: 2, stock: 0, cls: 'TOO_NEW' }));
  const variants = products.filter((p) => p.inventory.stock_units > 0).map((p) => stockVariant(p.product_key, `v-${p.product_key}`, p.inventory.stock_units, quality));
  return mkFacts({ products, variants });
}

/** A clean candidate: all costs quoted, price decided. Tests override single fields. */
export function candidate(overrides = {}) {
  return {
    candidate_id: 'cand-1', name: 'Synthetic item',
    unit_price: { value: 4, basis: 'QUOTED' }, landed_cost: { freight_per_unit: { value: 0.6, basis: 'QUOTED' }, duties_per_unit: { value: 0.4, basis: 'QUOTED' } },
    moq: { value: 12, basis: 'QUOTED' }, lead_time_days: 30,
    expected_retail_price: { value: 18, tax_basis: 'excl', basis: 'DECIDED' },
    peer_sets: [{ collection_ids: ['c-main'] }],
    ...overrides,
  };
}
