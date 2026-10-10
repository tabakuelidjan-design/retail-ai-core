import { COMPONENT, DECISION } from './ledger.js';

// Provider request construction for the ENVIRONMENT lane: built by Nordla from the Creative Direction and the brand's photography / composition principles. The
// request is ephemeral adapter data (it is never stored as canonical data, only its hash is recorded). It describes an EMPTY surface and backdrop: the real product is
// composited afterwards by Nordla, so the provider never receives a product image. What must NOT appear (a product, a phone, any object, display furniture, text) is said
// in the NEGATIVE prompt only: naming a forbidden object in the positive prompt primes a generator to draw it (the first real run returned a phone on a stone slab although the
// positive prompt said "no phone").

const NEGATIVE_SPACE_CLAUSE = Object.freeze({
  NONE: null,
  TOP: 'the upper part of the frame stays calm and uncluttered',
  BOTTOM: 'the lower part of the frame stays calm and uncluttered',
  START: 'the left side of the frame stays calm and uncluttered',
  END: 'the right side of the frame stays calm and uncluttered',
  SURROUNDING: 'generous calm space all around the centre of the frame',
});

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

/** Words the brand forbids (its own "dont" lists) that appear in a text, so a direction that asks for them is refused instead of silently executed. */
export function forbiddenVisualsIn(text, expression) {
  const terms = [
    ['beige', /\bbeige\b/], ['artificial glow', /\b(glow|glowing)\b/], ['gold', /\b(gold|golden)\b/], ['warm gradient', /warm\s+gradient/],
    ['leaves', /\b(leaf|leaves|foliage)\b/], ['hearts', /\b(heart|hearts)\b/], ['haze', /\b(haze|hazy|dreamy)\b/], ['luxury effects', /\bluxur(y|ious)\b/],
  ];
  const lower = norm(text);
  // only the terms the brand actually lists as forbidden count
  const listed = norm([...(expression?.photography?.dont ?? []), ...(expression?.composition?.dont ?? [])].join(' '));
  return terms.filter(([label, rx]) => rx.test(lower) && (listed.includes(label.split(' ')[0]) || listed.includes(label))).map(([label]) => label);
}

/** Display structures (a pedestal, plinth, podium, slab, stand, shelf, step) invite a generator to put a product on them: the environment is a surface and a backdrop, never a display. */
export function displayStructuresIn(text) {
  const rx = /(^|[^a-z])(pedestal|plinth|podium|slab|platform|stand(?!-alone)|shelf|steps?|riser|stage|display)(?=[^a-z]|$)/gi;
  return [...new Set([...norm(text).matchAll(rx)].map((m) => m[2].toLowerCase()))];
}

/**
 * @returns {{ prompt, negative_prompt, size }} (ephemeral); throws a coded error when the direction asks for something the brand forbids or for a display structure.
 */
export function buildEnvironmentRequest({ direction, expression, canvas, ledger }) {
  const wanted = `${direction.visual_intent} ${direction.concept}`;
  const violations = forbiddenVisualsIn(wanted, expression);
  if (violations.length) {
    const error = new Error(`the direction asks for visuals the brand forbids: ${violations.join(', ')}`);
    error.code = 'DIRECTION_VIOLATES_BRAND_FORBIDDEN_VISUALS';
    throw error;
  }
  const structures = displayStructuresIn(direction.visual_intent);
  if (structures.length) {
    const error = new Error(`the direction asks for a display structure (${structures.join(', ')}): an environment is a surface and a backdrop`);
    error.code = 'DIRECTION_ASKS_FOR_A_DISPLAY_STRUCTURE';
    throw error;
  }
  // only the brand statements about the SCENE (light, surface, colour, space) go into the request: anything that talks about the product, the phone or the case would invite one
  const aboutScene = (list) => (list ?? []).filter((s) => !/(^|[^a-z])(product|products|phone|case|cases|camera|personali[sz]ation|text|compos[a-z]*|generat[a-z]*)([^a-z]|$)/i.test(s));
  const principles = aboutScene(expression?.photography?.principles);
  const dos = aboutScene(expression?.photography?.do);
  const donts = expression?.photography?.dont ?? [];
  const compositionDo = aboutScene(expression?.composition?.do);
  const space = NEGATIVE_SPACE_CLAUSE[direction.negative_space_intent] ?? null;
  const prompt = [
    `A photograph of ${direction.visual_intent.replace(/[.\s]+$/, '')}, quiet and empty: a single continuous seamless surface meeting a plain backdrop, with nothing placed on it.`,
    space ? `${space[0].toUpperCase()}${space.slice(1)}.` : null,
    compositionDo.length ? `Composition: ${compositionDo.slice(0, 3).join('; ')}.` : null,
    principles.length ? `Photography: ${principles.slice(0, 4).join('; ')}.` : null,
    dos.length ? `Do: ${dos.slice(0, 4).join('; ')}.` : null,
    `Format: ${canvas.width} by ${canvas.height} pixels, a single coherent photograph.`,
  ].filter(Boolean).join(' ');
  const negative = [
    ...donts, 'product', 'phone', 'mobile phone', 'smartphone', 'phone case', 'camera lenses', 'device', 'object', 'object on the surface', 'pedestal', 'plinth', 'podium', 'slab',
    'stand', 'shelf', 'step', 'display', 'prop', 'person', 'hands', 'text', 'letters', 'logo', 'watermark',
  ].join(', ');
  const request = Object.freeze({ prompt, negative_prompt: negative, size: `${canvas.width}*${canvas.height}` });
  ledger?.record({
    decision: DECISION.PROVIDER_REQUEST_CONSTRUCTION, decided_by: COMPONENT.PROVIDER_REQUEST_BUILDER, rule: 'EMPTY_SURFACE_AND_BACKDROP_FROM_DIRECTION_AND_BRAND_PHOTOGRAPHY_PRINCIPLES',
    basis: [direction.direction_id],
    outcome: {
      lane: 'ENVIRONMENT', size: request.size, carries_input_asset: false, forbidden_objects_only_in_the_negative_prompt: true, brand_forbidden_terms_checked: true,
      display_structures_refused: true, negative_space_intent: direction.negative_space_intent,
    },
  });
  return request;
}
