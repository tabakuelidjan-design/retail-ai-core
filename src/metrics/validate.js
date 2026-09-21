// Metric validation: recompute the engine's order-cohort totals and compare
// them with the order-level totals Shopify itself reports for the same
// orders. Differences are reported, never hidden or "explained away" in code.
//
// Cohort basis: for validation, refunds are attributed to the order they
// belong to (not to the refund date), because Shopify's order-level totals
// are per order. The windowed metrics elsewhere use refund date.

import { ORDER_TOTALS_PAGE_QUERY } from '../shopify/queries.js';
import { aggregate } from './sales.js';
import { inWindow } from './windows.js';

const TOLERANCE = 0.005;
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100 + 0; // + 0 normalises -0
const money = (set) => Number(set.shopMoney.amount);

export async function fetchShopifyOrderTotals(shopify, since) {
  const searchQuery = `created_at:>=${since.toISOString().slice(0, 10)}`;
  const nodes = [];
  let cursor = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const page = await shopify.graphql(ORDER_TOTALS_PAGE_QUERY, { cursor, searchQuery });
    nodes.push(...page.orders.edges.map((e) => e.node));
    hasNextPage = page.orders.pageInfo.hasNextPage;
    cursor = page.orders.pageInfo.endCursor;
  }
  return nodes;
}

export function compareWindow(ledger, shopifyOrders, window) {
  const excluded = ledger.config.excludedOrderStatuses;
  const sOrders = shopifyOrders.filter((o) => inWindow(o.createdAt, window) && !o.test && !excluded.includes(o.displayFinancialStatus));
  const orderIds = new Set(ledger.orders.filter((o) => inWindow(o.orderedAt, window)).map((o) => o.id));

  const lines = ledger.lineFacts.filter((l) => orderIds.has(l.orderId));
  const refundFacts = ledger.refundFacts.filter((r) => orderIds.has(ledger.lineFacts.find((l) => l.orderLineId === r.orderLineId)?.orderId));
  const engine = aggregate(lines, refundFacts, ledger.config);
  const engineRefundTotal = ledger.refundTotals.filter((r) => orderIds.has(r.orderId)).reduce((a, r) => a + r.amount, 0);

  const sum = (f) => sOrders.reduce((a, o) => a + f(o), 0);
  const shipTax = (o) => (o.shippingLine?.taxLines ?? []).reduce((a, t) => a + money(t.priceSet), 0);
  const shopify = {
    order_count: sOrders.length,
    gross_sales: sum((o) => money(o.subtotalPriceSet) + money(o.totalDiscountsSet)),
    discounts: sum((o) => money(o.totalDiscountsSet)),
    refunds_product_lines: sum((o) => money(o.subtotalPriceSet) - money(o.currentSubtotalPriceSet)),
    refunds_total: sum((o) => money(o.totalRefundedSet)),
    tax_products_before_refunds: sum((o) => money(o.totalTaxSet) - shipTax(o)),
    net_sales: sum((o) => money(o.currentSubtotalPriceSet)),
  };
  const pairs = [
    ['order_count', orderIds.size, shopify.order_count],
    ['gross_sales', engine.gross_sales, shopify.gross_sales],
    ['discounts', engine.discounts, shopify.discounts],
    ['refunds_product_lines', engine.refunds, shopify.refunds_product_lines],
    ['refunds_total_incl_non_product', engineRefundTotal, shopify.refunds_total],
    ['tax_products_before_refunds', sum2(lines, (l) => l.tax), shopify.tax_products_before_refunds],
    ['net_sales', engine.net_sales, shopify.net_sales],
  ];
  return pairs.map(([metric, e, s]) => {
    const diff = round2(e - s);
    return { window: window.key, metric, engine: round2(e), shopify: round2(s), diff, ok: Math.abs(diff) <= TOLERANCE };
  });
}

const sum2 = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

export async function validateAgainstShopify({ shopify, ledger, windows }) {
  const oldest = Object.values(windows).reduce((m, w) => (w.start < m ? w.start : m), new Date());
  // One day earlier than the earliest window: the search filter is date-granular in UTC.
  const shopifyOrders = await fetchShopifyOrderTotals(shopify, new Date(oldest.getTime() - 24 * 60 * 60 * 1000));
  return Object.values(windows).flatMap((w) => compareWindow(ledger, shopifyOrders, w));
}
