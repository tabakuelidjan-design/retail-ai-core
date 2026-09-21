// Versioned, generic parameters for the metric engine and signals. These are
// DEFAULTS for any retailer; a merchant overrides them via mergeConfig() from
// its own config data (config/merchants/<merchant>/), never by editing code
// here. Changing a formula changes METRICS_VERSION; changing a threshold does not.

export const METRICS_VERSION = '2A.1';

export const DEFAULT_CONFIG = {
  // Orders in these financial statuses are not sales (never fulfilled/paid).
  excludedOrderStatuses: ['VOIDED'],
  // 'no_recovery': a refunded unit's cost stays in COGS (refund != restock).
  // 'restocked': refunded units are treated as returned to stock, cost recovered.
  cogsRefundTreatment: 'no_recovery',
  segments: {
    lowSelling: { minStock: 5, maxUnits: 1 },
    noRecentSales: { minStock: 1 },
    highRefunds: { minUnits: 2, minRate: 0.2 },
    strong: { minUnits: 2, minMarginPct: 0.4, minStock: 3 },
  },
  candidate: { minUnits: 2, minMarginPct: 0.4, minStock: 3, maxRefundRate: 0.1, highConfidenceUnits: 4 },
  cashRisk: { highStockMinUnits: 10, lowVelocityMaxUnits: 2, lowMarginPct: 0.15 },
  quality: { staleInventoryHours: 36 },
  // Missing-cost triage: stock at or above this many units counts as meaningful inventory.
  triage: { minMeaningfulStock: 1, largestStockPositions: 15 },
};

export function mergeConfig(overrides = {}) {
  const out = structuredClone(DEFAULT_CONFIG);
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...out[k], ...v } : v;
  }
  return out;
}
