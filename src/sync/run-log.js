// Synchronisation run log (table sync_runs). Records when a Shopify -> Supabase sync started, whether it finished and what it touched.
// Logging must never break a sync, and a sync failure must never erase data: runs only ever ADD rows, the sync itself only upserts.

const COUNT_KEYS = ['ordersUpserted', 'orderLinesUpserted', 'refundsUpserted', 'productsUpserted', 'variantsUpserted', 'locationsUpserted', 'snapshotsUpserted', 'costsUpserted', 'costRowsUpserted'];

/** Keep only the numeric counters of a module summary (never free text, never credentials). */
export function countsOf(summaries) {
  const out = {};
  for (const [mode, s] of Object.entries(summaries ?? {})) {
    const c = Object.fromEntries(COUNT_KEYS.filter((k) => Number.isFinite(s?.[k])).map((k) => [k, s[k]]));
    out[mode] = { ...c, errors: Array.isArray(s?.errors) ? s.errors.length : 0 };
  }
  return out;
}

export async function startRun(supabase, { merchantId, mode, now = new Date() }) {
  try {
    const [row] = await supabase.insert('sync_runs', [{ merchant_id: merchantId, mode, status: 'RUNNING', started_at: now.toISOString() }]);
    return row?.id ?? null;
  } catch { return null; } // logging is best effort
}

export async function finishRun(supabase, id, { ok, summaries, error, now = new Date() }) {
  if (!id) return;
  try {
    await supabase.update('sync_runs', { id: `eq.${id}` }, {
      status: ok ? 'SUCCESS' : 'FAILED', finished_at: now.toISOString(), summary: countsOf(summaries),
      error: ok ? null : String(error ?? 'sync reported errors').split('\n')[0].slice(0, 300),
    });
  } catch { /* best effort */ }
}

/**
 * Factual sync health: the last attempt, the last SUCCESSFUL sync that refreshed orders, and whether that is older than
 * `staleAfterMinutes`. A running sync older than `runningTimeoutMinutes` is reported as interrupted, not as running.
 */
export async function latestSyncStatus(supabase, merchantId, { now = new Date(), staleAfterMinutes = 60, runningTimeoutMinutes = 30 } = {}) {
  const rows = await supabase.select('sync_runs', { select: 'id,mode,status,started_at,finished_at,summary,error', merchant_id: `eq.${merchantId}`, order: 'started_at.desc', limit: '50' });
  const sorted = [...rows].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  if (!sorted.length) return { available: false, reason: 'NO_SYNC_RECORDED' };
  const view = (r) => r && { mode: r.mode, startedAt: r.started_at, finishedAt: r.finished_at ?? null, status: r.status, error: r.error ?? null, counts: r.summary ?? null };
  const lastAttempt = sorted[0];
  const interrupted = lastAttempt.status === 'RUNNING' && now - new Date(lastAttempt.started_at) > runningTimeoutMinutes * 60_000;
  const lastSuccess = sorted.find((r) => r.status === 'SUCCESS' && (r.mode === 'orders' || r.mode === 'all'));
  const ageMinutes = lastSuccess ? Math.round((now - new Date(lastSuccess.finished_at)) / 60_000) : null;
  return {
    available: true,
    lastAttempt: { ...view(lastAttempt), status: interrupted ? 'INTERRUPTED' : lastAttempt.status },
    lastSuccess: view(lastSuccess) ?? null,
    ageMinutes, staleAfterMinutes,
    stale: ageMinutes === null ? true : ageMinutes > staleAfterMinutes,
    latestFailed: lastAttempt.status === 'FAILED' || interrupted,
  };
}
