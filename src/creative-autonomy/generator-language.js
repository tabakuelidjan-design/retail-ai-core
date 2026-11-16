// PRODUCT_VISIBLE mode (A/B comparison, 2026-11-08): the texts the art director writes for the IMAGE GENERATOR must be written in English BY THE MODEL, never translated or rewritten afterwards.
// This module only DETECTS a text that is plainly not English, so that the existing repair circuit can ask the model to write it again. It never rewrites anything.
// Lexical and conservative: French function words (two or more) or accented letters (two or more). A proper noun or a single borrowed word does not trigger it.
const FRENCH_FUNCTION_WORDS = new Set(['le', 'la', 'les', 'des', 'une', 'du', 'de', 'et', 'sur', 'avec', 'pour', 'dans', 'qui', 'est', 'au', 'aux', 'ce', 'cette', 'ses', 'son', 'sa', 'un', 'par', 'pas', 'ne', 'que', 'où']);
const ACCENTED = /[àâäéèêëîïôöùûüçœ]/gi;

/** Whether a text is plainly French: { french: boolean, words: [...function words found], accents: n }. */
export function frenchEvidence(text) {
  const t = String(text ?? '');
  const words = t.toLowerCase().split(/[^\p{L}]+/u).filter((w) => FRENCH_FUNCTION_WORDS.has(w));
  const accents = (t.match(ACCENTED) ?? []).length;
  return { french: words.length >= 2 || accents >= 2, words: [...new Set(words)], accents };
}

/** The fields of an art direction that reach the generator as written (everything but each element's `reason`, which stays in the language of the concept). */
export function generatorTexts(art) {
  return [
    ['art_direction.atmosphere', art?.atmosphere], ['art_direction.material_language', art?.material_language], ['art_direction.lighting_intent', art?.lighting_intent], ['art_direction.rationale', art?.rationale],
    ...(art?.narrative_elements ?? []).map((e, i) => [`art_direction.narrative_elements[${i}].element`, e?.element]),
    ...(art?.permitted_secondary_elements ?? []).map((e, i) => [`art_direction.permitted_secondary_elements[${i}]`, e]),
  ].filter(([, v]) => typeof v === 'string' && v.trim());
}

/** [{ field, words, accents }] for every generator-bound text that is plainly not English. */
export function nonEnglishProblems(art) {
  return generatorTexts(art).flatMap(([field, v]) => { const e = frenchEvidence(v); return e.french ? [{ field, words: e.words, accents: e.accents }] : []; });
}
export const nonEnglishMessage = (p) => `${p.field} is not written in English (${p.words.length ? `French words: ${p.words.join(', ')}` : `${p.accents} accented letters`}): this text goes to the image generator as written, write it again in English yourself (no translation notes)`;
