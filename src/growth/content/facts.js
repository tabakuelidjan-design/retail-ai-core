// Growth > Contenu - facts assembly: the catalog rows as synced (products, variants, current collections) and each product's
// sales over the last 8 complete weeks (same window as Produits Potentiels). Sales only help decide WHAT TO FIX FIRST; they
// never change which content problem a product has.

import { buildLedger } from '../../metrics/ledger.js';
import { aggregate, windowFacts } from '../../metrics/sales.js';
import { buildWeekBuckets } from '../../metrics/windows.js';

export const WEEKS = 8;

export function contentFacts({ data, now, timeZone, config }) {
  const ledger = buildLedger(data, { config });
  const weeks = buildWeekBuckets(now, timeZone, WEEKS);
  const window = { start: weeks[0].start, end: weeks[WEEKS - 1].end };
  const { lines, refunds } = windowFacts(ledger, window);
  const lineProduct = new Map(ledger.lineFacts.map((l) => [l.orderLineId, l.productId]));
  const byProduct = new Map();
  const slot = (id) => byProduct.get(id) ?? byProduct.set(id, { lines: [], refunds: [] }).get(id);
  for (const l of lines) if (l.productId) slot(l.productId).lines.push(l);
  for (const r of refunds) { const id = lineProduct.get(r.orderLineId); if (id) slot(id).refunds.push(r); }
  const sales = new Map();
  for (const [id, g] of byProduct) { const a = aggregate(g.lines, g.refunds, config); sales.set(id, { units: a.units_sold, netSales: a.net_sales_ex_tax }); }
  return {
    products: data.products ?? [], variants: data.variants ?? [], collections: data.collections ?? [], sales,
    window: { start: window.start.toISOString(), end: window.end.toISOString(), weeks: WEEKS }, currency: ledger.currency,
  };
}
