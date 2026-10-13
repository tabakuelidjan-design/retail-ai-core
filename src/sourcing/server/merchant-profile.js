// Which merchant profile (DATA) the fit engine reads is an explicit deployment choice, never a default in the code:
//   SOURCING_MERCHANT_PROFILE = a path to a profile file, or
//   SOURCING_MERCHANT_ID      = config/merchants/<id>/sourcing-fit.json
// With neither set there is no profile and every fit dimension says so. The generic server knows no merchant by name.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
/** @returns {{ path: string|null, source: 'FILE'|'MERCHANT_ID'|'NONE', error?: string }} */
export function resolveMerchantProfilePath(env = {}, root = process.cwd()) {
  const file = String(env.SOURCING_MERCHANT_PROFILE ?? '').trim(); const id = String(env.SOURCING_MERCHANT_ID ?? '').trim();
  if (file) return { path: resolve(file), source: 'FILE' };
  if (id) return ID.test(id) ? { path: join(root, 'config', 'merchants', id, 'sourcing-fit.json'), source: 'MERCHANT_ID' } : { path: null, source: 'NONE', error: 'SOURCING_MERCHANT_ID must be lowercase letters, digits, - or _' };
  return { path: null, source: 'NONE' };
}
/** Reads and minimally validates the profile; a missing or invalid one yields `null` and a reason (the app keeps working: the fit says "profile not loaded"). */
export async function loadMerchantProfile(env, root) {
  const r = resolveMerchantProfilePath(env, root); if (!r.path) return { profile: null, ...r };
  try { const p = JSON.parse(await readFile(r.path, 'utf8')); if (!p || p.schema !== 1 || typeof p.merchantId !== 'string') return { profile: null, ...r, error: 'the profile must have schema 1 and a merchantId' }; return { profile: p, ...r }; }
  catch (e) { return { profile: null, ...r, error: e.code === 'ENOENT' ? 'profile file not found' : 'profile file unreadable' }; }
}
