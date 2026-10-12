import {
  BODY_PATTERN, COMPOSITION_MAX_DENSITY, CROP_OF_COMPOSITION, DENSITY_CLASS, NARRATIVE_ROLE as R, OBJECTIVE_KIND, POSITIONAL_ROLES, ROLE_MAX_DENSITY, ROLE_OPTIONS, TEXT_LED_FALLBACK,
} from './constants.js';
import { densityRank } from './density.js';

// THE SEQUENCE. From the content plan of a lane (its assets and what each carries) the planner chooses the narrative role of every asset, then a composition and an imagery intent that suit the role and
// the amount of text. No role is compulsory: a campaign uses the roles its content needs. The k-th occurrence of a role takes the k-th option of that role and an asset never repeats the look of its
// predecessor, so a carousel is not one template repeated.
//
// Rules (recorded with the plan):
//   POSITION_FIXES_THE_FRAME    the cover is the hook, a closing asset is the offer (when it carries a price) or the call to action
//   OBJECTIVE_FIXES_THE_BODY    the body assets follow the pattern of the objective; the last body asset is the proof when verified proof is available and there are three or more body assets
//   DENSITY_BOUNDS_THE_ROLE     a body role that should carry little text is replaced by a progression when the locked copy of its asset is longer (copy is distributed, never cut)
//   HINT_OVERRIDES              a role named for an asset by the person is kept

const has = (asset, role) => asset.slots.some((s) => s.role === role);

/** The objective of a campaign when nobody stated it: a price makes it a sale, a long body an explanation, otherwise awareness. */
export function deriveObjectiveKind({ assets, bodyChars }) {
  if (assets.some((a) => has(a, 'PRICE'))) return OBJECTIVE_KIND.SELL;
  return bodyChars > 600 ? OBJECTIVE_KIND.EDUCATE : OBJECTIVE_KIND.AWARENESS;
}

function pick(options, density, occurrence, previous) {
  const fits = ([c]) => densityRank(COMPOSITION_MAX_DENSITY[c]) >= densityRank(density);
  // the options of the role that carry this much text; an asset that carries much text has few of them, so the text-led variants complete the pool
  const own = options.filter(fits);
  const pool = own.length >= 4 ? own : [...own, ...TEXT_LED_FALLBACK.filter(fits).filter((o) => !own.some((x) => x[0] === o[0] && x[1] === o[1]))];
  for (let step = 0; step < pool.length; step += 1) {
    const option = pool[(occurrence + step) % pool.length];
    if (!previous || option[0] !== previous[0] || option[1] !== previous[1]) return option;
  }
  return pool[occurrence % pool.length];
}

/**
 * @param {object} input { assets (the assets of a content plan), densities (per asset: density class), objectiveKind, proofAvailable, hints: Map<index, { narrative_role }> }
 * @returns {object[]} per asset: { index, narrative_role, role_rule, composition_intent, imagery_intent, crop_scale, option_rule }
 */
export function planSequence({
  assets, densities, objectiveKind, proofAvailable = false, hints = new Map(),
}) {
  const pattern = BODY_PATTERN[objectiveKind];
  const roles = assets.map((a, i) => {
    const hint = hints.get(i)?.narrative_role;
    if (hint) return { role: hint, rule: 'HINT_OVERRIDES' };
    if (a.asset_role === 'SINGLE') return { role: has(a, 'PRICE') ? R.OFFER : R.HOOK, rule: 'POSITION_FIXES_THE_FRAME' };
    if (a.asset_role === 'COVER') return { role: R.HOOK, rule: 'POSITION_FIXES_THE_FRAME' };
    if (a.asset_role === 'CLOSING') return { role: has(a, 'PRICE') ? R.OFFER : R.CTA, rule: 'POSITION_FIXES_THE_FRAME' };
    return { role: null, rule: null };
  });
  // a sequence that begins with a body asset: that asset is the hook if it is light enough to be one
  if (assets.length > 1 && roles[0].role === null && densityRank(densities[0]) <= densityRank(DENSITY_CLASS.MEDIUM)) roles[0] = { role: R.HOOK, rule: 'POSITION_FIXES_THE_FRAME' };
  const remaining = roles.map((r, i) => (r.role ? -1 : i)).filter((i) => i >= 0);
  remaining.forEach((i, j) => {
    const isLast = j === remaining.length - 1;
    if (proofAvailable && remaining.length >= 3 && isLast) roles[i] = { role: R.PROOF, rule: 'OBJECTIVE_FIXES_THE_BODY' };
    else roles[i] = { role: pattern[Math.min(j, pattern.length - 1)], rule: 'OBJECTIVE_FIXES_THE_BODY' };
  });
  // the density bounds the role
  roles.forEach((r, i) => {
    if (r.rule === 'HINT_OVERRIDES' || POSITIONAL_ROLES.includes(r.role)) return;
    if (densityRank(densities[i]) > densityRank(ROLE_MAX_DENSITY[r.role])) roles[i] = { role: R.PROGRESSION, rule: 'DENSITY_BOUNDS_THE_ROLE' };
  });
  const seen = new Map(); let previous = null;
  return roles.map((r, i) => {
    const occurrence = seen.get(r.role) ?? 0; seen.set(r.role, occurrence + 1);
    const [composition, imagery] = pick(ROLE_OPTIONS[r.role] ?? TEXT_LED_FALLBACK, densities[i], occurrence, previous);
    previous = [composition, imagery];
    return {
      index: i, narrative_role: r.role, role_rule: r.rule, composition_intent: composition, imagery_intent: imagery, crop_scale: CROP_OF_COMPOSITION[composition], option_rule: 'ROLE_OPTIONS_BY_OCCURRENCE_WITHOUT_REPEATING_THE_PREVIOUS_LOOK',
    };
  });
}
