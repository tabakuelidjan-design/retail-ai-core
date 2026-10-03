// Honest data-health state for the Analytics page (Analyses Phase 0). Pure: no DOM, no clock, no I/O. Loaded as a classic script in the page
// (global NordlaHealth) and as a CommonJS module by the tests. It only ever REPORTS what the sync status and the report's own counters prove:
// it never says "up to date" or "verified". The full Data Health model (freshness, coverage, completeness, cost trust, ...) is Phase 1.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NordlaHealth = api;
}(typeof self !== 'undefined' ? self : this, () => {
  /**
   * @param {{available?: boolean, reason?: string, stale?: boolean, latestFailed?: boolean, lastSuccess?: {finishedAt?: string}|null}|null} sync  /api/sync-status `sync`
   * @returns {{ state: 'OK'|'STALE'|'FAILED'|'UNKNOWN'|'NO_SOURCE', tone: 'ok'|'warn'|'bad'|'mute', valueKey: string, since: string|null }}
   */
  function healthState(sync) {
    if (sync && sync.reason === 'NO_SALES_SOURCE') return { state: 'NO_SOURCE', tone: 'mute', valueKey: 'health.noSource', since: null };
    if (!sync || !sync.available) return { state: 'UNKNOWN', tone: 'warn', valueKey: 'health.unknown', since: null };
    const since = sync.lastSuccess && sync.lastSuccess.finishedAt ? sync.lastSuccess.finishedAt : null;
    if (sync.latestFailed) return { state: 'FAILED', tone: 'bad', valueKey: 'health.syncFailed', since };
    if (sync.stale) return { state: 'STALE', tone: 'warn', valueKey: 'health.syncStale', since };
    if (!since) return { state: 'UNKNOWN', tone: 'warn', valueKey: 'health.unknown', since: null };
    return { state: 'OK', tone: 'ok', valueKey: 'health.syncOk', since };
  }

  const EXCLUSION_KEYS = ['test', 'status', 'cancelled', 'otherCurrency', 'refundsOnExcludedOrders'];

  /** Every non-zero exclusion counter of the report, in a fixed order. `known:false` when the report carries no counters at all. */
  function exclusionNotes(excluded) {
    if (!excluded || typeof excluded !== 'object') return { known: false, items: [] };
    return { known: true, items: EXCLUSION_KEYS.filter((k) => Number(excluded[k]) > 0).map((key) => ({ key, count: Number(excluded[key]), labelKey: `health.excluded.${key}` })) };
  }

  return { healthState, exclusionNotes, EXCLUSION_KEYS };
}));
