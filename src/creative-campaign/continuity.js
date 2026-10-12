import { deepFreeze, deriveId } from '../creative-brain/validation.js';
import {
  FORBIDDEN_PATTERN, MUST_STAY_CONSISTENT, SCHEMA, SHOULD_VARY,
} from './constants.js';

// THE CONTINUITY CONTRACT states what every asset of a campaign keeps and what it is free to vary, and the DIVERSITY REPORT measures whether the variation is real. Together they prevent the commonest
// failure of a carousel: the same slide repeated with different text.

/**
 * @param {object} input { frame, concept, artDirection, brief, factRefs (the usable facts), copyRefs }
 */
export function buildContinuityContract({
  frame, concept, artDirection, brief, factRefs, copyRefs,
}) {
  const body = {
    schema: SCHEMA.continuity,
    must_stay_consistent: [
      { aspect: MUST_STAY_CONSISTENT.CAMPAIGN_CONCEPT, refs: [concept.concept_id], statement: concept.central_idea },
      { aspect: MUST_STAY_CONSISTENT.ART_DIRECTION, refs: [artDirection.art_direction_id], statement: artDirection.atmosphere },
      { aspect: MUST_STAY_CONSISTENT.BRAND_CONSTRAINTS, refs: [brief.ids.brand_id, ...Object.keys(brief.brand?.expression ?? {}).sort().map((k) => `expression:${k}`)], statement: 'the brand constraints of the approved Brand Memory' },
      { aspect: MUST_STAY_CONSISTENT.PRODUCT_IDENTITY, refs: [brief.ids.product_ref, brief.asset.ref], statement: 'the real product, its pixels and its identity, on every asset' },
      { aspect: MUST_STAY_CONSISTENT.APPROVED_FACTS, refs: [...new Set([...copyRefs, ...factRefs])].sort(), statement: 'only approved and verified facts' },
      {
        aspect: MUST_STAY_CONSISTENT.VISUAL_LANGUAGE,
        refs: [frame.frame_id],
        statement: [artDirection.material_language, artDirection.lighting_intent].join('; '),
        words: [artDirection.depth_model, artDirection.visual_rhythm, artDirection.product_relationship, artDirection.realism, artDirection.emotional_temperature, artDirection.visual_tension, artDirection.text_image_relationship],
      },
    ],
    should_vary: [
      { aspect: SHOULD_VARY.SLIDE_ROLE, source: 'the narrative role of each asset' },
      { aspect: SHOULD_VARY.COMPOSITION, source: 'the composition intent of each asset, never the look of its predecessor' },
      { aspect: SHOULD_VARY.IMAGERY, source: 'the imagery intent and the imagery brief of each asset' },
      { aspect: SHOULD_VARY.CROP_SCALE, source: 'the crop scale that follows the composition, wherever it keeps the product identity safe' },
      { aspect: SHOULD_VARY.TEXT_HIERARCHY, source: 'the density class and the text roles of each asset' },
      { aspect: SHOULD_VARY.RHYTHM, source: 'the alternation of density classes along the sequence' },
    ],
    forbidden_pattern: FORBIDDEN_PATTERN,
  };
  return deepFreeze({ continuity_id: deriveId('cnt', body), ...body });
}

const pairOf = (a) => `${a.composition_intent}/${a.imagery_intent}`;
const longestRun = (items) => {
  let best = 0; let run = 0; let last = null;
  for (const x of items) { run = x === last ? run + 1 : 1; last = x; best = Math.max(best, run); }
  return best;
};

/**
 * Measures how different the assets of a lane really are. Deterministic; the rules are the ones a reviewer applies by eye.
 * @param {object[]} assets the AssetPlans of a lane (composition_intent, imagery_intent, narrative_role, density, copy slots)
 */
export function auditDiversity(assets) {
  const n = assets.length;
  const pairs = assets.map(pairOf);
  const texts = assets.map((a) => a.copy.map((s) => s.text).join('|')).filter(Boolean);
  const distinct = (xs) => new Set(xs).size;
  const body = {
    schema: SCHEMA.diversity,
    assets: n,
    distinct_roles: distinct(assets.map((a) => a.narrative_role)),
    distinct_composition_intents: distinct(assets.map((a) => a.composition_intent)),
    distinct_imagery_intents: distinct(assets.map((a) => a.imagery_intent)),
    distinct_pairs: distinct(pairs),
    max_consecutive_same_pair: longestRun(pairs),
    density_classes: Object.fromEntries(['LOW', 'MEDIUM', 'HIGH', 'TEXT_LED'].map((c) => [c, assets.filter((a) => a.density.density_class === c).length])),
    duplicated_copy_assets: texts.length - distinct(texts),
  };
  const rules = [
    { id: 'NO_TWO_NEIGHBOURS_SHARE_A_LOOK', passed: body.max_consecutive_same_pair <= 1 },
    { id: 'NOT_ONE_TEMPLATE_REPEATED', passed: n < 3 || body.distinct_pairs >= Math.max(2, Math.ceil(n / 2)) },
    { id: 'ROLES_ARE_VARIED', passed: n < 3 || body.distinct_roles >= 3 },
    { id: 'NO_COPY_IS_REPEATED_ON_TWO_ASSETS', passed: body.duplicated_copy_assets === 0 },
  ];
  return deepFreeze({ ...body, rules, passed: rules.every((r) => r.passed) });
}
