// Growth > Potentiel produits - facts assembly. Joins, per product, the two EXISTING deterministic fact sets over the same
// 8-week window: demand & inventory facts (src/demand) and product performance (src/metrics/products). Nothing is recomputed
// differently here; the only derived value is the evolution %, i.e. the demand trend's own evidence (last weeks vs the same
// number of previous weeks) expressed as a ratio - and only when the previous side is not zero.

import { buildLedger } from '../../metrics/ledger.js';
import { buildDemandFacts } from '../../demand/build.js';
import { buildProductPerformance } from '../../metrics/products.js';
import { orderNetFacts, netSalesByProduct } from '../../metrics/net-sales.js';

const round4 = (x) => Math.round(x * 10000) / 10000;

/**
 * @param {{ data: object, now: Date, timeZone: string, config: object }} p  data = loadDataset() rows of ONE merchant
 * @returns {{ facts: object[], window: object, currency: string, dataQuality: object }}
 */
export function productPotentialFacts({ data, now, timeZone, config }) {
  const ledger = buildLedger(data, { config });
  // Sales are not reconciled with the source here (that needs the source itself): stated in dataQuality, never assumed.
  const demand = buildDemandFacts({ ledger, data, now, timeZone, config, salesReconciled: false });
  const window = { start: new Date(demand.window.start), end: new Date(demand.window.end) };
  // Margin and cost reliability come from product performance (gross profit is computed before refunds, so refund dating does not
  // change it). Net sales and refunds follow Nordla sales semantics A (metrics/net-sales.js): order-dated, net of every refund of
  // the order - the same figures as every other Growth page.
  const perfByKey = new Map(buildProductPerformance(ledger, window, now).map((r) => [r.product_key, r]));
  const salesByKey = netSalesByProduct(orderNetFacts(ledger, config), window);

  const facts = demand.products.map((p) => {
    const perf = perfByKey.get(p.product_key) ?? null;
    const sold = salesByKey.get(p.product_key) ?? null;
    const product = ledger.productById.get(p.product_key) ?? null;
    const trend = p.demand.trend ?? { direction: 'INSUFFICIENT_DATA' };
    const evolution = trend.direction !== 'INSUFFICIENT_DATA' && trend.prior_units > 0 ? round4((trend.recent_units - trend.prior_units) / trend.prior_units) : null;
    return {
      key: p.product_key, matched: p.matched, title: product?.title ?? p.title, imageUrl: product?.image_url ?? null,
      category: (product?.product_type ?? '').trim() || null,
      units: p.demand.units_8w, netSales: sold ? sold.net : 0,
      trend, evolution, observableWeeks: p.observable_weeks, velocity8: p.demand.velocity_8w,
      inventory: p.inventory,
      cover: { status: p.inventory.cover_status, weeks: p.inventory.weeks_of_cover, days: p.inventory.days_of_cover },
      grossProfit: perf ? perf.gross_profit : null,
      refundRate: sold && sold.units > 0 ? Math.round((sold.unitsRefunded / sold.units) * 10000) / 10000 : null, unitsRefunded: sold ? sold.unitsRefunded : 0,
    };
  });

  const snapshots = demand.products.map((p) => p.inventory.snapshot_at).filter(Boolean).sort();
  return {
    facts,
    window: { start: demand.window.start, end: demand.window.end, weeks: demand.window.weeks, historyDays: demand.window.history_days },
    currency: ledger.currency,
    dataQuality: {
      salesReconciledWithSource: false,
      latestStockSnapshotAt: snapshots.length ? snapshots.at(-1) : null,
      maxStockSnapshotAgeHours: config.gates.maxStockSnapshotAgeHours,
      unitCostConfirmedAllIn: config.gates.unitCostIsAllInVariableCost === true,
    },
  };
}
