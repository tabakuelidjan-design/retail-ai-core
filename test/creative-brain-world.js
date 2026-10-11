import { buildBrief } from './runtime-world.js';

// A synthetic Creative Brain world: scripted answers of fake language-model ports (no network, no provider, no cost). The content is generic and invented for the tests: it follows no benchmark.

export const frameAnswer = (over = {}) => ({
  what_we_show: 'A personalised phone case that carries a customer photograph, made locally and quickly.',
  audience: 'People who give or keep a personal object that holds a memory they look at every day.',
  understood_immediately: 'A real personalised case with the customer picture printed on it, ready in minutes.',
  felt: 'Being thought of: the warmth of an object made for one person.',
  remembered: 'The idea that a photo you look at daily becomes something you can hold.',
  commercial_objective: 'Make the offer clear and desirable enough to prompt a visit or an order.',
  occasion_context: 'A personal gift or a treat for oneself, without a single fixed occasion.',
  generic_risks: ['a product on a plain background with text stacked around it', 'warm gradients and decoration used to feel rich'],
  distinctive_levers: ['the made-to-order, local craft', 'the personal picture that only this customer has'],
  rationale: 'The product is personal and quick to make, so the frame favours care and craft over shine.',
  ...over,
});

export const CONCEPTS = [
  {
    central_idea: 'The keepsake as proof of attention: a made-to-order object that shows someone was thought of, finished in a single sitting.',
    visual_metaphor: 'A workshop bench at dusk where one finished piece rests after the last pass of the machine, tools still warm.',
    story: 'A maker completes one personal piece for one person and sets it down; the care taken in the making is the message.',
    emotional_intent: 'Quiet pride and the warmth of being thought of.',
    product_role: 'PROOF_OF_THE_STORY',
    message_role: 'EMBEDDED_IN_THE_STORY',
    memory_hook: 'The single finished piece resting where the work was done.',
    distinctiveness_reason: 'It shows how this product is made, locally and quickly, which a stock studio shot never can.',
    risks: ['the workshop could read as industrial and cold', 'tools could compete with the finished piece'],
  },
  {
    central_idea: 'The memory leaves the screen and joins the daily carry: the picture people glance at constantly becomes something they hold.',
    visual_metaphor: 'A drift of small private moments gathering into one tangible keepsake held in an open hand.',
    story: 'Moments that lived only on a glass surface are gathered, given weight and returned to the person they belong to.',
    emotional_intent: 'Tender recognition of what matters most.',
    product_role: 'DESTINATION_OF_THE_STORY',
    message_role: 'FOLLOWS',
    memory_hook: 'The moment where scattered pictures become one object in a hand.',
    distinctiveness_reason: 'It dramatizes the transformation from a digital memory to a physical object, the one thing this offer does.',
    risks: ['the gathering could look like a generic particle effect', 'a hand could be mistaken for the hero'],
  },
  {
    central_idea: 'A surprise prepared in minutes for someone who expects nothing, ready before they arrive.',
    visual_metaphor: 'A quiet entrance lit from within, with a small prepared gift waiting on a ledge for the person about to come in.',
    story: 'Someone slips away, makes the gift while the moment is still fresh, and leaves it ready; arrival is the payoff.',
    emotional_intent: 'Anticipation and the small thrill of giving without announcing it.',
    product_role: 'HERO_OF_THE_STORY',
    message_role: 'LEADS',
    memory_hook: 'The gift waiting in the light before anyone has seen it.',
    distinctiveness_reason: 'It turns the speed of the service into the emotion of the gesture.',
    risks: ['the entrance could dominate and hide the product', 'waiting scenes can feel staged'],
  },
];

export const criteriaOf = (outcomes = {}, evidence = 'Concrete evidence that supports this judgment.') => [
  'CONCEPT_STRENGTH', 'RELEVANCE_TO_BRIEF', 'EMOTIONAL_RESONANCE', 'PRODUCT_RELATIONSHIP', 'DISTINCTIVENESS', 'FEASIBILITY', 'BRAND_COMPATIBILITY', 'COMMERCIAL_CLARITY', 'NARRATIVE_COHESION', 'GENERIC_RISK',
].map((criterion) => ({ criterion, outcome: outcomes[criterion] ?? 'MEETS', evidence, ...(outcomes[criterion] && outcomes[criterion] !== 'MEETS' ? { refinement: 'Make this point stronger in plain terms.' } : {}) }));

export const evaluationsAnswer = (concepts, perConcept) => ({ evaluations: concepts.map((c, i) => ({ concept_id: c.concept_id, criteria: criteriaOf(perConcept[i] ?? {}) })) });

export const artDirectionAnswer = (over = {}) => ({
  atmosphere: 'A dusk workshop, calm and focused, warm only where the work is done.',
  depth_model: 'LAYERED_DEPTH',
  material_language: 'Worn timber, brushed metal and soft fabric, credible and slightly used.',
  lighting_intent: 'A single low light from the side, raking across the bench, deep soft shadow beyond it.',
  visual_rhythm: 'MEASURED',
  product_relationship: 'GROUNDED_IN_SCENE',
  text_image_relationship: 'TEXT_IN_CALM_ZONES',
  realism: 'PHOTOREALISTIC',
  emotional_temperature: 'WARM',
  visual_tension: 'MEDIUM',
  negative_space_strategy: 'ASYMMETRIC_RESERVE',
  narrative_elements: [
    { element: 'a pair of worn tools laid aside at the edge of the bench', reason: 'they show the maker has just finished, the care taken in the making', zone: 'FOREGROUND' },
    { element: 'a soft window glow far behind the bench', reason: 'it places the finished piece at dusk, the quiet end of the work', zone: 'BACKGROUND' },
  ],
  permitted_secondary_elements: ['a folded cloth near the edge of the bench'],
  forbidden_decorative_noise: ['confetti and sparkles', 'decorative flowers'],
  rationale: 'The scene tells the making, so the finished piece reads as proof of attention.',
  ...over,
});

export const compositionAnswer = (over = {}) => ({
  hero_relationship: 'PRODUCT_AND_HEADLINE_SHARE',
  product_anchor: { horizontal: 'START', vertical: 'MIDDLE' },
  text_adjacency: 'BESIDE',
  alignment_family: 'START',
  visual_weight: { HEADLINE: 'STRONG', SUBHEADLINE: 'QUIET', PRODUCT: 'STRONG', PRICE: 'QUIET' },
  grouping: [['HEADLINE', 'SUBHEADLINE'], ['PRICE']],
  overlap_permission: 'NONE',
  negative_space_reservation: [{ region: 'SURROUNDING', extent: 'MEDIUM' }],
  narrative_flow: ['HEADLINE', 'SUBHEADLINE', 'PRODUCT', 'PRICE'],
  rationale: 'An asymmetric split lets the piece rest in the scene while the words stand apart.',
  ...over,
});

/** A scripted language-model port: answers are consumed in order by the stage that calls it (keyed by stage name from the instruction). */
export function scriptedPort(answers) {
  const calls = [];
  const queue = { ...answers };
  const complete = async (instruction) => {
    const stage = [
      ['problem framer', 'frame'], ['concept director', 'ideate'], ['concept selector', 'select'], ['art director', 'art_direct'], ['composition planner', 'compose'],
    ].find(([needle]) => instruction.system.includes(`Nordla ${needle}`))?.[1];
    calls.push({ stage, instruction });
    const list = queue[stage];
    if (!list || !list.length) throw Object.assign(new Error('no scripted answer'), { code: 'NO_SCRIPT' });
    const next = list.shift();
    return { text: typeof next === 'string' ? next : JSON.stringify(next), model: 'fake-model', request_id: `req-${stage}-${calls.length}` };
  };
  return { complete, calls };
}

export const brief = () => buildBrief();
