// Growth > Potentiel produits: the detail BY VARIANT of a product (fiche produit). It reuses the verified net-sales calculation of
// src/creative-autonomy/opportunity.js#variantRowsFromDataset (order_lines.quantity is GROSS; test and cancelled orders count 0; refund lines are
// deducted once) and adds the stock state. It reads nothing and writes nothing: the dataset comes from loadDataset, the window from the demand engine.
//
// STOCK: the sellable quantity of the latest snapshot of each location, summed. A variant with no snapshot is UNKNOWN, a snapshot older than
// `maxSnapshotAgeHours` (the demand engine's own gate, 36 h) is STALE, a negative quantity is UNRELIABLE: in these three cases `units` is null
// (the screen shows a dash and the date), NEVER 0. Only a usable snapshot can read as 0 (a real out-of-stock).
import { variantRowsFromDataset } from '../../creative-autonomy/opportunity.js';
import { computeCover } from '../../demand/classify.js';

export function stockStateOf(evidence, stock, { now, maxSnapshotAgeHours }) {
  const at = evidence.stock_snapshot_at;
  if (stock == null || at == null) return { state: 'UNKNOWN', usable: false, units: null, snapshotAt: at ?? null, locations: [] };
  const base = { snapshotAt: at, locations: evidence.stock_locations };
  if (evidence.stock_locations.some((l) => l.quantity < 0)) return { ...base, state: 'UNRELIABLE', usable: false, units: null };
  if ((new Date(now) - new Date(at)) / 3_600_000 > maxSnapshotAgeHours) return { ...base, state: 'STALE', usable: false, units: null };
  return { ...base, state: 'OK', usable: true, units: stock };
}

/**
 * @param {object} data      loadDataset(...) result
 * @param {{ window: {start: Date|string, end: Date|string}, now: Date, maxSnapshotAgeHours: number }} p
 *   demandConfig + exposureByProduct: when given, each variant carries its COVER, computed by the product engine's own function (src/demand/classify.js#computeCover) with its own
 *   thresholds (config.demand): stock / (net units of the variant / exposure weeks of the PRODUCT). The exposure of the product is used because the age of a variant is not known.
 *   A variant whose stock is unknown / stale / unreliable has no cover (STOCK_UNUSABLE), never a cover computed from 0.
 * @returns {{ window: {since: string, until: string, days: number}, byProduct: Map<string, object[]> }} byProduct is keyed by the LOCAL product id (the Growth row id)
 */
export function variantDetailsByProduct(data, { window, now, maxSnapshotAgeHours, demandConfig = null, exposureByProduct = new Map() }) {
  const rows = variantRowsFromDataset(data, { now, since: window.start, until: window.end });
  const byProduct = new Map();
  for (const r of rows) {
    if (!r.product_local_id) continue;
    const e = r.evidence;
    const list = byProduct.get(r.product_local_id) ?? [];
    const stock = stockStateOf(e, r.stock, { now, maxSnapshotAgeHours });
    const ex = exposureByProduct.get(r.product_local_id);
    const cover = !demandConfig || !ex ? null : { minWeeks: demandConfig.cover.lowWeeks, ...(stock.usable
      ? computeCover({ stockUnits: stock.units, units: e.units_net, exposureWeeks: ex.exposureWeeks, observableWeeks: ex.observableWeeks }, demandConfig)
      : { status: 'STOCK_UNUSABLE', weeks: null, days: null }) };
    list.push({ id: r.variant_id, title: r.variant_title, unitsGross: e.units_gross, unitsRefunded: e.units_refunded, unitsCancelled: e.units_cancelled, unitsNet: e.units_net, lastSale: r.last_sale, stock, cover });
    byProduct.set(r.product_local_id, list);
  }
  for (const list of byProduct.values()) list.sort((a, b) => b.unitsNet - a.unitsNet || String(a.title).localeCompare(String(b.title)));
  return { window: rows[0]?.evidence.period ?? { since: new Date(window.start).toISOString(), until: new Date(window.end).toISOString(), days: Math.round((new Date(window.end) - new Date(window.start)) / 86_400_000) }, byProduct };
}
