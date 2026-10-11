import { principlesAsText, principlesFor, REASONING_STAGE } from './knowledge.js';
import { askAndNormalize } from './model-port.js';
import {
  BRAIN_ERROR, closed, deepFreeze, deriveId, enumOf, fail, listOf, noNumbers, oneLine, wordOverlap, wordsOf,
} from './validation.js';

// IDEATE. A concept is a central idea with a visual metaphor, a story, an emotional intent, a role for the product and for the message, a memory hook, a reason it is distinctive and its risks. Concepts
// must differ CONCEPTUALLY: a "concept" that is only a background, a colour, an alignment or a camera angle is a layout variant, and it is refused (a deterministic guard on the words, applied to the
// concept text with the vocabulary of layout, colour and camera removed). Nothing here says what any occasion looks like.

export const CONCEPT_PRODUCT_ROLE = Object.freeze({
  HERO_OF_THE_STORY: 'HERO_OF_THE_STORY', PROOF_OF_THE_STORY: 'PROOF_OF_THE_STORY', TOOL_OF_THE_STORY: 'TOOL_OF_THE_STORY', DESTINATION_OF_THE_STORY: 'DESTINATION_OF_THE_STORY',
});
export const MESSAGE_ROLE = Object.freeze({ LEADS: 'LEADS', FOLLOWS: 'FOLLOWS', EMBEDDED_IN_THE_STORY: 'EMBEDDED_IN_THE_STORY' });

const MODEL_KEYS = ['central_idea', 'visual_metaphor', 'story', 'emotional_intent', 'product_role', 'message_role', 'memory_hook', 'distinctiveness_reason', 'risks'];
const CONCEPT_KEYS = ['concept_id', ...MODEL_KEYS];
export const CONCEPT_COUNT = Object.freeze({ min: 3, max: 5 });

// the vocabulary of EXECUTION (layout, colour, camera, background, alignment, treatment) in English and French: a concept is not made of these words
const EXECUTION_WORDS = new Set([
  'background', 'backdrop', 'colour', 'color', 'colours', 'colors', 'palette', 'tone', 'shade', 'hue', 'gradient', 'align', 'aligned', 'alignment', 'centered', 'centred', 'center', 'centre', 'left', 'right', 'top', 'bottom', 'above', 'below',
  'angle', 'camera', 'lens', 'crop', 'framing', 'frame', 'layout', 'composition', 'grid', 'column', 'stack', 'size', 'bigger', 'smaller', 'larger', 'bold', 'font', 'typeface', 'serif', 'sans', 'margin', 'spacing', 'border',
  'fond', 'arrière', 'couleur', 'couleurs', 'teinte', 'dégradé', 'aligné', 'alignement', 'centré', 'centre', 'gauche', 'droite', 'haut', 'bas', 'dessus', 'dessous', 'cadrage', 'caméra', 'objectif', 'mise', 'page', 'colonne',
  'taille', 'police', 'marge', 'bleu', 'rouge', 'vert', 'noir', 'blanc', 'gris', 'beige', 'jaune', 'rose', 'blue', 'red', 'green', 'black', 'white', 'grey', 'gray', 'yellow', 'pink', 'cream', 'navy',
]);
const STOPWORDS = new Set([
  'the', 'and', 'with', 'for', 'that', 'this', 'from', 'into', 'onto', 'its', 'their', 'your', 'our', 'are', 'was', 'were', 'has', 'have', 'had', 'but', 'not', 'one', 'out', 'all', 'can', 'will', 'who', 'what', 'when', 'where',
  'les', 'des', 'une', 'aux', 'dans', 'sur', 'par', 'pour', 'avec', 'qui', 'que', 'est', 'sont', 'ses', 'leur', 'leurs', 'vous', 'nous', 'son', 'sans', 'plus', 'comme', 'cette', 'ces', 'entre', 'vers', 'chez',
]);

/** The conceptual content of a text: its words without execution vocabulary and without stopwords. */
export function conceptualWords(text) {
  return wordsOf(text).filter((w) => !EXECUTION_WORDS.has(w) && !STOPWORDS.has(w));
}
const conceptText = (c) => [c.central_idea, c.visual_metaphor, c.story, c.emotional_intent].join(' ');
const conceptualOverlap = (a, b) => wordOverlap(conceptualWords(conceptText(a)).join(' '), conceptualWords(conceptText(b)).join(' '));

const MIN_CONCEPTUAL_WORDS = 6; // distinct conceptual words in the central idea and the metaphor together
const MAX_CONCEPTUAL_OVERLAP = 0.4;
const MAX_METAPHOR_OVERLAP = 0.5;

/** One concept from a model's fields: closed, no figure, one-line texts, closed vocabularies, and conceptual (not only a matter of execution). */
export function normalizeConcept(raw, where = 'concept') {
  noNumbers(raw, where);
  const { concept_id: givenId, ...fields } = raw;
  closed(fields, MODEL_KEYS, where);
  const body = {
    central_idea: oneLine(fields.central_idea, `${where}.central_idea`),
    visual_metaphor: oneLine(fields.visual_metaphor, `${where}.visual_metaphor`),
    story: oneLine(fields.story, `${where}.story`),
    emotional_intent: oneLine(fields.emotional_intent, `${where}.emotional_intent`),
    product_role: enumOf(fields.product_role, CONCEPT_PRODUCT_ROLE, `${where}.product_role`),
    message_role: enumOf(fields.message_role, MESSAGE_ROLE, `${where}.message_role`),
    memory_hook: oneLine(fields.memory_hook, `${where}.memory_hook`),
    distinctiveness_reason: oneLine(fields.distinctiveness_reason, `${where}.distinctiveness_reason`),
    risks: listOf(fields.risks, `${where}.risks`, { min: 1, max: 4 }, (v, w) => oneLine(v, w, { max: 200 })),
  };
  const content = new Set([...conceptualWords(body.central_idea), ...conceptualWords(body.visual_metaphor)]);
  if (content.size < MIN_CONCEPTUAL_WORDS) fail(BRAIN_ERROR.NOT_DISTINCT, `${where} is not a concept: once layout, colour and camera words are removed almost nothing is left`, where, { problem: 'CONCEPT_IS_A_LAYOUT_VARIANT' });
  const id = deriveId('cnc', body);
  if (givenId !== undefined && givenId !== id) fail(BRAIN_ERROR.RULE_VIOLATION, `${where}.concept_id does not follow from the content`, `${where}.concept_id`);
  return deepFreeze({ concept_id: id, ...body });
}

/**
 * The concepts must differ conceptually from each other and from any concept already rejected: a pair whose central idea, metaphor, story and intent overlap in substance, or whose visual
 * metaphors are nearly the same, is refused, however different their backgrounds, colours, alignments or camera angles.
 */
export function assertConceptsDistinct(concepts, { against = [] } = {}) {
  const all = [...concepts.map((c) => ({ c, own: true })), ...against.map((c) => ({ c, own: false }))];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      if (!all[i].own && !all[j].own) continue;
      const overlap = conceptualOverlap(all[i].c, all[j].c);
      const metaphor = wordOverlap(conceptualWords(all[i].c.visual_metaphor).join(' '), conceptualWords(all[j].c.visual_metaphor).join(' '));
      if (overlap > MAX_CONCEPTUAL_OVERLAP || metaphor > MAX_METAPHOR_OVERLAP) {
        fail(BRAIN_ERROR.NOT_DISTINCT, 'two concepts are not conceptually distinct', 'concepts', { problem: 'CONCEPTS_NOT_DISTINCT', pair: [all[i].c.concept_id, all[j].c.concept_id], against_rejected: !all[i].own || !all[j].own });
      }
    }
  }
  return concepts;
}

/** The set of concepts of a round: a bounded number, each a concept, all distinct (and distinct from the concepts already rejected). */
export function normalizeConceptSet(rawList, { rejected = [], count = CONCEPT_COUNT } = {}) {
  const concepts = listOf(rawList, 'concepts', { min: count.min, max: count.max }, (raw, where) => normalizeConcept(raw, where));
  if (new Set(concepts.map((c) => c.concept_id)).size !== concepts.length) fail(BRAIN_ERROR.NOT_DISTINCT, 'the same concept appears twice', 'concepts', { problem: 'CONCEPTS_NOT_DISTINCT' });
  assertConceptsDistinct(concepts, { against: rejected });
  return deepFreeze(concepts);
}

export function buildConceptInstruction({ frame, rejected = [], refine = null, count = CONCEPT_COUNT }) {
  const system = [
    'You are the Nordla concept director. From the creative problem frame you invent several GENUINELY DIFFERENT concepts before any layout, scene or colour is chosen.',
    `Return ONLY one JSON object: { "concepts": [ ... ] } with ${count.min === count.max ? `exactly ${count.min}` : `${count.min} to ${count.max}`} concepts. Each concept has exactly these keys: ${MODEL_KEYS.join(', ')}.`,
    `product_role is one of: ${Object.values(CONCEPT_PRODUCT_ROLE).join(', ')}. message_role is one of: ${Object.values(MESSAGE_ROLE).join(', ')}. risks is a list of one to four short one-line texts. Every other value is ONE line of plain text of at most 300 characters.`,
    'Concepts must differ in their central idea, metaphor and story, not merely in background, colour, alignment or camera angle: a variation of layout is not a concept and will be refused. Every concept must lead back to the product.',
    'Do not reach for the image that usually comes with an occasion: argue the concept from the occasion\'s register, the relationship between giver and receiver and the moment in time, for this product.',
    'You never use numbers, coordinates or sizes. You never write the approved texts, prices or claims. Do not describe your reasoning: give the fields only.',
    ...(refine ? ['One concept is to be REFINED, not replaced: return an improved version of it (same central idea, stronger on the points below) as the first concept, then new concepts that differ from it.', `Concept to refine: ${refine.concept.central_idea} / ${refine.concept.visual_metaphor}`, ...refine.refinements.map((x) => `- improve: ${x}`)] : []),
    ...(rejected.length ? ['Concepts already rejected (do not return the same idea again, in any wording or setting):', ...rejected.map((c) => `- ${c.central_idea} / ${c.visual_metaphor}`)] : []),
    'Reason with these principles of art direction:',
    principlesAsText(principlesFor({ stage: REASONING_STAGE.IDEATE })),
  ].join('\n');
  return { system, user: JSON.stringify({ problem_frame: frame }) };
}

/** The IDEATE stage: one model completion, then the closed contract and the distinctness guard. */
export function createConceptDirector({ complete, count = CONCEPT_COUNT }) {
  return Object.freeze({
    async ideate({ frame, rejected = [], refine = null }) {
      const { value, meta } = await askAndNormalize({
        complete, instruction: buildConceptInstruction({ frame, rejected, refine, count }), stage: 'IDEATE', schema: { keys: ['concepts'], children: { concepts: { items: { keys: MODEL_KEYS } } } },
        normalize: (raw) => { closed(raw, ['concepts'], 'answer'); return normalizeConceptSet(raw.concepts, { rejected, count }); },
      });
      return { concepts: value, meta };
    },
  });
}
