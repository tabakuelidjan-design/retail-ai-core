// Synthetic, production-sized sync input (no real merchant data): ~300 variants over 6 Shopify pages
// (283 with a unit cost, ~350 variant x location levels) and 80 orders over 4 pages (~100 lines, refunds,
// visits). Sized like the pilot store's cycle measured on 2026-09-26, plus the edge cases the sync handles:
// variants missing locally, unknown locations, missing quantities, custom lines, refund lines without a line.

export const MERCHANT_ID = 'merchant-volume';
export const VARIANT_COUNT = 300;
const PAGE_SIZE = 50;
const ORDER_COUNT = 80;
const ORDERS_PER_PAGE = 25;

const money = (amount) => ({ shopMoney: { amount: String(amount) } });

/** Local catalog with fixed ids, so two databases seeded with it can be compared row for row. */
export async function seedVolumeCatalog(supabase) {
  await supabase.upsert('locations', [
    { id: 'loc-1', merchant_id: MERCHANT_ID, source_system: 'shopify', source_id: 'gid://shopify/Location/1' },
    { id: 'loc-2', merchant_id: MERCHANT_ID, source_system: 'shopify', source_id: 'gid://shopify/Location/2' },
  ], { onConflict: 'merchant_id,source_system,source_id' });
  const variants = [];
  for (let i = 1; i <= VARIANT_COUNT; i += 1) {
    variants.push({ id: `var-${i}`, merchant_id: MERCHANT_ID, source_system: 'shopify', source_id: `gid://shopify/ProductVariant/${i}` });
  }
  await supabase.upsert('variants', variants, { onConflict: 'merchant_id,source_system,source_id' });
}

function variantNode(i, { costOverrides = {}, quantityShift = 0 }) {
  const level = (locationNo, quantity) => ({
    node: {
      location: { id: `gid://shopify/Location/${locationNo}` },
      quantities: quantity === null ? [{ name: 'on_hand', quantity: 1 }] : [{ name: 'available', quantity }],
    },
  });
  const levels = [level(1, i % 50 === 0 ? null : (i + quantityShift) % 13)]; // every 50th: no "available" quantity
  if (i % 6 === 0) levels.push(level(2, (i * 3 + quantityShift) % 7));
  if (i === 7) levels.push(level(9, 4)); // location unknown locally
  const amount = costOverrides[i] ?? (i % 17 === 0 ? null : `${(i % 40) + 1}.50`); // every 17th: no unit cost
  return {
    id: `gid://shopify/ProductVariant/${i}`,
    inventoryItem: {
      unitCost: amount === null ? null : { amount, currencyCode: 'EUR' },
      inventoryLevels: { edges: levels },
    },
  };
}

/** Pages of VARIANT_INVENTORY_COST_PAGE_QUERY. Variant 301 is not in the local catalog. */
export function variantPages(opts = {}) {
  const nodes = [];
  for (let i = 1; i <= VARIANT_COUNT + 1; i += 1) nodes.push(variantNode(i, opts));
  const pages = [];
  for (let p = 0; p * PAGE_SIZE < nodes.length; p += 1) {
    const slice = nodes.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
    const hasNextPage = (p + 1) * PAGE_SIZE < nodes.length;
    pages.push({ productVariants: { edges: slice.map((node) => ({ node })), pageInfo: { hasNextPage, endCursor: hasNextPage ? `v${p + 1}` : null } } });
  }
  return pages;
}

function lineNode(k, n) {
  const variantNo = (k * 7 + n) % (VARIANT_COUNT + 5); // 0 and > 300: custom line / variant unknown locally
  return {
    id: `gid://shopify/LineItem/${k}-${n}`,
    title: `Synthetic item ${k}-${n}`,
    sku: n === 2 ? null : `SKU-${k}-${n}`,
    quantity: 1 + (k % 3),
    variant: variantNo === 0 ? null : { id: `gid://shopify/ProductVariant/${variantNo}` },
    originalUnitPriceSet: money(`${10 + (k % 9)}.00`),
    discountAllocations: k % 4 === 1 ? [{ allocatedAmountSet: money('2.00') }] : [],
    taxLines: [{ rate: 0.21, priceSet: money('1.74') }],
  };
}

function refundLine(lineItemId, quantity, amount) {
  return { node: { quantity, subtotalSet: money(amount), totalTaxSet: money('0.87'), lineItem: { id: lineItemId } } };
}

function orderNode(k, { refundAmountShift = 0 }) {
  const lines = [lineNode(k, 1)];
  if (k % 4 === 0) lines.push(lineNode(k, 2));
  const refunds = [];
  if (k % 10 === 0) {
    refunds.push({
      id: `gid://shopify/Refund/${k}`,
      createdAt: '2026-09-20T10:00:00Z',
      totalRefundedSet: money(10 + refundAmountShift),
      refundLineItems: { edges: [refundLine(lines[0].id, 1, '5.00')] },
    });
  }
  if (k === 20) {
    // Two refund lines on the same order line (conflict key refund_id,order_line_id: the last one wins) and a
    // refund line whose order line is not in this sync pass (reported as an error, never written).
    refunds.push({
      id: 'gid://shopify/Refund/20b',
      createdAt: '2026-09-21T10:00:00Z',
      totalRefundedSet: money(12),
      refundShippingLines: { edges: [{ node: { subtotalAmountSet: money('4.00'), taxAmountSet: money('0.84') } }] },
      refundLineItems: { edges: [refundLine(lines[1].id, 1, '3.00'), refundLine(lines[1].id, 1, '4.00'), refundLine('gid://shopify/LineItem/missing', 1, '1.00')] },
    });
  }
  const node = {
    id: `gid://shopify/Order/${k}`,
    name: `#${1000 + k}`,
    createdAt: `2026-09-${String(1 + (k % 25)).padStart(2, '0')}T09:00:00Z`,
    currencyCode: 'EUR',
    test: false,
    taxesIncluded: true,
    displayFinancialStatus: k % 10 === 0 ? 'PARTIALLY_REFUNDED' : 'PAID',
    retailLocation: k % 3 === 0 ? null : { id: `gid://shopify/Location/${k % 5 === 0 ? 9 : 1}` },
    customer: { id: `gid://shopify/Customer/${k % 30}` },
    lineItems: { edges: lines.map((l) => ({ node: l })) },
    refunds,
  };
  if (k % 2 === 0) {
    node.shippingLines = { edges: [{ node: { originalPriceSet: money('5.00'), discountedPriceSet: money('5.00'), taxLines: [{ rate: 0.21, priceSet: money('0.87') }] } }] };
  }
  if (k % 7 === 0) {
    node.sourceName = 'web';
    node.channelInformation = { channelDefinition: { handle: 'web', channelName: 'Online Store', subChannelName: 'Online Store' } };
    node.customerJourneySummary = {
      ready: true, customerOrderIndex: 1, daysToConversion: 2,
      firstVisit: { occurredAt: '2026-09-01T08:00:00Z', source: 'Google', sourceType: 'SEO', sourceDescription: null, referrerUrl: 'https://www.google.com/', landingPage: 'https://shop.example/products/x', utmParameters: {} },
      lastVisit: k % 14 === 0 ? null : { occurredAt: '2026-09-02T08:00:00Z', source: 'newsletter', sourceType: null, sourceDescription: null, referrerUrl: null, landingPage: 'https://shop.example/', utmParameters: { source: 'newsletter', medium: 'email', campaign: 'c1' } },
    };
  }
  return node;
}

/** Pages of ORDERS_PAGE_QUERY. */
export function orderPages(opts = {}) {
  const pages = [];
  for (let start = 1; start <= ORDER_COUNT; start += ORDERS_PER_PAGE) {
    const nodes = [];
    for (let k = start; k < start + ORDERS_PER_PAGE && k <= ORDER_COUNT; k += 1) nodes.push(orderNode(k, opts));
    const hasNextPage = start + ORDERS_PER_PAGE <= ORDER_COUNT;
    pages.push({ orders: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage, endCursor: hasNextPage ? `o${pages.length + 1}` : null } } });
  }
  return pages;
}

/** Fake Shopify serving the pages above by cursor. `failAtCursor` makes that page's fetch fail. */
export function volumeShopify({ variants = variantPages(), orders = orderPages(), failAtCursor = null } = {}) {
  const byCursor = (pages, prefix, cursor) => pages[cursor ? Number(cursor.slice(prefix.length)) : 0];
  return {
    async graphql(query, { cursor } = {}) {
      if (cursor && cursor === failAtCursor) throw new Error('simulated Shopify failure');
      if (query.includes('productVariants(')) return byCursor(variants, 'v', cursor);
      if (query.includes('orders(')) return byCursor(orders, 'o', cursor);
      throw new Error('unexpected query in volume fake shopify');
    },
  };
}

/**
 * Wraps a Supabase client and counts the HTTP requests the real client would send. selectAll pages at 1000
 * rows, so it costs floor(rows / 1000) + 1 requests.
 */
export function countRequests(supabase) {
  const counts = { total: 0, byCall: {} };
  const bump = (key, n = 1) => {
    counts.total += n;
    counts.byCall[key] = (counts.byCall[key] ?? 0) + n;
  };
  const client = {
    ...supabase,
    async select(table, params) { bump(`select ${table}`); return supabase.select(table, params); },
    async selectAll(table, params) {
      const rows = await supabase.selectAll(table, params);
      bump(`selectAll ${table}`, Math.floor(rows.length / 1000) + 1);
      return rows;
    },
    async insert(table, rows) { if (rows.length) bump(`insert ${table}`); return supabase.insert(table, rows); },
    async upsert(table, rows, opts) { if (rows.length) bump(`upsert ${table}`); return supabase.upsert(table, rows, opts); },
  };
  return { client, counts };
}
