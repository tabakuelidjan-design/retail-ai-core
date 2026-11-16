// CREATIVE STAGE ALONE (2026-11-08): Nordla's own model invents THREE advertising concepts for ONE product and ONE campaign, then chooses one, WITHOUT the technical contract of the composition (no placement, no reserve, no palette, no scene vocabulary).
// It keeps what the concept cannot ignore: the verified facts, the identity of the brand, the campaign (public, occasion, objective, offer) and the physical limits of the real product (it is placed as photographed and never transformed).
// The concept is prose, in French, for the owner to read. The composition (ad-composition.js) comes later and must DEVELOP the chosen concept faithfully, never replace it. The code writes no artistic content and adds no lexical guard: only the structure of the answer is checked.
import { obj, text, word, list, renderContract } from '../creative-brain/contract.js';
import { STARTING_POINTS } from './ad-composition.js';
import { ask } from './reference-direction.js';

export const CONCEPT_MAX_OUTPUT_TOKENS = 3200;
const free = (max) => text({ max, fit: true });
export const PRODUCT_UNCHANGEABLE = 'THE PRODUCT IS REAL AND UNCHANGEABLE. It appears as the photograph shows it: its shape, size, colours, parts (cables, straps, lids) and pose are never altered, and it is placed in the scene as it is. An idea that needs it transformed (melted, opened, transparent, resized, recoloured, split, floating apart, shown in use by hands) cannot be used. scene_prohibitions lists what a scene never holds. The light of the scene must be compatible with the soft, even light of the packshot (the side it comes from is product_facts.lit_side_of_the_photograph).';
export const VERIFIED_FACTS_ONLY = 'Verified facts only: any promise in a concept (idea or headline) must rest on verified_facts, listed by id in supported_by (it may stay empty). Never invent a capability, a duration, a number or a fact about the world; if a concept uses a real place or object, rely only on what you are sure is true. No benefit is required.';
export const CHOICES = Object.freeze({ ONE: 'ONE', TWO: 'TWO', THREE: 'THREE' });

export const conceptSpec = (factIds = []) => obj({
  concepts: list(obj({
    name: free(60),
    starting_point: word(STARTING_POINTS),
    product_trait: free(220),
    idea: free(520),
    link_to_product: free(260),
    speaks_to_the_public: free(260),
    headline: free(100),
    supported_by: list(word(Object.fromEntries(factIds.map((i) => [i, i]))), { min: 0, max: 4 }),
  }), { min: 3, max: 3 }),
  how_they_differ: free(260),
  choice: word(CHOICES),
  why_this_one: free(320),
});

export function conceptInstruction({ brief, productFacts, verifiedFacts, sceneProhibitions = [], hints = [] }) {
  const spec = conceptSpec(verifiedFacts.map((f) => f.id));
  const system = [
    'You are the Nordla creative director. You are shown the PHOTOGRAPH of one product (image labelled PRODUCT). You invent advertising concepts for it, for ONE campaign defined in the brief. Write everything for the owner to read, in French (fr-BE), in the voice of the brand.',
    'Look at the product itself: what it is, what it does, the technology it carries, its design (form, proportions, colours, materials, finish, details) and its verified characteristics (product_facts, verified_facts). Then read the campaign: brief.audience, brief.occasion, brief.objective and brief.offer, and the brand: brief.merchant_identity, brief.merchant_voice.',
    'Propose THREE concepts for genuinely different universes: different in kind, not in colour or in material. A situation of use, a scene with objects or an abstract creation can all work, and none is imposed. Each concept is a complete commercial proposal: what the viewer sees (the universe, the place of the product, the light, the mood), why it comes from THIS product (its design or its function), why it speaks to the public of the campaign, and the headline you imagine.',
    'The public in the brief shapes the concepts; do not deduce tastes from an age alone. When brief.audience is null the public is not defined: do not invent a target.',
    PRODUCT_UNCHANGEABLE,
    VERIFIED_FACTS_ONLY,
    'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...renderContract(spec, 'answer'),
    'how_they_differ says how the three differ in kind; choice is the concept you retain and why_this_one says why it is the strongest for this campaign. The composition will later develop the concept you choose, faithfully. Be concise: respect the lengths, an answer that is cut off is refused.',
    ...(hints.length ? ['A previous answer was refused for these reasons: fix exactly these, keep the rest:', ...hints.map((h) => `- ${h}`)] : []),
  ].join('\n');
  const user = JSON.stringify({ brief, product_facts: productFacts, verified_facts: verifiedFacts, scene_prohibitions: sceneProhibitions });
  return { system, user, max_output_tokens: CONCEPT_MAX_OUTPUT_TOKENS };
}

/** One ask, at most one repair that names the structural refusals. Nothing else is detected: the strength of a concept is the owner's judgement. */
export const runConceptCreation = ({ complete, brief, productFacts, verifiedFacts, sceneProhibitions, maxRepairs = 1 }) => ask({
  complete, stage: 'DIRECTION_CONCEPTS', spec: conceptSpec(verifiedFacts.map((f) => f.id)), maxRepairs,
  build: (hints) => conceptInstruction({ brief, productFacts, verifiedFacts, sceneProhibitions, hints }),
  violationsOf: () => [],
});
