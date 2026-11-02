// TENANT CREATIVE BRAND PROFILE. Shared creative code holds NO merchant's taste: a merchant's forbidden visual elements, palette words, merchant name,
// language, product nouns and commercial requirements come from its configuration (config/merchants/<merchant>/creative-brand.json), resolved here.
// What stays universal (in the shared modules, for every tenant): verified facts only, no invented capability, no figure or claim in a headline,
// no personalisation promise the product does not offer, the real product never modified.
// A tenant without a creative profile gets the GENERIC profile: no decor prohibition, no palette, its own merchant name, neutral requirements.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONFIG = fileURLToPath(new URL('../../config/merchants/', import.meta.url));

const GENERIC_REQUIREMENTS = Object.freeze([
  'An original, memorable idea: one strong visual gesture a passer-by remembers, not a generic mood or a postcard of a place used as decor.',
  'The real product (the photograph, unchanged) is the protagonist: the story happens AROUND it and makes it desirable; it is never a detail in a scene.',
  'A concrete reason to want this product, built ONLY on the verified facts above (what it is made for, its features as written in the product sheet, its variants, its price). No feature, promise or service that is not written there.',
  'Premium without advertising clichés or fake luxury: restraint, light, material and precision rather than shine or superlatives.',
  'A clear link between the story, the image and the objective: one sentence must say why this image makes people want the product.',
]);
const GENERIC_FACTS_RULE = 'Only the verified facts of the product sheet may be stated. No capability absent from the sheet (insulation, temperature duration, waterproofing, unbreakable, BPA-free, ecological, guarantee, superlative) may be attributed to the product.';

function freezeDeep(o) { if (o && typeof o === 'object') { Object.values(o).forEach(freezeDeep); Object.freeze(o); } return o; }

/**
 * The creative profile of the ACTIVE tenant. `brand` = the tenant brand given to the run: { merchant_id, brand_id, merchant_name?, colors?, expression?, creative? }.
 * `brand.creative` (from the tenant's configuration) carries the tenant's rules; without it the GENERIC profile applies.
 */
export function resolveBrandProfile(brand = {}) {
  const c = brand?.creative ?? null;
  const merchant = c?.merchant_display ?? brand?.merchant_display ?? brand?.merchant_name ?? null;
  return freezeDeep({
    kind: c ? 'TENANT' : 'GENERIC',
    merchant_id: brand?.merchant_id ?? null,
    merchant_display: merchant,
    brand_name: c?.brand_name ?? merchant,
    language: c?.language ?? brand?.language ?? null,
    locale: c?.locale ?? brand?.locale ?? null,
    expression: brand?.expression ?? null,
    forbidden_decor: [...(c?.forbidden_decor ?? [])],
    forbidden_decor_summary: c?.forbidden_decor_summary ?? null,
    scene_negative_terms: [...(c?.scene_negative_terms ?? [])],
    tone_words: { ...(c?.tone_words ?? {}) },
    product_nouns: [...(c?.product_nouns ?? [])],
    facts_rule: c?.facts_rule ?? GENERIC_FACTS_RULE,
    creative_requirements: [...(c?.creative_requirements ?? GENERIC_REQUIREMENTS)],
  });
}

/** The hint given to ART_DIRECT from its first call, built from the tenant's prohibitions (null when the tenant has none). */
export function artDirectionHintFor(profile) {
  if (!profile?.forbidden_decor?.length) return null;
  const who = profile.brand_name ?? profile.merchant_display ?? 'The merchant';
  return `${who}'s hard visual rules apply to every field of the art direction (atmosphere, materials, light, narrative and secondary elements, rationale): none of these may appear: ${profile.forbidden_decor.join(', ')}. You MAY list them in forbidden_decorative_noise (that field names what must NOT appear).`;
}

/** A merchant's tenant brand, read from config/merchants/<merchant>/creative-brand.json (data only). */
export function loadMerchantCreativeBrand(merchant) {
  if (!/^[a-z0-9-]{1,40}$/.test(merchant)) throw new TypeError('merchant config name: lower-case letters, digits and dashes only');
  const cfg = JSON.parse(readFileSync(`${CONFIG}${merchant}/creative-brand.json`, 'utf8'));
  const { merchant_id, brand_id, colors, expression, _comment, ...creative } = cfg;
  return freezeDeep({ merchant_id, brand_id, merchant_display: creative.merchant_display, colors, expression, creative });
}
