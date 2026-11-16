// COHERENCE CHECKS between the decisions of the Creator (2026-11-08, owner-validated after the TYESO gourde preparation). Three deterministic checks, each born from a real archived answer:
//   1. STAGE vs ART_DIRECTION: a material the art director FORBADE (forbidden_decorative_noise) may not be the material of a prop the stage CHOSE ("brushed metal" forbidden, then a BRUSHED_STEEL panel).
//   2. ORPHAN SHADOW (decor-first route): a shadow drawn in the set must belong to an element drawn in the set. A shadow shaped like a PART OF THE PRODUCT (its handle, its cap) cannot exist in an empty set:
//      the product is added afterwards and casts its own shadow. The part names come from the product's appearance sheet, in English and in French.
//   3. A BENEFIT PRESENTED AS VERIFIED must have its words in the verified facts ("bénéfice vérifié : boire facilement en mouvement" with no feature and a title that says nothing of it).
// Matching is lexical and conservative; it never judges the quality of an idea. Generic: no tenant, no product name.

const L = '\\p{L}\\p{N}_';
const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const wordRe = (alts) => new RegExp(`(?<![${L}])(?:${alts.join('|')})(?![${L}])`, 'iu');

// ---- 1. STAGE vs ART_DIRECTION
// A shared word is NOT a contradiction ("metal shavings", "glass bottle", "polished metal" vs a brushed steel panel are different things). The art direction forbids the MATERIAL of the prop only when its term is
// a BARE material term: the material noun alone, or with a finish that the prop itself has. Any other word in the term (a noun like shavings or glitter, a qualifier like generic or uniform) makes it a different ban, never a refusal.
const MATERIALS = Object.freeze({
  BRUSHED_STEEL: { nouns: ['steel', 'metal', 'metallic', 'acier', 'metallique', 'inox'], finishes: ['brushed', 'brosse', 'brossee', 'brosses'] },
  CONCRETE: { nouns: ['concrete', 'cement', 'beton', 'ciment'], finishes: ['raw', 'brut', 'brute', 'unfinished'] },
  FROSTED_GLASS: { nouns: ['glass', 'verre'], finishes: ['frosted', 'depoli', 'depolie', 'satin', 'satine'] },
  PAPER_WHITE: { nouns: ['paper', 'papier'], finishes: ['white', 'blanc', 'blanche'] },
});
// finishes a term may carry that the prop does NOT have (polished, mirror...): the ban then concerns ANOTHER finish
const OTHER_FINISHES = ['polished', 'poli', 'polie', 'shiny', 'glossy', 'mirror', 'miroir', 'chrome', 'matte', 'mat', 'rough', 'smooth'];
const wordsOf = (t) => plain(t).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['the', 'and', 'any', 'les', 'des', 'une', 'aux', 'sur'].includes(w));
/**
 * The props of a stage whose MATERIAL the art direction forbids, as a bare material term. [{ field, material, term }]
 * `noise` terms are split on commas. Compatible choices stay allowed: "metal shavings", "metallic glitter", "polished metal", "glass bottles", "béton ciré", "generic brushed metal".
 */
export function stageArtProblems(stage, art) {
  const noise = (art?.forbidden_decorative_noise ?? []).flatMap((t) => String(t).split(',')).map((t) => t.trim()).filter(Boolean);
  if (!noise.length) return [];
  const out = [];
  (stage?.props ?? []).forEach((p, i) => {
    const m = MATERIALS[p?.material]; if (!m) return;
    for (const term of noise) {
      const tokens = wordsOf(term);
      const nouns = tokens.filter((w) => m.nouns.includes(w));
      if (!nouns.length) continue;
      const rest = tokens.filter((w) => !m.nouns.includes(w));
      if (rest.some((w) => !m.finishes.includes(w) && !OTHER_FINISHES.includes(w))) continue; // another noun or a qualifier: a different ban
      if (rest.some((w) => OTHER_FINISHES.includes(w))) continue; // another finish than the prop's
      out.push({ field: `stage.props[${i}].material`, material: p.material, term, word: nouns[0] }); break;
    }
  });
  return out;
}

// ---- 2. ORPHAN SHADOW
// the parts a product may have, as English | French word groups; a group counts for a product when the group is in its appearance sheet
const PART_GROUPS = Object.freeze([
  ['handle', ['handles?', 'poign[ée]es?', 'anses?']],
  ['cap', ['caps?', 'lids?', 'corks?', 'bouchons?', 'couvercles?', 'capuchons?']],
  ['spout', ['spouts?', 'straws?', 'embouts?', 'pailles?', 'becs?', 'mouthpieces?']],
  ['strap', ['straps?', 'sangles?', 'lanyards?', 'cordons?', 'cables?', 'c[âa]bles?', 'loops?', 'boucles?']],
  ['button', ['buttons?', 'boutons?', 'clips?', 'zip(?:per)?s?', 'fermetures?', 'latch(?:es)?', 'loquets?']],
]);
const GROUP_RES = PART_GROUPS.map(([name, alts]) => [name, wordRe(alts)]);
const SHADOW_RE = wordRe(['shadows?', 'ombres?', 'ombr[ée]e?s?']);
const CLAUSES = /(?<=[.;!?])\s+|\s[—–]\s|;\s|:\s/;
const NEGATED = /(?<![\p{L}])(sans|without|no|not|never|jamais|aucune?|pas de)(?![\p{L}])/iu;
/**
 * The clauses of `text` where a shadow is drawn in the shape of (or as the shadow of) a PART OF THE PRODUCT. [{ clause, part }]. `appearance` = the product's appearance sheet ("" or null: nothing is known, nothing is flagged).
 */
export function orphanShadowProblems(text, appearance) {
  if (!appearance) return [];
  const known = GROUP_RES.filter(([, re]) => re.test(appearance));
  if (!known.length) return [];
  const out = [];
  for (const raw of String(text ?? '').split(CLAUSES)) {
    const clause = raw.trim(); if (!clause || !SHADOW_RE.test(clause)) continue;
    const m = clause.match(SHADOW_RE); if (NEGATED.test(clause.slice(Math.max(0, m.index - 30), m.index))) continue;
    const hit = known.find(([, re]) => re.test(clause));
    if (hit) out.push({ clause: clause.replace(/\s+/g, ' ').slice(0, 200), part: hit[0] });
  }
  return out;
}

// ---- 3. BENEFIT PRESENTED AS VERIFIED
// A benefit called verified must point to ONE precise fact, with its source: every significant word of the benefit AND every figure (45W, 750 ml) must be found in one and the same fact (the title, the variant,
// a sentence of the description, one feature). Words spread over several facts, or a figure that no fact states, are not a source. The source found is returned, so the report can show it.
const VERIFIED_BENEFIT = new RegExp(`(?:b[ée]n[ée]fices?|benefits?|avantages?|promesses?|claims?|usages?)\\s+(?:enti[èe]rement\\s+)?(?:v[ée]rifi[ée]e?s?|verified)\\s*[:—–-]?\\s*([^.;()]{3,90})|(?:verified|v[ée]rifi[ée]e?s?)\\s+(?:benefits?|b[ée]n[ée]fices?|claims?|promesses?)\\s*[:—–-]?\\s*([^.;()]{3,90})`, 'giu');
// function words only: every other word of the benefit counts, short ones included ("sans fil", "no", "24 h"), so that "recharge sans fil" is not proven by "recharge rapide"
const STOP = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et', 'ou', 'en', 'au', 'aux', 'à', 'a', 'the', 'of', 'and', 'or', 'in', 'to', 'for', 'an', 'is', 'are', 'avec', 'pour', 'dans', 'sur', 'with', 'tres', 'tout', 'toute', 'est', 'que', 'qui', 'par', 'ses', 'son', 'sa', 'ce', 'cet', 'cette', 'vos', 'votre', 'your']);
const glue = (t) => plain(t).replace(/(\d)\s+(w|wh|mah|ml|cl|l|cm|mm|kg|g|h|v|a|min|hz)(?![a-z])/g, '$1$2');
const stems = (t) => [...new Set(glue(t).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w)).map((w) => (/\d/.test(w) ? w : w.slice(0, 5))))];
/** The facts that may SOURCE a benefit: [{ source, text }] from a string (one fact) or an array of strings / { source, text }. */
const itemsOf = (facts) => (typeof facts === 'string' ? [{ source: 'verified_text', text: facts }] : (facts ?? []).map((f, i) => (typeof f === 'string' ? { source: `fact[${i}]`, text: f } : f)));
/**
 * The benefits that a text presents as VERIFIED and that NO single fact states. [{ benefit, missing, closest }]. `facts` = the verified facts with their source (see itemsOf).
 */
export function unsourcedBenefitProblems(text, facts) {
  const out = []; const items = itemsOf(facts).map((f) => ({ ...f, stems: new Set(stems(f.text)) }));
  for (const m of String(text ?? '').matchAll(VERIFIED_BENEFIT)) {
    const benefit = (m[1] ?? m[2] ?? '').trim(); const s = stems(benefit); if (!s.length) continue;
    if (items.some((f) => s.every((x) => f.stems.has(x)))) continue;
    const best = items.map((f) => ({ f, found: s.filter((x) => f.stems.has(x)).length })).sort((a2, b2) => b2.found - a2.found)[0];
    out.push({ benefit: benefit.slice(0, 120), missing: s.filter((x) => !(best?.f.stems.has(x))), closest: best && best.found ? best.f.source : null });
  }
  return out;
}
/** The fact that states a benefit: { source, text } or null (the proof shown in a report). */
export function sourceOfBenefit(benefit, facts) {
  const s = stems(benefit); if (!s.length) return null;
  return itemsOf(facts).find((f) => { const have = new Set(stems(f.text)); return s.every((x) => have.has(x)); }) ?? null;
}
