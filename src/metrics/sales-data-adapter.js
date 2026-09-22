// SalesDataAdapter contract. The hierarchical analytics engine (hierarchy.js) never reads a source system's
// tables, field names or ids directly - it only consumes the generic shapes below. A source becomes usable by
// implementing one adapter that produces:
//   1. `data` / `ledger` — the existing generic retail dataset (see load.js, ledger.js): products, variants,
//      orders, order lines, refunds, costs, stock snapshots. This shape already has no Shopify-specific
//      concept in it (ids, titles, quantities, money) and is unchanged here.
//   2. `enrichment` — the hierarchy/collection/channel facts hierarchy.js groups and drills into:
//        categoryPathByProduct: Map<productId, string[]>   broadest -> narrowest, e.g. ['Tech','Audio','Earbuds']
//        collectionsByProduct:  Map<productId, {id, title}[]>
//        channelByOrder:        Map<orderId, {id, title}>
// A merchant switching source systems (or running several side by side) writes a new adapter; hierarchy.js,
// sales.js, products.js and ledger.js do not change.

/**
 * @typedef {object} SalesDataAdapter
 * @property {() => Promise<{data: object, ledger: object, enrichment: {categoryPathByProduct: Map, collectionsByProduct: Map, channelByOrder: Map}}>} load
 */

const splitPath = (value, delimiter) => (value ?? '').split(delimiter).map((s) => s.trim()).filter(Boolean);

/**
 * Turns Shopify's flat `product_type` string into a hierarchy path, e.g. "Tech > Audio > Earbuds" with
 * delimiter=" > ". A merchant whose Product Type field is not structured this way supplies `categoryPathOverrides`
 * (productId -> string[]) instead; nothing here assumes a specific taxonomy or number of levels.
 * @param {{products: object[], collections: object[], orders: object[]}} data the generic dataset from load.js
 * @param {{delimiter?: string, categoryPathOverrides?: Map<string,string[]>}} opts
 */
export function deriveEnrichmentFromShopifyShape(data, { delimiter = ' > ', categoryPathOverrides = new Map() } = {}) {
  const categoryPathByProduct = new Map();
  for (const p of data.products) {
    const override = categoryPathOverrides.get(p.id);
    categoryPathByProduct.set(p.id, override ?? splitPath(p.product_type, delimiter));
  }
  const collectionsByProduct = new Map();
  for (const c of data.collections ?? []) {
    if (!collectionsByProduct.has(c.product_id)) collectionsByProduct.set(c.product_id, []);
    collectionsByProduct.get(c.product_id).push({ id: c.source_id, title: c.title });
  }
  const channelByOrder = new Map();
  for (const o of data.orders ?? []) {
    const id = o.channel_handle ?? o.source_name ?? null;
    if (id) channelByOrder.set(o.id, { id, title: o.channel_name ?? o.channel_handle ?? o.source_name });
  }
  return { categoryPathByProduct, collectionsByProduct, channelByOrder };
}

/**
 * Shopify (via the existing Supabase sync) as one concrete SalesDataAdapter. Everything Shopify-specific
 * lives here; hierarchy.js never imports this file or knows it exists.
 * @param {{supabase: object, merchantId: string, loadDataset: Function, buildLedger: Function}} deps
 */
export function createShopifySalesDataAdapter({ supabase, merchantId, loadDataset, buildLedger, config, categoryPathOverrides }) {
  return {
    async load({ since } = {}) {
      const data = await loadDataset(supabase, merchantId, { since: since ?? new Date(0) });
      const ledger = buildLedger(data, { config });
      const enrichment = deriveEnrichmentFromShopifyShape(data, { categoryPathOverrides });
      return { data, ledger, enrichment };
    },
  };
}
