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

/**
 * Valuation by MOVING WEIGHTED AVERAGE (owner decision, V1). The ledger is replayed in order over the PHYSICAL units (store, back room, warehouse, quarantine):
 *  - a receipt with a known cost adds units at that cost, so the average moves;
 *  - anything that leaves (adjustment, transfer, quarantine move, count) leaves at the current average, which therefore does not move;
 *  - a unit that enters without its own cost (a transfer in, a positive adjustment) enters at the current average;
 *  - units whose cost is UNKNOWN stay unknown: they are counted (`unknownUnits`) and NEVER valued at an invented cost.
 * Status: CONFIRMED (every valued unit has a confirmed landed cost), ESTIMATED (some valued units carry only the goods price), PARTIAL (some units have no cost: the
 * value covers the others only), UNKNOWN (no unit has a cost), EMPTY (no unit on hand).
 * FIFO stays possible later: `receiptLots` keeps every receipt (date, quantity, unit cost, cost status, order line) and the ledger keeps the order of everything else.
 */
export function valuationOf(movements, locations) {
  let qty = 0n; let value = 0n; let est = 0n; let unknown = 0n;
  for (const m of movements) {
    if (m.bucket !== 'ON_HAND' || !PHYSICAL_TYPES.has(locations.get(m.locationId)?.type)) continue;
    const d = BigInt(m.delta);
    if (d > 0n) {
      if (m.kind === 'RECEIPT') {
        if (m.costStatus === 'UNKNOWN' || m.unitCostEurMicro === null || m.unitCostEurMicro === undefined) unknown += d;
        else { qty += d; value += d * BigInt(m.unitCostEurMicro); if (m.costStatus === 'ESTIMATED') est += d; }
      } else if (qty > 0n) { value += (d * value) / qty; est += (d * est) / qty; qty += d; } // enters at the current average
      else unknown += d;
    } else {
      const out = -d; const total = qty + unknown;
      const outCosted = total > 0n ? (out * qty) / total : 0n;
      if (qty > 0n && outCosted > 0n) { value -= (value * outCosted) / qty; est -= (est * outCosted) / qty; qty -= outCosted; }
      unknown -= out - outCosted;
      if (unknown < 0n) unknown = 0n;
    }
  }
  const valuedUnits = Number(qty); const unknownUnits = Number(unknown);
  const base = { basis: 'MOVING_WEIGHTED_AVERAGE', valuedUnits, unknownUnits };
  if (valuedUnits === 0 && unknownUnits === 0) return { ...base, status: 'EMPTY', unitCostEurMicro: null, valueEurMinor: 0, goodsOnly: false };
  if (valuedUnits === 0) return { ...base, status: 'UNKNOWN', unitCostEurMicro: null, valueEurMinor: null, goodsOnly: true };
  const unit = Number((value + qty / 2n) / qty);
  const status = unknownUnits > 0 ? 'PARTIAL' : est > 0n ? 'ESTIMATED' : 'CONFIRMED';
  return { ...base, status, unitCostEurMicro: unit, valueEurMinor: Number((value + 5000n) / 10000n), goodsOnly: status !== 'CONFIRMED' };
}

/** Every receipt of an item, oldest first: the raw material of a future FIFO / lot costing (nothing is consumed or allocated here). */
export function receiptLots(movements, locations) {
  return movements.filter((m) => m.kind === 'RECEIPT' && m.bucket === 'ON_HAND' && m.delta > 0).map((m) => ({
    at: m.at, qty: m.delta, unitCostEurMicro: m.unitCostEurMicro ?? null, costStatus: m.costStatus, locationId: m.locationId, locationType: locations.get(m.locationId)?.type ?? null, reference: m.reference ?? null,
  }));
}
