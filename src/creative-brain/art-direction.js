import { conceptualWords } from './concept.js';
import { principlesAsText, principlesFor, REASONING_STAGE } from './knowledge.js';
import {
  list, obj, renderContract, renderRules, text, validateSpec, word,
} from './contract.js';
import { askAndNormalize } from './model-port.js';
import { assertNoSubstitute, SCENE_FORBIDDEN, SUBSTITUTE_LEXICON } from './substitutes.js';
import {
  BRAIN_ERROR, closed, deepFreeze, deriveId, enumOf, fail, listOf, noNumbers, oneLine,
} from './validation.js';

// ART DIRECT. The selected concept becomes an ArtDirection: semantic decisions about atmosphere, depth, material, light, rhythm, the relation of the product to the scene, the relation of the text to
// the image, realism, emotional temperature, tension, negative space, the narrative elements of the scene and what is forbidden. No coordinate, no size, no colour code, no number: geometry belongs to
// the deterministic solver. Every narrative element must carry a REASON in the concept (no arbitrary decoration), and nothing may be, or stand in for, the product.

export const DEPTH_MODEL = Object.freeze({ FLAT_FIELD: 'FLAT_FIELD', SHALLOW_LAYERS: 'SHALLOW_LAYERS', LAYERED_DEPTH: 'LAYERED_DEPTH', DEEP_SPACE: 'DEEP_SPACE' });
export const VISUAL_RHYTHM = Object.freeze({ STILL: 'STILL', MEASURED: 'MEASURED', FLOWING: 'FLOWING', PUNCTUATED: 'PUNCTUATED' });
export const PRODUCT_RELATIONSHIP = Object.freeze({ GROUNDED_IN_SCENE: 'GROUNDED_IN_SCENE', ELEVATED_IN_SCENE: 'ELEVATED_IN_SCENE', EMBEDDED_IN_SCENE: 'EMBEDDED_IN_SCENE', ADJACENT_TO_SCENE: 'ADJACENT_TO_SCENE' });
export const TEXT_IMAGE_RELATIONSHIP = Object.freeze({ TEXT_IN_CALM_ZONES: 'TEXT_IN_CALM_ZONES', TEXT_ANCHORED_TO_SUBJECT: 'TEXT_ANCHORED_TO_SUBJECT', TEXT_AS_STRUCTURE: 'TEXT_AS_STRUCTURE', TEXT_IN_SEPARATE_BAND: 'TEXT_IN_SEPARATE_BAND' });
export const REALISM = Object.freeze({ PHOTOREALISTIC: 'PHOTOREALISTIC', EDITORIAL_STYLISED: 'EDITORIAL_STYLISED' });
export const EMOTIONAL_TEMPERATURE = Object.freeze({ COOL: 'COOL', NEUTRAL: 'NEUTRAL', WARM: 'WARM', CONTRASTED: 'CONTRASTED' });
export const VISUAL_TENSION = Object.freeze({ LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' });
export const NEGATIVE_SPACE_STRATEGY = Object.freeze({ SURROUNDING_REST: 'SURROUNDING_REST', DIRECTIONAL_LEAD: 'DIRECTIONAL_LEAD', GROUP_SEPARATION: 'GROUP_SEPARATION', ASYMMETRIC_RESERVE: 'ASYMMETRIC_RESERVE' });
export const SCENE_ZONE = Object.freeze({ BACKGROUND: 'BACKGROUND', MIDGROUND: 'MIDGROUND', FOREGROUND: 'FOREGROUND' });

const MODEL_KEYS = ['atmosphere', 'depth_model', 'material_language', 'lighting_intent', 'visual_rhythm', 'product_relationship', 'text_image_relationship', 'realism', 'emotional_temperature', 'visual_tension',
  'negative_space_strategy', 'narrative_elements', 'permitted_secondary_elements', 'forbidden_decorative_noise', 'rationale'];
const KEYS = ['art_direction_id', 'concept_id', ...MODEL_KEYS];
export const MAX_NARRATIVE_ELEMENTS = 6;
// the limits of the contract, as named constants: the validator enforces them AND the ART_DIRECT instruction states them
export const ART_LIMITS = Object.freeze({
  text_max: 300, element_max: 140, reason_min: 12, reason_max: 220, secondary_max_items: 5, secondary_item_max: 140, noise_min_items: 1, noise_max_items: 8, noise_item_max: 140,
});

/** The art direction as a model states it: the contract the answer is validated against AND the contract the instruction states. */
export const ART_SPEC = obj({
  atmosphere: text({ geometry: true }), depth_model: word(DEPTH_MODEL), material_language: text({ geometry: true }), lighting_intent: text({ geometry: true }), visual_rhythm: word(VISUAL_RHYTHM),
  product_relationship: word(PRODUCT_RELATIONSHIP), text_image_relationship: word(TEXT_IMAGE_RELATIONSHIP), realism: word(REALISM), emotional_temperature: word(EMOTIONAL_TEMPERATURE),
  visual_tension: word(VISUAL_TENSION), negative_space_strategy: word(NEGATIVE_SPACE_STRATEGY),
  narrative_elements: list(obj({ element: text({ max: ART_LIMITS.element_max, forbid: true }), reason: text({ min: ART_LIMITS.reason_min, max: ART_LIMITS.reason_max }), zone: word(SCENE_ZONE) }), { min: 0, max: MAX_NARRATIVE_ELEMENTS }),
  permitted_secondary_elements: list(text({ max: ART_LIMITS.secondary_item_max, forbid: true }), { min: 0, max: ART_LIMITS.secondary_max_items }),
  forbidden_decorative_noise: list(text({ max: ART_LIMITS.noise_item_max }), { min: ART_LIMITS.noise_min_items, max: ART_LIMITS.noise_max_items }),
  rationale: text({ geometry: true }),
});

// a digit, a colour code or a unit is geometry or styling that belongs elsewhere
const GEOMETRY_TEXT = /[0-9]|#[0-9a-f]{3,8}\b|\b(px|pt|em|rem)\b/i;

/** Each narrative element must be argued in the concept: its reason shares a significant word with the concept's own text. */
function reasonInConcept(element, where, concept) {
  const conceptWords = new Set(conceptualWords([concept.central_idea, concept.visual_metaphor, concept.story, concept.emotional_intent].join(' ')));
  if (!conceptualWords(element.reason).some((w) => conceptWords.has(w))) fail(BRAIN_ERROR.RULE_VIOLATION, `${where} has no reason in the concept`, where, { problem: 'ELEMENT_WITHOUT_REASON_IN_THE_CONCEPT' });
}
export const ART_RULES = Object.freeze([
  { id: 'REASON_IN_THE_CONCEPT', statement: 'every narrative element needs a reason in the concept: the reason must contain at least one significant word that also appears in the concept\'s central_idea, visual_metaphor, story or emotional_intent (not a stop word), or the answer is refused.', check: (v, ctx) => v.narrative_elements.forEach((e, i) => reasonInConcept(e, `art_direction.narrative_elements[${i}]`, ctx.concept)) },
  { enforcedBy: 'art-direction.js#normalizeArtDirection (appends SCENE_FORBIDDEN)', id: 'MANDATORY_NOISE', statement: 'Nordla always adds its own prohibitions (a substitute for the product, a phone, a case or any device, a competing hero object, a misleading commercial object, text, letters, logos or watermarks) to forbidden_decorative_noise: you do not need to repeat them.' },
  { id: 'NO_OTHER_KEYS', statement: 'never include a key that is not listed above (no art_direction_id, concept_id or any other).', enforcedBy: 'closed spec (art-direction.js#normalizeArtDirection)' },
]);

/**
 * The ArtDirection of a selected concept, from a model's fields: closed, no figure, closed vocabularies, every narrative element argued in the concept and none a substitute for the product.
 * The mandatory forbidden list is Nordla's and is always present.
 */
export function normalizeArtDirection(raw, { concept }) {
  noNumbers(raw, 'art_direction');
  const v = validateSpec(ART_SPEC, raw, 'art_direction');
  for (const rule of ART_RULES) rule.check?.(v, { concept });
  const body = {
    concept_id: concept.concept_id,
    atmosphere: v.atmosphere,
    depth_model: v.depth_model,
    material_language: v.material_language,
    lighting_intent: v.lighting_intent,
    visual_rhythm: v.visual_rhythm,
    product_relationship: v.product_relationship,
    text_image_relationship: v.text_image_relationship,
    realism: v.realism,
    emotional_temperature: v.emotional_temperature,
    visual_tension: v.visual_tension,
    negative_space_strategy: v.negative_space_strategy,
    narrative_elements: v.narrative_elements,
    permitted_secondary_elements: v.permitted_secondary_elements,
    forbidden_decorative_noise: [...new Set([...v.forbidden_decorative_noise, ...SCENE_FORBIDDEN])],
    rationale: v.rationale,
  };
  return deepFreeze({ art_direction_id: deriveId('art', body), ...body });
}

export function buildArtDirectionInstruction({ frame, concept, hints = [] }) {
  const vocab = (e) => Object.values(e).join(' | ');
  const system = [
    'You are the Nordla art director. You turn the SELECTED concept into an art direction: semantic decisions only, never a coordinate, a size, a colour code or any number.',
    'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...renderContract(ART_SPEC, 'answer'),
    'rationale is one concise sentence of why, for the record; it is not a reasoning log. forbidden_decorative_noise is what must NOT appear as decoration: you may name anything there.',
    'The real product is protected merchant pixels placed by the system. The scene may be rich if the concept calls for it, and it must leave a calm area for the product, but it may never contain, show or describe the product or anything that could stand in for it or compete with it.',
    `Nordla REFUSES the whole answer if any narrative element or permitted secondary element contains one of these words (whole words, plurals included, English or French): product and devices: ${SUBSTITUTE_LEXICON.product_and_devices.join(', ')}; branding, price and text: ${SUBSTITUTE_LEXICON.branding_price_and_text.join(', ')}; competing hero: ${SUBSTITUTE_LEXICON.competing_hero.join(', ')}. This is about the WORD, even in a metaphor ("suggesting a screen" is refused).`,
    'If the concept\'s idea involves such an object (a screen, a device, a case, a label), express it WITHOUT naming it: through light, material, gesture, a trace, or an empty place where the system will add the real product.',
    ...renderRules(ART_RULES),
    ...(hints.length ? ['This is a REVISION of an earlier art direction for the same concept. Improve it on these points (intents only, never coordinates or sizes):', ...hints.map((h) => `- ${h}`)] : []),
    'Reason with these principles of art direction:',
    principlesAsText(principlesFor({ stage: REASONING_STAGE.ART_DIRECT })),
  ].join('\n');
  return { system, user: JSON.stringify({ problem_frame: frame, concept }) };
}

/** The ART_DIRECT stage: one model completion, then the closed contract. */
export function createArtDirector({ complete }) {
  return Object.freeze({
    async direct({ frame, concept, hints = [] }) {
      const { value, meta } = await askAndNormalize({
        complete, instruction: buildArtDirectionInstruction({ frame, concept, hints }), stage: 'ART_DIRECT',
        spec: ART_SPEC, normalize: (raw) => normalizeArtDirection(raw, { concept }),
      });
      return { art_direction: value, meta };
    },
  });
}

