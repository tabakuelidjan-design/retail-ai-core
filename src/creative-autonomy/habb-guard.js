// HABB'S GUARD, AS EARLY AS THE CONCEPT. Two families of refusal, applied to every creative decision Nordla takes (concepts, art direction, staging):
//   1. HABB's forbidden visual elements (beige, hearts, decorative foliage, gold, fake luxury...): the list lives in stage-contract.js (FORBIDDEN_DECOR)
//   2. INVENTED CAPABILITIES: a property of the product that its verified facts do not state (insulation, hours of cold, leak-proof, unbreakable, BPA-free...).
//      A capability is allowed only if the SAME capability appears in the verified Shopify text; otherwise the concept would sell something HABB cannot promise.
// Refusals are Brain contract refusals (BRAIN_FORBIDDEN_CONTENT / BRAIN_RULE_VIOLATION with the exact field): they stop the run, or feed the bounded repair the
// owner authorised. Nothing is rewritten, removed or softened by this guard.
import { BRAIN_ERROR, fail } from '../creative-brain/validation.js';
import { hasForbidden, FORBIDDEN_DECOR } from './stage-contract.js';

// JavaScript's \b only knows ASCII letters: "étanche" or "écologique" never matched it. Every \b below is compiled into a Unicode-aware boundary.
const U = (re, flags = 'iu') => new RegExp(re.source.replace(/\\b/g, '(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))').replace(/\\w/g, '[\\p{L}\\p{N}_]'), flags);

// words that tie a sentence to THE PRODUCT (a temperature, eco or origin statement about a coffee shop, a backdrop or the city is not a product claim)
const PRODUCT = /\b(gourdes?|bottles?|flasks?|bouteilles?|tyeso|produit|product|ts-8771c|dedans|inside|dans (la|ta|votre|cette) gourde)\b/;
const DRINK = /(drinks?|water|coffee|tea|beverages?|liquids?|contents?|boissons?|eau|café|thé)/;
const TEMP_EN = /(cold|cool|hot|warm|chilled|icy|ice[- ]?cold)/; const TEMP_FR = /(froid\w*|frais|fraîche\w*|chaud\w*|glac\w*)/;

/** Capabilities a creative text may NOT attribute to the product unless the verified facts state them (affirmatively). FR + EN. */
const RAW_CLAIMS = [
  { id: 'INSULATION', re: /\b(isotherm\w*|isolant\w*|insulat\w*|thermos|double[- ]paroi|double[- ]wall\w*|vacuum[- ]insulat\w*)\b/ },
  // the product DOING it ("keeps your water cold"), or a drink that stays cold IN the product
  { id: 'KEEPS_TEMPERATURE', re: new RegExp(String.raw`\b(keeps?|keeping)\b[^.;:]{0,40}\b${DRINK.source}\b[^.;:]{0,20}\b${TEMP_EN.source}\b|\b(garde|gardent|conserve|conservent|maintien\w*)\b[^.;:]{0,40}\b${DRINK.source}\b[^.;:]{0,20}\b${TEMP_FR.source}`), needsProduct: false },
  { id: 'KEEPS_TEMPERATURE', re: new RegExp(String.raw`\b${DRINK.source}\b[^.;:]{0,20}\b(stays?|remains?|reste|restent|demeure\w*)\b[^.;:]{0,15}\b(${TEMP_EN.source}|${TEMP_FR.source})`), needsProduct: true },
  { id: 'KEEPS_TEMPERATURE', re: /\b(ice[- ]?cold|glacée?s?)\b[^.;:]{0,30}\b(all day( long)?|toute la journée|for hours|pendant des heures|jusqu'au soir)\b/ },
  // a drink that stays cold UNTIL a time is a product promise even without naming the product ("ton eau reste froide jusqu'au soir")
  { id: 'KEEPS_TEMPERATURE', re: new RegExp(String.raw`\b${DRINK.source}\b[^.;:]{0,25}\b(stays?|remains?|reste|restent|demeure\w*)\b[^.;:]{0,15}\b(${TEMP_EN.source}|${TEMP_FR.source})[^.;:]{0,15}\b(jusqu'au soir|jusqu'à ce soir|toute la journée|all day( long)?|until (the )?evening|for hours|pendant des heures)\b`) },
  // a DURATION of temperature ("24h de fraîcheur", "cold for 12 hours"); a time of day ("à 7h du matin") is not a duration
  { id: 'DURATION_HOURS', re: new RegExp(String.raw`\b(tient|tiennent|keeps?|holds?)\s+(au\s+)?(frais|froid|chaud|cold|hot|cool|warm)\s+(pendant\s+|for\s+)?\d{1,2}\s?(h|hrs?|hours?|heures?)\b|\b(pendant|durant|for|up to|jusqu'à|jusqu'a)\s*\d{1,2}\s?(h|hrs?|hours?|heures?)\b[^.;:]{0,40}\b(${TEMP_EN.source}|${TEMP_FR.source})|\b(${TEMP_EN.source}|${TEMP_FR.source})[^.;:]{0,25}\b(for|pendant|durant|up to|jusqu'à)\s*\d{1,2}\s?(h|hrs?|hours?|heures?)\b|\b\d{1,2}\s?(h|heures?|hours?)\s+(de\s+)?(fraîcheur|froid|chaleur|cold|heat)\b`), numeric: true },
  { id: 'LEAK_PROOF', re: /\b(leak[- ]?proof|leak[- ]?free|leak[- ]?resistant|spill[- ]?proof|spill[- ]?resistant|anti[- ]?fuites?|étanche\w*|etanche\w*|hermétique\w*|hermetique\w*|zéro fuite|zero fuite|aucune fuite|sans (jamais )?fuir|sans fuites?|never (leaks?|spills?)|no (leaks?|spills?)|without (a single |any )?(leaks?|leaking|spills?)|ne fuit (jamais|pas)|ne coule (jamais|pas))\b/ },
  { id: 'UNBREAKABLE', re: /\b(unbreakable|indestructible|shatter[- ]?proof|incassable\w*|increvable\w*)\b/ },
  { id: 'BPA_FREE', re: /\b(bpa[- ]?free|sans bpa|without bpa)\b/ },
  { id: 'DISHWASHER', re: /\b(dishwasher[- ]?safe|lave[- ]vaisselle)\b/ },
  // a recycled MATERIAL of the product is a claim without naming the product ("made from recycled steel")
  { id: 'ECO_CLAIM', re: /\b(recycled|recyclé\w*)\s+(steel|stainless|acier|inox|aluminium|aluminum|plastic|plastique|tritan|silicone)\b|\b(made (from|of)|fait de|faite de|en) (recycled|recyclé\w*)\b/ },
  { id: 'ECO_CLAIM', re: /\b(eco[- ]?friendly|écologique\w*|ecologique\w*|zero[- ]waste|zéro déchet|recyclable\w*|recycled|recyclé\w*|carbon[- ]neutral|neutre en carbone|sustainable|durables? pour la planète|plastic[- ]free|sans plastique)\b/, needsProduct: true },
  { id: 'MADE_IN', re: /\b(made in|fabriquée? en|fabriquée? à|handmade|fait main)\b/, needsProduct: true },
  { id: 'GUARANTEE', re: /\b(guarantee[ds]?|warranty|warranted|garantie|garanti à vie|lifetime (guarantee|warranty)|satisfait ou rembours\w*)\b/ },
  { id: 'SUPERLATIVE', re: /(\bthe best\b|\ble meilleur\b|\bla meilleure\b|\bbest[- ]selling\b|n°\s?1\b|\bnumber one\b|\bnuméro un\b|\bworld'?s first\b|\bpremier au monde\b)/ },
];
export const CAPABILITY_CLAIMS = Object.freeze(RAW_CLAIMS.map((c) => Object.freeze({ ...c, re: U(c.re, 'giu') })));
const PRODUCT_U = U(PRODUCT, 'iu');
// a statement named in order to deny it: "non isotherme", "ne garde pas l'eau froide", "not insulated", "sans BPA" is NOT a negation here (it is the claim itself)
const NEGATED = U(/(\bnon\b|\bnot\b|\bnever\b|\b(doesn|don|won|can|isn|aren)['’]t\b|\bcannot\b|\bne\b[^.;:,]{0,25}\b(pas|jamais|plus)\b|\bn['’][^.;:,]{0,25}\b(pas|jamais|plus)\b|\bwithout being\b|\bpas\b)[^.;:,]{0,25}$/, 'iu');
const NEG_INSIDE = U(/\b(pas|jamais|plus|not|never|no longer|n't|doesn't|don't|won't|cannot|can't)\b|n['’]t\b/, 'iu');
const NOT_A_NEGATION = U(/\b(not only|not just|non seulement|pas seulement|pas que|not merely)\b/, 'iu');
const CLAUSE_CUT = U(/[,;:.!?()]|\b(mais|but|only|seulement|yet|however|cependant|pourtant|and|et)\b/, 'giu');
const clauseOf = (before) => { let cut = 0; let m; const re = new RegExp(CLAUSE_CUT.source, 'giu'); while ((m = re.exec(before))) cut = m.index + m[0].length; return before.slice(cut); };

const normalizeText = (s) => String(s ?? '').normalize('NFC').replace(/[​-‍⁠﻿­]/g, '');
const sentenceOf = (t, index) => { const a = Math.max(t.lastIndexOf('.', index - 1), t.lastIndexOf(';', index - 1), t.lastIndexOf('!', index - 1), t.lastIndexOf('?', index - 1)) + 1; const b = t.slice(index).search(/[.;!?]/); return t.slice(a, b < 0 ? t.length : index + b); };
const numbersIn = (x) => (x.match(/\d{1,3}/g) ?? []).map(Number);

/** Affirmative occurrences of one claim in a text (negated ones and, when required, those without the product in the sentence are left out). */
function affirmed(claim, text) {
  const out = []; const g = new RegExp(claim.re.source, 'giu'); let m;
  while ((m = g.exec(text))) {
    if (m[0] === '') { g.lastIndex += 1; continue; }
    const clause = clauseOf(text.slice(0, m.index));
    if (NEGATED.test(clause) && !NOT_A_NEGATION.test(text.slice(Math.max(0, m.index - 20), m.index + 1))) continue;
    // "ne garde PAS l'eau froide", "doesn't keep drinks cold": the negation sits INSIDE the matched phrase (only for claims whose patterns are not negative forms)
    if (!['LEAK_PROOF', 'BPA_FREE', 'ECO_CLAIM'].includes(claim.id) && NEG_INSIDE.test(m[0])) continue;
    if (claim.needsProduct && !PRODUCT_U.test(sentenceOf(text, m.index))) continue;
    out.push(m[0]);
  }
  return out;
}

/** The capabilities a text affirms that the verified text does not affirm too (for durations: with the same figure). */
export function inventedCapabilities(text, verifiedText = '') {
  const t = normalizeText(text); const v = normalizeText(verifiedText);
  const ids = new Set();
  for (const c of CAPABILITY_CLAIMS) {
    const said = affirmed(c, t); if (!said.length) continue;
    const backed = CAPABILITY_CLAIMS.filter((x) => x.id === c.id).flatMap((x) => affirmed({ ...x, needsProduct: false }, v));
    if (!backed.length) { ids.add(c.id); continue; }
    if (c.numeric) { const ok = new Set(backed.flatMap(numbersIn)); if (said.some((x) => numbersIn(x).some((n) => !ok.has(n)))) ids.add(c.id); }
  }
  return [...ids];
}

function check(fields, verifiedText) {
  for (const [field, value] of fields) {
    if (typeof value !== 'string' || !value) continue;
    const decor = hasForbidden(value);
    if (decor) fail(BRAIN_ERROR.FORBIDDEN_CONTENT, `${field} uses a word HABB forbids: ${decor}`, field, { problem: 'HABB_FORBIDDEN_DECOR', word: decor });
    const invented = inventedCapabilities(value, verifiedText);
    if (invented.length) fail(BRAIN_ERROR.RULE_VIOLATION, `${field} attributes to the product a capability its verified facts do not state: ${invented.join(', ')}`, field, { problem: 'INVENTED_CAPABILITY', capabilities: invented });
  }
}

/** The verified text a creative decision may rely on: the Shopify title, variant and description, nothing else. */
export const verifiedTextOf = (facts) => [facts?.product_title, facts?.variant, facts?.description].filter(Boolean).join(' . ');

/** IDEATE: every concept, on every field that describes what is shown or told (not the model's own list of risks, which may name what to avoid). */
export function assertConceptsHabbRules(concepts, facts) {
  const v = verifiedTextOf(facts);
  concepts.forEach((c, i) => check([
    [`concepts[${i}].central_idea`, c.central_idea], [`concepts[${i}].visual_metaphor`, c.visual_metaphor], [`concepts[${i}].story`, c.story],
    [`concepts[${i}].emotional_intent`, c.emotional_intent], [`concepts[${i}].memory_hook`, c.memory_hook], [`concepts[${i}].distinctiveness_reason`, c.distinctiveness_reason],
  ], v));
  return concepts;
}

/** ART_DIRECT: every field that describes what is seen (forbidden_decorative_noise is exempt: it names what must NOT appear). */
export function assertArtDirectionGuard(art, facts) {
  check([
    ['art_direction.atmosphere', art.atmosphere], ['art_direction.material_language', art.material_language], ['art_direction.lighting_intent', art.lighting_intent], ['art_direction.rationale', art.rationale],
    ...(art.narrative_elements ?? []).flatMap((e, i) => [[`art_direction.narrative_elements[${i}].element`, e.element], [`art_direction.narrative_elements[${i}].reason`, e.reason]]),
    ...(art.permitted_secondary_elements ?? []).map((e, i) => [`art_direction.permitted_secondary_elements[${i}]`, e]),
  ], verifiedTextOf(facts));
  return art;
}

/** STAGE: headline, rationale, light purposes and prop reasons (the stage contract already refuses decor words and figures; this adds invented capabilities). */
export function assertStageGuard(stage, facts) {
  check([
    ['stage.headline', stage.headline], ['stage.rationale', stage.rationale], ['stage.key_light.purpose', stage.key_light?.purpose],
    ...(stage.accent_lights ?? []).map((l, i) => [`stage.accent_lights[${i}].purpose`, l.purpose]),
    ...(stage.props ?? []).map((p, i) => [`stage.props[${i}].reason`, p.reason]),
  ], verifiedTextOf(facts));
  return stage;
}

/** What the Brain is TOLD from the frame on (public facts of the brief): who HABB is and what it never shows or claims. */
export function habbBriefFacts(brand) {
  return {
    merchant_identity: brand.expression?.identity ?? null,
    merchant_voice: brand.expression?.voice ?? null,
    visual_prohibitions: `${brand.expression?.visual_rules ?? ''} Mots et éléments refusés par Nordla à chaque étape : ${FORBIDDEN_DECOR.join(', ')}.`.trim(),
    facts_rule: 'Seuls les faits vérifiés de la fiche Shopify peuvent être affirmés. Aucune capacité non écrite dans la fiche (isolation, durée de froid ou de chaud, étanchéité, incassable, sans BPA, écologique, garantie, superlatif) ne peut être attribuée au produit. Le produit réel est montré tel qu\'il est photographié : forme, couleur, logo inchangés.',
  };
}
