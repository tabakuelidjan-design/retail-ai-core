#!/usr/bin/env node
// Launch the China Sourcing field mode:  npm run sourcing
// Binds 127.0.0.1 by default. To use it from a phone on your own network set SOURCING_HOST (e.g. 0.0.0.0): a token of 24+ characters is then mandatory.
// Nothing is deployed, nothing is sent to Shopify/Supabase; cases are local files under data/local/sourcing.
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, stat, statfs, writeFile } from 'node:fs/promises';
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
import { loadCoreConfig } from '../../core-pilot/config.js';
import { createFileJournal } from '../../core-pilot/journal.js';
import { createCoreRuntime } from '../../core-pilot/runtime.js';
import { createCoreHttp } from '../../core-pilot/http.js';

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

/** Nordla Core on this server: the merchant's core-decision.json + the decision journal in the data directory. Any problem (no config,
 *  a journal that does not verify) disables the Core with its reason and leaves China Sourcing working; the journal is never touched. */
export async function buildCore({ env, dir, merchantId, store, safety, root = join(HERE, '..', '..', '..') }) {
  const { config, error } = await loadCoreConfig(env, root);
  if (!config) return { core: createCoreHttp({ runtime: null, configError: `CORE_NOT_CONFIGURED: ${error}`, store }), status: `Nordla Core OFF (${error})` };
  const runtime = createCoreRuntime({ merchantId, config, journal: createFileJournal({ merchantId, file: join(dir, 'core', 'decision-journal.jsonl') }) });
  try { await runtime.ready(); } catch (e) { return { core: createCoreHttp({ runtime: null, configError: e.code ? `${e.code}: ${e.message}` : 'JOURNAL_UNREADABLE', store }), status: `Nordla Core OFF: ${e.message}` }; }
  const externals = async () => { try { const g = await safety.get(); return g?.alerts ? { safety: g } : {}; } catch { return {}; } };
  return { core: createCoreHttp({ runtime, store, externals }), status: `Nordla Core ON for merchant ${merchantId} (owner rules: ${config.ownerRules.length || 'none configured'})` };
}

export async function startSourcingServer({ env = process.env, log = console.log, port = Number(env.SOURCING_PORT || (isHosted(env) ? env.PORT : '') || 8787), dir = DATA_DIR, fetchImpl, ecb = () => fetchEcb(), allowedHosts = [], services = null } = {}) {
  assertSourcingRuntime(); // China Sourcing requires Node 24
  const hosted = isHosted(env) ? hostedConfig(env) : null; // SOURCING_HOSTED=1: complete configuration or nothing starts (src/sourcing/server/hosted.js)
  if (hosted) { dir = hosted.dataDir; for (const h of hosted.allowedHosts) if (!allowedHosts.includes(h)) allowedHosts.push(h); }
  const host = hosted ? hosted.host : env.SOURCING_HOST || '127.0.0.1';
  await mkdir(dir, { recursive: true });
  const gate = hosted ? buildHostedGate(env, hosted, services) : null; // hosted: the Core identity is the ONLY sign-in (no development token)
  const token = gate ? null : await ensureToken(env, dir);
  const safety = createSafetyGateAdapter({ cacheDir: join(dir, 'safety-gate'), ...(fetchImpl ? { fetchImpl } : {}) });
  const mp = await loadMerchantProfile(env, join(HERE, '..', '..', '..')); const merchantProfile = mp.profile; // explicit choice (SOURCING_MERCHANT_ID / SOURCING_MERCHANT_PROFILE): no merchant is named in this code
  const store = createFileStore(join(dir, 'cases'));
  const core = await buildCore({ env, dir, merchantId: hosted ? hosted.merchantId : merchantProfile?.merchantId ?? 'local', store, safety });
  const app = createSourcingApp({ gate, core: core.core, workspace: createFileWorkspaceStore(join(dir, 'cases')), merchantProfile, voiceDir: env.SOURCING_VOICE_DIR || join(HERE, '..', '..', '..', 'data', 'local', 'voice-bench'), token, store, photos: createFilePhotoStore(join(dir, 'photos')), safety, ecb, ai: env.SOURCING_VISION_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY ? createVisionProvider({ apiKey: env.ANTHROPIC_API_KEY }) : createDisabledProvider(), allowedHosts: (() => { for (const h of (env.SOURCING_ALLOWED_HOSTS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) if (!allowedHosts.includes(h)) allowedHosts.push(h); return allowedHosts; })(), uiDir: join(HERE, '..', 'ui'), coreDir: join(HERE, '..', 'core') });
  const server = http.createServer(app.handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const addr = server.address();
  log(`China Sourcing field mode: http://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}   (${hosted ? `HOSTED for ${hosted.origin}: Core identity sign-in (module sourcing, merchant ${hosted.merchantId}), no development token` : host === '127.0.0.1' ? 'loopback only' : `listening on ${host}: token required`})`);
  log(merchantProfile ? `Merchant profile: ${merchantProfile.merchantId} (${mp.source === 'FILE' ? 'file' : 'config/merchants'}), status ${merchantProfile.status ?? 'n/a'}` : `No merchant profile loaded${mp.error ? ` (${mp.error})` : ''}: the fit checklist will say so. Set SOURCING_MERCHANT_ID to choose one.`);
  log(core.status);
  log(`Process: Node ${process.versions.node}, uid ${process.getuid?.() ?? 'n/a'}${process.getuid?.() === 0 ? ' (ROOT: the image entrypoint was bypassed - see deploy/sourcing/Dockerfile)' : ''}, data ${dir}.`);
  log(`Access: ${hosted ? 'Nordla session (sign-in)' : env.SOURCING_TOKEN && env.SOURCING_TOKEN.length >= 24 ? 'token from SOURCING_TOKEN' : `token in ${join(dir, 'token.txt')}`} (never printed). Cases: ${join(dir, 'cases')}. Nothing is published or sent anywhere.`);
  const backups = scheduleBackups({ env, dir, log });
  server.on('close', () => backups.stop());
  return { server, token, safety, port: addr.port, backups };
}

async function dirBytes(d) { let n = 0; for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) { const p = join(d, e.name); n += e.isDirectory() ? await dirBytes(p) : (await stat(p).catch(() => ({ size: 0 }))).size; } return n; }

/** Daily encrypted backup of the whole data directory (cases, photos, Core journal) + its off-server copy, when configured
 *  (SOURCING_BACKUP_PASSPHRASE + SOURCING_BACKUP_BUCKET + SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Local archives go to
 *  SOURCING_BACKUP_DIR (default: next to the data directory, never inside it). A failure is logged and retried next run: it never stops
 *  the service and never touches the data. Without that configuration nothing runs and the log says so. */
export function scheduleBackups({ env, dir, log, run = null, firstDelayMs = 10 * 60_000, everyMs = 24 * 3600_000 }) {
  if (!String(env.SOURCING_BACKUP_PASSPHRASE ?? '').trim() || !String(env.SOURCING_BACKUP_BUCKET ?? '').trim()) { log('Backups: NOT scheduled (SOURCING_BACKUP_PASSPHRASE / SOURCING_BACKUP_BUCKET not set).'); return { stop: () => {}, runNow: async () => null }; }
  const out = String(env.SOURCING_BACKUP_DIR ?? '').trim() || join(dir, '..', 'sourcing-backups');
  // the local copies share the data volume (1 GB on the pilot): few of them (history lives off-server), and never when they could fill it
  const keep = Math.min(30, Math.max(1, Number.parseInt(env.SOURCING_BACKUP_KEEP ?? '3', 10) || 3));
  const once = run ?? (async () => {
    const size = await dirBytes(dir); const fs = await statfs(dir);
    const free = fs.bavail * fs.bsize; const need = 2 * size + 64 * 1024 * 1024; // the new archive (compressed, <= size) + head room
    if (free < need) throw Object.assign(new Error(`not enough free space on the volume (${Math.round(free / 1e6)} MB free, ${Math.round(need / 1e6)} MB needed): nothing written; enlarge the volume or lower SOURCING_BACKUP_KEEP`), { code: 'BACKUP_LOW_SPACE' });
    return (await import('../../../tools/sourcing-backup.mjs')).backupAndShip(dir, out, { env, keep });
  });
  const runNow = async () => { try { const r = await once(); log(`Backup OK: ${r.files} file(s), copied off-server as ${r.offsite}.`); return r; } catch (e) { log(`Backup FAILED (${e.code ?? 'ERROR'}): ${e.message} - retried at the next run; the data is untouched.`); return null; } };
  const first = setTimeout(runNow, firstDelayMs); const every = setInterval(runNow, everyMs); first.unref?.(); every.unref?.();
  log(`Backups: every ${Math.round(everyMs / 3600_000)} h, first in ${Math.round(firstDelayMs / 60_000)} min, ${keep} local copies in ${out}, off-server bucket ${env.SOURCING_BACKUP_BUCKET}.`);
  return { stop: () => { clearTimeout(first); clearInterval(every); }, runNow };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { safety } = await startSourcingServer();
  safety.refresh({ maxReports: Number(process.env.SOURCING_SAFETY_REPORTS || 26) }).then((r) => console.log(r.ok ? `Safety Gate cache refreshed (${r.added} new report(s)).` : `Safety Gate refresh failed (${r.error}): cached data, if any, stays CACHED - never shown as live.`));
}
