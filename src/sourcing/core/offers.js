// Supplier price tiers (100 pcs -> 7.20, 300 pcs -> 6.80, 500 pcs -> 6.40). The quote keeps its V0 shape (the engines still read quotes.at(-1)); `tiers` is an optional extension and
// the unit price for a given quantity is RESOLVED, never guessed: below the first tier, or with two prices for the same threshold, the answer is "unknown" (fail closed).
const toNum = (x) => (x === null || x === undefined || x === '' ? NaN : Number(String(x).replace(',', '.')));

/** Valid tiers sorted by threshold. Entries with a non-numeric threshold or price are dropped. */
export function normalizeTiers(tiers) {
  return (Array.isArray(tiers) ? tiers : []).map((t) => ({ min: toNum(t?.minQty), minQty: String(t?.minQty ?? ''), unitPrice: t?.unitPrice === null || t?.unitPrice === undefined ? null : String(t.unitPrice) }))
    .filter((t) => Number.isFinite(t.min) && t.min > 0 && t.unitPrice !== null && Number.isFinite(toNum(t.unitPrice))).sort((a, b) => a.min - b.min);
}

/** @returns {{ unitPrice: string|null, source: 'TIER'|'QUOTE'|'NONE', tier?: object, reason?: string }} */
export function resolveUnitPrice(quote, qty) {
  const q = quote ?? {}; const tiers = normalizeTiers(q.tiers); const explicit = q.unitPrice !== undefined && q.unitPrice !== null && q.unitPrice !== '' ? String(q.unitPrice) : null;
  const single = (reason) => (explicit !== null ? { unitPrice: explicit, source: 'QUOTE', ...(reason ? { flags: [reason] } : {}) } : { unitPrice: null, source: 'NONE', ...(reason ? { reason } : {}) });
  if (!tiers.length) return single(null);
  const dup = tiers.some((t, i) => tiers.findIndex((u) => u.min === t.min) !== i && tiers.find((u) => u.min === t.min).unitPrice !== t.unitPrice);
  if (dup) return { unitPrice: null, source: 'NONE', reason: 'AMBIGUOUS_TIER' };
  const n = toNum(qty); if (!(n > 0)) return single('QUANTITY_UNKNOWN');
  const hit = [...tiers].reverse().find((t) => t.min <= n);
  if (!hit) return single('BELOW_FIRST_TIER');
  return { unitPrice: hit.unitPrice, source: 'TIER', tier: { minQty: hit.minQty, unitPrice: hit.unitPrice } };
}

/** The quote as the engines and the screens should read it: with tiers, the unit price for the quantity being considered (quantity = qty, else MOQ). A quote without tiers is returned untouched. */
export function effectiveQuote(quote) {
  const q = quote ?? {}; if (!normalizeTiers(q.tiers).length) return q;
  const r = resolveUnitPrice(q, q.qty ?? q.moq); return r.unitPrice !== null ? { ...q, unitPrice: r.unitPrice } : q;
}
