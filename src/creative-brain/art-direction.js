import { conceptualWords } from './concept.js';
import { principlesAsText, principlesFor, REASONING_STAGE } from './knowledge.js';
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

// a digit, a colour code or a unit is geometry or styling that belongs elsewhere
const GEOMETRY_TEXT = /[0-9]|#[0-9a-f]{3,8}\b|\b(px|pt|em|rem)\b/i;

function narrativeElement(value, where, concept) {
  closed(value, ['element', 'reason', 'zone'], where);
  const element = oneLine(value.element, `${where}.element`, { max: ART_LIMITS.element_max });
  const reason = oneLine(value.reason, `${where}.reason`, { min: ART_LIMITS.reason_min, max: ART_LIMITS.reason_max });
  assertNoSubstitute(element, `${where}.element`);
  // the reason must be argued in the concept: it shares conceptual words with the concept's own text
  const conceptWords = new Set(conceptualWords([concept.central_idea, concept.visual_metaphor, concept.story, concept.emotional_intent].join(' ')));
  if (!conceptualWords(reason).some((w) => conceptWords.has(w))) fail(BRAIN_ERROR.RULE_VIOLATION, `${where} has no reason in the concept`, where, { problem: 'ELEMENT_WITHOUT_REASON_IN_THE_CONCEPT' });
  return { element, reason, zone: enumOf(value.zone, SCENE_ZONE, `${where}.zone`) };
}

/**
 * The ArtDirection of a selected concept, from a model's fields: closed, no figure, closed vocabularies, every narrative element argued in the concept and none a substitute for the product.
 * The mandatory forbidden list is Nordla's and is always present.
 */
export function normalizeArtDirection(raw, { concept }) {
  noNumbers(raw, 'art_direction');
  closed(raw, MODEL_KEYS, 'art_direction');
  for (const key of ['atmosphere', 'material_language', 'lighting_intent', 'rationale']) if (typeof raw[key] === 'string' && GEOMETRY_TEXT.test(raw[key])) fail(BRAIN_ERROR.FORBIDDEN_CONTENT, `art_direction.${key} holds a colour code or a unit`, `art_direction.${key}`);
  const secondary = listOf(raw.permitted_secondary_elements, 'art_direction.permitted_secondary_elements', { min: 0, max: ART_LIMITS.secondary_max_items }, (v, w) => assertNoSubstitute(oneLine(v, w, { max: ART_LIMITS.secondary_item_max }), w));
  const noise = listOf(raw.forbidden_decorative_noise, 'art_direction.forbidden_decorative_noise', { min: ART_LIMITS.noise_min_items, max: ART_LIMITS.noise_max_items }, (v, w) => oneLine(v, w, { max: ART_LIMITS.noise_item_max }));
  const body = {
    concept_id: concept.concept_id,
    atmosphere: oneLine(raw.atmosphere, 'art_direction.atmosphere'),
    depth_model: enumOf(raw.depth_model, DEPTH_MODEL, 'art_direction.depth_model'),
    material_language: oneLine(raw.material_language, 'art_direction.material_language'),
    lighting_intent: oneLine(raw.lighting_intent, 'art_direction.lighting_intent'),
    visual_rhythm: enumOf(raw.visual_rhythm, VISUAL_RHYTHM, 'art_direction.visual_rhythm'),
    product_relationship: enumOf(raw.product_relationship, PRODUCT_RELATIONSHIP, 'art_direction.product_relationship'),
    text_image_relationship: enumOf(raw.text_image_relationship, TEXT_IMAGE_RELATIONSHIP, 'art_direction.text_image_relationship'),
    realism: enumOf(raw.realism, REALISM, 'art_direction.realism'),
    emotional_temperature: enumOf(raw.emotional_temperature, EMOTIONAL_TEMPERATURE, 'art_direction.emotional_temperature'),
    visual_tension: enumOf(raw.visual_tension, VISUAL_TENSION, 'art_direction.visual_tension'),
    negative_space_strategy: enumOf(raw.negative_space_strategy, NEGATIVE_SPACE_STRATEGY, 'art_direction.negative_space_strategy'),
    narrative_elements: listOf(raw.narrative_elements, 'art_direction.narrative_elements', { min: 0, max: MAX_NARRATIVE_ELEMENTS }, (v, w) => narrativeElement(v, w, concept)),
    permitted_secondary_elements: secondary,
    forbidden_decorative_noise: [...new Set([...noise, ...SCENE_FORBIDDEN])],
    rationale: oneLine(raw.rationale, 'art_direction.rationale'),
  };
  return deepFreeze({ art_direction_id: deriveId('art', body), ...body });
}

export function buildArtDirectionInstruction({ frame, concept, hints = [] }) {
  const vocab = (e) => Object.values(e).join(' | ');
  const system = [
    'You are the Nordla art director. You turn the SELECTED concept into an art direction: semantic decisions only, never a coordinate, a size, a colour code or any number.',
    `Return ONLY one JSON object with exactly these keys: ${MODEL_KEYS.join(', ')}.`,
    `depth_model: ${vocab(DEPTH_MODEL)}. visual_rhythm: ${vocab(VISUAL_RHYTHM)}. product_relationship: ${vocab(PRODUCT_RELATIONSHIP)}. text_image_relationship: ${vocab(TEXT_IMAGE_RELATIONSHIP)}.`,
    `realism: ${vocab(REALISM)}. emotional_temperature: ${vocab(EMOTIONAL_TEMPERATURE)}. visual_tension: ${vocab(VISUAL_TENSION)}. negative_space_strategy: ${vocab(NEGATIVE_SPACE_STRATEGY)}.`,
    `narrative_elements is a list (at most ${MAX_NARRATIVE_ELEMENTS}) of { element, reason, zone } where zone is ${vocab(SCENE_ZONE)}; the reason must be argued in the concept. permitted_secondary_elements and forbidden_decorative_noise are lists of one-line texts.`,
    `atmosphere, material_language, lighting_intent and rationale are ONE line of plain text of at most ${ART_LIMITS.text_max} characters, with no digit at all, no colour code and no unit. rationale is one concise sentence of why, for the record; it is not a reasoning log.`,
    `narrative_elements: each element is one line of at most ${ART_LIMITS.element_max} characters and each reason one line of ${ART_LIMITS.reason_min} to ${ART_LIMITS.reason_max} characters. permitted_secondary_elements: ${0} to ${ART_LIMITS.secondary_max_items} texts of at most ${ART_LIMITS.secondary_item_max} characters. forbidden_decorative_noise: ${ART_LIMITS.noise_min_items} to ${ART_LIMITS.noise_max_items} texts of at most ${ART_LIMITS.noise_item_max} characters (what must NOT appear as decoration; you may name anything there).`,
    'The real product is protected merchant pixels placed by the system. The scene may be rich if the concept calls for it, and it must leave a calm area for the product, but it may never contain, show or describe the product or anything that could stand in for it or compete with it.',
    `Nordla REFUSES the whole answer if any narrative element or permitted secondary element contains one of these words (whole words, plurals included, English or French): product and devices: ${SUBSTITUTE_LEXICON.product_and_devices.join(', ')}; branding, price and text: ${SUBSTITUTE_LEXICON.branding_price_and_text.join(', ')}; competing hero: ${SUBSTITUTE_LEXICON.competing_hero.join(', ')}. This is about the WORD, even in a metaphor ("suggesting a screen" is refused).`,
    'If the concept\'s idea involves such an object (a screen, a device, a case, a label), express it WITHOUT naming it: through light, material, gesture, a trace, or an empty place where the system will add the real product.',
    'Every element needs a reason in the concept: no arbitrary decoration. The reason of each narrative element must contain at least one significant word that also appears in the concept\'s central_idea, visual_metaphor, story or emotional_intent (not a stop word), or the answer is refused.',
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
        schema: { keys: MODEL_KEYS, children: { narrative_elements: { items: { keys: ['element', 'reason', 'zone'] } } } }, normalize: (raw) => normalizeArtDirection(raw, { concept }),
      });
      return { art_direction: value, meta };
    },
  });
}

