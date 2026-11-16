// Growth > Contenu - facts assembly: the catalog rows as synced (products, variants, current collections) and each product's
// sales over the last 8 complete weeks (same window as Produits Potentiels). Sales only help decide WHAT TO FIX FIRST; they
// never change which content problem a product has. Net sales = Nordla sales semantics A (metrics/net-sales.js: order-dated,
// net of every refund of the order), identical on every Growth page.

import { buildLedger } from '../../metrics/ledger.js';
import { orderNetFacts, netSalesByProduct } from '../../metrics/net-sales.js';
import { buildWeekBuckets } from '../../metrics/windows.js';

export const WEEKS = 8;

export function contentFacts({ data, now, timeZone, config }) {
  const ledger = buildLedger(data, { config });
  const weeks = buildWeekBuckets(now, timeZone, WEEKS);
  const window = { start: weeks[0].start, end: weeks[WEEKS - 1].end };
  const sales = new Map();
  for (const [key, x] of netSalesByProduct(orderNetFacts(ledger, config), window)) sales.set(key, { units: x.units, netSales: x.net });
  return {
    products: data.products ?? [], variants: data.variants ?? [], collections: data.collections ?? [], sales,
    window: { start: window.start.toISOString(), end: window.end.toISOString(), weeks: WEEKS }, currency: ledger.currency,
  };
}
