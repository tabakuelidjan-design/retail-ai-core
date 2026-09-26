// TEST ORACLE ONLY - never imported by src/. Verbatim copies of the one-request-per-row sync functions as they
// were at 669096b (before batching), with only their import paths adjusted. The batched implementations in
// src/sync/ must leave the database in exactly the state these leave it in (test/sync-batching.test.js).

import { VARIANT_INVENTORY_COST_PAGE_QUERY, ORDERS_PAGE_QUERY, ORDERS_PAGE_QUERY_WITH_CUSTOMER_KEY } from '../../src/shopify/queries.js';
import { historySearchQuery } from '../../src/sync/history.js';
import { normalizeOrderAttribution } from '../../src/marketing/adapters/shopify.js';
import {
  normalizeProductCost, costHasChanged,
  extractAvailableQuantity, normalizeInventorySnapshot, shouldWriteInventorySnapshot,
  normalizeOrder, normalizeOrderLine, normalizeRefund, normalizeRefundLine,
} from '../../src/sync/normalize.js';

// ---- src/sync/cost.js @ 669096b ----
/**
 * @param {{graphql: Function}} shopify
 * @param {ReturnType<import('../supabase/client.js').createSupabaseClient>} supabase
 * @param {{merchantId: string, now?: Date}} opts
 */
export async function referenceSyncProductCosts({ shopify, supabase }, opts) {
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

// ---- src/sync/inventory.js @ 669096b ----
/**
 * @param {{graphql: Function}} shopify
 * @param {ReturnType<import('../supabase/client.js').createSupabaseClient>} supabase
 * @param {{merchantId: string, now?: Date, timeZone?: string}} opts
 */
export async function referenceSyncInventory({ shopify, supabase }, opts) {
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

// ---- src/sync/orders.js @ 669096b ----
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
/** Builds the Shopify search-string that bounds this sync to the last 60 days. */
function sixtyDayWindowQuery(now = new Date()) {
  const cutoff = new Date(now.getTime() - SIXTY_DAYS_MS);
  return `created_at:>=${cutoff.toISOString().slice(0, 10)}`;
}
/**
 * @param {{graphql: Function}} shopify
 * @param {ReturnType<import('../supabase/client.js').createSupabaseClient>} supabase
 * @param {{merchantId: string, now?: Date, customerKeySecret?: string|null, since?: string|null}} opts  customerKeySecret: when set, orders carry a keyed hash of the customer id
 */
export async function referenceSyncOrders({ shopify, supabase }, opts) {
  const now = opts.now ?? new Date();
  const summary = {
    ordersFetched: 0, ordersUpserted: 0, attributionRowsFetched: 0, attributionRowsUpserted: 0,
    orderLinesFetched: 0, orderLinesUpserted: 0,
    refundsFetched: 0, refundsUpserted: 0,
    refundLinesFetched: 0, refundLinesUpserted: 0,
    orderLinesWithoutVariant: 0, ordersWithoutLocation: 0,
    errors: [],
  };
  const localLocations = await supabase.select('locations', {
    select: 'id,source_id',
    merchant_id: `eq.${opts.merchantId}`,
  });
  const locationIdBySourceId = new Map(localLocations.map((l) => [l.source_id, l.id]));
  const localVariants = await supabase.select('variants', {
    select: 'id,source_id',
    merchant_id: `eq.${opts.merchantId}`,
  });
  const variantIdBySourceId = new Map(localVariants.map((v) => [v.source_id, v.id]));
  // opts.since (YYYY-MM-DD) widens the window for a backfill; the caller has already verified the read_all_orders scope (planOrdersSync).
  const searchQuery = opts.since ? historySearchQuery(opts.since) : sixtyDayWindowQuery(now);
  let cursor = null;
  let hasNextPage = true;
  while (hasNextPage) {
    let page;
    try {
      page = await shopify.graphql(opts.customerKeySecret ? ORDERS_PAGE_QUERY_WITH_CUSTOMER_KEY : ORDERS_PAGE_QUERY, { cursor, searchQuery });
    } catch (err) {
      summary.errors.push(`fetch: ${err.message}`);
      break;
    }
    const orderNodes = page.orders.edges.map((e) => e.node);
    for (const orderNode of orderNodes) {
      summary.ordersFetched += 1;
      const locationId = orderNode.retailLocation
        ? (locationIdBySourceId.get(orderNode.retailLocation.id) ?? null)
        : null;
      if (!locationId) summary.ordersWithoutLocation += 1;
      const orderRow = normalizeOrder(orderNode, opts.merchantId, locationId, { customerKeySecret: opts.customerKeySecret });
      const [order] = await supabase.upsert('orders', [orderRow], {
        onConflict: 'merchant_id,source_system,source_id',
      });
      // Marketing attribution: 0-2 visit rows (host/path only, no customer identity). Idempotent per (order, touch).
      const attributionRows = normalizeOrderAttribution(orderNode, order.id, opts.merchantId);
      summary.attributionRowsFetched += attributionRows.length;
      if (attributionRows.length > 0) {
        await supabase.upsert('order_attribution', attributionRows, { onConflict: 'order_id,source_system,touch' });
        summary.attributionRowsUpserted += attributionRows.length;
      }
      const lineItemNodes = orderNode.lineItems.edges.map((e) => e.node);
      const orderLineIdBySourceId = new Map();
      for (const lineItemNode of lineItemNodes) {
        summary.orderLinesFetched += 1;
        const variantId = lineItemNode.variant ? (variantIdBySourceId.get(lineItemNode.variant.id) ?? null) : null;
        if (!variantId) summary.orderLinesWithoutVariant += 1;
        const lineRow = normalizeOrderLine(lineItemNode, order.id, variantId, opts.merchantId);
        const [orderLine] = await supabase.upsert('order_lines', [lineRow], {
          onConflict: 'order_id,source_system,source_id',
        });
        orderLineIdBySourceId.set(lineItemNode.id, orderLine.id);
        summary.orderLinesUpserted += 1;
      }
      for (const refundNode of orderNode.refunds) {
        summary.refundsFetched += 1;
        const refundRow = normalizeRefund(refundNode, order.id, opts.merchantId);
        const [refund] = await supabase.upsert('refunds', [refundRow], {
          onConflict: 'order_id,source_system,source_id',
        });
        summary.refundsUpserted += 1;
        const refundLineNodes = refundNode.refundLineItems.edges.map((e) => e.node);
        for (const refundLineNode of refundLineNodes) {
          summary.refundLinesFetched += 1;
          const orderLineId = orderLineIdBySourceId.get(refundLineNode.lineItem.id);
          if (!orderLineId) {
            summary.errors.push(
              `refund line references order line ${refundLineNode.lineItem.id} not found in this sync pass for order ${orderNode.id}`,
            );
            continue;
          }
          const refundLineRow = normalizeRefundLine(refundLineNode, refund.id, orderLineId, orderNode.currencyCode, opts.merchantId);
          await supabase.upsert('refund_lines', [refundLineRow], {
            onConflict: 'refund_id,order_line_id',
          });
          summary.refundLinesUpserted += 1;
        }
      }
      summary.ordersUpserted += 1;
    }
    hasNextPage = page.orders.pageInfo.hasNextPage;
    cursor = page.orders.pageInfo.endCursor;
  }
  return summary;
}
