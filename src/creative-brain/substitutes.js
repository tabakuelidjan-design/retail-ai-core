import { BRAIN_ERROR, fail, wordsOf } from './validation.js';

// What may never appear in a generated scene or in a scene description: the product itself or a substitute for it, a competing hero object, a misleading commercial object, text. The real product is
// protected merchant pixels placed by Nordla; a generator must never be asked for anything that could stand in for it or compete with it. English and French stems.

const SUBSTITUTE_STEMS = [
  'product', 'produit', 'phone', 'smartphone', 'mobile', 'handset', 'telephone', 'téléphone', 'device', 'appareil', 'gadget', 'case', 'coque', 'cover', 'housing', 'tablet', 'tablette',
  'camera', 'lens', 'screen', 'écran', 'merchandise', 'packaging', 'box', 'boîte', 'logo', 'brand', 'label', 'price', 'prix', 'text', 'texte', 'letter', 'lettre', 'caption', 'watermark', 'slogan',
];
const COMPETING_STEMS = ['hero', 'héros', 'centrepiece', 'centerpiece', 'protagonist', 'protagoniste', 'focal', 'main subject', 'sujet principal'];

export const SCENE_FORBIDDEN = Object.freeze(['a substitute for the product', 'a phone, a case or any device', 'a competing hero object', 'a misleading commercial object', 'text, letters, logos or watermarks']);

/** The forbidden words found in a text (stems matched on whole words, plurals included). */
export function substituteWordsIn(text) {
  const words = wordsOf(text);
  const stems = [...SUBSTITUTE_STEMS, ...COMPETING_STEMS];
  return [...new Set(words.filter((w) => stems.some((s) => w === s || w === `${s}s` || w === `${s}es`)))];
}

export function assertNoSubstitute(text, where) {
  const found = substituteWordsIn(text);
  if (found.length) fail(BRAIN_ERROR.FORBIDDEN_CONTENT, `${where} speaks of the product, a substitute for it, a competing hero object or text`, where, { problem: 'SCENE_ELEMENT_SUBSTITUTES_THE_PRODUCT', words: found });
  return text;
}
