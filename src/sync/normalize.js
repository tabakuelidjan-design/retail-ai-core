// Pure functions: Shopify GraphQL node -> local DB row shape. No I/O here on
// purpose - this is the part unit tests exercise directly, without a live
// Shopify or Supabase connection.

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
    source_system: 'shopify',
    source_id: node.id,
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
 */
export function normalizeInventorySnapshot(variantId, locationId, quantity, syncedAt) {
  return {
    variant_id: variantId,
    location_id: locationId,
    quantity,
    synced_at: syncedAt.toISOString(),
  };
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
 * V1 inventory cadence: at most one snapshot per (variant, location) per UTC
 * calendar day. Lets stockout-day math tell apart "unchanged", "sync didn't
 * run", and "real movement" - see docs/architecture/inventory-cost-sync.md.
 * @param {string} isoDate e.g. the synced_at of an existing snapshot
 * @param {Date} now
 */
export function isSameUtcDay(isoDate, now) {
  const a = new Date(isoDate);
  return (
    a.getUTCFullYear() === now.getUTCFullYear() &&
    a.getUTCMonth() === now.getUTCMonth() &&
    a.getUTCDate() === now.getUTCDate()
  );
}

/**
 * @param {{synced_at: string} | null} latestExisting most recent snapshot for this (variant, location)
 * @param {Date} now
 * @returns {boolean} true if a new snapshot should be written
 */
export function shouldWriteInventorySnapshot(latestExisting, now) {
  if (!latestExisting) return true;
  return !isSameUtcDay(latestExisting.synced_at, now);
}
