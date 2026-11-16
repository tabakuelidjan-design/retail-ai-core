// THE NEXT ADVERTISEMENT: WHICH PRODUCT, AND WHICH VARIANT (2026-11-15). Pure and deterministic: the recent sales and the sellable stock of each variant in, a ranked list of commercial opportunities out, each with its reason or its exclusion.
// The facts are those of the Nordla dataset (orders and order lines of the last 120 days, the latest stock snapshot per variant); this module reads nothing and decides nothing artistic. The thresholds below are THIS module's own
// (the Growth potential engine, src/growth/products/potential.js, needs the full 8-week demand facts; the AD route needs one product and one variant today): they are named, listed in the report, and easy to move.
//   a variant is ADMISSIBLE when it sold in the window, its stock is sellable (>= MIN_STOCK_UNITS) and its cover at the observed pace is not short (>= MIN_COVER_WEEKS);
//   a product that sold much but whose variant stock is nearly out is NOT promoted (it would sell out: "restock", not "advertise");
//   the score is the product's sales (what the public already buys) + the variant's own sales, a bonus for a coloured variant (this first trial asks for colour), a small recency bonus.
// The eligibility of the PHOTO and of the product sheet is checked afterwards by Creator itself (free preflight): a product that fails there is skipped and the next one is tried.
export const WINDOW_DAYS = 120;
export const MIN_STOCK_UNITS = 5;
export const MIN_COVER_WEEKS = 8;
export const COLOUR_BONUS = 2;
export const RECENCY_DAYS = 30;
const COLOURS = ['rose', 'bleu', 'mauve', 'violet', 'vert', 'jaune', 'orange', 'rouge', 'turquoise', 'corail'];
const isColoured = (title) => COLOURS.some((c) => new RegExp(`(^|[^\\p{L}])${c}([^\\p{L}]|$)`, 'iu').test(String(title ?? '')));
const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86_400_000);

/**
 * @param {Array<{ product_id, title, variant_id, variant_title, units, last_sale, stock }>} rows  one row per variant (units sold in the window, stock = sellable units)
 * @param {{ now?: Date, exclude?: string[] }} opts  exclude = product ids already advertised or failed
 * @returns {{ ranked: object[], excluded: object[], rules: object }}
 */
export function rankAdOpportunities(rows, { now = new Date(), exclude = [] } = {}) {
  const productUnits = new Map(); for (const r of rows) productUnits.set(r.product_id, (productUnits.get(r.product_id) ?? 0) + Number(r.units ?? 0));
  const ranked = []; const excluded = [];
  for (const r of rows) {
    const units = Number(r.units ?? 0); const stock = r.stock == null ? null : Number(r.stock);
    const why = [];
    if (exclude.includes(r.product_id)) why.push('ALREADY_USED_OR_FAILED');
    if (units < 1) why.push('NO_SALE_IN_THE_WINDOW');
    if (stock == null) why.push('STOCK_UNKNOWN'); else if (stock < MIN_STOCK_UNITS) why.push(`STOCK_TOO_LOW (${stock} < ${MIN_STOCK_UNITS}): it would sell out, a restock matter, not an advertisement`);
    const weeklyPace = units / (WINDOW_DAYS / 7); const cover = stock != null && weeklyPace > 0 ? stock / weeklyPace : null;
    if (cover != null && cover < MIN_COVER_WEEKS) why.push(`COVER_TOO_SHORT (${cover.toFixed(1)} weeks < ${MIN_COVER_WEEKS})`);
    const item = { product_id: r.product_id, title: r.title, variant_id: r.variant_id, variant_title: r.variant_title, units, product_units: productUnits.get(r.product_id), stock, cover_weeks: cover == null ? null : Math.round(cover * 10) / 10, last_sale: r.last_sale ?? null, coloured: isColoured(r.variant_title), ...(r.evidence ? { evidence: r.evidence } : {}) };
    if (why.length) { excluded.push({ ...item, why }); continue; }
    const recent = r.last_sale && daysBetween(r.last_sale, now) <= RECENCY_DAYS;
    ranked.push({ ...item, score: item.product_units + 0.5 * units + (item.coloured ? COLOUR_BONUS : 0) + (recent ? 1 : 0) });
  }
  ranked.sort((a, b) => b.score - a.score || b.units - a.units || a.variant_id.localeCompare(b.variant_id));
  return { ranked, excluded, rules: { WINDOW_DAYS, MIN_STOCK_UNITS, MIN_COVER_WEEKS, COLOUR_BONUS, RECENCY_DAYS } };
}

/**
 * The rows rankAdOpportunities needs, from the Nordla dataset (src/metrics/load.js#loadDataset): NET units sold per variant over the window, and the SELLABLE stock of the variant.
 *
 * SOURCE OF THE QUANTITY (no double deduction): order_lines.quantity is the quantity ORDERED, as Shopify's lineItem.quantity (src/sync/normalize.js, normalizeOrderLine): it is GROSS, never already net of refunds.
 * Refunds live apart in refund_lines.quantity (one row per refunded order line and refund). So, for each order of the window (ordered_at in [now - windowDays, now]):
 *   - a TEST order (is_test) contributes 0;
 *   - a CANCELLED order contributes 0 (cancelled_at set and not after `now`; or, for a database without that column, a status that says cancelled). Its lines are NOT also deducted by their refund lines: Shopify refunds a cancelled order, deducting both would count it twice;
 *   - any other order contributes, per line, quantity - (refund_lines.quantity of that line, refunds dated at or before `now`, each refund_lines row counted ONCE by its id), never below 0.
 * A refund dated after `now` is unknown at the date of the calculation and is not deducted. The status REFUNDED alone is not read as "zero": the refund lines say how much was refunded (a partial refund keeps the remaining units).
 * Each row carries its evidence: the exact period, gross / refunded / cancelled / net units, and the stock with the date of its snapshot and the location(s). A variant with no snapshot has stock null (never zero: STOCK_UNKNOWN).
 */
export function variantRowsFromDataset(data, { now = new Date(), windowDays = WINDOW_DAYS, since: sinceOverride = null, until: untilOverride = null } = {}) {
  // since / until: an EXACT window given by the caller (Growth's 8 complete weeks); otherwise [now - windowDays, now). The END IS EXCLUDED, like the demand engine's weekly buckets.
  const until = new Date(untilOverride ?? now); const since = sinceOverride ? new Date(sinceOverride) : new Date(until.getTime() - windowDays * 86_400_000);
  const period = { since: since.toISOString(), until: until.toISOString(), days: Math.round((until - since) / 86_400_000) };
  // refunds and cancellations are those KNOWN at `now` (the date of the calculation), not at the end of the window
  const known0 = new Date(now);
  const known = (d) => d != null && new Date(d) <= known0; // known at the date of the calculation
  const inWindow = new Map((data.orders ?? []).filter((o) => { const t = new Date(o.ordered_at); return t >= since && t < until; }).map((o) => [o.id, o]));
  const cancelled = (o) => known(o.cancelled_at) || /cancel/i.test(String(o.status ?? ''));
  const refundDate = new Map((data.refunds ?? []).map((r) => [r.id, r.refunded_at]));
  const refunded = new Map(); const seenRefundLines = new Set(); // order_line_id -> units refunded and known
  for (const rl of data.refundLines ?? []) { if (seenRefundLines.has(rl.id) || !known(refundDate.get(rl.refund_id))) continue; seenRefundLines.add(rl.id); refunded.set(rl.order_line_id, (refunded.get(rl.order_line_id) ?? 0) + Number(rl.quantity ?? 0)); }
  const sold = new Map();
  for (const l of data.orderLines ?? []) {
    const o = inWindow.get(l.order_id); if (!o || o.is_test) continue;
    const s = sold.get(l.variant_id) ?? { gross: 0, refunded: 0, cancelled: 0, net: 0, last: null }; const q = Number(l.quantity ?? 0); s.gross += q;
    if (cancelled(o)) s.cancelled += q;
    else { const r = Math.min(q, refunded.get(l.id) ?? 0); s.refunded += r; s.net += q - r; if (q - r > 0 && (!s.last || new Date(o.ordered_at) > new Date(s.last))) s.last = o.ordered_at; }
    sold.set(l.variant_id, s);
  }
  const latest = new Map();
  for (const s of data.snapshots ?? []) { const k = `${s.variant_id}|${s.location_id}`; const cur = latest.get(k); if (!cur || new Date(s.synced_at) > new Date(cur.synced_at)) latest.set(k, s); }
  const locationName = new Map((data.locations ?? []).map((l) => [l.id, l.name]));
  const stock = new Map();
  for (const s of latest.values()) { const e = stock.get(s.variant_id) ?? { quantity: 0, at: null, locations: [] }; e.quantity += Number(s.quantity ?? 0); if (!e.at || new Date(s.synced_at) > new Date(e.at)) e.at = s.synced_at; e.locations.push({ location_id: s.location_id, name: locationName.get(s.location_id) ?? null, quantity: Number(s.quantity ?? 0), synced_at: s.synced_at }); stock.set(s.variant_id, e); }
  const product = new Map((data.products ?? []).map((p) => [p.id, p]));
  return (data.variants ?? []).map((v) => { const p = product.get(v.product_id); const s = sold.get(v.id); const st = stock.get(v.id);
    return { product_id: p?.source_id ?? null, product_local_id: p?.id ?? null, title: p?.title ?? null, variant_id: v.source_id ?? null, variant_title: v.title ?? null, units: s?.net ?? 0, last_sale: s?.last ? new Date(s.last).toISOString().slice(0, 10) : null, stock: st ? st.quantity : null,
      evidence: { period, units_gross: s?.gross ?? 0, units_refunded: s?.refunded ?? 0, units_cancelled: s?.cancelled ?? 0, units_net: s?.net ?? 0, stock_snapshot_at: st?.at ?? null, stock_locations: st?.locations ?? [] } };
  }).filter((r) => r.product_id && r.variant_id);
}
