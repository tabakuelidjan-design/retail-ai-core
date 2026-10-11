import { BRAIN_ERROR, fail, wordsOf } from './validation.js';

// What may never appear in a generated scene or in a scene description: the product itself or a substitute for it, a competing hero object, a misleading commercial object, text. The real product is
// protected merchant pixels placed by Nordla; a generator must never be asked for anything that could stand in for it or compete with it. English and French stems.

// The lexicon is DATA, exported so that the ART_DIRECT instruction prints exactly the words the validator refuses: what the model is told and what Nordla checks cannot drift apart.
export const SUBSTITUTE_LEXICON = Object.freeze({
  product_and_devices: Object.freeze([
    'product', 'produit', 'phone', 'smartphone', 'mobile', 'handset', 'telephone', 'téléphone', 'device', 'appareil', 'gadget', 'case', 'coque', 'cover', 'housing', 'tablet', 'tablette',
    'camera', 'lens', 'screen', 'écran', 'merchandise', 'packaging', 'box', 'boîte',
  ]),
  branding_price_and_text: Object.freeze(['logo', 'brand', 'label', 'price', 'prix', 'text', 'texte', 'letter', 'lettre', 'caption', 'watermark', 'slogan']),
  competing_hero: Object.freeze(['hero', 'héros', 'centrepiece', 'centerpiece', 'protagonist', 'protagoniste', 'focal', 'main subject', 'sujet principal']),
});
/** Every refused word or phrase, flat. */
export const FORBIDDEN_SCENE_WORDS = Object.freeze(Object.values(SUBSTITUTE_LEXICON).flat());

export const SCENE_FORBIDDEN = Object.freeze(['a substitute for the product', 'a phone, a case or any device', 'a competing hero object', 'a misleading commercial object', 'text, letters, logos or watermarks']);

/** The forbidden words found in a text (words matched whole, plurals included; a phrase of the lexicon is matched as a phrase). */
export function substituteWordsIn(text) {
  const words = wordsOf(text);
  const flat = ` ${words.join(' ')} `;
  const found = new Set(words.filter((w) => FORBIDDEN_SCENE_WORDS.some((s) => !s.includes(' ') && (w === s || w === `${s}s` || w === `${s}es`))));
  for (const phrase of FORBIDDEN_SCENE_WORDS.filter((s) => s.includes(' '))) if (flat.includes(` ${phrase} `)) found.add(phrase);
  return [...found];
}

export function assertNoSubstitute(text, where) {
  const found = substituteWordsIn(text);
  if (found.length) fail(BRAIN_ERROR.FORBIDDEN_CONTENT, `${where} speaks of the product, a substitute for it, a competing hero object or text`, where, { problem: 'SCENE_ELEMENT_SUBSTITUTES_THE_PRODUCT', words: found });
  return text;
}
