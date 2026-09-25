// Pure functions: Shopify GraphQL node -> local DB row shape. No I/O here on
// purpose - this is the part unit tests exercise directly, without a live
// Shopify or Supabase connection.

import { normalizeOrderChannel } from '../marketing/adapters/shopify.js';
import { pseudonymizeCustomerId } from '../customers/pseudonym.js';

/** @param {{id: string, name: string, myshopifyDomain: string}} shop */
export function normalizeMerchant(shop) {
  return {
    name: shop.name,
    vertical: 'general_retail',
    source_system: 'shopify',
    source_id: shop.id,
    source_domain: shop.myshopifyDomain,
  };
}

/** @param {{id: string, name: string}} node */
export function normalizeLocation(node, merchantId) {
  return {
    merchant_id: merchantId,
    name: node.name,
    // Shopify's Location object has no field that reliably maps to
    // store/warehouse/online (see docs/architecture/shopify-catalog-sync.md).
    // Never invent one - 'unknown' is the honest default.
    type: 'unknown',
    source_system: 'shopify',
    source_id: node.id,
  };
}

/** @param {{id: string, title: string, handle: string}} node */
export function normalizeProduct(node, merchantId) {
  return {
    merchant_id: merchantId,
    title: node.title,
    handle: node.handle,
    // Empty productType stays null = UNCLASSIFIED; it is never guessed from the title.
    product_type: node.productType?.trim() ? node.productType.trim() : null,
    source_created_at: node.createdAt ?? null,
    source_status: node.status ?? null,
    source_system: 'shopify',
    source_id: node.id,
  };
}

/** Collection membership; identity is the source collection id, never the title. */
export function normalizeProductCollection(collectionNode, productId, merchantId, syncedAt) {
  return {
    merchant_id: merchantId,
    product_id: productId,
    source_system: 'shopify',
    source_id: collectionNode.id,
    title: collectionNode.title,
    is_current: true,
    synced_at: syncedAt.toISOString(),
  };
}

/** @param {{id: string, title: string, sku: string|null}} node */
export function normalizeVariant(node, productId, merchantId) {
  return {
    product_id: productId,
    merchant_id: merchantId,
    // Never trust sku as identity - nullable, and confirmed duplicated
    // across unrelated variants in real HABB data. It's descriptive only.
    sku: node.sku ?? null,
    title: node.title ?? null,
    source_system: 'shopify',
    source_id: node.id,
  };
}

/**
 * @param {string} variantId local variant uuid
 * @param {string} locationId local location uuid
 * @param {number} quantity
 * @param {Date} syncedAt
 * @param {string} merchantId direct tenant ownership (migration 20260922230000) - required, never inferred
 */
export function normalizeInventorySnapshot(variantId, locationId, quantity, syncedAt, merchantId) {
  return {
    variant_id: variantId,
    location_id: locationId,
    quantity,
    synced_at: syncedAt.toISOString(),
    merchant_id: merchantId,
  };
}

/**
 * The value a future `observed_local_date` column (proposed, NOT yet
 * applied - see docs/architecture/inventory-cost-sync.md) would store, so a
 * DB-level UNIQUE(variant_id, location_id, observed_local_date) constraint
 * could enforce the one-per-merchant-local-day rule deterministically
 * instead of relying only on this application's pre-insert check.
 */
export function computeObservedLocalDate(syncedAt, timeZone) {
  return localCalendarDate(syncedAt.toISOString(), timeZone);
}

/**
 * Extracts the "available" quantity for a given location from an
 * InventoryItem's inventoryLevels connection, or null if that location isn't
 * tracked for this item.
 */
export function extractAvailableQuantity(inventoryItem, locationSourceId) {
  const edge = inventoryItem.inventoryLevels.edges.find(
    (e) => e.node.location.id === locationSourceId,
  );
  if (!edge) return null;
  const q = edge.node.quantities.find((x) => x.name === 'available');
  return q ? q.quantity : null;
}

/**
 * @param {string} variantId local variant uuid
 * @param {string} merchantId local merchant uuid
 * @param {{amount: string, currencyCode: string} | null} unitCost
 * @returns {object | null} a product_costs row, or null when there's no
 *   Shopify cost - the caller must NOT create a row in that case (UNCLASSIFIED).
 */
export function normalizeProductCost(variantId, merchantId, unitCost, effectiveFrom) {
  if (!unitCost) return null;
  return {
    variant_id: variantId,
    merchant_id: merchantId,
    unit_cost: Number(unitCost.amount),
    currency: unitCost.currencyCode,
    effective_from: effectiveFrom.toISOString(),
    source: 'shopify_unit_cost',
    validation_status: 'unverified',
  };
}

/**
 * Decides whether a new product_costs row is needed by comparing the
 * candidate against the most recent existing row for the variant. Mirrors
 * the DB-level "IS DISTINCT FROM" check used during manual Phase 1B testing,
 * but expressed as a pure, directly-testable function.
 * @param {{unit_cost: number, currency: string, source: string, validation_status: string} | null} latestExisting
 * @param {{unit_cost: number, currency: string, source: string, validation_status: string}} candidate
 */
export function costHasChanged(latestExisting, candidate) {
  if (!latestExisting) return true;
  return (
    latestExisting.unit_cost !== candidate.unit_cost ||
    latestExisting.currency !== candidate.currency ||
    latestExisting.source !== candidate.source ||
    latestExisting.validation_status !== candidate.validation_status
  );
}

/**
 * V1 inventory cadence: at most one snapshot per (variant, location) per
 * MERCHANT-LOCAL calendar day (not UTC) - a merchant's "business day" is
 * what stockout-day math actually needs to reason about. Lets that future
 * math tell apart "unchanged", "sync didn't run", and "real movement" - see
 * docs/architecture/inventory-cost-sync.md.
 *
 * The timezone is a parameter, never hardcoded: this is generic-core code,
 * and HABB's 'Europe/Brussels' is merchant configuration, not architecture.
 *
 * @param {string} isoDate e.g. the synced_at of an existing snapshot
 * @param {Date} now
 * @param {string} timeZone an IANA zone name, e.g. 'Europe/Brussels'
 * @returns {string} the local calendar date as YYYY-MM-DD
 */
export function localCalendarDate(isoDate, timeZone) {
  // en-CA formats as YYYY-MM-DD, which is exactly the comparable/storable form.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(isoDate));
}

export function isSameLocalDay(isoDateA, isoDateB, timeZone) {
  return localCalendarDate(isoDateA, timeZone) === localCalendarDate(isoDateB, timeZone);
}

/**
 * @param {{synced_at: string} | null} latestExisting most recent snapshot for this (variant, location)
 * @param {Date} now
 * @param {string} timeZone merchant-local IANA zone name
 * @returns {boolean} true if a new snapshot should be written
 */
export function shouldWriteInventorySnapshot(latestExisting, now, timeZone) {
  if (!latestExisting) return true;
  return !isSameLocalDay(latestExisting.synced_at, now.toISOString(), timeZone);
}

// --- Orders / order lines / refunds / refund lines (Phase 1C) ---
//
// V1 scope: business transaction data only. No customer name, email, phone,
// or address field is ever read from these nodes, even though Shopify's
// Order object exposes them - they are simply not part of the GraphQL
// selection in src/shopify/queries.js, and none of the functions below
// accept or forward anything customer-identifying.

const sumMoney = (amounts) => amounts.reduce((total, a) => total + Number(a), 0);

/**
 * @param {{id: string, createdAt: string, currencyCode: string, taxesIncluded: boolean, displayFinancialStatus: string, retailLocation: {id: string} | null}} node
 * @param {string} merchantId
 * @param {string | null} locationId local location uuid, or null if this
 *   order has no retailLocation (e.g. an online order) or its location
 *   hasn't been synced by the catalog sync yet.
 */
/**
 * Shipping as reported by the source. `shippingLines` absent from the node = not captured (all NULL, never assumed to be zero);
 * present but empty = the order had no shipping (zeros).
 */
export function normalizeShipping(node) {
  if (!node.shippingLines) return { shipping_price: null, shipping_discount: null, shipping_tax: null, shipping_tax_rate_bp: null };
  const lines = node.shippingLines.edges.map((e) => e.node);
  const price = lines.reduce((a, l) => a + Number(l.originalPriceSet.shopMoney.amount), 0);
  const discounted = lines.reduce((a, l) => a + Number(l.discountedPriceSet.shopMoney.amount), 0);
  const taxLines = lines.flatMap((l) => l.taxLines ?? []);
  const rates = [...new Set(taxLines.map((t) => Math.round(Number(t.rate) * 10000)))];
  return {
    shipping_price: Math.round(price * 100) / 100,
    shipping_discount: Math.round((price - discounted) * 100) / 100,
    shipping_tax: Math.round(taxLines.reduce((a, t) => a + Number(t.priceSet.shopMoney.amount), 0) * 100) / 100,
    shipping_tax_rate_bp: rates.length === 1 ? rates[0] : null, // several different rates on shipping: not collapsed into one
  };
}

export function normalizeOrder(node, merchantId, locationId, { customerKeySecret = null } = {}) {
  return {
    merchant_id: merchantId,
    location_id: locationId,
    source_system: 'shopify',
    source_id: node.id,
    ordered_at: node.createdAt,
    currency: node.currencyCode,
    status: node.displayFinancialStatus,
    taxes_included: node.taxesIncluded,
    is_test: node.test === true,
    order_name: node.name ?? null,
    ...normalizeShipping(node),
    ...normalizeOrderChannel(node),
    // Only present when customer keys are enabled: a keyed hash of the customer id (never the id itself).
    ...(customerKeySecret ? { customer_key: pseudonymizeCustomerId(node.customer?.id, customerKeySecret) } : {}),
  };
}

/**
 * The VAT rate the source reported for a line, in basis points. No tax lines = the source reported no tax = 0.
 * Several tax lines on one line (compound or multiple taxes) cannot be expressed as one rate = null (unavailable, never guessed).
 * A source that does not supply a rate on the tax line also yields null.
 */
export function lineTaxRateBp(taxLines) {
  if (!Array.isArray(taxLines) || taxLines.length === 0) return 0;
  if (taxLines.length > 1) return null; // several taxes on one line cannot be expressed as one VAT rate
  return typeof taxLines[0].rate === 'number' ? Math.round(taxLines[0].rate * 10000) : null;
}

/**
 * @param {object} lineItemNode a LineItem from ORDERS_PAGE_QUERY
 * @param {string} orderId local order uuid
 * @param {string | null} variantId local variant uuid, or null when the
 *   variant no longer exists in the catalog (deleted product) or the line
 *   is a custom item with no catalog variant at all - the order line must
 *   survive either way, using title_snapshot/sku_snapshot.
 * @param {string} merchantId direct tenant ownership (migration 20260922230000) - required, never inferred
 */
export function normalizeOrderLine(lineItemNode, orderId, variantId, merchantId) {
  const taxAmount = sumMoney(lineItemNode.taxLines.map((t) => t.priceSet.shopMoney.amount));
  return {
    order_id: orderId,
    merchant_id: merchantId,
    variant_id: variantId,
    source_system: 'shopify',
    source_id: lineItemNode.id,
    title_snapshot: lineItemNode.title,
    sku_snapshot: lineItemNode.sku ?? null,
    quantity: lineItemNode.quantity,
    unit_price: Number(lineItemNode.originalUnitPriceSet.shopMoney.amount),
    discount_amount: sumMoney(lineItemNode.discountAllocations.map((d) => d.allocatedAmountSet.shopMoney.amount)),
    tax_amount: taxAmount,
    tax_rate_bp: lineTaxRateBp(lineItemNode.taxLines),
  };
}

/**
 * @param {{id: string, createdAt: string, totalRefundedSet: {shopMoney: {amount: string}}}} refundNode
 * @param {string} orderId local order uuid
 * @param {string} merchantId direct tenant ownership (migration 20260922230000) - required, never inferred
 */
export function normalizeRefund(refundNode, orderId, merchantId) {
  return {
    order_id: orderId,
    merchant_id: merchantId,
    source_system: 'shopify',
    source_id: refundNode.id,
    amount: Number(refundNode.totalRefundedSet.shopMoney.amount),
    refunded_at: refundNode.createdAt,
    ...(refundNode.refundShippingLines
      ? {
        shipping_subtotal: Math.round(refundNode.refundShippingLines.edges.reduce((a, e) => a + Number(e.node.subtotalAmountSet.shopMoney.amount), 0) * 100) / 100,
        shipping_tax: Math.round(refundNode.refundShippingLines.edges.reduce((a, e) => a + Number(e.node.taxAmountSet.shopMoney.amount), 0) * 100) / 100,
      }
      : { shipping_subtotal: null, shipping_tax: null }),
    reason: null, // Shopify's refund note field is free text written by staff and may contain
    // customer-identifying context; V1 doesn't need it, so it's never read (see queries.js).
  };
}

/**
 * @param {object} refundLineItemNode a RefundLineItem from ORDERS_PAGE_QUERY
 * @param {string} refundId local refund uuid
 * @param {string} orderLineId local order_line uuid - must already exist
 *   (the order line is synced before its order's refunds).
 * @param {string} currency the parent order's currency (RefundLineItem
 *   itself carries no currency field of its own).
 * @param {string} merchantId direct tenant ownership (migration 20260922230000) - supplied directly from the
 *   sync context (one merchant per run), not derived/cross-checked - that cross-check is only needed when
 *   backfilling ownership for rows that already exist without it.
 */
export function normalizeRefundLine(refundLineItemNode, refundId, orderLineId, currency, merchantId) {
  return {
    refund_id: refundId,
    merchant_id: merchantId,
    order_line_id: orderLineId,
    quantity: refundLineItemNode.quantity,
    amount: Number(refundLineItemNode.subtotalSet.shopMoney.amount),
    tax_amount: Number(refundLineItemNode.totalTaxSet.shopMoney.amount),
    currency,
  };
}
