// The CREATIVE AMBITION of a revision: a generic statement of the quality level a premium creative is expected to reach, handed to the revision Director as reasoning guidance.
//
// It is a level, never a motif: nothing here names a subject, an object, a colour, a typeface, a product, a campaign or an occasion. A reference creative may have been used by a person to
// say "this is the level of ambition expected"; the reference itself is never an input and none of its content can enter (the brief below is a closed, canonical object, and the revision
// Director refuses anything that is not exactly it). The Director must invent its own concept from the brief and the brand, inside what the pipeline can execute.
// These six qualities are reasoning targets of the Director; they are NOT critic dimensions (the critic's closed vocabulary is unchanged).

export const AMBITION_DIMENSION = Object.freeze({
  CONCEPT_STRENGTH: 'CONCEPT_STRENGTH',
  NARRATIVE_COHESION: 'NARRATIVE_COHESION',
  EMOTIONAL_RESONANCE: 'EMOTIONAL_RESONANCE',
  EDITORIAL_SOPHISTICATION: 'EDITORIAL_SOPHISTICATION',
  DISTINCTIVENESS: 'DISTINCTIVENESS',
  WOW_FACTOR: 'WOW_FACTOR',
});

export const AMBITION_QUESTIONS = Object.freeze({
  CONCEPT_STRENGTH: 'Is there one strong central visual idea that the whole composition serves, rather than a tidy arrangement of parts?',
  NARRATIVE_COHESION: 'Do the scene, the light, the space, the product and the texts tell one coherent story that a viewer feels at a glance?',
  EMOTIONAL_RESONANCE: 'Does it evoke a feeling that fits the occasion and the meaning the product has for the person who gives or receives it?',
  EDITORIAL_SOPHISTICATION: 'Does it have the composition, restraint and typographic intelligence of an art-directed editorial piece, rather than a retail template?',
  DISTINCTIVENESS: 'Could it only belong to this brand and this product, or could any competitor publish it unchanged?',
  WOW_FACTOR: 'Is there a memorable moment that makes a viewer stop, beyond being correct and clean?',
});

export const CREATIVE_AMBITION = Object.freeze({
  kind: 'CREATIVE_AMBITION',
  instruction: [
    'The previous direction was competent but not memorable. Do not merely clean it up: attempt a conceptual leap, a new central idea with a story and an emotion, at the level of premium craftsmanship, occasion-specific art direction and brand distinctiveness.',
    'Invent the concept yourself from the brief and the brand; copy nothing from any reference.',
    'Express the idea only through what can be executed: the environment (a surface and a backdrop, its material, light, atmosphere and colour restraint), the spatial intent, the hierarchy and the typographic character.',
    'The real product and the approved texts are fixed. Judge your own direction against the six qualities before you answer.',
  ].join(' '),
  qualities: Object.freeze(Object.values(AMBITION_DIMENSION).map((dimension) => Object.freeze({ dimension, question: AMBITION_QUESTIONS[dimension] }))),
});

/** The ambition is accepted only as exactly the canonical object (or absent): free text from anywhere else can never reach the Director through it. */
export function isCanonicalAmbition(value) {
  return JSON.stringify(value) === JSON.stringify(CREATIVE_AMBITION);
}
