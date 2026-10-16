#!/usr/bin/env node
// Launch the HABB social publishing app:  npm run social
//
//   SOCIAL_MODE=none (default)  no platform is called: posts can be prepared, reviewed, approved, scheduled - and published BY HAND (manual pack).
//   SOCIAL_MODE=simulate        demo publishers that publish NOTHING; results are labelled SIMULÉ and can never be verified.
//   SOCIAL_MODE=live            real publishers. Needs the env names listed in docs/runbooks/social-go-live.md, SOCIAL_GRAPH_VERSION and
//                               SOCIAL_MEDIA_BASE_URL (public, content-addressed). Nothing here has ever been run against a real account.
//
// Binds 127.0.0.1 unless SOCIAL_HOST says otherwise (a token of 24+ characters is always required). Nothing is deployed, nothing is sent
// anywhere by starting it. Posts live as local files under data/local/social.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAssetLibrary, createPublicMediaResolver } from '../assets.js';
import { createEnvCredentialPort } from '../credentials.js';
import { createPublisher } from '../publisher.js';
import { createFacebookPagePublisher, createInstagramPublisher } from '../providers/meta.js';
import { createSimulatedPublisher } from '../providers/simulated.js';
import { createSocialService } from '../service.js';
import { createFileStore } from '../store.js';
import { createFetchHttp } from '../../activation/providers/http.js';
import { createSocialApp } from './app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = 'data/local/social';

async function ensureToken(env, dir) {
  if (env.SOCIAL_TOKEN && env.SOCIAL_TOKEN.length >= 24) return env.SOCIAL_TOKEN;
  const file = join(dir, 'token.txt');
  try { const t = (await readFile(file, 'utf8')).trim(); if (t.length >= 24) return t; } catch { /* first run */ }
  const t = randomBytes(24).toString('hex');
  await writeFile(file, `${t}\n`);
  return t;
}

export function buildPublishers({ env, credentialPort, fetchImpl = globalThis.fetch }) {
  const mode = env.SOCIAL_MODE || 'none';
  if (mode === 'none') return { publishers: {}, media: null };
  if (mode === 'simulate') {
    return { publishers: { instagram: createSimulatedPublisher('instagram'), facebook: createSimulatedPublisher('facebook', { nativeScheduling: true }) }, media: { async resolve(a) { return { url: 'https://simulation.invalid/x', content_type: a.content_type, sha256: a.sha256 }; } } };
  }
  if (mode !== 'live') throw new Error('SOCIAL_MODE must be none | simulate | live');
  if (!env.SOCIAL_GRAPH_VERSION) throw new Error('live mode: set SOCIAL_GRAPH_VERSION (for example v25.0) - the API version is configuration, not a default');
  if (!env.SOCIAL_MEDIA_BASE_URL) throw new Error('live mode: set SOCIAL_MEDIA_BASE_URL (the public https folder that serves <sha256>.<ext>)');
  const http = createFetchHttp({ fetch: fetchImpl });
  const credentials = { resolve: (platform) => credentialPort.resolve(platform) };
  const publishers = {};
  if (credentialPort.describe('instagram').configured) publishers.instagram = createInstagramPublisher({ http, graphVersion: env.SOCIAL_GRAPH_VERSION, credentials, timeoutMs: 20_000 });
  if (credentialPort.describe('facebook').configured) publishers.facebook = createFacebookPagePublisher({ http, graphVersion: env.SOCIAL_GRAPH_VERSION, credentials, timeoutMs: 20_000 });
  return { publishers, media: createPublicMediaResolver({ baseUrl: env.SOCIAL_MEDIA_BASE_URL, fetch: fetchImpl }) };
}

async function loadConfirmedFacts(dir) {
  // the owner's registry of facts he confirmed (a price, an opening hour...). Absent file = nothing is confirmed = every price is blocked.
  try { return JSON.parse(await readFile(join(dir, 'confirmed-facts.json'), 'utf8')).facts ?? []; } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

export async function startSocialServer({
  env = process.env, log = console.log, port = Number(env.SOCIAL_PORT || 8980), dir = env.SOCIAL_DATA_DIR || DATA_DIR, fetchImpl, tickMs = 60_000,
} = {}) {
  const host = env.SOCIAL_HOST || '127.0.0.1';
  await mkdir(dir, { recursive: true });
  const token = await ensureToken(env, dir);
  const credentialPort = createEnvCredentialPort(env);
  const { publishers, media } = buildPublishers({ env, credentialPort, fetchImpl });
  const confirmedFacts = await loadConfirmedFacts(dir);
  const service = createSocialService({ store: createFileStore(dir), publishers, confirmedFacts });
  const publisher = createPublisher({ service, publishers, media, logger: (l) => log(JSON.stringify(l)) });
  const assets = createAssetLibrary(join(dir, 'assets'));
  const connections = async () => ['instagram', 'facebook'].map((platform) => ({
    ...credentialPort.describe(platform), mode: publishers[platform]?.mode ?? null, connected: Boolean(publishers[platform]),
    capabilities: publishers[platform]?.capabilities ?? null, live_checked: false,
  }));
  const app = createSocialApp({ token, service, publisher, publishers, assets, credentialPort, uiDir: join(HERE, '..', 'ui'), connections });
  const server = http.createServer(app.handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const timer = setInterval(() => { publisher.runDue().catch((e) => log(`publisher pass failed: ${e.code ?? e.name}`)); }, tickMs);
  timer.unref();
  server.once('close', () => clearInterval(timer));
  const addr = server.address();
  log(`HABB social publishing: http://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}  mode=${env.SOCIAL_MODE || 'none'}  (${host === '127.0.0.1' ? 'loopback only' : `listening on ${host}`}; token required)`);
  log(`Access token: ${join(dir, 'token.txt')} (never printed). Posts: ${join(dir, 'posts')}. Audit: ${join(dir, 'audit.jsonl')}.`);
  if ((env.SOCIAL_MODE || 'none') === 'none') log('No platform is connected: nothing will be published automatically. Use the manual pack on each approved post.');
  return { server, token, port: addr.port, service, publisher, close: () => new Promise((r) => { clearInterval(timer); server.close(r); }) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await startSocialServer();
