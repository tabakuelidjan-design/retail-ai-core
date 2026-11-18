// Nordla module catalogue (phase 1): ONE list that the Core panel and the server controls both read.
//
// Two different things are kept apart on purpose:
//   - status: what really exists. AVAILABLE = a service is built for it and it can be opened for a merchant holding the right;
//     DEMO = only a replay / test build (never presented as working for a real merchant); PLANNED = not integrated, not audited here.
//   - entitlement: the module_entitlements code that grants access (must be in identity/modules.js, which is the SQL-checked registry).
//     null = no entitlement exists yet: the module can never be opened through the identity layer, whatever the environment says.
//
// Default deny: a module is opened only if its status is AVAILABLE, it has an entitlement, that entitlement is ACTIVE for THIS merchant,
// and (when the module restricts roles) the person's role is allowed. Nothing here grants an entitlement by itself.

import { MODULE_CODES } from './modules.js';

export const MODULE_STATUS = Object.freeze({ AVAILABLE: 'AVAILABLE', DEMO: 'DEMO', PLANNED: 'PLANNED' });

const FINANCE_ROLES = Object.freeze(['OWNER', 'ADMIN', 'ACCOUNTANT']);

export const CATALOG = Object.freeze([
  Object.freeze({ key: 'finance', label: 'Finances', status: MODULE_STATUS.AVAILABLE, entitlement: 'finance', openRoles: FINANCE_ROLES }),
  Object.freeze({ key: 'analytics', label: 'Analyses', status: MODULE_STATUS.AVAILABLE, entitlement: 'analytics', openRoles: FINANCE_ROLES }),
  Object.freeze({ key: 'growth', label: 'Développement des ventes', status: MODULE_STATUS.AVAILABLE, entitlement: 'growth', openRoles: null }),
  Object.freeze({ key: 'sourcing', label: 'Sourcing / Achats / Stock', status: MODULE_STATUS.AVAILABLE, entitlement: 'sourcing', openRoles: null }),
  Object.freeze({ key: 'creator', label: 'Création (Creator)', status: MODULE_STATUS.DEMO, entitlement: null, openRoles: null, note: 'démo rejouée ; pipeline réel non présent dans la release' }),
  Object.freeze({ key: 'video', label: 'Vidéo', status: MODULE_STATUS.DEMO, entitlement: null, openRoles: null, note: 'brouillons uniquement, derrière un indicateur d’environnement' }),
  Object.freeze({ key: 'gbp', label: 'Google Business', status: MODULE_STATUS.DEMO, entitlement: null, openRoles: null, note: 'brouillons ; aucune publication Google possible' }),
  Object.freeze({ key: 'connections', label: 'Connexions', status: MODULE_STATUS.DEMO, entitlement: null, openRoles: null, note: 'Instagram non configuré' }),
  Object.freeze({ key: 'market-radar', label: 'Market Radar', status: MODULE_STATUS.PLANNED, entitlement: null, openRoles: null, note: 'non audité dans cette phase' }),
]);

/** Catalogue entry for a key, or null. */
export const catalogOf = (key) => CATALOG.find((m) => m.key === key) ?? null;

// Every entitlement named by the catalogue must exist in the SQL-checked registry (identity/modules.js): checked at load time.
for (const m of CATALOG) if (m.entitlement !== null && !MODULE_CODES.includes(m.entitlement)) throw new Error(`module-catalog: '${m.key}' names an unregistered entitlement '${m.entitlement}'`);

/**
 * Decides whether a person may open a module on THIS merchant. Pure: the caller gives the merchant's ACTIVE entitlement codes.
 * @param {{ key: string, role: string|null, activeCodes: Set<string>|null }} input  activeCodes = null means "unknown": refused.
 * @returns {{ ok: true } | { ok: false, code: 'MODULE_UNKNOWN'|'MODULE_NOT_AVAILABLE'|'MODULE_NOT_REGISTERED'|'MODULE_NOT_ENABLED'|'FORBIDDEN' }}
 */
export function decideModuleOpen({ key, role, activeCodes }) {
  const m = catalogOf(key);
  if (!m) return { ok: false, code: 'MODULE_UNKNOWN' };
  if (m.status !== MODULE_STATUS.AVAILABLE) return { ok: false, code: 'MODULE_NOT_AVAILABLE' };
  if (m.entitlement === null) return { ok: false, code: 'MODULE_NOT_REGISTERED' };
  if (!(activeCodes instanceof Set) || !activeCodes.has(m.entitlement)) return { ok: false, code: 'MODULE_NOT_ENABLED' };
  if (m.openRoles && !(typeof role === 'string' && m.openRoles.includes(role))) return { ok: false, code: 'FORBIDDEN' };
  return { ok: true };
}
