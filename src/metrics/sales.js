// Deterministic Sales + Profit metrics. Formulas are defined in
// docs/metrics/definitions.md (version METRICS_VERSION) - keep both in sync.
// Nothing here estimates: a line with no reliable cost contributes to revenue
// but is UNCLASSIFIED for cost/profit.

import { METRICS_VERSION } from './config.js';
import { COST_STATUS } from './costs.js';
import { inWindow } from './windows.js';

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const isKnown = (fact) => fact.cost.status !== COST_STATUS.MISSING;

function confidenceOf(facts) {
  const statuses = new Set(facts.filter(isKnown).map((f) => f.cost.status));
  if (statuses.size === 0) return 'NONE';
  if (statuses.has('ESTIMATED') || statuses.has('STALE')) return 'ESTIMATED_OR_STALE';
  if (statuses.has('UNVERIFIED')) return 'UNVERIFIED';
  return 'VERIFIED';
}

function profitObject(value, marginBase, ctx, { paymentFeesOmitted = false } = {}) {
  const { status, coveragePct, confidence, appliedToHistory, classifiedRevenue, unclassifiedRevenue } = ctx;
  const caveats = [];
  if (status === 'UNCLASSIFIED') caveats.push('COST_MISSING');
  if (status === 'PARTIAL') caveats.push(`PARTIAL_COST_COVERAGE_${Math.round(coveragePct * 100)}PCT`);
  if (confidence === 'UNVERIFIED') caveats.push('COST_UNVERIFIED');
  if (confidence === 'ESTIMATED_OR_STALE') caveats.push('COST_ESTIMATED_OR_STALE');
  if (appliedToHistory) caveats.push('COST_IS_CURRENT_COST_APPLIED_TO_HISTORY');
  if (paymentFeesOmitted) caveats.push('PAYMENT_FEES_NOT_INCLUDED');
  const calculable = status === 'CALCULATED' || status === 'PARTIAL';
  return {
    value: status === 'UNCLASSIFIED' ? null : round2(value),
    status,
    margin_pct: calculable && marginBase > 0 ? round4(value / marginBase) : null,
    cost_confidence: confidence,
    certain: status === 'CALCULATED' && confidence === 'VERIFIED' && !appliedToHistory && !paymentFeesOmitted,
    covered_revenue_ex_tax: round2(classifiedRevenue),
    unclassified_revenue_ex_tax: round2(unclassifiedRevenue),
    caveats,
  };
}

/** Core aggregation over already-windowed facts. Shared by totals, products and variants. */
export function aggregate(lineFacts, refundFacts, config) {
  const gross = sum(lineFacts, (l) => l.gross);
  const discounts = sum(lineFacts, (l) => l.discount);
  const refunds = sum(refundFacts, (r) => r.amount);
  const tax = sum(lineFacts, (l) => l.tax) - sum(refundFacts, (r) => r.tax);
  const exTaxBeforeRefund = sum(lineFacts, (l) => l.exTaxBeforeRefund);
  const refundsExTax = sum(refundFacts, (r) => r.exTax);

  const classifiedLines = lineFacts.filter(isKnown);
  const classifiedRefunds = refundFacts.filter(isKnown);
  const classifiedRevenue = sum(classifiedLines, (l) => l.exTaxBeforeRefund);
  const unclassifiedRevenue = exTaxBeforeRefund - classifiedRevenue;
  const classifiedRefundsExTax = sum(classifiedRefunds, (r) => r.exTax);

  let cogs = sum(classifiedLines, (l) => l.qty * l.cost.unit_cost);
  if (config.cogsRefundTreatment === 'restocked') cogs -= sum(classifiedRefunds, (r) => r.qty * r.cost.unit_cost);

  const hasActivity = lineFacts.length > 0 || refundFacts.length > 0;
  const anyUnclassified = lineFacts.some((l) => !isKnown(l)) || refundFacts.some((r) => !isKnown(r));
  let status;
  if (!hasActivity) status = 'NO_SALES';
  else if (classifiedLines.length === 0 && classifiedRefunds.length === 0) status = 'UNCLASSIFIED';
  else status = anyUnclassified ? 'PARTIAL' : 'CALCULATED';

  const coveragePct = exTaxBeforeRefund > 0 ? classifiedRevenue / exTaxBeforeRefund : null;
  const verifiedRevenue = sum(
    classifiedLines.filter((l) => l.cost.status === COST_STATUS.VERIFIED),
    (l) => l.exTaxBeforeRefund,
  );
  const ctx = {
    status, coveragePct, confidence: confidenceOf([...classifiedLines, ...classifiedRefunds]),
    appliedToHistory: classifiedLines.some((l) => l.cost.basis === 'CURRENT_COST_APPLIED_TO_HISTORY'),
    classifiedRevenue, unclassifiedRevenue,
  };

  const grossProfitValue = classifiedRevenue - cogs;
  const cmValue = grossProfitValue - classifiedRefundsExTax; // minus payment fees: unavailable, see definitions.md

  return {
    units_sold: sum(lineFacts, (l) => l.qty),
    units_refunded: sum(refundFacts, (r) => r.qty),
    gross_sales: round2(gross),
    discounts: round2(discounts),
    refunds: round2(refunds),
    net_sales: round2(gross - discounts - refunds),
    tax: round2(tax),
    net_sales_ex_tax: round2(exTaxBeforeRefund - refundsExTax),
    cogs: status === 'UNCLASSIFIED' ? null : round2(cogs),
    cost_coverage_pct: coveragePct === null ? null : round4(coveragePct),
    verified_cost_coverage_pct: exTaxBeforeRefund > 0 ? round4(verifiedRevenue / exTaxBeforeRefund) : null,
    unclassified_revenue_ex_tax: round2(unclassifiedRevenue),
    gross_profit: profitObject(grossProfitValue, classifiedRevenue, ctx),
    contribution_margin_v0: profitObject(cmValue, classifiedRevenue - classifiedRefundsExTax, ctx, { paymentFeesOmitted: true }),
  };
}

export function windowFacts(ledger, window) {
  return {
    shipping: (ledger.shippingFacts ?? []).filter((x) => inWindow(x.orderedAt, window)),
    shippingRefunds: (ledger.shippingRefundFacts ?? []).filter((x) => inWindow(x.refundedAt, window)),
    orders: ledger.orders.filter((o) => inWindow(o.orderedAt, window)),
    lines: ledger.lineFacts.filter((l) => inWindow(l.orderedAt, window)),
    refunds: ledger.refundFacts.filter((r) => inWindow(r.refundedAt, window)),
    refundTotals: ledger.refundTotals.filter((r) => inWindow(r.refundedAt, window)),
  };
}

/**
 * Shipping, kept apart from product revenue on purpose (product metrics intentionally represent product lines only).
 * Amounts follow the same convention as product lines: `charged` is what the customer paid for shipping after shipping discounts
 * (VAT-inclusive when the source prices include VAT), `net_ex_tax` is without VAT.
 */
export function aggregateShipping(shippingFacts, shippingRefundFacts) {
  const S = (xs, f) => round2(sum(xs, f));
  const refundsExTax = S(shippingRefundFacts, (r) => r.exTax);
  const refundsTax = S(shippingRefundFacts, (r) => r.tax);
  const chargedIncl = S(shippingFacts, (x) => x.inclTax);
  const chargedExTax = S(shippingFacts, (x) => x.exTax);
  return {
    orders_with_shipping: shippingFacts.filter((x) => x.charged > 0).length,
    gross: S(shippingFacts, (x) => x.gross), discounts: S(shippingFacts, (x) => x.discount),
    charged_incl_tax: chargedIncl, tax: S(shippingFacts, (x) => x.tax), net_ex_tax: chargedExTax,
    refunds_incl_tax: S(shippingRefundFacts, (r) => r.inclTax), refunds_ex_tax: refundsExTax, refunds_tax: refundsTax,
    net_incl_tax_after_refunds: round2(chargedIncl - sum(shippingRefundFacts, (r) => r.inclTax)),
    net_ex_tax_after_refunds: round2(chargedExTax - refundsExTax), tax_after_refunds: round2(sum(shippingFacts, (x) => x.tax) - refundsTax),
  };
}

export function computeSalesMetrics(ledger, window) {
  const { orders, lines, refunds, refundTotals, shipping: shippingFacts, shippingRefunds } = windowFacts(ledger, window);
  const m = aggregate(lines, refunds, ledger.config);
  const ship = aggregateShipping(shippingFacts, shippingRefunds);
  const cov = ledger.shippingCoverage ?? { orders: 0, captured: 0, uncaptured: 0 };
  const uncapturedInWindow = cov.uncaptured === 0 ? 0 : orders.length - shippingFacts.length;
  const orderCount = orders.length;
  return {
    metrics_version: METRICS_VERSION,
    window: { key: window.key, start: window.start.toISOString(), end: window.end.toISOString(), timeZone: window.timeZone },
    currency: ledger.currency,
    order_count: orderCount,
    ...m,
    aov: orderCount > 0 ? round2(m.net_sales / orderCount) : null,
    aov_ex_tax: orderCount > 0 ? round2(m.net_sales_ex_tax / orderCount) : null,
    refunds_non_product: round2(sum(refundTotals, (r) => r.otherAmount)),
    // Shipping and reconciled totals. Product fields above are unchanged (product lines only); these add the shipping side explicitly.
    shipping: { ...ship, orders_without_shipping_data: uncapturedInWindow, coverage: uncapturedInWindow > 0 ? 'PARTIAL' : 'COMPLETE' },
    refunds_breakdown: {
      product: m.refunds, shipping: ship.refunds_incl_tax, other: round2(sum(refundTotals, (r) => r.otherAmount)),
      total: round2(m.refunds + ship.refunds_incl_tax + sum(refundTotals, (r) => r.otherAmount)),
    },
    totals_with_shipping: {
      net_sales_incl_tax: round2(m.net_sales + ship.net_incl_tax_after_refunds),
      net_sales_ex_tax: round2(m.net_sales_ex_tax + ship.net_ex_tax_after_refunds),
      tax: round2(m.tax + ship.tax_after_refunds),
    },
    payment_fees: {
      value: null,
      status: 'UNAVAILABLE',
      note: 'Transaction fees are not persisted by the Phase 1C sync; see docs/metrics/definitions.md',
    },
  };
}
