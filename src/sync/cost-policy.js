// Per-merchant policy for the cost the Shopify sync reads (inventoryItem.unitCost, "Coût par article").
//
//   DEFAULT (every merchant unless configured): the Shopify cost is recorded as an UNVERIFIED import - nothing says it is the merchant's
//   own reference cost, so margins built on it stay "à vérifier".
//   MERCHANT_DECLARED: the merchant confirmed that this Shopify field IS their reference purchase cost (complete: supplier price +
//   transport + other purchase costs). The amount is used as is - never topped up with fees, never replaced by a spreadsheet estimate -
//   and recorded with validation_status 'verified'. The policy is stored in the merchant's own Shopify connector config
//   (merchant_connectors.config.cost_policy, non-secret), so it applies to that merchant only.
//
// PROVENANCE: product_costs.source is a closed set (no migration here), so a declared cost keeps source = 'shopify_unit_cost' and carries
// validation_status = 'verified'; costProvenance() names that pair "shopify_declared_by_merchant" (Shopify · coût déclaré par le marchand).
//
// ZERO: Shopify returns null when the field is empty (no row, cost MISSING) but cannot tell an explicitly typed 0 from a default 0, so an
// amount <= 0 is never accepted as declared: it stays 'unverified' (and the metric layer already reads a non-positive cost as MISSING).

export const COST_POLICY = Object.freeze({ DEFAULT: 'shopify_unit_cost_unverified', MERCHANT_DECLARED: 'merchant_declared' });
export const COST_PROVENANCE = Object.freeze({ DECLARED: 'shopify_declared_by_merchant', IMPORTED: 'shopify_unit_cost_unverified' });

/** The policy of a connector config; anything unknown or absent is the default (rules in force for the other merchants). */
export function resolveCostPolicy(config) {
  const v = config && typeof config === 'object' ? config.cost_policy : undefined;
  return v === COST_POLICY.MERCHANT_DECLARED ? COST_POLICY.MERCHANT_DECLARED : COST_POLICY.DEFAULT;
}

/** Provenance label of a stored cost row (null for rows from other sources). */
export function costProvenance(row) {
  if (!row || row.source !== 'shopify_unit_cost') return row?.source ?? null;
  return row.validation_status === 'verified' ? COST_PROVENANCE.DECLARED : COST_PROVENANCE.IMPORTED;
}
