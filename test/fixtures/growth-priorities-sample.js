// Synthetic engine payloads (hand-made, same shapes as the engines' outputs) for a small store in its first months: few sales per
// product, purchase costs not verified, a thin identified-customer base, a store history not yet long enough to compare.
// No real merchant data: every id, title and figure is invented for the tests.
const TH = { minObservableWeeks: 4, minUnits: 3, trend: { minObservableWeeks: 6, minUnits: 4 } };
const ppRow = (id, title, over = {}) => ({ id, title, units: 1, netSales: 10, trend: 'INSUFFICIENT_DATA', margin: { tier: 'UNVERIFIED', pct: 0.6 }, status: 'insufficient', action: 'none', rule: 'THIN_SAMPLE', reasons: ['COST_UNVERIFIED'], opportunity: null, top: false, topRank: null, ...over });
export function smallStore() {
  const products = {
    currency: 'EUR', window: { weeks: 8 }, thresholds: TH,
    rows: [
      ppRow('p1', 'Rising product', { units: 5, netSales: 195, trend: 'UP', status: 'watch', action: 'checkCost', rule: 'RISING_DEMAND_BLOCKED', top: true, topRank: 1 }),
      ppRow('p2', 'Steady best seller', { units: 4, netSales: 129, trend: 'FLAT', status: 'topSeller', action: 'keep', rule: 'TOP_SELLER', top: true, topRank: 2 }),
      ppRow('p3', 'Thin product', { units: 3, netSales: 86, status: 'stable', rule: 'NO_SIGNAL', reasons: ['COST_UNVERIFIED', 'TREND_INSUFFICIENT'] }),
      ...Array.from({ length: 12 }, (_, i) => ppRow(`t${i}`, `Single sale ${i}`)),
      ppRow('m1', 'No cost', { margin: { tier: 'MISSING', pct: null }, reasons: ['COST_MISSING'] }),
    ],
  };
  const store = {
    currency: 'EUR', mode: 'store', window: { weeks: 8, previousComparable: false }, thresholds: { minOrders: 30 },
    store: { orders: 38 }, online: { orders: 6 },
    topProducts: [
      { id: 'p1', title: 'Rising product', net: 195, units: 5, share: 0.167, potentialStatus: 'watch', highlightAllowed: false },
      { id: 'p2', title: 'Steady best seller', net: 129, units: 4, share: 0.11, potentialStatus: 'topSeller', highlightAllowed: true },
    ],
    actions: [{ code: 'highlightProduct', productId: 'p2', title: 'Steady best seller', share: 0.11 }],
  };
  const noSku = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, title: `Catalog item ${i}`, units: 0, netSales: 0, problems: ['missingSku'] }));
  const content = {
    currency: 'EUR', scope: { analysed: 140 },
    problems: [{ code: 'missingSku', count: 126 }, { code: 'noType', count: 2 }],
    rows: [
      { id: 'p1', title: 'Rising product', units: 5, netSales: 195, problems: ['noType', 'missingSku'] },
      { id: 'p2', title: 'Steady best seller', units: 4, netSales: 129, problems: ['noType', 'missingSku'] },
      ...noSku(124),
    ],
  };
  const audience = {
    currency: 'EUR', window: { days: 90 }, thresholds: { minCustomers: 30, minGroup: 30 }, identifiedCustomers: 18,
    segments: [{ key: 'new', status: 'insufficient', customers: 17, opportunity: null }, { key: 'loyal', status: 'insufficient', customers: 1, opportunity: null }],
  };
  return { products, store, content, audience };
}

