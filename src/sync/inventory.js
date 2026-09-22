// Inventory sync: at most one snapshot per (variant, location) per
// merchant-local calendar day (timezone is a parameter - HABB's
// 'Europe/Brussels' is merchant config, never hardcoded in this generic
// module). A manual retry within the same local day is a no-op, not a new
// row - this is what lets future stockout-day math tell "unchanged" apart
// from "sync didn't run" and "real movement" (see
// docs/architecture/inventory-cost-sync.md).

import { VARIANT_INVENTORY_COST_PAGE_QUERY } from '../shopify/queries.js';
import { extractAvailableQuantity, normalizeInventorySnapshot, shouldWriteInventorySnapshot } from './normalize.js';

/**
 * @param {{graphql: Function}} shopify
 * @param {ReturnType<import('../supabase/client.js').createSupabaseClient>} supabase
 * @param {{merchantId: string, now?: Date, timeZone?: string}} opts
 */
export async function syncInventory({ shopify, supabase }, opts) {
  const now = opts.now ?? new Date();
  const timeZone = opts.timeZone ?? 'UTC';
  const summary = { variantsChecked: 0, snapshotsWritten: 0, snapshotsSkippedSameDay: 0, errors: [] };

  // Local lookup tables: source_id -> local id, for variants and locations
  // belonging to this merchant. Fetched once per run.
  const [localVariants, localLocations] = await Promise.all([
    supabase.select('variants', { select: 'id,source_id', merchant_id: `eq.${opts.merchantId}` }),
    supabase.select('locations', { select: 'id,source_id', merchant_id: `eq.${opts.merchantId}` }),
  ]);
  const variantIdBySourceId = new Map(localVariants.map((v) => [v.source_id, v.id]));
  const locationIdBySourceId = new Map(localLocations.map((l) => [l.source_id, l.id]));

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

      for (const edge of node.inventoryItem.inventoryLevels.edges) {
        const locationSourceId = edge.node.location.id;
        const locationId = locationIdBySourceId.get(locationSourceId);
        if (!locationId) {
          summary.errors.push(`location not found locally for source_id ${locationSourceId} - run catalog sync first`);
          continue;
        }

        const quantity = extractAvailableQuantity(node.inventoryItem, locationSourceId);
        if (quantity === null) continue;

        const [latest] = await supabase.select('inventory_snapshots', {
          select: 'synced_at',
          // merchant_id added as defense-in-depth (variantId/locationId are already this merchant's own
          // resolved local ids, so this was safe by construction even before the column existed).
          merchant_id: `eq.${opts.merchantId}`,
          variant_id: `eq.${variantId}`,
          location_id: `eq.${locationId}`,
          order: 'synced_at.desc',
          limit: '1',
        });

        if (!shouldWriteInventorySnapshot(latest ?? null, now, timeZone)) {
          summary.snapshotsSkippedSameDay += 1;
          continue;
        }

        await supabase.insert('inventory_snapshots', [
          normalizeInventorySnapshot(variantId, locationId, quantity, now, opts.merchantId),
        ]);
        summary.snapshotsWritten += 1;
      }
    }

    hasNextPage = page.productVariants.pageInfo.hasNextPage;
    cursor = page.productVariants.pageInfo.endCursor;
  }

  return summary;
}
