// Read-side copy of Core's per-merchant cost policy (retail-ai-core feature/core-declared-cost: src/sync/cost-policy.js).
//
// A merchant whose Shopify connector config says cost_policy = "merchant_declared" has confirmed that the Shopify "Coût par article" IS its reference
// purchase cost (supplier price + transport + other purchase costs). Core's sync records it as 'verified', but until that sync rule is deployed the
// scheduler writes 'unverified' imports every cycle. So the rule is also applied here, when the rows are read: for such a merchant ONLY, a positive
// Shopify-sourced cost is read as verified. Nothing is written; the amount is used as is; an amount <= 0 stays unverified (a typed 0 cannot be told from
// a default); an empty cost has no row; other merchants and other sources are untouched. Remove this once the Core rule is deployed everywhere.

export const COST_POLICY_DECLARED = 'merchant_declared';

/** The merchant's policy from its Shopify connector config (anything unknown or unreadable = default). */
export async function readCostPolicy(supabase, merchantId) {
  try {
    const rows = await supabase.select('merchant_connectors', { select: 'config', merchant_id: `eq.${merchantId}`, kind: 'eq.shopify', limit: '1' });
    return rows?.[0]?.config?.cost_policy === COST_POLICY_DECLARED ? COST_POLICY_DECLARED : null;
  } catch { return null; }
}

/** @returns the same rows, Shopify-sourced positive costs read as verified when the policy is declared (new objects; the input is not mutated). */
export function applyCostPolicy(costs, policy) {
  if (policy !== COST_POLICY_DECLARED) return costs;
  return costs.map((c) => (c.source === 'shopify_unit_cost' && c.validation_status === 'unverified' && Number(c.unit_cost) > 0 ? { ...c, validation_status: 'verified' } : c));
}
