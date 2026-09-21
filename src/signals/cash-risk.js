// CASH_RISK_SIGNAL: deterministic facts about money tied up in, or unexplained
// by, a product. A signal is not a decision; every reason code is a plain
// threshold check whose criteria are echoed in the output.

export function detectCashRisks(rows, config, window) {
  const r = config.cashRisk;
  const out = [];
  for (const row of rows) {
    if (!row.matched) continue;
    const reasons = [];
    const hasStock = row.stock_units > 0;

    if (hasStock && row.units_sold === 0) reasons.push('NO_RECENT_SALES_WITH_STOCK');
    if (row.stock_units >= r.highStockMinUnits && row.units_sold >= 1 && row.units_sold <= r.lowVelocityMaxUnits) {
      reasons.push('HIGH_STOCK_LOW_VELOCITY');
    }
    const missingCostMatters = (row.units_sold >= 1 && ['MISSING', 'PARTIAL_MISSING'].includes(row.cost_status))
      || (hasStock && row.inventory_value_at_cost.units_without_cost > 0);
    if (missingCostMatters) reasons.push('MISSING_COST');

    const cm = row.contribution_margin_v0;
    if (cm.margin_pct !== null) {
      if (cm.margin_pct < 0) reasons.push('NEGATIVE_MARGIN');
      else if (cm.margin_pct < r.lowMarginPct) reasons.push('LOW_MARGIN');
    }
    if (reasons.length === 0) continue;

    out.push({
      signal: 'CASH_RISK_SIGNAL',
      product_key: row.product_key,
      title: row.title,
      window: window.key,
      reason_codes: reasons,
      evidence: {
        units_sold: row.units_sold,
        stock_units: row.stock_units,
        days_since_last_sale: row.days_since_last_sale,
        inventory_value_at_cost: row.inventory_value_at_cost,
        margin_pct: cm.margin_pct,
        cost_status: row.cost_status,
        cost_confidence: cm.cost_confidence,
      },
      criteria: r,
      caveats: cm.caveats,
    });
  }
  const tied = (s) => s.evidence.inventory_value_at_cost?.value ?? 0;
  return out.sort((a, b) => tied(b) - tied(a) || a.title.localeCompare(b.title));
}
