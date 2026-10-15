// Nordla identity - closed registry of the sellable modules (ADR 0004, Core C3).
// Internal codes are stable and never translated; the visible names are translated by the interfaces later. 'core' is the common
// foundation, not a sellable module: it never receives an entitlement. A new module is added here AND in the SQL check of
// module_entitlements (migration), deliberately, with tests. No module code coming from a client is ever accepted as is.

export const MODULES = Object.freeze([
  Object.freeze({ code: 'finance', name: 'Finances' }),
  Object.freeze({ code: 'analytics', name: 'Analyses' }),
  Object.freeze({ code: 'growth', name: 'Développement des ventes' }),
  // China Sourcing (Buying & Suppliers): its hosted server opens Nordla sessions like the others. SQL: supabase/migrations-pending/20261015093000_identity_module_sourcing.sql
  Object.freeze({ code: 'sourcing', name: 'Sourcing Chine' }),
]);
export const MODULE_CODES = Object.freeze(MODULES.map((m) => m.code));

/** True only for a code of the registry (exact, case-sensitive: no normalisation of untrusted input). */
export const isModuleCode = (code) => typeof code === 'string' && MODULE_CODES.includes(code);

/** The registry entry of a code, or null. */
export const moduleOf = (code) => MODULES.find((m) => m.code === code) ?? null;
