// Inventory sync: at most one snapshot per (variant, location) per
// merchant-local calendar day (timezone is a parameter - HABB's
// 'Europe/Brussels' is merchant config, never hardcoded in this generic
// module). A manual retry within the same local day is a no-op, not a new
// row - this is what lets future stockout-day math tell "unchanged" apart
// from "sync didn't run" and "real movement" (see
// docs/architecture/inventory-cost-sync.md).
//
// Batched: the merchant's recent snapshots are read once (not once per variant x location) and the new
// snapshots are inserted together at the end, so a cycle costs a handful of requests instead of two per pair.

import { VARIANT_INVENTORY_COST_PAGE_QUERY } from '../shopify/queries.js';
import { extractAvailableQuantity, normalizeInventorySnapshot, shouldWriteInventorySnapshot } from './normalize.js';
import { insertInChunks } from './batch.js';

// A local calendar day starts at most 25 h before any instant in it (DST), so a snapshot older than this can
// never be on `now`'s local day: for shouldWriteInventorySnapshot it is the same as no snapshot at all.
// Reading only this window keeps the read one page long however much history accumulates.
export const SNAPSHOT_LOOKBACK_MS = 48 * 60 * 60 * 1000;

const pairKey = (variantId, locationId) => `${variantId}|${locationId}`;

/**
 * The most recent snapshot per (variant, location) among the merchant's snapshots since now - 48 h
 * (including any dated after `now`). A pair with none in the window gets no entry.
 * @returns {Map<string, {synced_at: string}>} keyed by pairKey(variantId, locationId)
 */
export async function loadRecentLatestSnapshots(supabase, merchantId, now) {
  const rows = await supabase.selectAll('inventory_snapshots', {
    select: 'id,variant_id,location_id,synced_at',
    merchant_id: `eq.${merchantId}`,
    synced_at: `gte.${new Date(now.getTime() - SNAPSHOT_LOOKBACK_MS).toISOString()}`,
  });
  const latest = new Map();
  for (const row of rows) {
    const key = pairKey(row.variant_id, row.location_id);
    const current = latest.get(key);
    if (!current || Date.parse(row.synced_at) > Date.parse(current.synced_at)) latest.set(key, row);
  }
  return latest;
}

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
  const latestByPair = await loadRecentLatestSnapshots(supabase, opts.merchantId, now);
  const newSnapshots = [];

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

        const key = pairKey(variantId, locationId);
        if (!shouldWriteInventorySnapshot(latestByPair.get(key) ?? null, now, timeZone)) {
          summary.snapshotsSkippedSameDay += 1;
          continue;
        }

        const snapshot = normalizeInventorySnapshot(variantId, locationId, quantity, now, opts.merchantId);
        newSnapshots.push(snapshot);
        latestByPair.set(key, snapshot); // a pair seen twice in one run is skipped the second time, as before
        summary.snapshotsWritten += 1;
      }
    }

    hasNextPage = page.productVariants.pageInfo.hasNextPage;
    cursor = page.productVariants.pageInfo.endCursor;
  }

  // Also after a failed page fetch: the snapshots decided before the failure are written, as they were one by one.
  await insertInChunks(supabase, 'inventory_snapshots', newSnapshots);
  return summary;
}
