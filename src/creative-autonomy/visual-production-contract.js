// Nordla Creative Production V1: vendor-neutral, text-only scene contract.
// Does not generate, transmit, or edit pixels. The real product is composed separately.
const FORMATS = Object.freeze({
  INSTAGRAM_FEED_4_5: Object.freeze({ width: 1080, height: 1350 }),
  INSTAGRAM_STORY_9_16: Object.freeze({ width: 1080, height: 1920 }),
  WEB_BANNER_16_9: Object.freeze({ width: 1920, height: 1080 }),
});
const EXCLUSIONS = Object.freeze([
  'beige, cream, sand or ecru backgrounds',
  'gold, fake luxury, neon, artificial glow or bokeh',
  'hearts, leaves, foliage or decorative branches',
  'marble, velvet, generic decorative icons',
]);
function requiredText(value, field, max = 1600) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TypeError(field + ' must be nonempty text up to ' + max + ' characters');
  }
  return value.trim();
}
/**
 * Build an environment ONLY; never ask a generator to invent the authentic product.
 * No visual quality or fidelity claim is made by this prompt.
 */
export function buildVisualBackgroundBrief({ concept, artDirection, format = 'INSTAGRAM_FEED_4_5', productPosition = 'CENTER' }) {
  if (!concept || typeof concept !== 'object' || !artDirection || typeof artDirection !== 'object') {
    throw new TypeError('concept and artDirection are required');
  }
  if (!Object.hasOwn(FORMATS, format)) throw new RangeError('unsupported output format');
  if (!['LEFT_THIRD', 'CENTER', 'RIGHT_THIRD'].includes(productPosition)) {
    throw new RangeError('unsupported productPosition');
  }
  const dimensions = FORMATS[format];
  const story = requiredText(concept.story, 'concept.story');
  const metaphor = requiredText(concept.visual_metaphor, 'concept.visual_metaphor');
  const atmosphere = requiredText(artDirection.atmosphere, 'artDirection.atmosphere');
  const lighting = requiredText(artDirection.lighting_intent, 'artDirection.lighting_intent');
  const materials = requiredText(artDirection.material_language, 'artDirection.material_language');
  const zone = productPosition === 'CENTER' ? 'the central third' : productPosition === 'LEFT_THIRD' ? 'the left third' : 'the right third';
  const prompt = [
    'Create a distinctive photorealistic premium advertising ENVIRONMENT ONLY for HABB.',
    'Do NOT draw, imitate, invent or insert any product, bottle, person, packaging, logo, word, letter, number, price or watermark.',
    'The real product photograph will be placed later, untouched, in ' + zone + ' of the final composition.',
    'Keep ' + zone + ' visually clear, with a plausible contact surface and directional lighting.',
    'Convey the story with environment ONLY: ' + story,
    'Translate the metaphor through environment ONLY: ' + metaphor,
    'Atmosphere: ' + atmosphere,
    'Lighting: ' + lighting,
    'Materials: ' + materials,
    'Editorial commercial photography, believable depth and materials, original but restrained.',
    'Never use ' + EXCLUSIONS.join('; ') + '.',
    'Produce a clean text-free background for later deterministic product compositing and typesetting.',
    'Final crop ratio ' + dimensions.width + ':' + dimensions.height + '.',
  ].join('\n');
  return Object.freeze({ contract: 'NORDLA_VISUAL_BACKGROUND_V1', format, dimensions, productPosition,
    containsProductImage: false, containsCommercialText: false, prompt });
}
/** Permission is tied to the exact plan/provider/model, not to a previous trial. */
export function assertVisualProductionApproval({ planId, provider, model, authorization, sourcePhotoRights }) {
  requiredText(planId, 'planId', 160);
  requiredText(provider, 'provider', 60);
  requiredText(model, 'model', 160);
  if (!authorization || authorization.planId !== planId ||
      authorization.provider !== provider || authorization.model !== model || authorization.approved !== true) {
    throw new Error('VISUAL_PRODUCTION_NOT_AUTHORIZED: exact plan, provider and model require explicit approval');
  }
  if (!Number.isInteger(authorization.maxCalls) || authorization.maxCalls !== 1) {
    throw new Error('VISUAL_PRODUCTION_NOT_AUTHORIZED: one model call per approved test');
  }
  if (sourcePhotoRights !== 'OWNER_CONFIRMED') {
    throw new Error('PHOTO_RIGHTS_UNVERIFIED: verified advertising rights required');
  }
  if (authorization.photoTransmission !== 'NONE') {
    throw new Error('PHOTO_TRANSMISSION_FORBIDDEN: generation must not transmit the source photo');
  }
  return true;
}
export const VISUAL_FORMATS = FORMATS;
