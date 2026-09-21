// Markdown rendering of the deterministic report. Presentation only: every
// number printed here was already computed by the metric layer.

const fmt = (v) => (v === null || v === undefined ? 'UNCLASSIFIED' : typeof v === 'number' ? v.toFixed(2) : String(v));
const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const profitCell = (p) => (p.value === null ? 'UNCLASSIFIED' : `${p.value.toFixed(2)}${p.certain ? '' : ' *'}`);

export function renderMarkdown(report, extras = {}) {
  const c = report.currency;
  const out = [];
  out.push(`# Sales & Profit report (metrics ${report.metrics_version})`);
  out.push(`Generated ${report.generated_at} - merchant timezone ${report.merchant_timezone} - currency ${c}`);
  out.push(`Order history available: ${report.order_history.first_order_at} -> ${report.order_history.last_order_at}`);
  out.push('`*` = number depends on unverified/estimated/partial cost or omitted payment fees; see caveats in the JSON.\n');

  out.push('## Sales and profit by window');
  out.push('| Window | Orders | Units | Gross | Discounts | Refunds | Net sales | Tax | Net ex tax | AOV | Cost coverage | COGS | Gross profit | CM v0 | Unclassified rev |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of Object.values(report.sales)) {
    out.push(`| ${s.window.key} | ${s.order_count} | ${s.units_sold} | ${fmt(s.gross_sales)} | ${fmt(s.discounts)} | ${fmt(s.refunds)} | ${fmt(s.net_sales)} | ${fmt(s.tax)} | ${fmt(s.net_sales_ex_tax)} | ${fmt(s.aov)} | ${pct(s.cost_coverage_pct)} | ${fmt(s.cogs)} | ${profitCell(s.gross_profit)} | ${profitCell(s.contribution_margin_v0)} | ${fmt(s.unclassified_revenue_ex_tax)} |`);
  }

  for (const [key, block] of Object.entries(report.products)) {
    out.push(`\n## Products - ${key}`);
    const list = (title, rows, cols) => {
      out.push(`\n### ${title}`);
      if (!rows.length) { out.push('_none_'); return; }
      out.push(`| Product | ${cols.map((x) => x[0]).join(' | ')} |`);
      out.push(`|---|${cols.map(() => '---').join('|')}|`);
      for (const r of rows) out.push(`| ${r.title} | ${cols.map((x) => x[1](r)).join(' | ')} |`);
    };
    const R = block.rankings;
    list('Top by revenue (ex tax)', R.top_revenue, [['Revenue', (r) => fmt(r.net_sales_ex_tax)], ['Units', (r) => r.units_sold], ['Cost', (r) => r.cost_status]]);
    list('Top by units', R.top_units, [['Units', (r) => r.units_sold], ['Revenue', (r) => fmt(r.net_sales_ex_tax)]]);
    list('Top by gross profit', R.top_gross_profit, [['Gross profit *', (r) => fmt(r.gross_profit)], ['Cost', (r) => r.cost_confidence]]);
    list('Top by contribution margin v0', R.top_contribution_margin, [['CM v0 *', (r) => fmt(r.contribution_margin_v0)], ['Margin', (r) => pct(r.margin_pct)]]);
    for (const [name, seg] of Object.entries(block.segments)) {
      list(`${name} (${seg.criteria})`, seg.items, [['Units', (r) => r.units_sold], ['Stock', (r) => r.stock_units], ['Last sale (days)', (r) => r.days_since_last_sale ?? 'never'], ['Cost', (r) => r.cost_status]]);
    }
    list('Commercial candidates', block.commercial_candidates, [['Confidence', (r) => r.confidence], ['Units', (r) => r.evidence.units_sold], ['Margin', (r) => pct(r.evidence.margin_pct)], ['Stock', (r) => r.evidence.stock_units], ['Reasons', (r) => r.reason_codes.join(', ')]]);
    list('Cash-risk signals', block.cash_risks, [['Stock', (r) => r.evidence.stock_units], ['Stock value at cost', (r) => fmt(r.evidence.inventory_value_at_cost?.value)], ['Reasons', (r) => r.reason_codes.join(', ')]]);
  }

  if (extras.quality) out.push(`\n## Data quality\n${'```'}json\n${JSON.stringify(extras.quality, null, 2)}\n${'```'}`);
  if (extras.validation) {
    out.push('\n## Validation vs Shopify order totals');
    out.push('| Window | Metric | Engine | Shopify | Diff | OK |');
    out.push('|---|---|---|---|---|---|');
    for (const v of extras.validation) out.push(`| ${v.window} | ${v.metric} | ${v.engine} | ${v.shopify} | ${v.diff} | ${v.ok ? 'yes' : 'NO'} |`);
  }
  return out.join('\n');
}
