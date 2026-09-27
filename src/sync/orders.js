// Orders + order_lines + refunds + refund_lines sync. Read-only against
// Shopify (read_orders scope only - no read_all_orders, no write scope).
//
// Incremental strategy (V1): refetch the full 60-day window every run,
// sorted by CREATED_AT, and upsert everything idempotently by source_id.
// This is deliberately NOT "reload entire order history" - Shopify's Order
// object itself refuses anything older than 60 days without the
// read_all_orders scope, which this project does not request (see
// docs/architecture/orders-refunds-sync.md). Refetching the whole window
// each run (currently ~45 orders) is simplest-safe here because:
//   1. Refunds can be added to an order well after it was created, so a
//      "only new orders since last run" cursor would miss refund updates
//      on already-synced orders.
//   2. Volume is small enough (tens of orders) that refetching costs
//      nothing meaningful.
// If order volume grows enough that this becomes expensive, the documented
// upgrade path is a persisted watermark on updated_at with a safety overlap
// - not implemented now, to avoid over-engineering for 45 rows.

import { historySearchQuery } from './history.js';
import { ORDERS_PAGE_QUERY, ORDERS_PAGE_QUERY_WITH_CUSTOMER_KEY } from '../shopify/queries.js';
import { normalizeOrderAttribution } from '../marketing/adapters/shopify.js';
import { normalizeOrder, normalizeOrderLine, normalizeRefund, normalizeRefundLine } from './normalize.js';
import { upsertInChunks } from './batch.js';

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

/** Builds the Shopify search-string that bounds this sync to the last 60 days. */
export function sixtyDayWindowQuery(now = new Date()) {
  const cutoff = new Date(now.getTime() - SIXTY_DAYS_MS);
  return `created_at:>=${cutoff.toISOString().slice(0, 10)}`;
}

/**
 * @param {{graphql: Function}} shopify
 * @param {ReturnType<import('../supabase/client.js').createSupabaseClient>} supabase
 * @param {{merchantId: string, now?: Date, customerKeySecret?: string|null, since?: string|null}} opts  customerKeySecret: when set, orders carry a keyed hash of the customer id
 */
export async function syncOrders({ shopify, supabase }, opts) {
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
    await writeOrdersPage(supabase, orderNodes, { opts, summary, locationIdBySourceId, variantIdBySourceId });

    hasNextPage = page.orders.pageInfo.hasNextPage;
    cursor = page.orders.pageInfo.endCursor;
  }

  return summary;
}

// One Shopify page of orders (up to 25-50) is written with one upsert per table - orders, visits, lines,
// refunds, refund lines - instead of one per row. Each table's rows need the local ids of the rows above them,
// read back from the previous upsert by their natural keys. Pages are written one at a time so a full-history
// backfill never holds more than a page in memory.
async function writeOrdersPage(supabase, orderNodes, { opts, summary, locationIdBySourceId, variantIdBySourceId }) {
  const byOrderAndSource = (row) => `${row.order_id}|${row.source_id}`;

  const orderRows = orderNodes.map((orderNode) => {
    summary.ordersFetched += 1;
    const locationId = orderNode.retailLocation
      ? (locationIdBySourceId.get(orderNode.retailLocation.id) ?? null)
      : null;
    if (!locationId) summary.ordersWithoutLocation += 1;
    return normalizeOrder(orderNode, opts.merchantId, locationId, { customerKeySecret: opts.customerKeySecret });
  });
  const orders = await upsertInChunks(supabase, 'orders', orderRows, { onConflict: 'merchant_id,source_system,source_id' });
  const orderIdBySourceId = new Map(orders.map((o) => [o.source_id, o.id]));

  // Marketing attribution: 0-2 visit rows (host/path only, no customer identity). Idempotent per (order, touch).
  const attributionRows = [];
  const lineRows = [];
  for (const orderNode of orderNodes) {
    const orderId = orderIdBySourceId.get(orderNode.id);
    const visits = normalizeOrderAttribution(orderNode, orderId, opts.merchantId);
    summary.attributionRowsFetched += visits.length;
    attributionRows.push(...visits);

    for (const { node: lineItemNode } of orderNode.lineItems.edges) {
      summary.orderLinesFetched += 1;
      const variantId = lineItemNode.variant ? (variantIdBySourceId.get(lineItemNode.variant.id) ?? null) : null;
      if (!variantId) summary.orderLinesWithoutVariant += 1;
      lineRows.push(normalizeOrderLine(lineItemNode, orderId, variantId, opts.merchantId));
    }
  }
  await upsertInChunks(supabase, 'order_attribution', attributionRows, { onConflict: 'order_id,source_system,touch' });
  summary.attributionRowsUpserted += attributionRows.length;
  const orderLines = await upsertInChunks(supabase, 'order_lines', lineRows, { onConflict: 'order_id,source_system,source_id' });
  const orderLineIdByKey = new Map(orderLines.map((l) => [byOrderAndSource(l), l.id]));
  summary.orderLinesUpserted += lineRows.length;

  const refundRows = orderNodes.flatMap((orderNode) => orderNode.refunds.map((refundNode) => {
    summary.refundsFetched += 1;
    return normalizeRefund(refundNode, orderIdBySourceId.get(orderNode.id), opts.merchantId);
  }));
  const refunds = await upsertInChunks(supabase, 'refunds', refundRows, { onConflict: 'order_id,source_system,source_id' });
  const refundIdByKey = new Map(refunds.map((r) => [byOrderAndSource(r), r.id]));
  summary.refundsUpserted += refundRows.length;

  const refundLineRows = [];
  for (const orderNode of orderNodes) {
    const orderId = orderIdBySourceId.get(orderNode.id);
    for (const refundNode of orderNode.refunds) {
      const refundId = refundIdByKey.get(`${orderId}|${refundNode.id}`);
      for (const { node: refundLineNode } of refundNode.refundLineItems.edges) {
        summary.refundLinesFetched += 1;
        // Only this order's own lines, synced in this pass, can be referenced.
        const orderLineId = orderLineIdByKey.get(`${orderId}|${refundLineNode.lineItem.id}`);
        if (!orderLineId) {
          summary.errors.push(
            `refund line references order line ${refundLineNode.lineItem.id} not found in this sync pass for order ${orderNode.id}`,
          );
          continue;
        }
        refundLineRows.push(normalizeRefundLine(refundLineNode, refundId, orderLineId, orderNode.currencyCode, opts.merchantId));
      }
    }
  }
  await upsertInChunks(supabase, 'refund_lines', refundLineRows, { onConflict: 'refund_id,order_line_id' });
  summary.refundLinesUpserted += refundLineRows.length;

  summary.ordersUpserted += orderNodes.length;
}
