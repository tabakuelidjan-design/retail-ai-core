#!/usr/bin/env node
// The ONE start command of every Nordla service deployed from this repository (railway.json and railpack.json both run it).
// Which service a deployment runs is an explicit, required variable - NORDLA_SERVICE - never implied by a config file:
//   core      -> the Shopify sync scheduler           (src/sync/scheduler.js)
//   finance   -> the Finance dashboard server          (src/finance/server/index.js)
//   analytics -> the Analytics Premium server          (src/analytics-premium/server/serve.js)
// Missing or unknown -> the process refuses to start (exit 1) and nothing runs: a service can never start another service's program
// by accident (e.g. an Analytics service running the Core sync because a shared config file said so).

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SERVICE_ENTRIES = Object.freeze({
  core: 'src/sync/scheduler.js',
  finance: 'src/finance/server/index.js',
  analytics: 'src/analytics-premium/server/serve.js',
});
export const SERVICE_ENV = 'NORDLA_SERVICE';

export class ServiceStartError extends Error {}

/** The entry file for this deployment's NORDLA_SERVICE; throws ServiceStartError when it is missing or unknown. */
export function resolveServiceEntry(env = process.env) {
  const name = String(env[SERVICE_ENV] ?? '').trim().toLowerCase();
  if (!name) throw new ServiceStartError(`${SERVICE_ENV} is not set: this deployment does not say which Nordla service it is (${Object.keys(SERVICE_ENTRIES).join(', ')}). Nothing was started.`);
  const entry = SERVICE_ENTRIES[name];
  if (!entry) throw new ServiceStartError(`${SERVICE_ENV}="${name}" is not a Nordla service (${Object.keys(SERVICE_ENTRIES).join(', ')}). Nothing was started.`);
  return { name, entry };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let target;
  try { target = resolveServiceEntry(); } catch (e) { console.error(`service start refused: ${e.message}`); process.exit(1); }
  console.log(`Nordla service: ${target.name} (${target.entry})`);
  // The service runs as a child with the same environment and stdio; signals are forwarded and its exit code is ours.
  const child = spawn(process.execPath, [target.entry], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: process.env, stdio: 'inherit' });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on('error', (e) => { console.error(`service start failed: ${e.message}`); process.exit(1); });
}
