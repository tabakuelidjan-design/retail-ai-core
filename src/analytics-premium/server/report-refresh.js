// Hosted staging only: Analytics builds its own report snapshot from the synced Supabase data (read-only, deterministic, no LLM) by
// running the Core report command. reports/ is gitignored and a container filesystem does not survive a redeploy, so the report is
// regenerated at startup and then every N hours. Until the first run finishes the API answers NO_REPORT_AVAILABLE (an honest empty
// state, never invented figures). Failures are logged as one truncated line and never stop the server; the previous snapshot stays.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Last report generation attempt (a report is generated FROM the synced data; it is not a Shopify sync). */
export const reportRefreshState = { lastAttemptAt: null, lastSuccessAt: null, lastStatus: null };

export function runReportOnce({ spawnFn = spawn, cwd = ROOT, log = console.log } = {}) {
  return new Promise((resolve) => {
    const child = spawnFn(process.execPath, ['src/report/index.js', 'report'], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    reportRefreshState.lastAttemptAt = new Date().toISOString();
    child.stderr?.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('error', (e) => { log(`report refresh could not start: ${String(e.message).slice(0, 160)}`); resolve(false); });
    child.on('close', (code) => {
      reportRefreshState.lastStatus = code === 0 ? 'SUCCESS' : 'FAILED';
      if (code === 0) reportRefreshState.lastSuccessAt = new Date().toISOString();
      if (code === 0) log('report refresh: ok');
      else log(`report refresh failed (exit ${code}): ${(err.trim().split('\n').pop() ?? '').slice(0, 200)}`);
      resolve(code === 0);
    });
  });
}

export function startReportRefresh({ hours, run = runReportOnce, setIntervalFn = setInterval } = {}) {
  const first = run();
  let timer = null;
  if (hours > 0) { timer = setIntervalFn(() => { run(); }, hours * 3600_000); timer.unref?.(); }
  return { first, stop: () => timer && clearInterval(timer) };
}

/**
 * Regenerate the report only when needed: at startup, whenever a NEWER successful Shopify sync exists than the one the current report was
 * built from, and as a safety net every `fallbackHours` (0 = never) even when the sync status cannot be read. A failed generation does not
 * advance the "built from" marker, so it is retried on the next check, and the previous report file stays in place.
 */
export function startSyncAwareRefresh({ getSyncFinishedAt, run = runReportOnce, needsRebuild = null, checkMinutes = 5, fallbackHours = 6, setIntervalFn = setInterval, now = () => Date.now() }) {
  let builtFrom = null; let lastRunAt = null; let running = false;
  const tick = async () => {
    if (running) return false;
    let sync = null;
    try { sync = (await getSyncFinishedAt?.()) ?? null; } catch { sync = null; }
    // `needsRebuild`: the derived files (report, dataset snapshot) are only a cache - if they are missing (container recreated, file deleted) they are rebuilt
    // from the synchronised data at the next check, or immediately when a request finds them missing.
    let missing = false; try { missing = needsRebuild ? await needsRebuild() : false; } catch { missing = false; }
    const due = missing || lastRunAt === null || (sync !== null && sync !== builtFrom) || (fallbackHours > 0 && now() - lastRunAt >= fallbackHours * 3600_000);
    if (!due) return false;
    running = true;
    try {
      const ok = await run();
      lastRunAt = now();
      if (ok && sync !== null) builtFrom = sync;
      return ok;
    } finally { running = false; }
  };
  const first = tick();
  const timer = setIntervalFn(() => { tick(); }, Math.max(1, checkMinutes) * 60_000);
  timer.unref?.();
  return { first, tick, stop: () => clearInterval(timer) };
}
