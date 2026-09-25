// Hosted staging only: Analytics builds its own report snapshot from the synced Supabase data (read-only, deterministic, no LLM) by
// running the Core report command. reports/ is gitignored and a container filesystem does not survive a redeploy, so the report is
// regenerated at startup and then every N hours. Until the first run finishes the API answers NO_REPORT_AVAILABLE (an honest empty
// state, never invented figures). Failures are logged as one truncated line and never stop the server; the previous snapshot stays.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function runReportOnce({ spawnFn = spawn, cwd = ROOT, log = console.log } = {}) {
  return new Promise((resolve) => {
    const child = spawnFn(process.execPath, ['src/report/index.js', 'report'], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('error', (e) => { log(`report refresh could not start: ${String(e.message).slice(0, 160)}`); resolve(false); });
    child.on('close', (code) => {
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
