import { COMPONENT, DECISION } from './ledger.js';

// Provider request construction for the ENVIRONMENT lane: built by Nordla from the Creative Direction and the brand's photography / composition principles. The
// request is ephemeral adapter data (it is never stored as canonical data, only its hash is recorded). It describes an EMPTY scene: the real product is composited
// afterwards by Nordla, so the provider never receives a product image and is told never to draw a product, an object or any text.

const NEGATIVE_SPACE_CLAUSE = Object.freeze({
  NONE: null,
  TOP: 'keep the upper part of the frame calm and uncluttered so text can be set there',
  BOTTOM: 'keep the lower part of the frame calm and uncluttered so text can be set there',
  START: 'keep the left side of the frame calm and uncluttered so text can be set there',
  END: 'keep the right side of the frame calm and uncluttered so text can be set there',
  SURROUNDING: 'keep generous calm space all around the centre of the frame',
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

/**
 * @returns {{ prompt, negative_prompt, size }} (ephemeral); throws a coded error when the direction asks for something the brand forbids.
 */
export function buildEnvironmentRequest({ direction, expression, canvas, ledger }) {
  const violations = forbiddenVisualsIn(`${direction.visual_intent} ${direction.concept}`, expression);
  if (violations.length) {
    const error = new Error(`the direction asks for visuals the brand forbids: ${violations.join(', ')}`);
    error.code = 'DIRECTION_VIOLATES_BRAND_FORBIDDEN_VISUALS';
    throw error;
  }
  // only the brand statements about the SCENE (light, surface, colour, space) go into an empty-scene request: anything that talks about the product, the phone or the case would invite the provider to draw one
  const aboutScene = (list) => (list ?? []).filter((s) => !/(^|[^a-z])(product|products|phone|case|cases|camera|personali[sz]ation)([^a-z]|$)/i.test(s));
  const principles = aboutScene(expression?.photography?.principles);
  const dos = aboutScene(expression?.photography?.do);
  const donts = expression?.photography?.dont ?? [];
  const compositionDo = aboutScene(expression?.composition?.do);
  const space = NEGATIVE_SPACE_CLAUSE[direction.negative_space_intent] ?? null;
  const prompt = [
    `A photograph of an empty scene: ${direction.visual_intent.replace(/[.\s]+$/, '')}.`,
    'The scene is empty: no product, no phone, no case, no object, no person, no hands, no text, no letters, no logo, no watermark.',
    space ? `${space[0].toUpperCase()}${space.slice(1)}.` : null,
    compositionDo.length ? `Composition: ${compositionDo.slice(0, 3).join('; ')}.` : null,
    principles.length ? `Photography: ${principles.slice(0, 4).join('; ')}.` : null,
    dos.length ? `Do: ${dos.slice(0, 4).join('; ')}.` : null,
    `Format: ${canvas.width} by ${canvas.height} pixels, a single coherent photograph.`,
  ].filter(Boolean).join(' ');
  const negative = [...donts, 'product', 'phone', 'phone case', 'object', 'person', 'text', 'letters', 'logo', 'watermark'].join(', ');
  const request = Object.freeze({ prompt, negative_prompt: negative, size: `${canvas.width}*${canvas.height}` });
  ledger?.record({
    decision: DECISION.PROVIDER_REQUEST_CONSTRUCTION, decided_by: COMPONENT.PROVIDER_REQUEST_BUILDER, rule: 'ENVIRONMENT_ONLY_FROM_DIRECTION_AND_BRAND_PHOTOGRAPHY_PRINCIPLES',
    basis: [direction.direction_id],
    outcome: { lane: 'ENVIRONMENT', size: request.size, carries_input_asset: false, forbids_product_text_and_objects: true, brand_forbidden_terms_checked: true, negative_space_intent: direction.negative_space_intent },
  });
  return request;
}
