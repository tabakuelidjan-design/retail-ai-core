// Pure stock-ledger rules. The ledger of movements is the ONLY source of balances: nothing here (or anywhere) stores a quantity.
// Buckets: ON_HAND (physical units at a location) and RESERVED (units at that location promised to someone, still physically there).
import { fail } from './errors.js';

export const LOCATION_TYPES = ['STORE', 'BACKROOM', 'WAREHOUSE', 'TRANSIT', 'QUARANTINE'];
export const SELLABLE_TYPES = new Set(['STORE', 'BACKROOM', 'WAREHOUSE']);
export const PHYSICAL_TYPES = new Set(['STORE', 'BACKROOM', 'WAREHOUSE', 'QUARANTINE']);
export const MOVEMENT_KINDS = ['RECEIPT', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'DEFECT_QUARANTINE_OUT', 'DEFECT_QUARANTINE_IN', 'COUNT_ADJUST', 'RESERVE', 'RELEASE'];
export const BUCKETS = ['ON_HAND', 'RESERVED'];

/** @returns {Map<string,{itemId,locationId,onHand:number,reserved:number}>} keyed `${itemId}|${locationId}` */
export function balancesFrom(movements) {
  const m = new Map();
  for (const mv of movements) {
    const k = `${mv.itemId}|${mv.locationId}`;
    const b = m.get(k) ?? { itemId: mv.itemId, locationId: mv.locationId, onHand: 0, reserved: 0 };
    if (mv.bucket === 'ON_HAND') b.onHand += mv.delta; else b.reserved += mv.delta;
    m.set(k, b);
  }
  return m;
}

/** Throws when applying `mv` on top of `current` would break an invariant: no negative bucket, reserved never above on-hand. */
export function assertPostable(current, mv) {
  const onHand = (current?.onHand ?? 0) + (mv.bucket === 'ON_HAND' ? mv.delta : 0);
  const reserved = (current?.reserved ?? 0) + (mv.bucket === 'RESERVED' ? mv.delta : 0);
  if (onHand < 0) fail('INSUFFICIENT_STOCK', `only ${current?.onHand ?? 0} on hand at this location`, { onHand: current?.onHand ?? 0, requested: -mv.delta });
  if (reserved < 0) fail('INSUFFICIENT_RESERVED', `only ${current?.reserved ?? 0} reserved`, { reserved: current?.reserved ?? 0 });
  if (reserved > onHand) fail('RESERVED_STOCK', `reserved (${reserved}) would exceed on-hand (${onHand}): reserved units cannot leave or be over-promised`, { onHand, reserved });
}

/** Position of one item across locations. `locations` is Map id -> {id,type}. */
export function positionOf(itemId, movements, locations) {
  const per = [...balancesFrom(movements.filter((m) => m.itemId === itemId)).values()].map((b) => ({ locationId: b.locationId, type: locations.get(b.locationId)?.type ?? 'UNKNOWN', onHand: b.onHand, reserved: b.reserved }));
  let physical = 0; let sellable = 0; let reserved = 0; let inTransit = 0; let quarantine = 0;
  for (const p of per) {
    if (PHYSICAL_TYPES.has(p.type)) physical += p.onHand;
    if (SELLABLE_TYPES.has(p.type)) { sellable += p.onHand; reserved += p.reserved; }
    if (p.type === 'TRANSIT') inTransit += p.onHand;
    if (p.type === 'QUARANTINE') quarantine += p.onHand;
  }
  return { itemId, locations: per, physical, sellable, reserved, available: sellable - reserved, inTransit, quarantine };
}

/** Valuation = quantity x weighted-average unit cost of the receipts, by cost status. Never invents a cost: no receipt cost -> UNKNOWN (value null). */
export function valuationOf(movements, physicalQty) {
  const by = { CONFIRMED: { q: 0, c: 0 }, ESTIMATED: { q: 0, c: 0 } };
  for (const m of movements) if (m.kind === 'RECEIPT' && m.bucket === 'ON_HAND' && m.delta > 0 && by[m.costStatus]) { by[m.costStatus].q += m.delta; by[m.costStatus].c += m.delta * m.unitCostEurMicro; }
  const pick = by.CONFIRMED.q ? 'CONFIRMED' : by.ESTIMATED.q ? 'ESTIMATED' : null;
  if (!pick) return { status: 'UNKNOWN', unitCostEurMicro: null, valueEurMinor: null, basis: 'WEIGHTED_AVERAGE_OF_ALL_RECEIPTS', goodsOnly: true };
  const unit = Math.round(by[pick].c / by[pick].q);
  return { status: pick, unitCostEurMicro: unit, valueEurMinor: Math.round((Math.max(physicalQty, 0) * unit) / 10000), basis: 'WEIGHTED_AVERAGE_OF_ALL_RECEIPTS', goodsOnly: pick === 'ESTIMATED' };
}
