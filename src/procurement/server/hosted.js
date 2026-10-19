// Stock / Achats MOUNTED on the Nordla server (hosted or local PC): one process, one sign-in, one volume.
//  - the API lives under /api/procurement/* of the China Sourcing server (src/sourcing/server/app.js delegates there AFTER it has authenticated the
//    person, checked the CSRF token on a change and the module access) - this module reads no token and has no login of its own;
//  - data: <data dir>/procurement/procurement.json (file store), inside the volume that is backed up with the cases and the Core journal;
//  - Sourcing cases are read from the SAME directory the Sourcing server writes (<data dir>/cases): no copy, no second source of truth;
//  - nothing here pays, writes to Shopify or messages a supplier. Approving / ordering is the signed-in OWNER's named approval, built by the server.
// Failure isolation: if the store cannot open, `buildHostedProcurement` returns { handler: null, assistant: null, status } and the rest of Nordla keeps running.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createProcurement, openFileProcurementStore, createPgProcurementStore } from '../../procurement/index.js';
import { createProcurementApp } from '../../procurement/server/app.js';
import { SERVER_POLICY, GRANTS, capabilitiesOf } from './permissions.js';

/** Core identity roles -> procurement roles. Least privilege: only the owner approves or orders; an accountant or a viewer reads. */
export const PROCUREMENT_ROLE = Object.freeze({ OWNER: 'OWNER', ADMIN: 'BUYER', COLLABORATOR: 'WAREHOUSE', VIEWER: 'VIEWER', ACCOUNTANT: 'VIEWER' });

/**
 * Explicit authorizations the OWNER gave to named people: PROCUREMENT_GRANTS='{"<userId>":["RECEIVE","ADJUST"]}' (RECEIVE = goods receipt, transfers, count entry, filing stock changes;
 * ADJUST = deciding stock changes; APPROVE_PO = approving / placing orders). Anything else, an unknown grant or a malformed value is refused at start: nobody is granted by accident.
 */
export function parseGrants(raw) {
  const out = new Map(); if (raw == null || String(raw).trim() === '') return out;
  let obj; try { obj = JSON.parse(String(raw)); } catch { throw Object.assign(new Error('PROCUREMENT_GRANTS is not valid JSON'), { code: 'GRANTS_INVALID' }); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw Object.assign(new Error('PROCUREMENT_GRANTS must be an object { userId: [grants] }'), { code: 'GRANTS_INVALID' });
  for (const [id, list] of Object.entries(obj)) {
    if (!Array.isArray(list) || list.some((g) => !GRANTS.includes(g))) throw Object.assign(new Error(`PROCUREMENT_GRANTS: unknown grant for ${id} (allowed: ${GRANTS.join(', ')})`), { code: 'GRANTS_INVALID' });
    out.set(id, new Set(list));
  }
  return out;
}
let configuredGrants = new Map(); // set once by buildHostedProcurement; src/sourcing/server/app.js calls procurementUserFor(actor) with one argument

/** The user the procurement API sees, built from the server's own authenticated actor (never from the request). null = no access. */
export function procurementUserFor(actor, grants = configuredGrants) {
  const role = PROCUREMENT_ROLE[String(actor?.role ?? '')];
  if (!role) return null;
  const id = String(actor.userId ?? actor.label ?? '').trim();
  if (!id) return null;
  const owner = role === 'OWNER'; const given = [...(grants.get(id) ?? [])];
  const user = { id, role, name: owner ? 'Propriétaire' : id, grants: given, ...(owner ? { approverRole: 'OWNER' } : {}) };
  return { ...user, canApprove: capabilitiesOf(user).canApprove };
}

/** @returns {Promise<{ handler: Function|null, assistant: object|null, procurement: object|null, status: string }>} */
export async function buildHostedProcurement({ dir, merchantId, env = process.env, log = () => {}, pgPool = null, lease = undefined }) {
  let closeStore = async () => {}; let offSignals = () => {};
  // kill switch: PROCUREMENT_DISABLED=1 turns the module OFF at start (no file opened, no route, no screen) - a rollback that needs no redeploy and touches no data
  if (String(env.PROCUREMENT_DISABLED ?? '') === '1') { log('Stock / Achats: DISABLED by PROCUREMENT_DISABLED=1 (data untouched).'); return { handler: null, assistant: null, procurement: null, store: null, close: async () => {}, status: 'Stock / Achats OFF (DISABLED)' }; }
  try {
    const base = join(dir, 'procurement');
    await mkdir(base, { recursive: true });
    configuredGrants = parseGrants(env.PROCUREMENT_GRANTS);
    let store; let where;
    if (env.PROCUREMENT_PG_URL || pgPool) { // PostgreSQL ONLY when the operator asks for it; a failure never falls back to the file (that would split the data in two)
      let pool = pgPool; // an injected pool (the PostgreSQL smoke tests) or the operator's connection string
      if (!pool) {
        let pg; try { pg = (await import('pg')).default; } catch { throw Object.assign(new Error('PROCUREMENT_PG_URL is set but the "pg" package is not installed'), { code: 'PG_DRIVER_MISSING' }); }
        pool = new pg.Pool({ connectionString: env.PROCUREMENT_PG_URL, max: Number(env.PROCUREMENT_PG_POOL_MAX ?? 5) }); closeStore = () => pool.end();
      }
      store = createPgProcurementStore({ pool }); where = 'PostgreSQL';
    } else {
      // On a Railway volume (or PROCUREMENT_LOCK_LEASE=1) the file's write lock is a LEASE (heartbeat), not a process id: see src/procurement/file-store.js.
      const useLease = lease !== undefined ? lease : (String(env.RAILWAY_VOLUME_MOUNT_PATH ?? '').trim() || env.PROCUREMENT_LOCK_LEASE === '1') ? true : null;
      store = await openFileProcurementStore({ path: join(base, 'procurement.json'), lease: useLease }); where = join(base, 'procurement.json');
      closeStore = async () => { offSignals(); await store.close(); };
      if (useLease) { // a clean stop (SIGTERM from the host) releases the lease at once; a crash is covered by the staleness rule
        const onSignal = (sig) => { closeStore().catch(() => {}).finally(() => process.kill(process.pid, sig)); };
        const sigs = ['SIGTERM', 'SIGINT']; for (const sig of sigs) process.once(sig, onSignal);
        offSignals = () => { for (const sig of sigs) process.removeListener(sig, onSignal); };
      }
    }
    const procurement = createProcurement({ store, merchantId, policy: SERVER_POLICY });
    const system = { id: 'system', role: 'OWNER' };
    const have = new Set((await procurement.queries.locations()).map((l) => l.type));
    const boot = async (type, name) => { if (!have.has(type)) await procurement.commands.createLocation(system, `bootstrap:${type.toLowerCase()}:${merchantId}`, { name, type }).catch((e) => { if (e.code !== 'UNIQUE_VIOLATION') throw e; }); };
    await boot('WAREHOUSE', 'Réception (par défaut)'); await boot('QUARANTINE', 'Quarantaine');
    const handler = createProcurementApp({ procurement, users: [], sourcingDir: join(dir, 'cases'), uploadsDir: join(base, 'uploads'), allowedHosts: [], cacheAssets: env.PROCUREMENT_DEV !== '1' });
    return { handler, assistant: procurement.assistant, procurement, store, close: closeStore, status: `Stock / Achats ON (${where}; ${configuredGrants.size} authorization(s) granted)` };
  } catch (e) {
    try { await closeStore(); } catch { /* nothing to release */ }
    log(`Stock / Achats: NOT mounted (${e.code ?? 'ERROR'}: ${String(e.message ?? '').slice(0, 200)}). The rest of Nordla is unaffected.`);
    return { handler: null, assistant: null, procurement: null, store: null, close: async () => {}, status: `Stock / Achats OFF (${e.code ?? 'ERROR'})` };
  }
}
