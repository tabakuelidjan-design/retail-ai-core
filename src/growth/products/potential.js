// Growth > Potentiel produits - the decision engine. Pure and deterministic: facts in, one Growth status per product out.
// It answers "which products should I push, watch or avoid promoting now?" (Analytics > Produits answers "what is happening").
// Chain per product: Signal -> Preuve -> Opportunité -> Confiance -> Effort -> Action.
//
// Inputs are the EXISTING deterministic facts, never re-derived here:
//   - demand facts (src/demand, 8 complete weeks): units, weekly trend (last 4 vs previous 4 weeks), stock + its quality, cover,
//     observable weeks (product age), refunds;
//   - product performance (src/metrics/products, same window): net sales, gross margin with its status and cost confidence,
//     refund rate.
// Thresholds are the merchant configuration that already exists (src/metrics/config.js) - none is invented here:
//   demand.minObservableWeeks, demand.cover.minUnits / lowWeeks, cashRisk.lowMarginPct, segments.highRefunds,
//   candidate.maxRefundRate, hierarchy.topN. An unknown value is never turned into 0 (no cost != 0 % margin; no stock snapshot != out of stock).

export const POTENTIAL_VERSION = 'growth-potential.1';
export const STATUSES = ['push', 'restock', 'topSeller', 'watch', 'declining', 'lowMargin', 'returns', 'insufficient', 'stable'];
/** Statuses counted as "À surveiller" (a risk or a contradiction the merchant should look at). */
export const WATCH_GROUP = ['watch', 'declining', 'lowMargin', 'returns'];
/** The page's filter pills, in display order. */
export const FILTERS = ['all', 'push', 'growth', 'top', 'watch', 'restock', 'lowMargin', 'insufficient'];
// "Meilleures ventes" = the existing top-products list size of the merchant configuration (hierarchy.topN, the same list
// Analytics uses): a rank on net sales, not a sales threshold.
const topSellers = (config) => config.hierarchy.topN;

const STOCK_USABLE = ['UNVERIFIED', 'SUSPECT_ROUND_QUANTITY']; // Shopify-reported, recent enough (never physically verified)
const round4 = (x) => Math.round(x * 10000) / 10000;

/** Margin reliability from the existing gross-profit object: never a guess. */
export function marginTier(grossProfit) {
  if (!grossProfit || grossProfit.status === 'UNCLASSIFIED' || grossProfit.status === 'UNAVAILABLE') return 'MISSING';
  if (grossProfit.status === 'PARTIAL') return 'PARTIAL';
  return grossProfit.cost_confidence === 'VERIFIED' ? 'RELIABLE' : 'UNVERIFIED';
}

/** Stock as a decision input: 'known' (usable quantity, possibly 0) or why it cannot be used. */
export function stockState(inventory) {
  const q = inventory?.stock_quality ?? 'NO_STOCK_DATA';
  if (STOCK_USABLE.includes(q)) return { usable: true, quality: q, units: inventory.stock_units };
  return { usable: false, quality: q, units: null }; // STALE / NO_STOCK_DATA / UNRELIABLE_NEGATIVE: unknown, not 0
}

/**
 * The Growth status of one active product, with its evidence and reasons (first matching rule wins).
 * @param {object} f merged facts: { units, netSales, trend, observableWeeks, inventory, cover, grossProfit, refundRate, unitsRefunded, topRank }
 */
export function classifyProduct(f, config) {
  const cfg = { minObs: config.demand.minObservableWeeks, minUnits: config.demand.cover.minUnits, lowWeeks: config.demand.cover.lowWeeks,
    lowMargin: config.cashRisk.lowMarginPct, highRefunds: config.segments.highRefunds, maxRefundRate: config.candidate.maxRefundRate };
  const stock = stockState(f.inventory);
  const tier = marginTier(f.grossProfit);
  const marginPct = tier === 'MISSING' ? null : f.grossProfit.margin_pct;
  const up = f.trend?.direction === 'UP';
  const down = f.trend?.direction === 'DOWN';
  const top = f.topRank != null && f.topRank <= topSellers(config);
  const favorable = up || top;
  const coverOk = stock.usable && f.cover?.status === 'CALCULATED' && f.cover.weeks >= cfg.lowWeeks;
  const coverLow = stock.usable && ((stock.units ?? 0) <= 0 || (f.cover?.status === 'CALCULATED' && f.cover.weeks < cfg.lowWeeks));
  const highReturns = f.unitsRefunded >= cfg.highRefunds.minUnits && f.refundRate != null && f.refundRate >= cfg.highRefunds.minRate;
  const elevatedReturns = f.refundRate != null && f.refundRate > cfg.maxRefundRate;

  const reasons = [];
  if (tier === 'MISSING') reasons.push('COST_MISSING'); else if (tier === 'PARTIAL') reasons.push('MARGIN_PARTIAL'); else if (tier === 'UNVERIFIED') reasons.push('COST_UNVERIFIED');
  if (!stock.usable) reasons.push(stock.quality === 'STALE' ? 'STOCK_STALE' : 'STOCK_UNAVAILABLE');
  if (stock.usable && f.cover?.status !== 'CALCULATED' && (stock.units ?? 0) > 0) reasons.push('COVER_UNKNOWN');
  if (highReturns) reasons.push('HIGH_RETURNS'); else if (elevatedReturns) reasons.push('RETURNS_ELEVATED');
  if (f.trend?.direction === 'INSUFFICIENT_DATA') reasons.push('TREND_INSUFFICIENT');

  const out = (status, action, rule) => ({ status, action, rule, reasons, marginTier: tier, marginPct, stock, favorable, top, up });
  // 1. Not enough evidence for any recommendation (new product or too few units).
  if (f.observableWeeks < cfg.minObs || f.units < cfg.minUnits) return out('insufficient', 'none', f.observableWeeks < cfg.minObs ? 'NEW_PRODUCT' : 'THIN_SAMPLE');
  // 2. Good demand but the stock cannot absorb a promotion: restock first, never "push".
  if (favorable && coverLow) return out('restock', 'restockFirst', (stock.units ?? 0) <= 0 ? 'DEMAND_BUT_OUT_OF_STOCK' : 'DEMAND_BUT_LOW_COVER');
  // 3. Abnormal refunds: contradictory with good demand -> watch; otherwise the product's own problem.
  if (highReturns) return favorable ? out('watch', 'reviewReturns', 'DEMAND_BUT_HIGH_RETURNS') : out('returns', 'doNotPromote', 'HIGH_RETURNS');
  // 4. Margin too thin - only when the margin is reliable (verified costs covering all its revenue).
  if (tier === 'RELIABLE' && marginPct != null && marginPct < cfg.lowMargin) return out('lowMargin', 'doNotPromote', 'LOW_RELIABLE_MARGIN');
  // 5. A real decline over the comparable period.
  if (down) return out('declining', 'watch', 'TREND_DOWN');
  // 6. Push: rising demand + enough cover + reliable margin + normal refunds.
  if (up && coverOk && tier === 'RELIABLE' && !elevatedReturns) return out('push', 'increaseVisibility', 'RISING_DEMAND_COVERED_RELIABLE_MARGIN');
  // 7. Rising demand, but something blocks a push: say what to check first (a steady top seller is not promoted anyway).
  if (up) {
    const first = !stock.usable ? 'checkStock' : tier !== 'RELIABLE' ? 'checkCost' : elevatedReturns ? 'reviewReturns' : 'watch';
    return out('watch', first, 'RISING_DEMAND_BLOCKED');
  }
  // 8. A top seller without a new push signal: keep it available, no new promotion needed.
  if (top) return out('topSeller', 'keep', 'TOP_SELLER');
  return out('stable', 'none', 'NO_SIGNAL');
}

/** The primary evidence shown in the "Signal Growth" column (code + values; the UI words it). */
export function primarySignal(f, c) {
  if (c.status === 'insufficient') return { code: c.rule === 'NEW_PRODUCT' ? 'newProduct' : 'thinSample', units: f.units };
  if (c.status === 'restock') return (c.stock.units ?? 0) <= 0 ? { code: 'outOfStock' } : { code: 'coverDays', days: f.cover.days };
  if (c.status === 'returns' || c.rule === 'DEMAND_BUT_HIGH_RETURNS') return { code: 'returnRate', rate: f.refundRate };
  if (c.status === 'lowMargin') return { code: 'margin', pct: c.marginPct };
  if (f.evolution != null && (c.up || c.status === 'declining')) return { code: 'evolution', pct: f.evolution };
  if (c.top) return { code: 'topRank', rank: f.topRank };
  return { code: 'none' };
}

/**
 * The page payload from the merged product facts (one entry per ACTIVE product = units sold in the window).
 * @param {Array<object>} facts see classifyProduct; plus { key, title, imageUrl, category, matched }
 */
export function buildProductPotential(facts, { config, currency, window, dataQuality }) {
  const active = facts.filter((f) => f.units > 0);
  const ranked = [...active].sort((a, b) => b.netSales - a.netSales || a.key.localeCompare(b.key));
  ranked.forEach((f, i) => { f.topRank = i + 1; });
  const rows = ranked.map((f) => {
    const c = classifyProduct(f, config);
    return {
      id: f.key, title: f.title, imageUrl: f.imageUrl ?? null, category: f.category ?? null, matched: f.matched !== false,
      netSales: f.netSales, units: f.units, evolution: f.evolution, trend: f.trend?.direction ?? 'INSUFFICIENT_DATA',
      margin: { tier: c.marginTier, pct: c.marginPct },
      stock: { usable: c.stock.usable, quality: c.stock.quality, units: c.stock.units },
      // Cover is only meaningful on a usable stock quantity: from a stale / missing snapshot it is not shown (status STOCK_UNUSABLE).
      cover: c.stock.usable
        ? { status: f.cover?.status ?? null, days: f.cover?.status === 'CALCULATED' ? f.cover.days : null, weeks: f.cover?.status === 'CALCULATED' ? f.cover.weeks : null }
        : { status: 'STOCK_UNUSABLE', days: null, weeks: null },
      refunds: { units: f.unitsRefunded, rate: f.refundRate },
      topRank: f.topRank, top: c.top, status: c.status, action: c.action, rule: c.rule, reasons: c.reasons,
      signal: primarySignal(f, c),
      evidence: { recentUnits: f.trend?.recent_units ?? null, priorUnits: f.trend?.prior_units ?? null, weeksEachSide: f.trend?.weeks_each_side ?? null, observableWeeks: f.observableWeeks, velocityWeekly: f.velocity8 ?? null, snapshotAt: f.inventory?.snapshot_at ?? null },
      // A strong recommendation can later become a Growth opportunity (contract only: nothing is persisted here).
      opportunity: c.status === 'push' || c.status === 'restock' ? { kind: c.status === 'push' ? 'productVisibility' : 'productRestock', productId: f.key } : null,
    };
  });
  // Filter membership is decided here, once: the UI filters on row.filters and never re-derives a business group.
  for (const r of rows) {
    r.filters = FILTERS.filter((k) => k === 'all' || (k === 'push' && r.status === 'push') || (k === 'growth' && r.trend === 'UP') || (k === 'top' && r.top)
      || (k === 'watch' && WATCH_GROUP.includes(r.status)) || (k === 'restock' && r.status === 'restock') || (k === 'lowMargin' && r.status === 'lowMargin')
      || (k === 'insufficient' && r.status === 'insufficient'));
  }
  const count = (fn) => rows.filter(fn).length;
  const kpis = {
    activeProducts: rows.length,
    push: count((r) => r.status === 'push'),
    watch: count((r) => WATCH_GROUP.includes(r.status)),
    restock: count((r) => r.status === 'restock'),
  };
  const filters = Object.fromEntries(FILTERS.map((k) => [k, count((r) => r.filters.includes(k))]));
  const PROTECT_ORDER = ['restock', 'returns', 'lowMargin', 'watch', 'declining'];
  const toPush = rows.filter((r) => r.status === 'push').slice(0, 5);
  const toProtect = rows.filter((r) => PROTECT_ORDER.includes(r.status))
    .sort((a, b) => PROTECT_ORDER.indexOf(a.status) - PROTECT_ORDER.indexOf(b.status) || b.netSales - a.netSales).slice(0, 5);
  const byStatus = STATUSES.map((s) => ({ status: s, count: count((r) => r.status === s) })).filter((s) => s.count > 0);
  const totalSales = rows.reduce((a, r) => a + r.netSales, 0);
  return {
    version: POTENTIAL_VERSION, currency, window, kpis, filters, rows, toPush, toProtect, byStatus,
    totals: { netSales: Math.round(totalSales * 100) / 100, pushShare: totalSales > 0 ? round4(toPush.reduce((a, r) => a + r.netSales, 0) / totalSales) : null },
    thresholds: {
      minObservableWeeks: config.demand.minObservableWeeks, minUnits: config.demand.cover.minUnits, lowCoverWeeks: config.demand.cover.lowWeeks,
      lowMarginPct: config.cashRisk.lowMarginPct, highRefunds: config.segments.highRefunds, maxRefundRateToPush: config.candidate.maxRefundRate, topSellers: topSellers(config),
      trend: config.demand.trend,
    },
    dataQuality,
  };
}
