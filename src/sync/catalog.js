// Catalog sync: merchant, locations, products, variants. Read-only against
// Shopify; idempotent upserts against Supabase, keyed on
// (merchant_id, source_system, source_id) per table - never on name or sku.

import { SHOP_QUERY, LOCATIONS_QUERY, PRODUCTS_PAGE_QUERY } from '../shopify/queries.js';
import { normalizeMerchant, normalizeLocation, normalizeProduct, normalizeVariant } from './normalize.js';

/**
 * @param {{graphql: Function}} shopify
 * @param {ReturnType<import('../supabase/client.js').createSupabaseClient>} supabase
 */
export async function syncCatalog({ shopify, supabase }) {
  const summary = {
    locationsFetched: 0, locationsUpserted: 0,
    productsFetched: 0, productsUpserted: 0,
    variantsFetched: 0, variantsUpserted: 0,
    errors: [],
  };

  let merchantId;
  try {
    const { shop } = await shopify.graphql(SHOP_QUERY);
    const [merchant] = await supabase.upsert('merchants', [normalizeMerchant(shop)], {
      onConflict: 'source_system,source_id',
    });
    merchantId = merchant.id;
  } catch (err) {
    summary.errors.push(`merchant: ${err.message}`);
    return summary;
  }

  try {
    const { locations } = await shopify.graphql(LOCATIONS_QUERY);
    const nodes = locations.edges.map((e) => e.node);
    summary.locationsFetched = nodes.length;
    const rows = nodes.map((n) => normalizeLocation(n, merchantId));
    const upserted = await supabase.upsert('locations', rows, {
      onConflict: 'merchant_id,source_system,source_id',
    });
    summary.locationsUpserted = upserted.length;
  } catch (err) {
    summary.errors.push(`locations: ${err.message}`);
  }

  try {
    let cursor = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const { products } = await shopify.graphql(PRODUCTS_PAGE_QUERY, { cursor });
      const productNodes = products.edges.map((e) => e.node);
      summary.productsFetched += productNodes.length;

      const productRows = productNodes.map((n) => normalizeProduct(n, merchantId));
      const upsertedProducts = await supabase.upsert('products', productRows, {
        onConflict: 'merchant_id,source_system,source_id',
      });
      summary.productsUpserted += upsertedProducts.length;

      // Map Shopify product source_id -> local product id for this page.
      const productIdBySourceId = new Map(upsertedProducts.map((p) => [p.source_id, p.id]));

      const variantRows = [];
      for (const productNode of productNodes) {
        const localProductId = productIdBySourceId.get(productNode.id);
        for (const edge of productNode.variants.edges) {
          summary.variantsFetched += 1;
          variantRows.push(normalizeVariant(edge.node, localProductId, merchantId));
        }
      }
      if (variantRows.length > 0) {
        const upsertedVariants = await supabase.upsert('variants', variantRows, {
          onConflict: 'merchant_id,source_system,source_id',
        });
        summary.variantsUpserted += upsertedVariants.length;
      }

      hasNextPage = products.pageInfo.hasNextPage;
      cursor = products.pageInfo.endCursor;
    }
  } catch (err) {
    summary.errors.push(`products/variants: ${err.message}`);
  }

  return summary;
}
