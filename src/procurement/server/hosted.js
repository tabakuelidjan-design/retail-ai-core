// Stock / Achats MOUNTED on the Nordla server (hosted or local PC): one process, one sign-in, one volume.
//  - the API lives under /api/procurement/* of the China Sourcing server (src/sourcing/server/app.js delegates there AFTER it has authenticated the
//    person, checked the CSRF token on a change and the module access) - this module reads no token and has no login of its own;
//  - data: <data dir>/procurement/procurement.json (file store), inside the volume that is backed up with the cases and the Core journal;
//  - Sourcing cases are read from the SAME directory the Sourcing server writes (<data dir>/cases): no copy, no second source of truth;
//  - nothing here pays, writes to Shopify or messages a supplier. Approving / ordering is the signed-in OWNER's named approval, built by the server.
// Failure isolation: if the store cannot open, `buildHostedProcurement` returns { handler: null, assistant: null, status } and the rest of Nordla keeps running.
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createProcurement, openFileProcurementStore } from '../../procurement/index.js';
import { createProcurementApp } from '../../procurement/server/app.js';

/** Core identity roles -> procurement roles. Least privilege: only the owner approves or orders; an accountant or a viewer reads. */
export const PROCUREMENT_ROLE = Object.freeze({ OWNER: 'OWNER', ADMIN: 'BUYER', COLLABORATOR: 'WAREHOUSE', VIEWER: 'VIEWER', ACCOUNTANT: 'VIEWER' });

/** The user the procurement API sees, built from the server's own authenticated actor (never from the request). null = no access. */
export function procurementUserFor(actor) {
  const role = PROCUREMENT_ROLE[String(actor?.role ?? '')];
  if (!role) return null;
  const id = String(actor.userId ?? actor.label ?? '').trim();
  if (!id) return null;
  const owner = role === 'OWNER';
  return { id, role, name: owner ? 'Propriétaire' : id, canApprove: owner, ...(owner ? { approverRole: 'OWNER' } : {}) };
}

/** @returns {Promise<{ handler: Function|null, assistant: object|null, procurement: object|null, status: string }>} */
export async function buildHostedProcurement({ dir, merchantId, env = process.env, log = () => {} }) {
  try {
    const base = join(dir, 'procurement');
    await mkdir(base, { recursive: true });
    const file = join(base, 'procurement.json');
    // The file store's lock is checked by process id, which means nothing after a container restart (another process of the NEW container can hold the
    // old id: reproduced, "Stock / Achats OFF (STORE_LOCKED)" after every restart). On Railway the volume has ONE writer by construction (a volume is
    // mounted by one deployment at a time, and the Core journal refuses to run without it), so a lock left on that volume is by definition from the
    // previous container: it is removed before opening. Anywhere else the store's own check stays in charge.
    if (String(env.RAILWAY_VOLUME_MOUNT_PATH ?? '').trim()) await unlink(`${file}.lock`).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    const store = await openFileProcurementStore({ path: file });
    const procurement = createProcurement({ store, merchantId });
    const system = { id: 'system', role: 'OWNER' };
    const have = new Set((await procurement.queries.locations()).map((l) => l.type));
    const boot = async (type, name) => { if (!have.has(type)) await procurement.commands.createLocation(system, `bootstrap:${type.toLowerCase()}:${merchantId}`, { name, type }).catch((e) => { if (e.code !== 'UNIQUE_VIOLATION') throw e; }); };
    await boot('WAREHOUSE', 'Réception (par défaut)'); await boot('QUARANTINE', 'Quarantaine');
    const handler = createProcurementApp({ procurement, users: [], sourcingDir: join(dir, 'cases'), uploadsDir: join(base, 'uploads'), allowedHosts: [], cacheAssets: env.PROCUREMENT_DEV !== '1' });
    return { handler, assistant: procurement.assistant, procurement, store, status: `Stock / Achats ON (${file})` };
  } catch (e) {
    log(`Stock / Achats: NOT mounted (${e.code ?? 'ERROR'}: ${String(e.message ?? '').slice(0, 200)}). The rest of Nordla is unaffected.`);
    return { handler: null, assistant: null, procurement: null, store: null, status: `Stock / Achats OFF (${e.code ?? 'ERROR'})` };
  }
}
