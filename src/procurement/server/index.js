#!/usr/bin/env node
// Stock / Achats mobile server launcher:  npm run procurement
//
// Local by default: listens on 127.0.0.1 only and keeps its data in data/local/procurement (git-ignored):
//   procurement.json   the durable store (atomic writes; refuses to start over a corrupt file)
//   users.json         personal access tokens, created on first start (owner who can approve, field buyer who cannot)
//   merchant-id.txt    this store's merchant id (NORDLA_MERCHANT_ID overrides it)
//   uploads/           photos, named by their SHA-256
// It never pays, never writes to Shopify, never messages a supplier. PROCUREMENT_PG_URL selects PostgreSQL instead of the file (needs the `pg` package,
// a deployment step that is not part of this repository's dependencies yet).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProcurement, openFileProcurementStore, createPgProcurementStore } from '../index.js';
import { createProcurementApp, listen } from './app.js';

export const DATA_DIR = 'data/local/procurement';

async function loadUsers(dir, env) {
  if (env.PROCUREMENT_USERS) return { users: JSON.parse(env.PROCUREMENT_USERS), created: false, file: null };
  const file = join(dir, 'users.json');
  try { return { users: JSON.parse(await readFile(file, 'utf8')), created: false, file }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const users = [
    { id: 'owner', name: 'Propriétaire', role: 'OWNER', canApprove: true, approverRole: 'OWNER', token: randomBytes(24).toString('hex') },
    { id: 'terrain', name: 'Terrain (achats)', role: 'BUYER', canApprove: false, token: randomBytes(24).toString('hex') },
  ];
  await writeFile(file, JSON.stringify(users, null, 2), { flag: 'wx' });
  return { users, created: true, file };
}

/** @returns {Promise<{ server, port, host, users, store, dataDir, stop: () => Promise<void> }>} */
export async function startProcurementServer({ env = process.env, log = console.log, port, host, allowedHosts = [], dataDir = resolve(env.PROCUREMENT_DATA_DIR ?? DATA_DIR) } = {}) {
  await mkdir(dataDir, { recursive: true });
  const { users, created, file } = await loadUsers(dataDir, env);
  let merchantId = env.NORDLA_MERCHANT_ID;
  if (!merchantId) {
    const f = join(dataDir, 'merchant-id.txt');
    try { merchantId = (await readFile(f, 'utf8')).trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; merchantId = randomUUID(); await writeFile(f, merchantId); }
  }
  let store;
  if (env.PROCUREMENT_PG_URL) {
    let pg; try { pg = (await import('pg')).default; } catch { throw new Error('PROCUREMENT_PG_URL is set but the `pg` package is not installed in this project: adding it is a deployment decision. Use the file store (unset PROCUREMENT_PG_URL) until then.'); }
    store = createPgProcurementStore({ pool: new pg.Pool({ connectionString: env.PROCUREMENT_PG_URL, max: 6 }) });
  } else store = await openFileProcurementStore({ path: join(dataDir, 'procurement.json') });
  const procurement = createProcurement({ store, merchantId });
  const system = { id: 'system', role: 'OWNER' };
  await procurement.commands.createLocation(system, 'bootstrap:loc-main', { name: 'Réception (par défaut)', type: 'WAREHOUSE' }).catch((e) => { if (e.code !== 'UNIQUE_VIOLATION') throw e; });
  await procurement.commands.createLocation(system, 'bootstrap:loc-quarantine', { name: 'Quarantaine', type: 'QUARANTINE' }).catch((e) => { if (e.code !== 'UNIQUE_VIOLATION') throw e; });
  const hosts = [...allowedHosts, ...(env.PROCUREMENT_ALLOWED_HOSTS ?? '').split(',').map((x) => x.trim()).filter(Boolean)];
  const handler = createProcurementApp({ procurement, users, sourcingDir: resolve(env.SOURCING_CASES_DIR ?? 'data/local/sourcing/cases'), uploadsDir: join(dataDir, 'uploads'), allowedHosts: hosts, cacheAssets: env.PROCUREMENT_DEV !== '1' });
  const listening = await listen(handler, { host: host ?? env.PROCUREMENT_HOST ?? '127.0.0.1', port: port ?? Number(env.PROCUREMENT_PORT ?? 8975) });
  const stop = async () => { await new Promise((r) => listening.server.close(r)); await store.close?.(); };
  if (created) log(`First start: access tokens were created in ${file} (keep that file private).`);
  return { ...listening, host: host ?? env.PROCUREMENT_HOST ?? '127.0.0.1', users, store, dataDir, merchantId, allowedHosts: hosts, stop };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const s = await startProcurementServer();
  const who = s.users.map((u) => `  ${u.name ?? u.id}${u.canApprove ? ' (can approve)' : ''}: http://127.0.0.1:${s.port}/#t=${u.token}`).join('\n');
  console.log(`\nStock / Achats is running on this computer only (http://127.0.0.1:${s.port}).\nOpen the link of the person using it (the token after # is never sent to a server and is removed from the address bar):\n${who}\n\nData: ${s.dataDir}\nFor a phone: npm run procurement:phone (HTTPS tunnel, needs cloudflared). Ctrl+C to stop.`);
  process.on('SIGINT', async () => { await s.stop(); process.exit(0); });
}
