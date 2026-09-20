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

import { ORDERS_PAGE_QUERY } from '../shopify/queries.js';
import { normalizeOrder, normalizeOrderLine, normalizeRefund, normalizeRefundLine } from './normalize.js';

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

/** Builds the Shopify search-string that bounds this sync to the last 60 days. */
export function sixtyDayWindowQuery(now = new Date()) {
  const cutoff = new Date(now.getTime() - SIXTY_DAYS_MS);
  return `created_at:>=${cutoff.toISOString().slice(0, 10)}`;
}

/**
 * @param {{graphql: Function}} shopify
 * @param {ReturnType<import('../supabase/client.js').createSupabaseClient>} supabase
 * @param {{merchantId: string, now?: Date}} opts
 */
export async function syncOrders({ shopify, supabase }, opts) {
  const now = opts.now ?? new Date();
  const summary = {
    ordersFetched: 0, ordersUpserted: 0,
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

  const searchQuery = sixtyDayWindowQuery(now);
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    let page;
    try {
      page = await shopify.graphql(ORDERS_PAGE_QUERY, { cursor, searchQuery });
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

      const orderRow = normalizeOrder(orderNode, opts.merchantId, locationId);
      const [order] = await supabase.upsert('orders', [orderRow], {
        onConflict: 'merchant_id,source_system,source_id',
      });

      const lineItemNodes = orderNode.lineItems.edges.map((e) => e.node);
      const orderLineIdBySourceId = new Map();

      for (const lineItemNode of lineItemNodes) {
        summary.orderLinesFetched += 1;
        const variantId = lineItemNode.variant ? (variantIdBySourceId.get(lineItemNode.variant.id) ?? null) : null;
        if (!variantId) summary.orderLinesWithoutVariant += 1;

        const lineRow = normalizeOrderLine(lineItemNode, order.id, variantId);
        const [orderLine] = await supabase.upsert('order_lines', [lineRow], {
          onConflict: 'order_id,source_system,source_id',
        });
        orderLineIdBySourceId.set(lineItemNode.id, orderLine.id);
        summary.orderLinesUpserted += 1;
      }

      for (const refundNode of orderNode.refunds) {
        summary.refundsFetched += 1;
        const refundRow = normalizeRefund(refundNode, order.id);
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
          const refundLineRow = normalizeRefundLine(refundLineNode, refund.id, orderLineId, orderNode.currencyCode);
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
