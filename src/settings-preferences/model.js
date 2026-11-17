// Paramètres -> Préférences: the vocabulary (languages, regional formats, view modules) and the validators. DATA and pure functions only: no storage, no HTTP.
// A preference is PERSONAL (account + merchant) and grants nothing: no role, permission or business rule reads it.

/** Interface languages. The label is written in the language itself, so a person can always find theirs. */
export const LANGUAGES = Object.freeze([
  Object.freeze({ id: 'fr', label: 'Français' }),
  Object.freeze({ id: 'nl', label: 'Nederlands' }),
  Object.freeze({ id: 'en', label: 'English' }),
]);
export const LANGUAGE_IDS = Object.freeze(LANGUAGES.map((l) => l.id));
/** What an account without a saved choice gets today: the existing journeys are in French. */
export const DEFAULT_LANGUAGE = 'fr';

/** Regional formats (presentation only: never a currency, a time zone or a reporting period). `null` = the default format (fr-BE, what Stock / Achats already showed). */
export const REGIONS = Object.freeze([
  Object.freeze({ id: 'fr-BE', label: 'Français (Belgique)' }),
  Object.freeze({ id: 'nl-BE', label: 'Nederlands (België)' }),
  Object.freeze({ id: 'en-GB', label: 'English (United Kingdom)' }),
]);
export const REGION_IDS = Object.freeze(REGIONS.map((r) => r.id));
export const DEFAULT_REGION = 'fr-BE';

/**
 * Screens that can hold saved views. A screen is listed ONLY when its filters are stable and the screen reads them back from the address (`#items?q=...`).
 * `filters` is the allow-list of what a saved view may carry: anything else is refused on save and dropped (with a reason) on opening.
 * `roles` = the roles that can open the module (the same mapping Stock / Achats applies); a view never widens it.
 */
export const VIEW_MODULES = Object.freeze({
  procurement_items: Object.freeze({
    id: 'procurement_items', module: 'Stock / Achats', screen: 'Produits', href: '/procurement/#items',
    filters: Object.freeze({ q: Object.freeze({ type: 'text', max: 80, label: 'Recherche' }) }),
    roles: Object.freeze(['OWNER', 'ADMIN', 'COLLABORATOR', 'VIEWER', 'ACCOUNTANT']),
  }),
});

export class PreferencesError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'PreferencesError'; this.code = code; Object.assign(this, extra); }
}

export const isLanguage = (v) => LANGUAGE_IDS.includes(v);
export const isRegion = (v) => REGION_IDS.includes(v);

/** { language?, region? } -> the columns to write. `null` clears a choice (back to the default). Unknown values are refused, never coerced. */
export function validatePreferences(input) {
  const errors = {}; const patch = {};
  if (input == null || typeof input !== 'object' || Array.isArray(input)) throw new PreferencesError('VALIDATION', 'Réglage invalide.', { errors: { _: 'OBJECT_EXPECTED' } });
  if ('language' in input) { if (input.language === null || isLanguage(input.language)) patch.language = input.language; else errors.language = 'LANGUAGE_UNKNOWN'; }
  if ('region' in input) { if (input.region === null || isRegion(input.region)) patch.region = input.region; else errors.region = 'REGION_UNKNOWN'; }
  for (const k of Object.keys(input)) if (k !== 'language' && k !== 'region') errors[k] = 'FIELD_UNKNOWN';
  if (Object.keys(errors).length) throw new PreferencesError('VALIDATION', 'Réglage invalide.', { errors });
  if (!Object.keys(patch).length) throw new PreferencesError('VALIDATION', 'Aucun réglage à enregistrer.', { errors: { _: 'EMPTY' } });
  return patch;
}

/** Keeps only the allow-listed, well-typed, non-empty filters of a module. Returns { filters, dropped } (dropped = names that are no longer valid). */
export function cleanFilters(moduleId, raw) {
  const def = VIEW_MODULES[moduleId]; if (!def) return { filters: {}, dropped: Object.keys(raw ?? {}) };
  const filters = {}; const dropped = [];
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})) {
    const f = def.filters[k];
    if (!f) { dropped.push(k); continue; }
    if (f.type === 'text') { const s = typeof v === 'string' ? v.trim() : ''; if (s.length > f.max) { dropped.push(k); continue; } if (s) filters[k] = s; }
  }
  return { filters, dropped };
}

export function validateViewInput({ module: moduleId, name, filters }) {
  const errors = {};
  if (!VIEW_MODULES[moduleId]) errors.module = 'MODULE_UNKNOWN';
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n.length > 60) errors.name = 'NAME_INVALID';
  let clean = { filters: {}, dropped: [] };
  if (!errors.module) { clean = cleanFilters(moduleId, filters); if (clean.dropped.length) errors.filters = `FILTER_UNKNOWN:${clean.dropped.join(',')}`; }
  if (Object.keys(errors).length) throw new PreferencesError('VALIDATION', 'Vue invalide.', { errors });
  return { module: moduleId, name: n, filters: clean.filters };
}

export const validateName = (name) => { const n = typeof name === 'string' ? name.trim() : ''; if (!n || n.length > 60) throw new PreferencesError('VALIDATION', 'Nom invalide.', { errors: { name: 'NAME_INVALID' } }); return n; };

/**
 * WHERE each preference really applies (shown on the page, never a promise):
 *   language: APPLIED = follows the choice | KEPT = keeps its current language (French) | OWN = has its own FR/NL/EN switch, not linked to this setting yet
 *   region:   APPLIED = formatted by the shared formatter | NONE = keeps its own date / number format | OWN = formats per its own language switch, not linked yet
 * Update this list in the SAME change that wires a module: it is the only source of that table.
 */
export const APPLICATION = Object.freeze([
  Object.freeze({ id: 'hub', label: 'Paramètres (accueil)', language: 'APPLIED', region: 'NONE' }),
  Object.freeze({ id: 'preferences', label: 'Paramètres › Préférences', language: 'APPLIED', region: 'APPLIED' }),
  Object.freeze({ id: 'general', label: 'Paramètres › Général', language: 'KEPT', region: 'NONE' }),
  Object.freeze({ id: 'team', label: 'Paramètres › Équipe et accès', language: 'KEPT', region: 'NONE' }),
  Object.freeze({ id: 'connections', label: 'Paramètres › Connexions', language: 'KEPT', region: 'NONE' }),
  Object.freeze({ id: 'security', label: 'Paramètres › Sécurité', language: 'KEPT', region: 'NONE' }),
  Object.freeze({ id: 'procurement', label: 'Stock / Achats', language: 'KEPT', region: 'APPLIED' }),
  Object.freeze({ id: 'sourcing', label: 'China Sourcing et Parle à Nordla', language: 'KEPT', region: 'NONE' }),
  Object.freeze({ id: 'analytics', label: 'Analyses', language: 'OWN', region: 'OWN' }),
  Object.freeze({ id: 'growth', label: 'Growth', language: 'OWN', region: 'OWN' }),
]);
