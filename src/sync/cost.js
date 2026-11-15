// Product cost sync: source_id-based, diff-only history. A variant with no
// Shopify unitCost gets no row at all (UNCLASSIFIED) - never a fabricated
// zero or estimate. An unchanged cost writes nothing; a changed cost writes
// exactly one new row, preparing the future COGS Drift view.
//
// Batched: the merchant's cost history is read once (not once per variant) and the new rows are inserted
// together at the end, so a cycle costs a handful of requests instead of two per variant.

import { VARIANT_INVENTORY_COST_PAGE_QUERY } from '../shopify/queries.js';
import { normalizeProductCost, costHasChanged } from './normalize.js';
import { insertInChunks } from './batch.js';
import { COST_POLICY } from './cost-policy.js';

/**
 * The most recent product_costs row per variant (greatest effective_from), from the merchant's whole history.
 * @returns {Map<string, {unit_cost: number, currency: string, source: string, validation_status: string}>}
 */
export async function loadLatestCosts(supabase, merchantId) {
  const rows = await supabase.selectAll('product_costs', {
    select: 'id,variant_id,unit_cost,currency,source,validation_status,effective_from',
    merchant_id: `eq.${merchantId}`,
  });
  const latest = new Map();
  for (const row of rows) {
    const current = latest.get(row.variant_id);
    if (!current || Date.parse(row.effective_from) > Date.parse(current.effective_from)) latest.set(row.variant_id, row);
  }
  return latest;
}

/**
 * @param {{graphql: Function}} shopify
 * @param {ReturnType<import('../supabase/client.js').createSupabaseClient>} supabase
 * @param {{merchantId: string, now?: Date, costPolicy?: string}} opts  costPolicy: the merchant's policy (cost-policy.js); unknown = default, so every merchant
 *   that did not configure MERCHANT_DECLARED keeps today's behaviour exactly.
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
  const latestByVariantId = await loadLatestCosts(supabase, opts.merchantId);
  const newRows = [];
  const policy = opts.costPolicy === COST_POLICY.MERCHANT_DECLARED ? COST_POLICY.MERCHANT_DECLARED : COST_POLICY.DEFAULT;
  if (policy === COST_POLICY.MERCHANT_DECLARED) { summary.acceptedAsDeclared = 0; summary.promotedToDeclared = 0; } // counters exist only under the declared policy: other merchants' summary is unchanged
  const promote = []; // ids of rows whose amount is unchanged but which are now the merchant's declared cost: re-labelled in place, history kept

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

      const candidate = normalizeProductCost(variantId, opts.merchantId, node.inventoryItem.unitCost, now, { policy });
      if (!candidate) {
        summary.withoutCost += 1;
        continue; // UNCLASSIFIED: no row, never a fabricated cost.
      }
      summary.withCost += 1;

      const latest = latestByVariantId.get(variantId);
      if (candidate.validation_status === 'verified') summary.acceptedAsDeclared += 1;
      // Same amount and currency, same source, only the trust label differs (an earlier UNVERIFIED import of the same Shopify value): the amount is
      // not new, so no new cost row (that would date the declaration today and leave every earlier sale on the unverified label) - the existing
      // row is re-labelled. A changed amount is a real change and still writes one new row.
      if (latest && policy === COST_POLICY.MERCHANT_DECLARED && candidate.validation_status === 'verified' && latest.validation_status === 'unverified'
        && latest.source === candidate.source && Number(latest.unit_cost) === candidate.unit_cost && latest.currency === candidate.currency && latest.id) {
        promote.push(latest.id);
        latestByVariantId.set(variantId, { ...latest, validation_status: 'verified' });
        summary.promotedToDeclared += 1;
        continue;
      }
      if (latest && !costHasChanged(latest, candidate)) {
        summary.unchangedSkipped += 1;
        continue;
      }

      newRows.push(candidate);
      latestByVariantId.set(variantId, candidate); // a variant seen twice in one run compares against this row, as before
      summary.newCostRows += 1;
    }

    hasNextPage = page.productVariants.pageInfo.hasNextPage;
    cursor = page.productVariants.pageInfo.endCursor;
  }

  // Also after a failed page fetch: the rows decided before the failure are written, as they were one by one.
  await insertInChunks(supabase, 'product_costs', newRows);
  for (let i = 0; i < promote.length; i += 100) {
    const ids = promote.slice(i, i + 100);
    try { await supabase.update('product_costs', { merchant_id: `eq.${opts.merchantId}`, id: `in.(${ids.join(',')})` }, { validation_status: 'verified' }); } catch (err) { summary.errors.push(`promote: ${err.message}`); }
  }
  return summary;
}
