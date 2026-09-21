// Live-vs-stored order validation for the marketing report. Both sides are compared over the SAME explicit date range.
// Regression: with `read_all_orders` history stored, the live side was still read over the last 60 days while the stored side
// counted everything, so a perfectly synced database reported a mismatch (47 live vs 71 stored).

/**
 * The range to compare over. With a verified full-history backfill (coverage marker) the range starts at the verified date;
 * otherwise it is the ordinary available window (what Shopify exposes without read_all_orders).
 * @param {{availableStart: Date, coverage?: {completeFrom?: string|null}|null}} p
 * @returns {{since: string, basis: 'full_history'|'available_window'}}
 */
export function validationRange({ availableStart, coverage }) {
  if (coverage?.completeFrom && /^\d{4}-\d{2}-\d{2}$/.test(coverage.completeFrom)) return { since: coverage.completeFrom, basis: 'full_history' };
  return { since: availableStart.toISOString().slice(0, 10), basis: 'available_window' };
}

/**
 * @param {{live: object[], stored: object[], attribution: object[], range: {since: string, basis: string}}} p
 * live: Shopify order nodes (already fetched for `range.since`); stored: rows with source_id, ordered_at, is_test, channel_handle, id;
 * attribution: last_visit rows keyed by order_id.
 */
export function compareOrders({ live, stored, attribution, range }) {
  const liveReal = live.filter((n) => !n.test);
  // Stored rows are restricted to the same range as the live query (a date, inclusive, compared on the ISO day).
  const storedReal = stored.filter((o) => !o.is_test && String(o.ordered_at).slice(0, 10) >= range.since);
  const storedBySource = new Map(storedReal.map((o) => [o.source_id, o]));
  const liveIds = new Set(liveReal.map((n) => n.id));
  const attrByOrderId = new Map(attribution.map((a) => [a.order_id, a]));
  let channelMismatch = 0;
  let visitMismatch = 0;
  for (const n of liveReal) {
    const s = storedBySource.get(n.id);
    if (!s) continue;
    if ((n.channelInformation?.channelDefinition?.handle ?? null) !== s.channel_handle) channelMismatch += 1;
    const liveSource = n.customerJourneySummary?.lastVisit?.source ?? null;
    const storedSource = attrByOrderId.get(s.id)?.source ?? null;
    if (liveSource !== storedSource) visitMismatch += 1;
  }
  const missingInDb = liveReal.filter((n) => !storedBySource.has(n.id)).length;
  const extraInDb = storedReal.filter((o) => !liveIds.has(o.source_id)).length;
  return {
    range: { since: range.since, basis: range.basis },
    shopify_orders: liveReal.length, stored_orders: storedReal.length,
    missing_in_db: missingInDb, extra_in_db: extraInDb,
    channel_mismatches: channelMismatch, last_visit_source_mismatches: visitMismatch,
    ok: liveReal.length === storedReal.length && missingInDb === 0 && extraInDb === 0 && channelMismatch === 0 && visitMismatch === 0,
  };
}
