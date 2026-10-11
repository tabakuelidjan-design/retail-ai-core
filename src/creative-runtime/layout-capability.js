import * as CI from '../creative-intelligence/index.js';
import { selectApprovedCopy } from './agents.js';
import { recipesForIntent, solveRecipeLayout, TYPE_SCALE } from './layout-plan.js';

// The LAYOUT CAPABILITY PROFILE: what the deterministic layout can actually execute for THIS approved copy, stated in abstract terms the Creative Director can reason with before it
// chooses a direction. It is derived, never declared: every recipe is solved by the very same code that will place the real layout (`solveRecipeLayout`) with the approved texts of the
// brief, and only the abstract outcome is kept:
//   - per text role: whether the type rules allow one line or several (`line_policy`)
//   - per recipe: the roles it has a slot for, and for each approved role whether the text FITS, DOES_NOT_FIT its slot, or has NO_SLOT
//   - per spatial intent: the recipes that realize it, the roles they can carry, and whether one of them can carry ALL the approved texts (`executable`)
// The profile holds no coordinate, size, font, colour, count or brand value (a validator refuses numbers anywhere). It is advice about what is feasible: the planner stays authoritative
// and still solves the real layout afterwards, so a direction that somehow gets through is caught by it.

export const LAYOUT_CAPABILITY_SCHEMA = 'layout-capability@1';
const FIT = Object.freeze({ FITS: 'FITS', DOES_NOT_FIT: 'DOES_NOT_FIT', NO_SLOT: 'NO_SLOT' });
const TEXT_ROLES = Object.freeze(['HEADLINE', 'SUBHEADLINE', 'PRICE', 'CTA']);

export class LayoutCapabilityError extends Error {
  constructor(code, message) { super(message); this.name = 'LayoutCapabilityError'; this.code = code; }
}

/**
 * @param {object} input { at, brief: { ids, claims, approved_copy, format, brand, asset }, fonts }
 */
export function computeLayoutCapabilityProfile({ at, brief, fonts }) {
  const { ids, claims, brand } = brief;
  const format = { ...brief.format };
  const claimRefs = claims.map((c) => c.ref);
  const { items } = selectApprovedCopy({ hierarchy: TEXT_ROLES, approvedCopy: brief.approved_copy, claims });
  const roles = items.map((i) => i.text_role);
  // a neutral direction: the assembly needs an id only; nothing of it influences the fitting
  const direction = { direction_id: `cdr_${'0'.repeat(32)}` };
  const recipes = CI.LAYOUT_RECIPE_IDS.map((recipeId) => {
    const slotRoles = new Set(CI.getLayoutRecipe(recipeId).slots.map((s) => s.role));
    const { solved } = solveRecipeLayout({
      at, ids, direction, format, brand, copyItems: items, cutoutRef: 'asset://capability/cutout', cutoutSize: { width: brief.asset.width_px, height: brief.asset.height_px }, environmentRef: 'asset://capability/environment',
      providerId: 'capability-profile', size: format.canvas, fonts, claimRefs, recipeId,
    });
    const unfit = new Set(solved.violations.filter((v) => v.code === 'TEXT_DOES_NOT_FIT').flatMap((v) => v.layers));
    const noSlot = new Set(solved.unplaced.map((u) => u.layer_id));
    const roleFit = Object.fromEntries(roles.map((role) => {
      const layer = `text-${role.toLowerCase()}`;
      return [role, noSlot.has(layer) || !slotRoles.has(role) ? FIT.NO_SLOT : (unfit.has(layer) ? FIT.DOES_NOT_FIT : FIT.FITS)];
    }));
    return {
      recipe_id: recipeId,
      supported_roles: [...slotRoles].filter((r) => r !== 'PRODUCT' && r !== 'LOGO').sort(),
      role_fit: roleFit,
      complete: roles.every((r) => roleFit[r] === FIT.FITS),
    };
  });
  const byId = Object.fromEntries(recipes.map((r) => [r.recipe_id, r]));
  const intents = Object.keys(CI.SPATIAL_INTENT).map((spatialIntent) => {
    const ids2 = [...new Set(Object.keys(CI.PRODUCT_ROLE).flatMap((productRole) => recipesForIntent({ spatial_intent: spatialIntent, product_role: productRole })))];
    const usable = roles.filter((role) => ids2.some((id) => byId[id].role_fit[role] === FIT.FITS));
    // executable = at least one recipe of the intent carries EVERY approved text
    return { spatial_intent: spatialIntent, recipes: ids2, usable_roles: usable, executable: ids2.some((id) => byId[id].complete) };
  });
  return normalizeLayoutCapabilityProfile({
    schema_version: LAYOUT_CAPABILITY_SCHEMA,
    text_roles: roles.map((role) => ({ role, line_policy: TYPE_SCALE.max_lines[role] > 1 ? 'MULTI_LINE' : 'SINGLE_LINE' })),
    recipes,
    spatial_intents: intents,
  });
}

const KEYS = Object.freeze({
  profile: ['schema_version', 'text_roles', 'recipes', 'spatial_intents'], text_role: ['role', 'line_policy'], recipe: ['recipe_id', 'supported_roles', 'role_fit', 'complete'], intent: ['spatial_intent', 'recipes', 'usable_roles', 'executable'],
});
const exact = (value, keys, where) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new LayoutCapabilityError('LAYOUT_CAPABILITY_MALFORMED', `${where} must be an object`);
  for (const k of Object.keys(value)) if (!keys.includes(k)) throw new LayoutCapabilityError('LAYOUT_CAPABILITY_KEY_NOT_ALLOWED', `${where}.${k} is not part of a capability profile`);
  for (const k of keys) if (!(k in value)) throw new LayoutCapabilityError('LAYOUT_CAPABILITY_MALFORMED', `${where}.${k} is missing`);
};
const noNumbers = (value, where) => {
  if (typeof value === 'number' || typeof value === 'bigint') throw new LayoutCapabilityError('LAYOUT_CAPABILITY_NUMERIC_VALUE', `${where} is a number: the profile holds no coordinate, size or count`);
  if (Array.isArray(value)) value.forEach((v, i) => noNumbers(v, `${where}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) noNumbers(v, `${where}.${k}`);
};

/** The strict shape of a profile: only the abstract fields above, only words and booleans (no number anywhere), deep-frozen. */
export function normalizeLayoutCapabilityProfile(profile) {
  exact(profile, KEYS.profile, 'profile');
  if (profile.schema_version !== LAYOUT_CAPABILITY_SCHEMA) throw new LayoutCapabilityError('LAYOUT_CAPABILITY_MALFORMED', 'unknown profile version');
  noNumbers(profile, 'profile');
  profile.text_roles.forEach((t, i) => { exact(t, KEYS.text_role, `text_roles[${i}]`); if (!['SINGLE_LINE', 'MULTI_LINE'].includes(t.line_policy)) throw new LayoutCapabilityError('LAYOUT_CAPABILITY_MALFORMED', 'line_policy'); });
  profile.recipes.forEach((r, i) => {
    exact(r, KEYS.recipe, `recipes[${i}]`);
    for (const fit of Object.values(r.role_fit)) if (!Object.values(FIT).includes(fit)) throw new LayoutCapabilityError('LAYOUT_CAPABILITY_MALFORMED', 'role_fit');
  });
  profile.spatial_intents.forEach((s, i) => exact(s, KEYS.intent, `spatial_intents[${i}]`));
  const freeze = (v) => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(freeze); } return v; };
  return freeze(structuredClone(profile));
}

/**
 * Can this direction be executed by at least one recipe? Every approved role of the profile must be kept by the direction's hierarchy (a revision never drops an approved message) and
 * must FIT in the slot of a recipe that realizes the direction's spatial intent. Returns { executable, recipes, reasons }.
 */
export function assessDirectionExecutable(profile, { spatial_intent: spatialIntent, hierarchy = [], product_role: productRole = 'HERO' }) {
  const approved = profile.text_roles.map((t) => t.role);
  const missing = approved.filter((role) => !hierarchy.includes(role));
  const reasons = missing.map((role) => `MISSING_APPROVED_ROLE:${role}`);
  const candidates = recipesForIntent({ spatial_intent: spatialIntent, product_role: productRole });
  if (!candidates.length) reasons.push('NO_RECIPE_FOR_THE_SPATIAL_INTENT');
  const usable = candidates.filter((id) => {
    const recipe = profile.recipes.find((r) => r.recipe_id === id);
    return recipe && approved.every((role) => recipe.role_fit[role] === FIT.FITS);
  });
  if (candidates.length && !usable.length) reasons.push('NO_RECIPE_CARRIES_EVERY_APPROVED_TEXT');
  return Object.freeze({ executable: usable.length > 0 && missing.length === 0, recipes: usable, reasons });
}

/** The spatial intents that can carry every approved text (the only ones a revision may choose). */
export const executableSpatialIntents = (profile) => profile.spatial_intents.filter((s) => s.executable).map((s) => s.spatial_intent);
