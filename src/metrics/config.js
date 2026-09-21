// Versioned, generic parameters for the metric engine and signals. These are
// DEFAULTS for any retailer; a merchant overrides them via mergeConfig() from
// its own config data (config/merchants/<merchant>/), never by editing code
// here. Changing a formula changes METRICS_VERSION; changing a threshold does not.

export const METRICS_VERSION = '2A.1';
export const DEMAND_VERSION = '2B.1';
export const BUYING_VERSION = '2C.1';

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
  // Demand & inventory facts (Phase 2B). Thresholds are configuration; the
  // classification rules themselves are versioned in DEMAND_VERSION.
  demand: {
    weeks: 8,
    minObservableWeeks: 4, // fewer observable weeks => INSUFFICIENT_HISTORY, never a confident label
    spikeShare: 0.6, spikeMinUnits: 4, // one week holds >= 60% of >= 4 units => ONE_OFF_SPIKE
    consistentMinActiveWeeks: 3, consistentMinActiveShare: 0.5,
    trend: { minObservableWeeks: 6, minUnits: 4, changeRatio: 0.5, minUnitDelta: 2 },
    cover: { minUnits: 3, lowWeeks: 4, slowWeeks: 26 },
    reorder: { minOrders: 3 }, // repeat-purchase evidence needed before reorder facts count as SUFFICIENT
    historyVerifiedDays: 90, // shorter history keeps sales facts PARTIAL
    roundQuantity: { minUnits: 100, multipleOf: 50 }, // descriptive marker of possibly uncounted stock
    minPeersForBenchmark: 3,
  },
  // Buying Intelligence Lite (Phase 2C). Money thresholds are merchant policy and are NOT defaulted:
  // a null value makes the dependent check INCOMPLETE instead of inventing a number.
  buying: {
    requiredChecks: ['inputs_complete', 'unit_margin', 'test_capital', 'peer_benchmark', 'sell_through', 'peer_exposure', 'capability_fit', 'lead_time'],
    testBudget: null, // max capital at risk for a test, in merchant currency
    minUnitMarginPct: null, // hurdle for unit margin ex tax after payment cost
    paymentCostPct: null, // processor cost as a share of retail ex tax (0 is a valid explicit value)
    taxRateAssumption: null, // used only to convert a tax-inclusive expected retail price
    maxSellThroughWeeks: 12,
    maxLeadTimeDays: null, // lead-time check is not applicable until the merchant sets a limit
    estimateTolerancePct: 0.25, // band applied to ESTIMATED / ASSUMPTION inputs when testing whether a conclusion could flip
    allowExploratoryTests: false, // off by default; a merchant enables it explicitly
    requireDecidedRetailPrice: false, // true: an ASSUMPTION retail price makes the inputs INCOMPLETE
    // Policy keys the merchant has marked as temporary (e.g. 'minUnitMarginPct'). A rejection that rests on a
    // provisional value is withheld (NEED MORE DATA) and the value is named as needing confirmation.
    provisional: [],
    exploratoryBudget: null,
    exposure: { noSaleShare: 0.6, coverWeeks: 26 },
    stockTrust: { blockedShare: 0.2, trustedShare: 0.8, verificationMaxAgeDays: 45, unverifiedMaySupportPass: true },
  },
  // unitCostIsAllInVariableCost: a merchant sets true only when unit cost already includes every variable
  // cost (e.g. a pure resale merchant, or a production cost module). Until then margin stays gated.
  gates: { minVerifiedCostCoverage: 0.8, maxStockSnapshotAgeHours: 36, unitCostIsAllInVariableCost: false },
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
