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
import { createFilePhotoStore } from '../store/photo-store.js';
import { createFileWorkspaceStore } from '../store/workspace-store.js';
import { loadMerchantProfile } from './merchant-profile.js';
import { createSafetyGateAdapter } from '../adapters/safety-gate.js';
import { fetchEcb } from '../adapters/fx.js';
import { createDisabledProvider, createVisionProvider } from '../adapters/ai-provider.js';
import { assertSourcingRuntime } from '../runtime.js';
import { hostedConfig, isHosted } from './hosted.js';
import { createSessionGate } from './session-gate.js';
import { createIdentityService, loadIdentityServiceEnv } from '../../identity/service.js';
import { createHttpSecurity } from '../../security/index.js';
import { createSupabaseClient, loadSupabaseConfigFromEnv } from '../../supabase/client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = 'data/local/sourcing';

async function ensureToken(env, dir) {
  if (env.SOURCING_TOKEN && env.SOURCING_TOKEN.length >= 24) return env.SOURCING_TOKEN;
  const file = join(dir, 'token.txt');
  try { const t = (await readFile(file, 'utf8')).trim(); if (t.length >= 24) return t; } catch { /* first run */ }
  const t = randomBytes(24).toString('hex'); await writeFile(file, `${t}\n`); return t;
}

/** The hosted sign-in: Core identity ('sourcing' module of THIS merchant) + Core HTTP security behind Railway. `services` lets a test inject both. */
export function buildHostedGate(env, hosted, services = null) {
  const identity = services?.identity ?? createIdentityService({ merchantId: hosted.merchantId, moduleCode: 'sourcing', supabase: createSupabaseClient(loadSupabaseConfigFromEnv(env)), ...loadIdentityServiceEnv(env) });
  const security = services?.security ?? createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: hosted.allowedHosts, allowedOrigins: [hosted.origin], moduleCode: 'sourcing', csrfKey: env.NORDLA_CSRF_KEY, rateLimitKey: env.NORDLA_IDENTITY_RATE_LIMIT_KEY });
  return createSessionGate({ identity, security });
}

export async function startSourcingServer({ env = process.env, log = console.log, port = Number(env.SOURCING_PORT || 8787), dir = DATA_DIR, fetchImpl, ecb = () => fetchEcb(), allowedHosts = [], services = null } = {}) {
  assertSourcingRuntime(); // China Sourcing requires Node 24
  const hosted = isHosted(env) ? hostedConfig(env) : null; // SOURCING_HOSTED=1: complete configuration or nothing starts (src/sourcing/server/hosted.js)
  if (hosted) { dir = hosted.dataDir; for (const h of hosted.allowedHosts) if (!allowedHosts.includes(h)) allowedHosts.push(h); }
  const host = hosted ? hosted.host : env.SOURCING_HOST || '127.0.0.1';
  await mkdir(dir, { recursive: true });
  const gate = hosted ? buildHostedGate(env, hosted, services) : null; // hosted: the Core identity is the ONLY sign-in (no development token)
  const token = gate ? null : await ensureToken(env, dir);
  const safety = createSafetyGateAdapter({ cacheDir: join(dir, 'safety-gate'), ...(fetchImpl ? { fetchImpl } : {}) });
  const mp = await loadMerchantProfile(env, join(HERE, '..', '..', '..')); const merchantProfile = mp.profile; // explicit choice (SOURCING_MERCHANT_ID / SOURCING_MERCHANT_PROFILE): no merchant is named in this code
  const app = createSourcingApp({ gate, workspace: createFileWorkspaceStore(join(dir, 'cases')), merchantProfile, voiceDir: env.SOURCING_VOICE_DIR || join(HERE, '..', '..', '..', 'data', 'local', 'voice-bench'), token, store: createFileStore(join(dir, 'cases')), photos: createFilePhotoStore(join(dir, 'photos')), safety, ecb, ai: env.SOURCING_VISION_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY ? createVisionProvider({ apiKey: env.ANTHROPIC_API_KEY }) : createDisabledProvider(), allowedHosts: (() => { for (const h of (env.SOURCING_ALLOWED_HOSTS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) if (!allowedHosts.includes(h)) allowedHosts.push(h); return allowedHosts; })(), uiDir: join(HERE, '..', 'ui'), coreDir: join(HERE, '..', 'core') });
  const server = http.createServer(app.handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const addr = server.address();
  log(`China Sourcing field mode: http://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}   (${hosted ? `HOSTED for ${hosted.origin}: Core identity sign-in (module sourcing, merchant ${hosted.merchantId}), no development token` : host === '127.0.0.1' ? 'loopback only' : `listening on ${host}: token required`})`);
  log(merchantProfile ? `Merchant profile: ${merchantProfile.merchantId} (${mp.source === 'FILE' ? 'file' : 'config/merchants'}), status ${merchantProfile.status ?? 'n/a'}` : `No merchant profile loaded${mp.error ? ` (${mp.error})` : ''}: the fit checklist will say so. Set SOURCING_MERCHANT_ID to choose one.`);
  log(`Access: ${hosted ? 'Nordla session (sign-in)' : env.SOURCING_TOKEN && env.SOURCING_TOKEN.length >= 24 ? 'token from SOURCING_TOKEN' : `token in ${join(dir, 'token.txt')}`} (never printed). Cases: ${join(dir, 'cases')}. Nothing is published or sent anywhere.`);
  return { server, token, safety, port: addr.port };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { safety } = await startSourcingServer();
  safety.refresh({ maxReports: Number(process.env.SOURCING_SAFETY_REPORTS || 26) }).then((r) => console.log(r.ok ? `Safety Gate cache refreshed (${r.added} new report(s)).` : `Safety Gate refresh failed (${r.error}): cached data, if any, stays CACHED - never shown as live.`));
}
