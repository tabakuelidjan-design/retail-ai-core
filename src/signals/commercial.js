// COMMERCIAL_CANDIDATE: a deterministic flag that a product's facts meet all
// the configured criteria for commercial attention. It is evidence, not a
// recommendation - no LLM is involved and no action follows automatically.

const LEVELS = ['LOW', 'MEDIUM', 'HIGH'];
const downgrade = (level) => LEVELS[Math.max(0, LEVELS.indexOf(level) - 1)];

function costReason(row) {
  const c = row.contribution_margin_v0;
  if (c.cost_confidence === 'VERIFIED') return { code: 'COST_VERIFIED', base: 'HIGH' };
  if (c.cost_confidence === 'UNVERIFIED') return { code: 'COST_UNVERIFIED', base: 'MEDIUM' };
  return { code: 'COST_ESTIMATED_OR_STALE', base: 'LOW' };
}

export function detectCommercialCandidates(rows, config, window) {
  const c = config.candidate;
  const out = [];
  for (const row of rows) {
    if (!row.matched) continue;
    const cm = row.contribution_margin_v0;
    // No reliable margin -> cannot be a candidate (see cash-risk MISSING_COST instead).
    if (cm.status !== 'CALCULATED' && cm.status !== 'PARTIAL') continue;
    if (cm.margin_pct === null) continue;

    const checks = [
      [row.units_sold >= c.minUnits, 'RECENT_SALES_AT_OR_ABOVE_MIN'],
      [cm.margin_pct >= c.minMarginPct, 'MARGIN_AT_OR_ABOVE_MIN'],
      [row.stock_units >= c.minStock, 'STOCK_AVAILABLE'],
      [(row.refund_rate ?? 0) <= c.maxRefundRate, 'REFUND_RATE_WITHIN_LIMIT'],
    ];
    if (!checks.every(([ok]) => ok)) continue;

    const reasons = checks.map(([, code]) => code);
    const { code, base } = costReason(row);
    reasons.push(code);
    let confidence = base;
    if (cm.status === 'PARTIAL') { reasons.push('PARTIAL_COST_COVERAGE'); confidence = 'LOW'; }
    if (row.units_sold < c.highConfidenceUnits) confidence = downgrade(confidence);

    out.push({
      signal: 'COMMERCIAL_CANDIDATE',
      product_key: row.product_key,
      title: row.title,
      window: window.key,
      confidence,
      reason_codes: reasons,
      evidence: {
        units_sold: row.units_sold,
        net_sales_ex_tax: row.net_sales_ex_tax,
        contribution_margin_v0: cm.value,
        margin_pct: cm.margin_pct,
        stock_units: row.stock_units,
        refund_rate: row.refund_rate,
        cost_confidence: cm.cost_confidence,
        cost_coverage_pct: row.cost_coverage_pct,
      },
      criteria: c,
      caveats: cm.caveats,
    });
  }
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return out.sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.evidence.contribution_margin_v0 - a.evidence.contribution_margin_v0);
}
