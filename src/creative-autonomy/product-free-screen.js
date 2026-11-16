// THE ONE SCREEN for what may be written in a scene description. A product-less environment is built by an image model that is NOT shown the product: every sentence that names the product, a device
// part, a cable or a person made it DRAW one (real run 2026-11-05: both rooms held a power bank, one held by a hand). This module is the single source of that screen. It is applied
//   1. at ART_DIRECT (brand-guard.js, art-violations.js): the model is refused and REPAIRED, before any image is bought, so the idea is rewritten in scene vocabulary;
//   2. at request time (scene-engine.js): the same screen, as a safety net. It must find nothing in a run that passed 1; whatever it still removes is recorded under its real reason.
// Before C1 the two places used two different lists: ART_DIRECT refused "product", "phone", "device"... (SUBSTITUTE_LEXICON) but accepted "câble" and "batterie", which the request builder then removed in
// silence (real Remax run cr-91a98dda0c0e: the "cable unrolled towards the empty space" idea vanished from the request, and was logged under the wrong bucket).
// Matching is Unicode-aware (the former \b missed words that start with an accent, such as "écran").

const L = '\\p{L}\\p{N}_';
const whole = (alternatives) => new RegExp(`(?<![${L}])(?:${alternatives.join('|')})(?![${L}])`, 'iu');

/** Plain words (English and French) that name the product, a part of it, a cable or a device: shown to the director so that what it is told and what Nordla checks cannot drift apart. */
export const PRODUCT_SCREEN_WORDS = Object.freeze([
  'battery', 'batterie', 'power bank', 'device', 'appareil', 'display', 'screen', 'écran', 'phone', 'téléphone', 'charger', 'chargeur', 'cable', 'câble', 'cord', 'cordon', 'lanyard', 'USB',
  'casing', 'case', 'boîtier', 'product', 'produit', 'object', 'objet', 'gadget', 'numerical', 'digital', 'LED', 'port', 'connector', 'connecteur',
]);
/** The words the ART_DIRECT instruction does NOT already print (its SUBSTITUTE_LEXICON covers product, phone, device, screen, case, boîtier...): all that the hint has to add. */
export const PRODUCT_SCREEN_WORDS_ADDED = Object.freeze(['battery', 'batterie', 'power bank', 'display', 'charger', 'cable', 'câble', 'cord', 'USB', 'LED', 'port', 'connector']);
export const PEOPLE_SCREEN_WORDS = Object.freeze(['hand', 'main', 'finger', 'doigt', 'thumb', 'palm', 'arm', 'bras', 'person', 'personne', 'people', 'man', 'woman', 'child']);

export const PRODUCT_FREE_RE = whole([
  'batter(?:y|ies|ie)', 'power ?banks?', 'devices?', 'appareils?', 'displays?', 'screens?', '[ée]crans?', 'phones?', 'smartphones?', 't[ée]l[ée]phones?', 'chargers?', 'chargeurs?', 'cables?', 'c[âa]bles?',
  'cords?', 'cordons?', 'lanyards?', 'usb', 'casings?', 'cases?', 'bo[iî]tiers?', 'products?', 'produits?', 'objects?', 'objets?', 'gadgets?', 'numerical', 'digital', 'led', 'ports?', 'connectors?', 'connecteurs?',
]);
// V1 (owner decision 2026-11-05): no hand, finger or person touches or crowds the product
export const PEOPLE_RE = whole(['hands?', 'fingers?', 'thumbs?', 'palms?', 'arms?', 'persons?', 'people', 'man', 'men', 'woman', 'women', 'child', 'children', 'mains?', 'doigts?', 'pouces?', 'bras', 'personnes?', 'hommes?', 'homme', 'femmes?', 'enfants?']);

export const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n).replace(/[.\s]+$/, '');

// sentence by sentence, then CLAUSE by clause (a clause that names the product is dropped, the rest of its sentence stays), screened BEFORE it is shortened
const CLAUSES = /(?<=[.;!?])\s+|\s[—–]\s|;\s|:\s/;
export const productFree = (text, max) => clip(String(text ?? '').split(CLAUSES).map((sentence) => sentence.trim().replace(/[.;!?]+$/, '').split(/,\s/).map((c) => c.trim()).filter((c) => c && !PRODUCT_FREE_RE.test(c) && !PEOPLE_RE.test(c)).join(', ').replace(/^(while|and|but|as|so)\s+/i, '')).filter(Boolean).join('. '), max);
/** The clauses that `productFree` removes, shortened, in order. */
export const productFreeWords = (text) => String(text ?? '').split(/(?<=[.;!?])\s+|\s[—–]\s|;\s|:\s|,\s/).map((s) => s.trim()).filter((s) => s && (PRODUCT_FREE_RE.test(s) || PEOPLE_RE.test(s))).map((s) => clip(s, 90));

// REFORMULATION (2026-11-07): a GENERIC noun for the product ("the product", "l'objet", "the device") is said as the reserved area instead of being dropped with its clause, so the decision it belongs to still reaches the
// generator ("the light grazes the product" -> "the light grazes the reserved area"). Parts of the product (battery, cable, screen, port...), and people, are NOT reformulated: their clause is still dropped and reported.
const GENERIC_NOUN = '(?:products?|produits?|objects?|objets?|devices?|appareils?|gadgets?)';
const GENERIC_MENTION_RE = new RegExp(`(?<![${L}])(?:(?:the|a|an|this|that|its|le|la|un|une|ce|cet|cette|son|sa)\\s+|l['’])?${GENERIC_NOUN}(?![${L}])`, 'giu');
export const reformulateProductMentions = (text) => String(text ?? '').replace(GENERIC_MENTION_RE, 'the reserved area');

// CONTEXTUAL RULE for the GENERIC nouns ("objet", "produit", "object", "product", "gadget") in the free sentences of the scene (atmosphere, materials, light), real run 2026-11-08 (TYESO gourde): the director wrote "sans altérer la texture réelle du produit" and
// "sans montrer aucun acteur ni objet" in the LIGHT, and was refused twice. In context, such a noun is either a NEGATED mention (the clause says what is NOT there: it is dropped, so the image model is never told about it, the lesson of 2026-10-10)
// or the product spoken of in general (it is said as the reserved area). Parts of the product (battery, cable, screen, device, phone...) stay refused. Nothing is silent: the caller gets what was reformulated and what was dropped.
const NEGATION_BEFORE = whole(['sans', 'pas', 'jamais', 'aucune?', 'ni', 'without', 'never', 'no', 'not', 'non']);
const GENERIC_ONLY = new RegExp(GENERIC_MENTION_RE.source, 'iu');
/** { text, reformulated: [{ from, to }], dropped: [clause] }: the generic mentions of `text` resolved in their context. */
export function resolveGenericMentions(text) {
  const reformulated = []; const dropped = [];
  const sentences = String(text ?? '').split(/(?<=[.;!?])\s+|\s[—–]\s|;\s|:\s/).map((sentence) => {
    const clauses = sentence.trim().replace(/[.;!?]+$/, '').split(/,\s/).map((c) => c.trim()).filter(Boolean);
    const kept = [];
    for (const clause of clauses) {
      if (!GENERIC_ONLY.test(clause)) { kept.push(clause); continue; }
      if (NEGATION_BEFORE.test(clause)) { dropped.push(clip(clause, 160)); continue; }
      const to = reformulateProductMentions(clause); reformulated.push({ from: clip(clause, 160), to: clip(to, 160) }); kept.push(to);
    }
    return kept.join(', ');
  }).filter(Boolean);
  return { text: sentences.join('. '), reformulated, dropped };
}

/** The words of `text` that the screen refuses: { product: [...], people: [...] } (lower case, in order of appearance). */
export function screenedWordsIn(text) {
  const grab = (re) => [...String(text ?? '').matchAll(new RegExp(re.source, 'giu'))].map((m) => m[0].toLowerCase());
  return { product: [...new Set(grab(PRODUCT_FREE_RE))], people: [...new Set(grab(PEOPLE_RE))] };
}

/**
 * The fields of an ART_DIRECT answer that become words of the scene request, each with the words the screen refuses in it.
 * forbidden_decorative_noise (what must NOT appear) and permitted_secondary_elements (screened by the Brain's own lexicon) are not part of it.
 * @returns {[{ field, words, kind }]} in document order; [] when the answer is clean
 */
export function sceneVocabularyProblems(art) {
  const fields = [
    ['art_direction.atmosphere', art?.atmosphere], ['art_direction.material_language', art?.material_language], ['art_direction.lighting_intent', art?.lighting_intent],
    ...(Array.isArray(art?.narrative_elements) ? art.narrative_elements : []).map((e, i) => [`art_direction.narrative_elements[${i}].element`, e?.element]),
  ];
  const out = [];
  for (const [field, value] of fields) {
    if (typeof value !== 'string') continue;
    // the free sentences (atmosphere, materials, light) are screened AFTER their generic mentions are resolved in context; a narrative element keeps the strict screen (an element that names an object may stand in for the product)
    const w = screenedWordsIn(field.includes('narrative_elements') ? value : resolveGenericMentions(value).text);
    if (w.product.length) out.push({ field, words: w.product, kind: 'PRODUCT' });
    if (w.people.length) out.push({ field, words: w.people, kind: 'PEOPLE' });
  }
  return out;
}

/** The line given to ART_DIRECT from its first call (every tenant): what is refused, and how to say the idea instead. */
export function sceneVocabularyHint() {
  return `These fields go to an image model NOT shown the product: besides the words above, Nordla refuses ${PRODUCT_SCREEN_WORDS_ADDED.join(', ')}, a person or a hand (one repair). A generic "object" or "product" in the atmosphere, the materials or the light is not refused: Nordla says it as the reserved area, or drops the clause when it only says what is NOT there; a narrative element may not name an object.`;
}
