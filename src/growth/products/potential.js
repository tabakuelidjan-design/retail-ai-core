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
//   candidate.maxRefundRate. The only page-owned rule is the "Top vente" size (TOP_SELLER_RULE below, owner decision
// 2026-09-27). An unknown value is never turned into 0 (no cost != 0 % margin; no stock snapshot != out of stock).
//
// Status priority (owner decision 2026-09-27; the first matching rule wins, so a restock / promotion advice is never given
// to a product that already has a bigger quality, profitability or trend problem):
//   1 insufficient  2 returns (returns / watch)  3 lowMargin (reliable cost only)  4 declining
//   5 restock  6 push  7 watch  8 topSeller  9 stable

export const POTENTIAL_VERSION = 'growth-potential.2';
export const STATUSES = ['push', 'restock', 'topSeller', 'watch', 'declining', 'lowMargin', 'returns', 'insufficient', 'stable'];
/** Statuses counted as "À surveiller" (a risk or a contradiction the merchant should look at). */
export const WATCH_GROUP = ['watch', 'declining', 'lowMargin', 'returns'];
/** The page's filter pills, in display order. */
export const FILTERS = ['all', 'push', 'growth', 'top', 'watch', 'restock', 'lowMargin', 'insufficient'];
/**
 * Top seller (status topSeller, filter "top") (owner decision 2026-09-27): relative to the catalogue actually selling, never a fixed top 10.
 *   eligible  = products sold in the window AND sufficiently observed (not "Données insuffisantes")
 *   topCount  = min(10, max(1, ceil(eligible * 20 %)))       15 -> 3, 30 -> 6, 50 -> 10, 100 -> 10
 *   top       = eligible products whose net sales are >= the net sales of the topCount-th eligible product (and > 0).
 * Ties at the boundary are all included (never cut by an arbitrary order), so the list can exceed topCount only when products
 * have exactly the same net sales as the last one. Ranks are competition ranks (1, 2, 2, 4) on net sales.
 */
export const TOP_SELLER_RULE = { share: 0.2, min: 1, max: 10 };
export function topSellerCount(eligible) {
  if (!eligible) return 0;
  return Math.min(TOP_SELLER_RULE.max, Math.max(TOP_SELLER_RULE.min, Math.ceil(eligible * TOP_SELLER_RULE.share - 1e-9)));
}
/** Enough evidence for any recommendation (same thresholds as rule 1). */
export const isObserved = (f, config) => f.observableWeeks >= config.demand.minObservableWeeks && f.units >= config.demand.cover.minUnits;

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
  const top = f.top === true; // decided once for the whole catalogue (buildProductPotential / TOP_SELLER_RULE)
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
  // 2. Abnormal refunds: contradictory with good demand -> watch; otherwise the product's own problem.
  if (highReturns) return favorable ? out('watch', 'reviewReturns', 'DEMAND_BUT_HIGH_RETURNS') : out('returns', 'doNotPromote', 'HIGH_RETURNS');
  // 3. Margin too thin - only when the margin is reliable (verified costs covering all its revenue).
  if (tier === 'RELIABLE' && marginPct != null && marginPct < cfg.lowMargin) return out('lowMargin', 'doNotPromote', 'LOW_RELIABLE_MARGIN');
  // 4. A real decline over the comparable period (the demand engine's DOWN trend: a significant, not a noise-level, drop).
  if (down) return out('declining', 'watch', 'TREND_DOWN');
  // 5. Good demand, no blocking refund / margin / trend signal, but a KNOWN stock that cannot absorb a promotion: restock
  //    first. Refunds above the push limit also block it (they are reviewed first, rule 7).
  if (favorable && coverLow && !elevatedReturns) return out('restock', 'restockFirst', (stock.units ?? 0) <= 0 ? 'DEMAND_BUT_OUT_OF_STOCK' : 'DEMAND_BUT_LOW_COVER');
  // 6. Push: rising demand + enough cover + reliable margin + normal refunds.
  if (up && coverOk && tier === 'RELIABLE' && !elevatedReturns) return out('push', 'increaseVisibility', 'RISING_DEMAND_COVERED_RELIABLE_MARGIN');
  // 7. Good demand, but something blocks both a push and a restock advice: say what to check first.
  if (up || (top && elevatedReturns)) {
    const first = elevatedReturns ? 'reviewReturns' : !stock.usable ? 'checkStock' : tier !== 'RELIABLE' ? 'checkCost' : 'watch';
    return out('watch', first, up ? 'RISING_DEMAND_BLOCKED' : 'TOP_SELLER_RETURNS');
  }
  // 8. A top seller without a new push signal: keep it available, no new promotion needed.
  if (top) return out('topSeller', 'keep', 'TOP_SELLER');
  return out('stable', 'none', 'NO_SIGNAL');
}

/** The primary evidence shown in the "Signal Growth" column (code + values; the UI words it). */
export function primarySignal(f, c) {
  if (c.status === 'insufficient') return { code: c.rule === 'NEW_PRODUCT' ? 'newProduct' : 'thinSample', units: f.units };
  if (c.status === 'restock') return (c.stock.units ?? 0) <= 0 ? { code: 'outOfStock' } : { code: 'coverDays', days: f.cover.days };
  if (c.status === 'returns' || c.rule === 'DEMAND_BUT_HIGH_RETURNS' || c.rule === 'TOP_SELLER_RETURNS') return { code: 'returnRate', rate: f.refundRate };
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
  // Display order: net sales, then units, then title and key (fully deterministic).
  const ranked = [...active].sort((a, b) => b.netSales - a.netSales || b.units - a.units || String(a.title).localeCompare(String(b.title)) || a.key.localeCompare(b.key));
  // Top sellers: competition rank among the sufficiently observed products; ties at the boundary all included.
  const eligible = ranked.filter((f) => isObserved(f, config));
  const topCount = topSellerCount(eligible.length);
  const boundary = topCount ? eligible[topCount - 1].netSales : null;
  for (const f of ranked) {
    const ok = eligible.includes(f);
    f.topRank = ok ? 1 + eligible.filter((g) => g.netSales > f.netSales).length : null;
    f.top = ok && boundary != null && f.netSales > 0 && f.netSales >= boundary;
  }
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
      lowMarginPct: config.cashRisk.lowMarginPct, highRefunds: config.segments.highRefunds, maxRefundRateToPush: config.candidate.maxRefundRate,
      topSellers: { ...TOP_SELLER_RULE, eligible: eligible.length, count: topCount, selected: rows.filter((r) => r.top).length },
      trend: config.demand.trend,
    },
    dataQuality,
  };
}
