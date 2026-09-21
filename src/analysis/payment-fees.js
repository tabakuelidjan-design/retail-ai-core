// Payment-fee visibility (read-only). Payment fees are NOT part of any metric:
// this module only measures how much of the fee picture Shopify can show, so
// the size of the omission from contribution margin v0 is known, not guessed.

import { PAYMENT_TRANSACTIONS_PAGE_QUERY } from '../shopify/queries.js';

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

export async function fetchPaymentTransactions(shopify, since) {
  const searchQuery = `created_at:>=${since.toISOString().slice(0, 10)}`;
  const nodes = [];
  let cursor = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const page = await shopify.graphql(PAYMENT_TRANSACTIONS_PAGE_QUERY, { cursor, searchQuery });
    nodes.push(...page.orders.edges.map((e) => e.node));
    hasNextPage = page.orders.pageInfo.hasNextPage;
    cursor = page.orders.pageInfo.endCursor;
  }
  return nodes;
}

/**
 * Groups countable (non-test) orders by the gateway(s) that captured them.
 * `fees_reported` is what Shopify itself records; a gateway whose fees Shopify
 * cannot see (external card terminal, cash) has `fee_visibility: 'NOT_VISIBLE'`.
 */
export function summarizePaymentFees(orders, { feeVisibleGateways = ['shopify_payments'] } = {}) {
  const groups = new Map();
  for (const o of orders.filter((x) => !x.test)) {
    const captured = o.transactions.filter((t) => t.status === 'SUCCESS' && ['SALE', 'CAPTURE'].includes(t.kind));
    const gateway = [...new Set(captured.map((t) => t.gateway))].sort().join('+') || 'none';
    const amount = captured.reduce((a, t) => a + Number(t.amountSet.shopMoney.amount), 0);
    const fees = o.transactions.reduce((a, t) => a + t.fees.reduce((b, f) => b + Number(f.amount.amount), 0), 0);
    const g = groups.get(gateway) ?? { gateway, orders: 0, captured_amount: 0, fees_reported: 0, orders_with_fee: 0 };
    g.orders += 1;
    g.captured_amount += amount;
    g.fees_reported += fees;
    if (fees > 0) g.orders_with_fee += 1;
    groups.set(gateway, g);
  }
  const rows = [...groups.values()].map((g) => ({
    ...g, captured_amount: round2(g.captured_amount), fees_reported: round2(g.fees_reported),
    fee_visibility: g.gateway.split('+').every((x) => feeVisibleGateways.includes(x)) ? 'VISIBLE' : 'NOT_VISIBLE',
  })).sort((a, b) => b.captured_amount - a.captured_amount);
  const total = rows.reduce((a, g) => a + g.captured_amount, 0);
  return {
    by_gateway: rows,
    captured_amount_total: round2(total),
    fees_reported_total: round2(rows.reduce((a, g) => a + g.fees_reported, 0)),
    captured_amount_fee_not_visible: round2(rows.filter((g) => g.fee_visibility === 'NOT_VISIBLE').reduce((a, g) => a + g.captured_amount, 0)),
    note: 'captured_amount includes shipping and tax (what the customer paid), so it is not comparable to net sales ex tax.',
  };
}
