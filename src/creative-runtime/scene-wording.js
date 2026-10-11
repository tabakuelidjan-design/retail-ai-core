// The scene wording of a direction, for a provider request that must describe an EMPTY environment.
//
// Words (English and French stems) that speak about the PRODUCT or about an OBJECT in the scene, about a contact / grounding effect or about a focal point or subject do not belong in such a
// request: the real product is composited afterwards and its contact shadow is Nordla's own deterministic rule, so asking a generator for them invites it to draw a subject (the third live
// revision run returned a stone bowl, after a direction that asked for a contact shadow "at the contact of the product" and for a contrast "to set the case apart").
// The direction itself is never altered: only the provider request is purified, clause by clause.

const SUBJECT_WORDS = /(^|[^a-zà-ÿ])(products?|produits?|coques?|cases?|phones?|t[ée]l[ée]phones?|smartphones?|mobiles?|devices?|appareils?|objects?|objets?|subjects?|sujets?|items?|articles?|contact|contacts|focal|focus|focale|hero|h[ée]ros|grounded|grounding|ancr[a-zà-ÿ]*)(?=[^a-zà-ÿ]|$)/i;
export const PLAIN_SCENE = 'a calm, plain surface and backdrop';

/** @returns {{ text: string, dropped: number }} the clauses of the visual intent without any clause about the product, an object, a contact effect or a focal point; never empty. */
export function sceneWordingOf(visualIntent) {
  const clauses = String(visualIntent).split(/[,;.]|\s[-–—]\s/).map((c) => c.trim()).filter(Boolean);
  const kept = clauses.filter((c) => !SUBJECT_WORDS.test(c));
  return { text: kept.length ? kept.join(', ') : PLAIN_SCENE, dropped: clauses.length - kept.length };
}
