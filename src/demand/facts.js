// Demand & inventory facts per product, variant and category. Deterministic and
// pure: rows in, facts out. Every record carries its own provenance
// (input_status) and gates, so a future consumer can tell VERIFIED, PARTIAL
// and unreliable inputs apart without re-deriving anything. Identity is always
// the Shopify product / variant id (or the category value) - never a SKU.

import { stockValue } from '../metrics/products.js';
import { aggregate } from '../metrics/sales.js';
import { buildWeekBuckets, localDateString, localMidnight } from '../metrics/windows.js';
import {
  classifyInventory, classifyPattern, classifyTrend, computeCover, isRoundQuantity, median, round2, sellThrough, stockQuality,
} from './classify.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_AVAILABLE = ['supplier_lead_time', 'minimum_order_quantity', 'incoming_stock', 'restock_history', 'seasonality'];

const bucketIndex = (buckets, t) => buckets.findIndex((b) => t >= b.start && t < b.end);
const unmatchedKey = (l) => `unmatched:${l.title}`; // display grouping only; never an identity, never SKU

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

/** Shared context for every record built in one run. */
export function buildDemandContext(ledger, data, now, timeZone, config) {
  const cfg = config.demand;
  const buckets = buildWeekBuckets(now, timeZone, cfg.weeks);
  const window = { start: buckets[0].start, end: buckets.at(-1).end };
  const firstOrder = ledger.orders.length ? new Date(Math.min(...ledger.orders.map((o) => o.orderedAt))) : null;
  const merchantStart = firstOrder ? localMidnight(localDateString(firstOrder, timeZone), timeZone) : window.start;
  const inWindowFact = (t) => t >= window.start && t < window.end;

  const linesByProduct = new Map();
  const linesByVariant = new Map();
  const partialUnitsByProduct = new Map(); // sales after the last complete day (today): in stock, not in the weekly buckets
  const partialUnitsByVariant = new Map();
  const lastSaleByProduct = new Map();
  const lastSaleByVariant = new Map();
  for (const l of ledger.lineFacts) {
    const pk = l.productId ?? unmatchedKey(l);
    if (!lastSaleByProduct.has(pk) || l.orderedAt > lastSaleByProduct.get(pk)) lastSaleByProduct.set(pk, l.orderedAt);
    if (l.variantId && (!lastSaleByVariant.has(l.variantId) || l.orderedAt > lastSaleByVariant.get(l.variantId))) lastSaleByVariant.set(l.variantId, l.orderedAt);
    if (l.orderedAt >= window.end) {
      partialUnitsByProduct.set(pk, (partialUnitsByProduct.get(pk) ?? 0) + l.qty);
      if (l.variantId) partialUnitsByVariant.set(l.variantId, (partialUnitsByVariant.get(l.variantId) ?? 0) + l.qty);
    }
    if (!inWindowFact(l.orderedAt)) continue;
    push(linesByProduct, pk, l);
    if (l.variantId) push(linesByVariant, l.variantId, l);
  }
  const refundsByProduct = new Map();
  const refundsByVariant = new Map();
  const lineById = new Map(ledger.lineFacts.map((l) => [l.orderLineId, l]));
  for (const r of ledger.refundFacts) {
    if (!inWindowFact(r.refundedAt)) continue;
    const line = lineById.get(r.orderLineId);
    push(refundsByProduct, r.productId ?? (line ? unmatchedKey(line) : 'unmatched:unknown'), r);
    if (r.variantId) push(refundsByVariant, r.variantId, r);
  }

  const variantsByProduct = new Map();
  for (const v of ledger.variantById.values()) push(variantsByProduct, v.product_id, v.id);

  const historyDays = firstOrder ? Math.floor((now - firstOrder) / DAY_MS) : 0;
  return {
    cfg, config, ledger, now, timeZone, buckets, window, merchantStart, historyDays, firstOrder,
    partialUnitsByProduct, partialUnitsByVariant, linesByProduct, linesByVariant, refundsByProduct, refundsByVariant, lastSaleByProduct, lastSaleByVariant, variantsByProduct,
  };
}

/** Fractional weeks an entity existed inside each bucket, from its (optional) creation instant. */
function exposureOf(ctx, createdAt) {
  const from = Math.max(ctx.merchantStart.getTime(), createdAt ? createdAt.getTime() : 0);
  const fractions = ctx.buckets.map((b) => {
    const span = b.end - b.start;
    return Math.max(0, Math.min(1, (b.end - Math.max(b.start, from)) / span));
  });
  return {
    fractions,
    weeks: round2(fractions.reduce((a, b) => a + b, 0)),
    observableWeeks: fractions.filter((f) => f >= 0.5).length,
  };
}

function stockOf(ctx, variantIds) {
  const { ledger, now, cfg } = ctx;
  const sv = stockValue(ledger, variantIds, now);
  let snapshotAt = null;
  let roundVariants = 0;
  let anyNegative = false;
  for (const id of variantIds) {
    const s = ledger.stockByVariant.get(id);
    if (!s) continue;
    if (!snapshotAt || s.snapshotAt > snapshotAt) snapshotAt = s.snapshotAt;
    if (s.units < 0) anyNegative = true;
    if (isRoundQuantity(s.units, cfg)) roundVariants += 1;
  }
  return { units: sv.units, value: sv.inventory_value_at_cost, snapshotAt, roundVariants, anyNegative };
}

function gatesOf({ agg, units, stock, quality, cover, insufficientHistory, salesReconciled, ctx }) {
  const min = ctx.config.gates.minVerifiedCostCoverage;
  const demandReasons = [];
  if (!salesReconciled) demandReasons.push('SALES_NOT_RECONCILED_WITH_SOURCE');
  if (insufficientHistory) demandReasons.push('INSUFFICIENT_HISTORY_FOR_ENTITY');
  if (units > 0 && units < ctx.cfg.cover.minUnits) demandReasons.push('THIN_SALES_SAMPLE');
  const demandCaveats = ctx.historyDays < ctx.cfg.historyVerifiedDays ? [`HISTORY_${ctx.historyDays}_DAYS_UNDER_${ctx.cfg.historyVerifiedDays}`] : [];

  const marginReasons = [];
  if (units === 0) marginReasons.push('NO_SALES_IN_WINDOW');
  else {
    if ((agg.cost_coverage_pct ?? 0) < 1) marginReasons.push('COST_MISSING_ON_PART_OF_REVENUE');
    if ((agg.verified_cost_coverage_pct ?? 0) < min) marginReasons.push('COST_NOT_VERIFIED');
    if (agg.gross_profit.caveats.includes('COST_IS_CURRENT_COST_APPLIED_TO_HISTORY')) marginReasons.push('COST_IS_CURRENT_COST_APPLIED_TO_HISTORY');
  }
  // Until the merchant confirms unit cost is the all-in variable cost, margin is not decision-grade.
  if (!ctx.config.gates.unitCostIsAllInVariableCost) marginReasons.push('UNIT_COST_NOT_CONFIRMED_ALL_IN');

  const capitalReasons = [];
  if (stock.units > 0) {
    if (stock.value.units_without_cost > 0) capitalReasons.push('STOCK_UNITS_WITHOUT_COST');
    if (stock.value.cost_confidence !== 'VERIFIED') capitalReasons.push('COST_NOT_VERIFIED');
    if (quality !== 'UNVERIFIED') capitalReasons.push(`STOCK_QUANTITY_${quality}`);
  }
  const coverReasons = [];
  if (stock.units > 0 && quality !== 'UNVERIFIED') coverReasons.push(`STOCK_QUANTITY_${quality}`);
  if (cover.status !== 'CALCULATED' && cover.status !== 'NO_STOCK') coverReasons.push(`COVER_${cover.status}`);

  return {
    demand: { status: demandReasons.length ? 'LIMITED' : 'OPEN', reasons: demandReasons, caveats: demandCaveats },
    margin: { status: marginReasons.length ? 'GATED' : 'OPEN', reasons: marginReasons, caveats: ['PAYMENT_FEES_NOT_INCLUDED'] },
    capital_exposure_value: stock.units > 0 ? { status: capitalReasons.length ? 'GATED' : 'OPEN', reasons: capitalReasons, caveats: quality === 'UNVERIFIED' ? ['STOCK_QUANTITY_NOT_PHYSICALLY_VERIFIED'] : [] } : { status: 'NOT_APPLICABLE', reasons: [] },
    cover: stock.units > 0 ? { status: coverReasons.length ? 'LIMITED' : 'OPEN', reasons: coverReasons, caveats: quality === 'UNVERIFIED' ? ['STOCK_QUANTITY_NOT_PHYSICALLY_VERIFIED'] : [] } : { status: 'NOT_APPLICABLE', reasons: [] },
  };
}

/**
 * The demand + inventory block for any group of lines (a variant, a product, a category).
 * @param {{lines: object[], refunds: object[], variantIds: string[], createdAt: Date|null, lastSaleAt: Date|null, salesReconciled: boolean}} p
 */
export function demandBlock(ctx, p) {
  const { cfg, ledger, buckets, now } = ctx;
  const exposure = exposureOf(ctx, p.createdAt);
  const weeklyUnits = buckets.map(() => 0);
  const weeklyOrders = buckets.map(() => new Set());
  for (const l of p.lines) {
    const i = bucketIndex(buckets, l.orderedAt);
    if (i < 0) continue;
    weeklyUnits[i] += l.qty;
    weeklyOrders[i].add(l.orderId);
  }
  const units = weeklyUnits.reduce((a, b) => a + b, 0);
  const orderIds = new Set(p.lines.map((l) => l.orderId));
  const perOrder = new Map();
  for (const l of p.lines) perOrder.set(l.orderId, (perOrder.get(l.orderId) ?? 0) + l.qty);
  const perOrderUnits = [...perOrder.values()];

  const agg = aggregate(p.lines, p.refunds, ledger.config);
  const last4 = weeklyUnits.slice(-4).reduce((a, b) => a + b, 0);
  const exposureLast4 = exposureOf(ctx, p.createdAt).fractions.slice(-4).reduce((a, b) => a + b, 0);

  const patternResult = classifyPattern({ units, orderCount: orderIds.size, weeklyUnits, observableWeeks: exposure.observableWeeks }, cfg);
  const trend = classifyTrend({ weeklyUnits, observableWeeks: exposure.observableWeeks }, cfg);
  const stock = stockOf(ctx, p.variantIds);
  const quality = p.variantIds.length === 0 && stock.units === 0 ? 'NO_STOCK_DATA' : stockQuality(
    { snapshotAt: stock.snapshotAt, units: stock.anyNegative ? -1 : stock.units, roundVariants: stock.roundVariants },
    { now, maxAgeHours: ctx.config.gates.maxStockSnapshotAgeHours },
  );
  const cover = computeCover({ stockUnits: stock.units, units, exposureWeeks: exposure.weeks, observableWeeks: exposure.observableWeeks }, cfg);
  const inventoryClass = classifyInventory({ stockUnits: stock.units, units, observableWeeks: exposure.observableWeeks, cover }, cfg);
  const velocity8 = exposure.weeks >= 1 ? round2(units / exposure.weeks) : null;
  const velocity4 = exposureLast4 >= 1 ? round2(last4 / exposureLast4) : null;
  const lastSale = p.lastSaleAt ?? null;
  const daysSinceLastSale = lastSale ? Math.floor((now - lastSale) / DAY_MS) : null;
  const avgNetUnitPrice = units > 0 ? round2(p.lines.reduce((a, l) => a + l.exTaxBeforeRefund, 0) / units) : null;

  const gates = gatesOf({
    agg, units, stock, quality, cover,
    insufficientHistory: exposure.observableWeeks < cfg.minObservableWeeks, salesReconciled: p.salesReconciled, ctx,
  });

  const reorderReasons = [];
  if (!['CONSISTENT', 'INTERMITTENT'].includes(patternResult.pattern)) reorderReasons.push(`PATTERN_${patternResult.pattern}`);
  if (orderIds.size < cfg.reorder.minOrders) reorderReasons.push('ORDERS_BELOW_MIN');
  if (cover.status !== 'CALCULATED') reorderReasons.push(`COVER_${cover.status}`);
  if (['STALE', 'NO_STOCK_DATA', 'UNRELIABLE_NEGATIVE', 'SUSPECT_ROUND_QUANTITY'].includes(quality) && stock.units > 0) reorderReasons.push(`STOCK_QUANTITY_${quality}`);

  return {
    exposure_weeks: exposure.weeks,
    observable_weeks: exposure.observableWeeks,
    demand: {
      units_8w: units, orders_8w: orderIds.size, units_refunded_8w: p.refunds.reduce((a, r) => a + r.qty, 0),
      weekly_units: weeklyUnits, weekly_orders: weeklyOrders.map((s) => s.size),
      velocity_4w: velocity4, velocity_8w: velocity8,
      units_per_order: perOrderUnits.length ? { median: median(perOrderUnits), max: Math.max(...perOrderUnits) } : null,
      pattern: patternResult.pattern, pattern_evidence: patternResult.evidence,
      trend,
      first_sale_at: p.lines.length ? new Date(Math.min(...p.lines.map((l) => l.orderedAt))).toISOString() : null,
      last_sale_at: lastSale ? lastSale.toISOString() : null, days_since_last_sale: daysSinceLastSale,
      net_sales_ex_tax_8w: agg.net_sales_ex_tax, avg_net_unit_price_ex_tax: avgNetUnitPrice,
    },
    inventory: {
      stock_units: stock.units, snapshot_at: stock.snapshotAt ? stock.snapshotAt.toISOString() : null,
      stock_quality: quality, round_quantity_variants: stock.roundVariants,
      stock_value_at_cost: stock.value, weeks_of_cover: cover.weeks, days_of_cover: cover.days, cover_status: cover.status,
      sell_through: sellThrough({ units: units + (p.partialUnits ?? 0), stockUnits: stock.units }), units_since_window_end: p.partialUnits ?? 0, inventory_class: inventoryClass,
    },
    reorder_facts: {
      status: reorderReasons.length === 0 ? 'SUFFICIENT' : 'LIMITED', reasons: reorderReasons,
      facts: {
        velocity_4w: velocity4, velocity_8w: velocity8, weeks_of_cover: cover.weeks, stock_units: stock.units,
        days_since_last_sale: daysSinceLastSale, orders_8w: orderIds.size, pattern: patternResult.pattern, trend: trend.direction,
        units_per_order_median: perOrderUnits.length ? median(perOrderUnits) : null,
      },
      not_available: NOT_AVAILABLE,
    },
    input_status: {
      sales_history: p.salesReconciled ? (ctx.historyDays >= cfg.historyVerifiedDays ? 'VERIFIED' : 'PARTIAL') : 'UNVERIFIED',
      inventory: quality,
      cost_on_sales: units === 0 ? 'NO_SALES' : ((agg.cost_coverage_pct ?? 0) === 0 ? 'MISSING' : ((agg.cost_coverage_pct ?? 0) < 1 ? 'PARTIAL' : agg.gross_profit.cost_confidence)),
      cost_on_stock: stock.units === 0 ? 'NO_STOCK' : (stock.value.status === 'UNCLASSIFIED' ? 'MISSING' : (stock.value.units_without_cost > 0 ? 'PARTIAL' : stock.value.cost_confidence)),
    },
    gates,
    cost_coverage: { revenue_cost_coverage_pct: agg.cost_coverage_pct, revenue_verified_cost_coverage_pct: agg.verified_cost_coverage_pct },
  };
}

/** One record per catalog product (and per unmatched historical item), plus one per variant that sold or holds stock. */
export function buildEntityFacts(ctx, { products, collections, salesReconciled }) {
  const { ledger } = ctx;
  const membershipsByProduct = new Map();
  for (const c of collections.filter((x) => x.is_current !== false)) push(membershipsByProduct, c.product_id, { source_id: c.source_id, title: c.title });

  const productFacts = [];
  const keys = new Set([...ledger.productById.keys(), ...ctx.linesByProduct.keys()]);
  for (const key of keys) {
    const row = ledger.productById.get(key);
    const lines = ctx.linesByProduct.get(key) ?? [];
    const createdAt = row?.source_created_at ? new Date(row.source_created_at) : null;
    const block = demandBlock(ctx, {
      lines, refunds: ctx.refundsByProduct.get(key) ?? [], variantIds: ctx.variantsByProduct.get(key) ?? [],
      createdAt, lastSaleAt: ctx.lastSaleByProduct.get(key) ?? null, salesReconciled,
      partialUnits: ctx.partialUnitsByProduct.get(key) ?? 0,
    });
    productFacts.push({
      kind: 'product', product_key: key, matched: Boolean(row),
      title: row?.title ?? lines[0]?.title ?? 'Unmatched historical item',
      product_type: row?.product_type ?? null,
      category: row?.product_type ?? 'UNCLASSIFIED',
      source_status: row?.source_status ?? null, source_created_at: createdAt ? createdAt.toISOString() : null,
      collections: membershipsByProduct.get(key) ?? [],
      variants: (ctx.variantsByProduct.get(key) ?? []).length,
      ...block,
      input_status: { ...block.input_status, category: row?.product_type ? 'PRODUCT_TYPE' : 'UNCLASSIFIED', product_age: createdAt ? 'KNOWN' : 'UNKNOWN' },
    });
  }

  const variantFacts = [];
  for (const v of ledger.variantById.values()) {
    const lines = ctx.linesByVariant.get(v.id) ?? [];
    const hasStock = (ledger.stockByVariant.get(v.id)?.units ?? 0) > 0;
    if (lines.length === 0 && !hasStock) continue;
    const parent = ledger.productById.get(v.product_id);
    const createdAt = parent?.source_created_at ? new Date(parent.source_created_at) : null;
    variantFacts.push({
      kind: 'variant', variant_id: v.id, product_key: v.product_id, variant_title: v.title ?? null, product_title: parent?.title ?? null,
      category: parent?.product_type ?? 'UNCLASSIFIED',
      ...demandBlock(ctx, {
        lines, refunds: ctx.refundsByVariant.get(v.id) ?? [], variantIds: [v.id], createdAt,
        lastSaleAt: ctx.lastSaleByVariant.get(v.id) ?? null, salesReconciled, partialUnits: ctx.partialUnitsByVariant.get(v.id) ?? 0,
      }),
    });
  }
  return { productFacts, variantFacts };
}

