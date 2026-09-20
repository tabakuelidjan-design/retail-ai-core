// Product cost sync: source_id-based, diff-only history. A variant with no
// Shopify unitCost gets no row at all (UNCLASSIFIED) - never a fabricated
// zero or estimate. An unchanged cost writes nothing; a changed cost writes
// exactly one new row, preparing the future COGS Drift view.

import { VARIANT_INVENTORY_COST_PAGE_QUERY } from '../shopify/queries.js';
import { normalizeProductCost, costHasChanged } from './normalize.js';

/**
 * @param {{graphql: Function}} shopify
 * @param {ReturnType<import('../supabase/client.js').createSupabaseClient>} supabase
 * @param {{merchantId: string, now?: Date}} opts
 */
export async function syncProductCosts({ shopify, supabase }, opts) {
  const now = opts.now ?? new Date();
  const summary = {
    variantsChecked: 0, withCost: 0, withoutCost: 0,
    newCostRows: 0, unchangedSkipped: 0, errors: [],
  };

  const localVariants = await supabase.select('variants', {
    select: 'id,source_id',
    merchant_id: `eq.${opts.merchantId}`,
  });
  const variantIdBySourceId = new Map(localVariants.map((v) => [v.source_id, v.id]));

  let cursor = null;
  let hasNextPage = true;
  while (hasNextPage) {
    let page;
    try {
      page = await shopify.graphql(VARIANT_INVENTORY_COST_PAGE_QUERY, { cursor });
    } catch (err) {
      summary.errors.push(`fetch: ${err.message}`);
      break;
    }

    const nodes = page.productVariants.edges.map((e) => e.node);
    for (const node of nodes) {
      summary.variantsChecked += 1;
      const variantId = variantIdBySourceId.get(node.id);
      if (!variantId) {
        summary.errors.push(`variant not found locally for source_id ${node.id} - run catalog sync first`);
        continue;
      }

      const candidate = normalizeProductCost(variantId, opts.merchantId, node.inventoryItem.unitCost, now);
      if (!candidate) {
        summary.withoutCost += 1;
        continue; // UNCLASSIFIED: no row, never a fabricated cost.
      }
      summary.withCost += 1;

      const [latest] = await supabase.select('product_costs', {
        select: 'unit_cost,currency,source,validation_status',
        variant_id: `eq.${variantId}`,
        order: 'effective_from.desc',
        limit: '1',
      });

      if (latest && !costHasChanged(latest, candidate)) {
        summary.unchangedSkipped += 1;
        continue;
      }

      await supabase.insert('product_costs', [candidate]);
      summary.newCostRows += 1;
    }

    hasNextPage = page.productVariants.pageInfo.hasNextPage;
    cursor = page.productVariants.pageInfo.endCursor;
  }

  return summary;
}
