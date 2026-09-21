// Stock trust. Phase 2B can only ever label a Shopify quantity UNVERIFIED (there
// is no physical-count evidence in the data). A merchant can supply counts:
//   { variant_id, counted_units, counted_at }
// A count makes a quantity VERIFIED only if it still reconciles with the current
// Shopify quantity: counted units minus units sold since the count == stock now,
// the count is recent, and the stock was synced after the count. Any mismatch
// (an unrecorded restock, a manual edit, a sale not synced) leaves the quantity
// unverified rather than assuming the count still holds.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Attaches units sold since each count, from the ledger (pure). */
export function prepareStockVerification(records, ledger) {
  const out = new Map();
  for (const r of records ?? []) {
    if (r.counted_units == null || r.counted_at == null) continue; // an unfilled count-sheet row is not a count
    const at = new Date(r.counted_at);
    const soldSince = ledger.lineFacts
      .filter((l) => l.variantId === r.variant_id && l.orderedAt > at)
      .reduce((a, l) => a + l.qty, 0);
    out.set(r.variant_id, { counted_units: r.counted_units, counted_at: at, units_sold_since: soldSince });
  }
  return out;
}

/**
 * @returns {Map<string, {trusted: boolean, reason: string}>} per variant with a count
 */
export function reconcileVerification(prepared, variantFacts, { now, maxAgeDays }) {
  const byVariant = new Map(variantFacts.map((v) => [v.variant_id, v]));
  const out = new Map();
  for (const [variantId, rec] of prepared) {
    const v = byVariant.get(variantId);
    if (!v) { out.set(variantId, { trusted: false, reason: 'VARIANT_NOT_IN_FACTS' }); continue; }
    if ((now - rec.counted_at) / DAY_MS > maxAgeDays) { out.set(variantId, { trusted: false, reason: 'COUNT_TOO_OLD' }); continue; }
    if (!v.inventory.snapshot_at || new Date(v.inventory.snapshot_at) < rec.counted_at) { out.set(variantId, { trusted: false, reason: 'STOCK_NOT_SYNCED_AFTER_COUNT' }); continue; }
    const expected = rec.counted_units - rec.units_sold_since;
    if (v.inventory.stock_units !== expected) { out.set(variantId, { trusted: false, reason: `DOES_NOT_RECONCILE_EXPECTED_${expected}_FOUND_${v.inventory.stock_units}` }); continue; }
    out.set(variantId, { trusted: true, reason: 'RECONCILES' });
  }
  return out;
}

/** VERIFIED (counted and reconciled) | UNVERIFIED | UNRELIABLE (suspect / stale / no data / negative and not counted). */
export function variantStockTrust(variantFact, verification) {
  if (verification?.trusted) return 'VERIFIED';
  return variantFact.inventory.stock_quality === 'UNVERIFIED' ? 'UNVERIFIED' : 'UNRELIABLE';
}

/** Unit-weighted trust class for a set of variants. */
export function peerStockTrust(variants, verifications, cfg) {
  let verified = 0;
  let unverified = 0;
  let unreliable = 0;
  const unverifiedList = [];
  for (const v of variants) {
    const units = v.inventory.stock_units;
    if (units <= 0) continue;
    const t = variantStockTrust(v, verifications.get(v.variant_id));
    if (t === 'VERIFIED') verified += units;
    else if (t === 'UNVERIFIED') { unverified += units; unverifiedList.push({ variant_id: v.variant_id, product_title: v.product_title, variant_title: v.variant_title, units }); }
    else unreliable += units;
  }
  const total = verified + unverified + unreliable;
  const share = (x) => (total > 0 ? Math.round((x / total) * 10000) / 10000 : 0);
  let trust = 'UNVERIFIED';
  if (total === 0) trust = 'NO_STOCK';
  else if (cfg.blockedShare == null || cfg.trustedShare == null) trust = 'POLICY_MISSING'; // never compare against an unset threshold
  else if (share(unreliable) >= cfg.blockedShare) trust = 'BLOCKED';
  else if (share(verified) >= cfg.trustedShare) trust = 'TRUSTED';
  return {
    trust, total_units: total, verified_share: share(verified), unverified_share: share(unverified), unreliable_share: share(unreliable),
    largest_unverified_variants: unverifiedList.sort((a, b) => b.units - a.units).slice(0, 5),
  };
}
