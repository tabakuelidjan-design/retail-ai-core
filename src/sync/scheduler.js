#!/usr/bin/env node
// Long-running scheduler for the Core Shopify sync (Railway "Core" service, not a public website).
//   node src/sync/scheduler.js            -> runs `node src/sync/index.js all` now, then again every SYNC_INTERVAL_MINUTES (default 15)
// Each run is a separate child process (clean memory, clean exit code) and runs never overlap. A failed run is already recorded FAILED in
// sync_runs by the sync itself; the scheduler logs it and simply tries again at the next interval (that is the retry), keeping the previous data.
// Configuration by environment only: SYNC_INTERVAL_MINUTES (5..1440), SYNC_MODE (all|orders|catalog|inventory|cost).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODES = ['all', 'orders', 'catalog', 'inventory', 'cost'];
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function resolveSchedule(env = process.env) {
  const raw = env.SYNC_INTERVAL_MINUTES;
  const intervalMinutes = raw === undefined || raw === '' ? 15 : Number(raw);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) throw new Error('SYNC_INTERVAL_MINUTES must be between 5 and 1440 (default 15)');
  const mode = env.SYNC_MODE || 'all';
  if (!MODES.includes(mode)) throw new Error(`SYNC_MODE must be one of ${MODES.join(', ')}`);
  return { intervalMinutes, mode };
}

export function runChild(mode, { spawnFn = spawn, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawnFn(process.execPath, ['src/sync/index.js', mode], { cwd, env: process.env, stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Runs `run()` now and then every `intervalMinutes` (start to start; never overlapping, never faster than 30 s between runs). */
export async function schedule({ intervalMinutes, mode, run = () => runChild(mode), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), log = console.log, maxRuns = Infinity }) {
  for (let n = 0; n < maxRuns; n += 1) {
    const started = now();
    log(`[scheduler] sync ${mode} starting`);
    let code = 1;
    try { code = await run(); } catch { code = 1; }
    log(`[scheduler] sync ${mode} ${code === 0 ? 'finished OK' : `finished with exit code ${code} (recorded in sync_runs; retrying at the next interval)`}`);
    if (n + 1 >= maxRuns) break;
    await sleep(Math.max(30_000, intervalMinutes * 60_000 - (now() - started)));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await schedule(resolveSchedule()); } catch (e) { console.error(`scheduler configuration error: ${e.message}`); process.exit(1); }
}
