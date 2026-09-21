// Versioned, generic parameters for the metric engine and signals. These are
// DEFAULTS for any retailer; a merchant overrides them via mergeConfig() from
// its own config data (config/merchants/<merchant>/), never by editing code
// here. Changing a formula changes METRICS_VERSION; changing a threshold does not.

export const METRICS_VERSION = '2A.1';
export const DEMAND_VERSION = '2B.1';
export const BUYING_VERSION = '2C.1';
export const MARKETING_VERSION = '2D.2';
export const CUSTOMERS_VERSION = '2E.1';

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
  // Marketing measurement (Phase 2D). Everything merchant-specific is data here, never code: own domains,
  // target markets and brand terms default to EMPTY and are then reported as unknown, not guessed.
  marketing: {
    ownHosts: [], // the merchant's own domains: a referrer from one of them is internal navigation, not a source
    targetMarkets: [], // countries the merchant sells to; empty = traffic geography cannot be judged
    brandRules: [], // explicit only: [{ type: 'contains' | 'equals' | 'starts_with', value: '...' }]
    onlineChannelHandles: ['web', 'online_store'],
    posChannelHandles: ['pos'],
    taxonomy: {
      mediumMap: {
        cpc: 'paid_search', ppc: 'paid_search', paidsearch: 'paid_search', 'paid-search': 'paid_search', sem: 'paid_search',
        paid_social: 'paid_social', paidsocial: 'paid_social', 'paid-social': 'paid_social', cpm: 'paid_social',
        display: 'paid_display', banner: 'paid_display', email: 'email', newsletter: 'email', affiliate: 'affiliate',
        referral: 'referral', organic: 'organic_search', social: 'organic_social', 'social-media': 'organic_social',
      },
      sourceTypeMap: { SEO: 'organic_search', EMAIL: 'email', SOCIAL: 'organic_social', DIRECT: 'direct' },
      searchHosts: ['google.', 'bing.', 'duckduckgo.', 'ecosia.', 'yahoo.', 'yandex.', 'qwant.', 'baidu.', 'startpage.'],
      socialHosts: ['facebook.', 'instagram.', 'tiktok.', 'pinterest.', 'youtube.', 'linkedin.', 'twitter.', 't.co', 'x.com', 'reddit.'],
      aiAssistantHosts: ['chatgpt.', 'openai.', 'perplexity.', 'claude.ai', 'gemini.', 'copilot.'],
    },
    minAttributedOrdersForPaidMetrics: 30,
    minSpendCoverage: 0.95, // share of window days that must have spend rows before spend-based metrics open
    minCampaignLinkage: 0.8, // share of paid-attributed orders whose campaign matches an ad campaign
    minSessionsForConversion: 100,
    minSessionsForLandingSignal: 10, // a landing page needs this many sessions before "traffic but no sales" is reported
    maxNonTargetSessionShare: 0.3, // above this, sessions are not a valid denominator for the merchant's orders
    windowToleranceDays: 1, // traffic/ads windows may differ from the order window by this many days
    maxUnattributedOnlineShare: 0.2, // above this, channel attribution is too incomplete for spend-based metrics
    // Search visibility (Phase 2D.2). Classification exists ONLY through explicit rules; with none configured every
    // query is 'unclassified'. Thresholds are configuration for rule-based facts, not recommendations.
    search: {
      intentRules: { local: [], product: [], informational: [] }, // [{ type: 'contains'|'equals'|'starts_with', value }]
      intentPrecedence: ['local', 'product', 'informational'],
      opportunity: {
        minImpressions: 40, lowCtr: 0.02, // HIGH_IMPRESSIONS_LOW_CTR
        positionBand: { from: 4, to: 15 }, minImpressionsPositionBand: 20, // POSITION_BAND_MEANINGFUL_IMPRESSIONS
        minPageImpressions: 40, // PRODUCT_PAGE_VISIBLE_WEAK_CTR
        excludeBranded: true, // branded queries are not treated as discovery opportunities (only when brand rules exist)
      },
      minQueryCoverage: 0.5, // below this share of reported clicks, query-level facts carry a coverage caveat
      concentrationTopN: 5,
      maxTargetMarketGap: 0.3, // search vs sessions non-target share may differ by this much before a mismatch is reported
    },
  },
  // Customer behaviour facts (Phase 2E). Order-level only: no customer identity is stored or read.
  customers: {
    minOrdersPerGroup: 30, // each group compared (new vs returning) needs this many orders before a comparison is safe for Phase 3
    shortHistoryDays: 90, // an order history shorter than this is flagged SHORT_HISTORY
    basket: { minOrders: 30, minPairSupport: 3, maxPairs: 20 }, // co-purchase pairs are listed only above both thresholds
    minCustomers: 30, // customer-level averages, repeat rate and concentration need this many identified customers
    minIntervals: 10, // time-between-purchases needs this many observed gaps
    concentration: { topN: 5, riskTop1Share: 0.2, riskTopNShare: 0.5 }, // shares above these are flagged (only once the sample gate is open)
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
  // marketing.search is nested one level deeper: a merchant override of some keys must keep the other defaults.
  const s = overrides.marketing?.search;
  if (s && typeof s === 'object') {
    const d = DEFAULT_CONFIG.marketing.search;
    out.marketing.search = { ...structuredClone(d), ...s, opportunity: { ...d.opportunity, ...(s.opportunity ?? {}) }, intentRules: { ...d.intentRules, ...(s.intentRules ?? {}) } };
  }
  return out;
}
