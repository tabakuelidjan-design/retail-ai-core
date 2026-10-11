import { BRAIN_ERROR, deepFreeze, fail } from './validation.js';

// The CREATIVE KNOWLEDGE of Nordla: principles of art direction, each with its PURPOSE, the conditions where it applies, its FAILURE MODES and the principles it is in TENSION with. It is knowledge to
// reason with, never a rule table: a principle says why something works and how it fails, so that a decision can be argued in context (dominance is contextual, symmetry is not a fault, a stock
// association is not a concept). It holds no figure, no coordinate, no brand, no product, no campaign, and no motif: nothing here says what a given occasion looks like; the OCCASION_INTELLIGENCE
// principles say how to REASON toward a concept that suits an occasion, so that two occasions never share a stock image by default.

export const KNOWLEDGE_DOMAIN = Object.freeze({
  ATTENTION: 'ATTENTION',
  HIERARCHY: 'HIERARCHY',
  COMPOSITION: 'COMPOSITION',
  STORYTELLING: 'STORYTELLING',
  PREMIUM_CRAFT: 'PREMIUM_CRAFT',
  COMMERCIAL_COMMUNICATION: 'COMMERCIAL_COMMUNICATION',
  DISTINCTIVENESS: 'DISTINCTIVENESS',
  OCCASION_INTELLIGENCE: 'OCCASION_INTELLIGENCE',
});

/** The stages of the creative reasoning a principle supports. */
export const REASONING_STAGE = Object.freeze({
  OBSERVE: 'OBSERVE', FRAME: 'FRAME', IDEATE: 'IDEATE', SELECT_CONCEPT: 'SELECT_CONCEPT', ART_DIRECT: 'ART_DIRECT', COMPOSE: 'COMPOSE', PRODUCE: 'PRODUCE', CRITIQUE: 'CRITIQUE', DIAGNOSE: 'DIAGNOSE',
});

const S = REASONING_STAGE;
const p = (id, domain, name, principle, purpose, whenItApplies, failureModes, tensions, stages) => ({
  id, domain, name, principle, purpose, when_it_applies: whenItApplies, failure_modes: failureModes, tensions, stages,
});

const PRINCIPLES = [
  // ---- ATTENTION
  p('ATT-FOCAL', 'ATTENTION', 'One focal point', 'A composition has one thing the eye lands on first; everything else is arranged to lead to it or to rest.',
    'A viewer decides in a glance what to look at: a clear focal point makes the decision effortless.', 'Always, but what the focal point IS depends on the concept.',
    ['two elements of equal weight fight for first attention', 'the focal point is a decoration rather than the subject of the message', 'no focal point: the eye wanders and leaves'], ['ATT-ENTRY', 'HIE-CONTEXTUAL'], [S.FRAME, S.COMPOSE, S.CRITIQUE]),
  p('ATT-ENTRY', 'ATTENTION', 'Entry point and eye path', 'The eye needs a place to enter and a route to follow: an entry point, then a path that ends on the message and the product.',
    'A path turns a set of elements into a reading; without it the viewer assembles the picture alone.', 'Whenever several elements compete or a story is told through the image.',
    ['the path leads out of the frame', 'the path ends on a secondary element', 'the route crosses the text and breaks its reading'], ['ATT-FOCAL'], [S.ART_DIRECT, S.COMPOSE, S.CRITIQUE]),
  p('ATT-SALIENCE', 'ATTENTION', 'Salience is relative', 'Contrast, scale, isolation, sharpness and colour make an element salient only relative to its surroundings.',
    'Attention is not a property of an element but of its difference from its context.', 'When deciding what should stand out and what should recede.',
    ['everything is emphasized so nothing stands out', 'salience is spent on an element that carries no meaning'], ['ATT-FOCAL'], [S.ART_DIRECT, S.COMPOSE]),
  p('ATT-WEIGHT', 'ATTENTION', 'Visual weight', 'Every element carries visual weight; weight can be balanced by distance, by contrast or by empty space, not only by symmetry.',
    'Weight explains why a composition feels stable, tense or heavy on one side.', 'When judging balance or placing elements relative to each other.',
    ['a heavy block overpowers the subject it should serve', 'balance is achieved only by centring, producing a rigid, mechanical stack'], ['COM-BALANCE'], [S.COMPOSE, S.CRITIQUE]),
  // ---- HIERARCHY
  p('HIE-CONTEXTUAL', 'HIERARCHY', 'Dominance is contextual', 'What should dominate depends on the intent: a product hero usually needs immediate recognition, but an emotional idea may attract attention first if it clearly resolves back to the product.',
    'Dominance serves the message; it is not a fixed rule that the product is always largest or the headline always first.', 'When the concept relies on a narrative or a feeling before an offer.',
    ['the concept pulls attention away and never resolves to the product', 'the product dominates so completely that the idea has no room to exist', 'the headline dominates by habit rather than by need'], ['ATT-FOCAL', 'COM-RECOGNITION'], [S.IDEATE, S.SELECT_CONCEPT, S.COMPOSE, S.CRITIQUE]),
  p('HIE-LEVELS', 'HIERARCHY', 'Distinct levels', 'A hierarchy has few levels, each clearly different from the next in role, weight and treatment.',
    'Levels let a viewer read in order of importance without effort.', 'When several texts and visual elements share the frame.',
    ['levels differ by size only and feel like a list', 'two levels look alike and merge', 'too many levels dilute the order'], ['HIE-CONTEXTUAL'], [S.COMPOSE, S.CRITIQUE]),
  p('HIE-PROPORTION', 'HIERARCHY', 'Proportion of emphasis', 'Emphasis is proportionate to the role: a text or block may be clear and still too heavy for what it says.',
    'Weight that exceeds the role steals attention from what matters.', 'When a block, a plate or a price is given a graphic treatment.',
    ['a clear block that overpowers the subject', 'a price or label treated as a second hero', 'heavy containers that make the layout feel assembled'], ['ATT-WEIGHT'], [S.COMPOSE, S.CRITIQUE]),
  // ---- COMPOSITION
  p('COM-BALANCE', 'COMPOSITION', 'Balance without rigidity', 'Balance can be symmetrical or asymmetrical; intentional asymmetry creates tension and movement while staying stable.',
    'A composition feels considered when its balance is chosen, not defaulted.', 'When a layout reads as a centred stack or a template.',
    ['perfect symmetry used because it is easy', 'asymmetry that feels accidental and unresolved'], ['ATT-WEIGHT'], [S.ART_DIRECT, S.COMPOSE, S.CRITIQUE]),
  p('COM-RHYTHM', 'COMPOSITION', 'Rhythm and tension', 'Repetition, interval and contrast of mass create rhythm; a controlled tension keeps the eye engaged.',
    'Rhythm gives a still image a sense of time and intention.', 'When the image feels static or evenly spaced.',
    ['monotonous spacing', 'tension with no resolution', 'rhythm made of decorative repetition'], ['COM-NEGATIVE'], [S.ART_DIRECT, S.COMPOSE]),
  p('COM-NEGATIVE', 'COMPOSITION', 'Negative space with a job', 'Empty space is an element: it frames the subject, separates groups, gives rest and directs the eye.',
    'Space that has a job reads as confidence; space left over reads as emptiness.', 'When the frame feels crowded or hollow.',
    ['dead zones that belong to nothing', 'space reserved on one side only because text is there', 'crowding that leaves no rest'], ['COM-DEPTH'], [S.ART_DIRECT, S.COMPOSE, S.CRITIQUE]),
  p('COM-DEPTH', 'COMPOSITION', 'Depth layers', 'Foreground, midground and background give the image depth; the subject is placed in a relationship with them rather than pasted over them.',
    'Depth makes a scene believable and lets the product belong to it.', 'When the product must feel integrated with its surroundings.',
    ['the subject floats on a flat background', 'layers compete with the subject', 'depth cues that contradict each other'], ['PRE-INTEGRATION'], [S.ART_DIRECT, S.COMPOSE, S.CRITIQUE]),
  p('COM-GROUPING', 'COMPOSITION', 'Grouping and alignment', 'Elements that belong together are grouped by proximity and aligned to a shared axis; groups are separated by more space than their members.',
    'Grouping tells the viewer what goes with what before any word is read.', 'When several texts, a price and a claim share the frame.',
    ['every element is spaced the same, so nothing is grouped', 'alignments that do not share an axis', 'a group split by an unrelated element'], ['HIE-LEVELS'], [S.COMPOSE, S.CRITIQUE]),
  p('COM-SCALE', 'COMPOSITION', 'Scale relationships', 'The relationship of scale between elements communicates importance, distance and drama.',
    'A deliberate jump in scale creates emphasis; a timid difference looks like an accident.', 'When choosing how large the subject and the text are relative to each other and to the frame.',
    ['neighbouring elements of nearly equal scale', 'scale used for impact with no meaning behind it'], ['HIE-PROPORTION'], [S.COMPOSE]),
  // ---- STORYTELLING
  p('STO-IDEA', 'STORYTELLING', 'A central idea', 'A strong image serves one central idea that can be said in a sentence and felt in a glance.',
    'One idea makes every other decision easy to justify; several ideas dilute each other.', 'At the start of every creative.',
    ['a tidy arrangement of parts with no idea', 'an idea so abstract it cannot be seen', 'several ideas competing'], ['DIS-REASON'], [S.IDEATE, S.SELECT_CONCEPT, S.CRITIQUE]),
  p('STO-METAPHOR', 'STORYTELLING', 'Visual metaphor with a bridge', 'A visual metaphor works when the viewer can cross from the image to the product through a bridge the image itself provides.',
    'The metaphor must lead back to what is being offered; otherwise it is decoration.', 'When the idea is expressed through a scene, a material or a gesture.',
    ['a metaphor with no bridge to the product', 'a literal depiction mistaken for a metaphor', 'a metaphor the audience cannot read'], ['STO-IDEA', 'COM-RECOGNITION'], [S.IDEATE, S.SELECT_CONCEPT, S.ART_DIRECT]),
  p('STO-PROGRESSION', 'STORYTELLING', 'Narrative progression', 'A story in a still image is a progression the eye can follow: before, during and after, or cause and effect, laid out along the reading path.',
    'Progression turns a scene into a story.', 'When the concept relies on a narrative device.',
    ['elements that tell nothing in sequence', 'a progression running against the reading direction'], ['ATT-ENTRY'], [S.ART_DIRECT, S.COMPOSE]),
  p('STO-PAYOFF', 'STORYTELLING', 'Emotional payoff', 'A story ends on a feeling the viewer can name; the payoff is what is remembered.',
    'Without a payoff the image is informative but forgettable.', 'When the objective includes being remembered or felt.',
    ['the feeling is stated in words instead of produced by the image', 'the payoff is borrowed from a stock association'], ['OCC-REGISTER'], [S.FRAME, S.IDEATE, S.CRITIQUE]),
  p('STO-RELATION', 'STORYTELLING', 'Concept and product relationship', 'The product is either the hero of the story, its proof, its tool or its destination; the relation must be clear and necessary.',
    'A concept that could exist without the product is not a concept for it.', 'When choosing the role of the product in the idea.',
    ['the product is added after the idea', 'the product is hidden by the story', 'the product role changes between the image and the text'], ['HIE-CONTEXTUAL'], [S.IDEATE, S.SELECT_CONCEPT]),
  // ---- PREMIUM CRAFT
  p('PRE-RESTRAINT', 'PREMIUM_CRAFT', 'Restraint', 'Premium is mostly what is left out: few elements, each with a reason, treated with care.',
    'Restraint signals confidence and lets craft be seen.', 'Always for a premium brand.',
    ['decoration used to feel rich', 'restraint mistaken for emptiness', 'plain because nothing was decided'], ['DIS-REASON'], [S.ART_DIRECT, S.CRITIQUE]),
  p('PRE-MATERIAL', 'PREMIUM_CRAFT', 'Material credibility', 'Materials look credible when texture, wear, reflectance and scale agree with how the material behaves in light.',
    'Credible material is the cheapest way to look expensive and the first thing a viewer distrusts.', 'When the scene uses surfaces, structures or objects.',
    ['uniform texture that reads as a filter', 'a material at a scale that contradicts its nature', 'artificial gloss, glow or gold used to simulate luxury'], ['PRE-LIGHT'], [S.ART_DIRECT, S.PRODUCE, S.CRITIQUE]),
  p('PRE-LIGHT', 'PREMIUM_CRAFT', 'Light with a direction', 'Light has a source, a direction, a quality and a temperature; consistent light makes a scene believable and shapes mood.',
    'Light is the main carrier of atmosphere and depth.', 'When describing atmosphere or integrating a product into a scene.',
    ['flat light that gives no depth', 'two light directions in one image', 'light that contradicts the story'], ['COM-DEPTH'], [S.ART_DIRECT, S.PRODUCE, S.CRITIQUE]),
  p('PRE-INTEGRATION', 'PREMIUM_CRAFT', 'Integration of the subject', 'A subject belongs to a scene when its contact, its shadow, its scale and its light agree with the scene.',
    'A pasted subject breaks the image however good each part is.', 'When an authoritative product is placed into a generated scene.',
    ['no grounding or contact', 'a shadow that disagrees with the light', 'the scene is an afterthought behind the subject'], ['COM-DEPTH', 'PRE-LIGHT'], [S.ART_DIRECT, S.COMPOSE, S.CRITIQUE]),
  p('PRE-TYPE', 'PREMIUM_CRAFT', 'Typography as part of the image', 'Typography is composed with the image: its scale, alignment, weight and spacing answer to the subject and to the space around it.',
    'Type that ignores the image looks laid on top of it.', 'When text and image share the frame.',
    ['text blocks dropped into free space', 'type treatments that fragment the message', 'a heavy container used to rescue legibility'], ['HIE-PROPORTION'], [S.ART_DIRECT, S.COMPOSE, S.CRITIQUE]),
  p('PRE-DETAIL', 'PREMIUM_CRAFT', 'Crafted detail', 'Small details that are consistent and justified signal care; careless details signal a generated or templated image.',
    'Detail is where a viewer decides whether something is crafted.', 'When inspecting edges, transitions and micro-structure.',
    ['inconsistent detail across the image', 'detail added for richness with no reason'], ['PRE-RESTRAINT'], [S.PRODUCE, S.CRITIQUE]),
  // ---- COMMERCIAL COMMUNICATION
  p('COM-RECOGNITION', 'COMMERCIAL_COMMUNICATION', 'Product recognition', 'The product must be recognizable in the time the viewer gives the image, whatever the concept.',
    'An idea that hides what is sold cannot sell it.', 'Always.',
    ['the concept obscures the product', 'the product is recognizable only after reading the text'], ['HIE-CONTEXTUAL'], [S.FRAME, S.SELECT_CONCEPT, S.CRITIQUE]),
  p('COM-OFFER', 'COMMERCIAL_COMMUNICATION', 'Offer and claim clarity', 'The offer and the approved claims are stated once, plainly, in the order of their importance to the buyer.',
    'Clarity of the offer is what turns attention into a decision.', 'When a claim or a price is part of the creative.',
    ['claims that compete with each other', 'a claim buried in the concept', 'wording changed to suit the layout'], ['HIE-LEVELS'], [S.FRAME, S.COMPOSE, S.CRITIQUE]),
  p('COM-PRICE', 'COMMERCIAL_COMMUNICATION', 'The role of the price', 'A price is information the buyer looks for, not a hero: it is easy to find, quiet in treatment, and consistent with the tone of the brand.',
    'A price treated as a second hero reads as a promotion; a hidden price reads as evasion.', 'When a price is part of the creative.',
    ['a price block as heavy as the headline', 'a price with a style that clashes with the rest', 'a price that is hard to find'], ['HIE-PROPORTION'], [S.COMPOSE, S.CRITIQUE]),
  p('COM-EMPHASIS', 'COMMERCIAL_COMMUNICATION', 'Emotional versus transactional emphasis', 'A creative leans toward feeling or toward the transaction; the balance is chosen by the objective and kept consistent.',
    'Mixed emphasis confuses both goals.', 'When the objective includes both being remembered and selling.',
    ['transactional elements breaking an emotional idea', 'an emotional idea with no way to act'], ['STO-PAYOFF'], [S.FRAME, S.COMPOSE]),
  // ---- DISTINCTIVENESS
  p('DIS-REASON', 'DISTINCTIVENESS', 'A reason for every element', 'Every visual element exists for a reason that can be stated in terms of the concept; an element without a reason is removed.',
    'Reasons are what separate a designed image from a decorated one.', 'At every stage, and in every critique.',
    ['arbitrary decoration', 'elements added because similar images have them', 'a reason invented afterwards'], ['PRE-RESTRAINT'], [S.IDEATE, S.ART_DIRECT, S.CRITIQUE]),
  p('DIS-GENERIC', 'DISTINCTIVENESS', 'Generic is a defect', 'An image that any competitor could publish unchanged is generic; distinctiveness comes from the brand, the product, the occasion and the idea, in combination.',
    'A generic image is invisible in a feed.', 'When comparing concepts or judging a candidate.',
    ['a template with a different background', 'common generated-image tropes used as style', 'distinctiveness reduced to a colour'], ['DIS-REASON'], [S.FRAME, S.SELECT_CONCEPT, S.CRITIQUE]),
  p('DIS-MEMORY', 'DISTINCTIVENESS', 'A memory hook', 'A memorable image has one hook: a single image, gesture or contrast the viewer can recall and describe.',
    'What cannot be described cannot be remembered.', 'When the objective includes being remembered.',
    ['no memory hook at all', 'several hooks that cancel each other', 'a hook that is only a novelty'], ['STO-IDEA'], [S.FRAME, S.IDEATE, S.SELECT_CONCEPT, S.CRITIQUE]),
  // ---- OCCASION INTELLIGENCE
  p('OCC-REGISTER', 'OCCASION_INTELLIGENCE', 'Emotional register of an occasion', 'Every occasion has an emotional register (its mood, its stakes, its tempo); a concept must suit that register before it suits anything else.',
    'Two occasions that share a mood can share a tone; occasions with different registers must not share an emotional language.', 'Whenever the product is given, shown or bought for an occasion.',
    ['one emotional language applied to every occasion', 'a mood that contradicts the stakes of the occasion'], ['OCC-RELATION'], [S.FRAME, S.IDEATE, S.SELECT_CONCEPT]),
  p('OCC-RELATION', 'OCCASION_INTELLIGENCE', 'Who gives, who receives', 'The relationship between the person who gives and the person who receives shapes what is appropriate: intimacy, ceremony, humour, gratitude or pride.',
    'The same product means different things depending on the relationship it expresses.', 'When the audience is a buyer who gives to someone.',
    ['addressing the wrong person in the relationship', 'a tone that suits the buyer but not the recipient'], ['OCC-REGISTER'], [S.FRAME, S.IDEATE]),
  p('OCC-TIME', 'OCCASION_INTELLIGENCE', 'The moment in time', 'An occasion has a temporal quality (anticipation, arrival, keeping, remembering); the concept can live in one moment of it and make that moment felt.',
    'A single moment is easier to picture than a whole occasion.', 'When choosing what the image is a picture of.',
    ['an image of the occasion in general', 'a moment that does not belong to the occasion'], ['STO-PROGRESSION'], [S.IDEATE, S.ART_DIRECT]),
  p('OCC-NO-SHORTCUT', 'OCCASION_INTELLIGENCE', 'No stock association', 'A concept chosen because an occasion usually comes with a familiar image is a shortcut, not a concept: the image must be argued from the register, the relationship and the moment of this occasion and this product.',
    'Stock associations make every campaign for an occasion look alike.', 'Always, and especially when an association comes to mind first.',
    ['the first familiar image is used without being argued', 'a motif repeated across campaigns because it worked once', 'the occasion reduced to a symbol'], ['DIS-GENERIC', 'DIS-REASON'], [S.IDEATE, S.SELECT_CONCEPT, S.CRITIQUE]),
  p('OCC-PRODUCT-FIT', 'OCCASION_INTELLIGENCE', 'The product in the occasion', 'The product earns its place in the occasion through what it does for the people in it, not through proximity to a symbol.',
    'A concept is credible when the product is necessary to the feeling.', 'When tying a product to an occasion.',
    ['the product is only placed near the occasion symbol', 'a generic gift story that fits any product'], ['STO-RELATION'], [S.FRAME, S.IDEATE, S.SELECT_CONCEPT]),
];

const FIELDS = ['id', 'domain', 'name', 'principle', 'purpose', 'when_it_applies', 'failure_modes', 'tensions', 'stages'];

/** Verifies the knowledge itself: complete entries, a purpose and failure modes for every principle, known tensions and stages, no figure. Throws on the first defect. */
export function validateKnowledge(principles) {
  const ids = new Set(principles.map((x) => x.id));
  if (ids.size !== principles.length) fail(BRAIN_ERROR.RULE_VIOLATION, 'a principle id is repeated', 'knowledge');
  for (const x of principles) {
    for (const key of FIELDS) if (!(key in x)) fail(BRAIN_ERROR.MISSING_KEY, `${x.id}.${key} is missing`, `${x.id}.${key}`);
    if (!Object.values(KNOWLEDGE_DOMAIN).includes(x.domain)) fail(BRAIN_ERROR.ENUM_INVALID, `${x.id}.domain`, `${x.id}.domain`);
    if (typeof x.name !== 'string' || x.name.length < 4) fail(BRAIN_ERROR.TEXT_INVALID, `${x.id}.name`, `${x.id}.name`);
    for (const key of ['principle', 'purpose', 'when_it_applies']) if (typeof x[key] !== 'string' || x[key].length < 6) fail(BRAIN_ERROR.TEXT_INVALID, `${x.id}.${key}`, `${x.id}.${key}`);
    if (!x.failure_modes.length) fail(BRAIN_ERROR.RULE_VIOLATION, `${x.id} has no failure mode`, `${x.id}.failure_modes`);
    for (const t of x.tensions) if (!ids.has(t)) fail(BRAIN_ERROR.RULE_VIOLATION, `${x.id} names an unknown tension`, `${x.id}.tensions`);
    for (const st of x.stages) if (!Object.values(REASONING_STAGE).includes(st)) fail(BRAIN_ERROR.ENUM_INVALID, `${x.id}.stages`, `${x.id}.stages`);
    if (/[0-9]/.test(JSON.stringify({ ...x, id: '' }))) fail(BRAIN_ERROR.NUMERIC_VALUE, `${x.id} holds a figure`, x.id);
  }
  return principles;
}

export const CREATIVE_KNOWLEDGE = deepFreeze(validateKnowledge(PRINCIPLES));
export const principleById = (id) => CREATIVE_KNOWLEDGE.find((x) => x.id === id) ?? null;

/** The principles of some domains and / or supporting a stage, in a stable order. */
export function principlesFor({ domains = null, stage = null } = {}) {
  return CREATIVE_KNOWLEDGE.filter((x) => (!domains || domains.includes(x.domain)) && (!stage || x.stages.includes(stage)));
}

/** A compact text projection of principles for a model instruction (adapter-level): id, principle, purpose, and how it fails. Never anything about a brand, a product or an occasion. */
export function principlesAsText(principles) {
  return principles.map((x) => `${x.id} ${x.name}: ${x.principle} Why: ${x.purpose} Fails when: ${x.failure_modes.join('; ')}.`).join('\n');
}
