// Assembles the Phase 2B demand & inventory facts document. Pure and
// deterministic: same rows + same `now` => same output. Facts only: no
// recommendations, no supplier or buying logic, no LLM. The `contract` block
// names the fields a future Buying Intelligence layer is meant to read.

import { DEMAND_VERSION } from '../metrics/config.js';
import { buildCategoryFacts, buildStockExposure, concentrationOf } from './categories.js';
import { buildDemandContext, buildEntityFacts, demandBlock } from './facts.js';

const CONTRACT = {
  entity_keys: 'Shopify product id (product_key) and variant id (variant_id). category = product_type value or UNCLASSIFIED; collections by source collection id. SKU is never a key.',
  proposed_purchase_vs_historical_demand: ['products[].demand', 'variants[].demand', 'products[].reorder_facts'],
  proposed_purchase_vs_existing_stock: ['products[].inventory', 'variants[].inventory', 'stock_exposure'],
  proposed_purchase_vs_capital_exposure: ['products[].inventory.stock_value_at_cost', 'stock_exposure.value_at_cost', 'categories.*[].stock_value_share', 'gates.capital_exposure_value'],
  related_product_performance: ['categories.product_type[]', 'categories.collection[] (overlapping)', 'products[].category', 'products[].collections'],
  provenance: ['*.input_status', '*.gates', 'input_status', 'gates', 'data_limitations'],
  not_available: ['supplier_price', 'minimum_order_quantity', 'supplier_lead_time', 'incoming_stock', 'restock_history', 'seasonality', 'variant_retail_price_for_unsold_items'],
};

export function buildDemandFacts({ ledger, data, now, timeZone, config, salesReconciled }) {
  const ctx = buildDemandContext(ledger, data, now, timeZone, config);
  const { productFacts, variantFacts } = buildEntityFacts(ctx, { products: data.products, collections: data.collections ?? [], salesReconciled });

  const allLines = [...ctx.linesByProduct.values()].flat();
  const allRefunds = [...ctx.refundsByProduct.values()].flat();
  const allVariantIds = [...ledger.variantById.keys()];
  const portfolio = demandBlock(ctx, { lines: allLines, refunds: allRefunds, variantIds: allVariantIds, createdAt: null, lastSaleAt: null, salesReconciled,
    partialUnits: [...ctx.partialUnitsByProduct.values()].reduce((a, b) => a + b, 0) });

  const totals = {
    net_sales_ex_tax: portfolio.demand.net_sales_ex_tax_8w,
    stock_value: portfolio.inventory.stock_value_at_cost.value ?? 0,
  };
  const categories = {
    product_type: buildCategoryFacts(ctx, productFacts, { dimension: 'product_type', salesReconciled, totals }),
    collection: buildCategoryFacts(ctx, productFacts, { dimension: 'collection', salesReconciled, totals }),
  };

  const unclassified = categories.product_type.find((c) => c.category === 'UNCLASSIFIED');
  const stockQualityUnits = {};
  for (const p of productFacts.filter((x) => x.matched)) {
    stockQualityUnits[p.inventory.stock_quality] = (stockQualityUnits[p.inventory.stock_quality] ?? 0) + p.inventory.stock_units;
  }
  const sold = productFacts.filter((p) => p.demand.units_8w > 0);
  const patternCounts = {};
  for (const p of sold) patternCounts[p.demand.pattern] = (patternCounts[p.demand.pattern] ?? 0) + 1;

  const limitations = [
    `Order history is ${ctx.historyDays} days (the source exposes about 60 days without read_all_orders): no seasonality, no year-over-year, thin per-product samples.`,
    `${portfolio.demand.units_8w} units across ${portfolio.demand.orders_8w} orders in the ${config.demand.weeks}-week window; ${sold.length} products sold, ${(patternCounts.SINGLE_ORDER ?? 0)} of them from a single order.`,
    'Stock quantities are Shopify-reported and were never physically verified; round quantities are marked SUSPECT_ROUND_QUANTITY.',
    'Costs are unverified Shopify unit costs dated after most sales, and no production/payment cost is modelled: margin and capital-value facts are gated.',
    'No supplier price, MOQ, lead time, incoming stock or restock history exists in the data.',
    `${unclassified ? unclassified.products_total : 0} products have no product_type (UNCLASSIFIED) and carry ${Math.round((unclassified?.revenue_share ?? 0) * 100)}% of window revenue, so product_type category demand is incomplete; collections overlap, so collection totals are not additive.`,
    'Variant retail price is not stored: price facts exist only for items that sold (from order lines).',
  ];

  return {
    schema_version: DEMAND_VERSION,
    generated_at: now.toISOString(),
    merchant_timezone: timeZone,
    currency: ledger.currency,
    window: {
      weeks: config.demand.weeks, start: ctx.window.start.toISOString(), end: ctx.window.end.toISOString(),
      week_buckets: ctx.buckets.map((b) => ({ index: b.index, local_start: b.localStart })),
      history_days: ctx.historyDays,
    },
    input_status: portfolio.input_status,
    gates: portfolio.gates,
    portfolio,
    concentration: {
      products_by_revenue: concentrationOf(productFacts, (p) => p.demand.net_sales_ex_tax_8w),
      products_by_units: concentrationOf(productFacts, (p) => p.demand.units_8w),
      product_types_by_revenue: concentrationOf(categories.product_type, (c) => c.demand.net_sales_ex_tax_8w),
      unclassified_revenue_share: unclassified ? unclassified.revenue_share : 0,
      sales_pattern_counts: patternCounts,
    },
    stock_exposure: { ...buildStockExposure(productFacts), quantity_by_stock_quality: stockQualityUnits },
    categories,
    products: productFacts,
    variants: variantFacts,
    data_limitations: limitations,
    contract: CONTRACT,
  };
}
