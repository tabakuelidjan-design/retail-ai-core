#!/usr/bin/env node
// Launch the China Sourcing field mode:  npm run sourcing
// Binds 127.0.0.1 by default. To use it from a phone on your own network set SOURCING_HOST (e.g. 0.0.0.0): a token of 24+ characters is then mandatory.
// Nothing is deployed, nothing is sent to Shopify/Supabase; cases are local files under data/local/sourcing.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSourcingApp } from './app.js';
import { createFileStore } from '../store/file-store.js';
import { createSafetyGateAdapter } from '../adapters/safety-gate.js';
import { fetchEcb } from '../adapters/fx.js';
import { createDisabledProvider } from '../adapters/ai-provider.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = 'data/local/sourcing';

async function ensureToken(env, dir) {
  if (env.SOURCING_TOKEN && env.SOURCING_TOKEN.length >= 24) return env.SOURCING_TOKEN;
  const file = join(dir, 'token.txt');
  try { const t = (await readFile(file, 'utf8')).trim(); if (t.length >= 24) return t; } catch { /* first run */ }
  const t = randomBytes(24).toString('hex'); await writeFile(file, `${t}\n`); return t;
}

export async function startSourcingServer({ env = process.env, log = console.log, port = Number(env.SOURCING_PORT || 8787), dir = DATA_DIR, fetchImpl, ecb = () => fetchEcb() } = {}) {
  const host = env.SOURCING_HOST || '127.0.0.1';
  await mkdir(dir, { recursive: true });
  const token = await ensureToken(env, dir);
  const safety = createSafetyGateAdapter({ cacheDir: join(dir, 'safety-gate'), ...(fetchImpl ? { fetchImpl } : {}) });
  const app = createSourcingApp({ token, store: createFileStore(join(dir, 'cases')), safety, ecb, ai: createDisabledProvider(), uiDir: join(HERE, '..', 'ui'), coreDir: join(HERE, '..', 'core') });
  const server = http.createServer(app.handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const addr = server.address();
  log(`China Sourcing field mode: http://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}   (${host === '127.0.0.1' ? 'loopback only' : `listening on ${host}: token required`})`);
  log(`Access token: ${join(dir, 'token.txt')} (never printed). Cases: ${join(dir, 'cases')}. Nothing is published or sent anywhere.`);
  return { server, token, safety, port: addr.port };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { safety } = await startSourcingServer();
  safety.refresh({ maxReports: 12 }).then((r) => console.log(r.ok ? `Safety Gate cache refreshed (${r.added} new report(s)).` : `Safety Gate refresh failed (${r.error}): cached data, if any, stays CACHED - never shown as live.`));
}
