// THE BRAND GUARD, AS EARLY AS THE CONCEPT. Two families of refusal, applied to every creative decision Nordla takes (concepts, art direction, staging):
//   1. the ACTIVE TENANT's forbidden visual elements (its creative profile, config/merchants/<merchant>/creative-brand.json; none for a tenant without one)
//   2. INVENTED CAPABILITIES (UNIVERSAL, every tenant): a property of the product that its verified facts do not state (insulation, hours of cold,
//      leak-proof, unbreakable, BPA-free...). Allowed only if the SAME capability appears in the verified product text.
// Refusals are Brain contract refusals (BRAIN_FORBIDDEN_CONTENT / BRAIN_RULE_VIOLATION with the exact field): they stop the run, or feed the bounded repair the
// owner authorised. Nothing is rewritten, removed or softened by this guard.
import { BRAIN_ERROR, BrainError, fail } from '../creative-brain/validation.js';
import { hasForbidden } from './stage-contract.js';
import { resolveBrandProfile } from './brand-profile.js';
import { sceneVocabularyProblems } from './product-free-screen.js';
import { orphanShadowProblems, stageArtProblems, unsourcedBenefitProblems } from './decor-coherence.js';
import { nonEnglishProblems, nonEnglishMessage } from './generator-language.js';
import { ROUTE_ENVIRONMENT_FIRST, ENVIRONMENT_FIRST_ROUTE_REQUIREMENT, ENVIRONMENT_FIRST_COMPOSITION_REQUIREMENT, ROUTE_PRODUCT_VISIBLE, PRODUCT_VISIBLE_ROUTE_REQUIREMENT, PRODUCT_VISIBLE_COMPOSITION_REQUIREMENT } from './route-executability.js';

// JavaScript's \b only knows ASCII letters: "étanche" or "écologique" never matched it. Every \b below is compiled into a Unicode-aware boundary.
const U = (re, flags = 'iu') => new RegExp(re.source.replace(/\\b/g, '(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))').replace(/\\w/g, '[\\p{L}\\p{N}_]'), flags);

// words that tie a sentence to THE PRODUCT (a temperature, eco or origin statement about a coffee shop, a backdrop or the city is not a product claim):
// generic product words + the tenant's own product nouns (profile.product_nouns) + the significant words of THIS product's title
const PRODUCT = /\b(produit|product|article|item|dedans|inside)\b/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const productRe = (profile, verifiedText) => {
  const title = String(verifiedText ?? '').split(' . ')[0];
  const words = [...new Set(title.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length >= 4 && !/^\d/.test(w)))].map(escapeRe);
  const extra = [...(profile?.product_nouns ?? []), ...words.map((w) => `${w}s?`)];
  return U(new RegExp(`\\b(${[PRODUCT.source.slice(3, -3), ...extra].join('|')})\\b`), 'iu');
};
const DRINK = /(drinks?|water|coffee|tea|beverages?|liquids?|contents?|boissons?|eau|café|thé)/;
const TEMP_EN = /(cold|cool|hot|warm|chilled|icy|ice[- ]?cold)/; const TEMP_FR = /(froid\w*|frais|fraîche\w*|chaud\w*|glac\w*)/;

/** Capabilities a creative text may NOT attribute to the product unless the verified facts state them (affirmatively). FR + EN. */
const RAW_CLAIMS = [
  { id: 'INSULATION', re: /\b(isotherm\w*|(?<!(?:^|[^\p{L}])en\s+)isolant\w*(?!\s+(?:le|la|les|l'|un|une|des|du|de|d'|ce|cet|cette|ces|son|sa|ses)(?![\p{L}]))|insulat\w*|thermos|double[- ]paroi|double[- ]wall\w*|vacuum[- ]insulat\w*)\b/ },
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
function affirmed(claim, text, productU) {
  const out = []; const g = new RegExp(claim.re.source, 'giu'); let m;
  while ((m = g.exec(text))) {
    if (m[0] === '') { g.lastIndex += 1; continue; }
    const clause = clauseOf(text.slice(0, m.index));
    if (NEGATED.test(clause) && !NOT_A_NEGATION.test(text.slice(Math.max(0, m.index - 20), m.index + 1))) continue;
    // "ne garde PAS l'eau froide", "doesn't keep drinks cold": the negation sits INSIDE the matched phrase (only for claims whose patterns are not negative forms)
    if (!['LEAK_PROOF', 'BPA_FREE', 'ECO_CLAIM'].includes(claim.id) && NEG_INSIDE.test(m[0])) continue;
    if (claim.needsProduct && !productU.test(sentenceOf(text, m.index))) continue;
    out.push(m[0]);
  }
  return out;
}

/** The capabilities a text affirms that the verified text does not affirm too (for durations: with the same figure). */
export function inventedCapabilities(text, verifiedText = '', profile = null) {
  const t = normalizeText(text); const v = normalizeText(verifiedText);
  const productU = productRe(profile, v);
  const ids = new Set();
  for (const c of CAPABILITY_CLAIMS) {
    const said = affirmed(c, t, productU); if (!said.length) continue;
    const backed = CAPABILITY_CLAIMS.filter((x) => x.id === c.id).flatMap((x) => affirmed({ ...x, needsProduct: false }, v, productU));
    if (!backed.length) { ids.add(c.id); continue; }
    if (c.numeric) { const ok = new Set(backed.flatMap(numbersIn)); if (said.some((x) => numbersIn(x).some((n) => !ok.has(n)))) ids.add(c.id); }
  }
  return [...ids];
}

function check(fields, verifiedText, profile) {
  for (const [field, value] of fields) {
    if (typeof value !== 'string' || !value) continue;
    const decor = hasForbidden(value, profile.forbidden_decor);
    if (decor) fail(BRAIN_ERROR.FORBIDDEN_CONTENT, `${field} uses a word ${profile.brand_name ?? 'the merchant'} forbids: ${decor}`, field, { problem: 'BRAND_FORBIDDEN_DECOR', word: decor });
    const invented = inventedCapabilities(value, verifiedText, profile);
    if (invented.length) fail(BRAIN_ERROR.RULE_VIOLATION, `${field} attributes to the product a capability its verified facts do not state: ${invented.join(', ')}`, field, { problem: 'INVENTED_CAPABILITY', capabilities: invented });
  }
}

/** The verified text a creative decision may rely on: the Shopify title, variant and description, nothing else. */
export const verifiedTextOf = (facts) => [facts?.product_title, facts?.variant, facts?.description].filter(Boolean).join(' . ');
/** What may SOURCE a benefit presented as verified: ONE fact with its source (title, variant, a sentence of the description, one feature). */
export const benefitSourceOf = (facts) => [
  ...(facts?.product_title ? [{ source: 'product_title', text: facts.product_title }] : []), ...(facts?.variant ? [{ source: 'variant', text: facts.variant }] : []),
  ...String(facts?.description ?? '').split(/(?<=[.;!?\n])\s+/).filter(Boolean).map((x, i) => ({ source: `description[${i}]`, text: x })),
  ...(Array.isArray(facts?.features) ? facts.features.map((f, i) => ({ source: `features[${i}]`, text: typeof f === 'string' ? f : JSON.stringify(f) })) : []),
];

/** IDEATE: every concept, on every field that describes what is shown or told (not the model's own list of risks, which may name what to avoid). */
const conceptFields = (c, i) => [
  [`concepts[${i}].central_idea`, c?.central_idea], [`concepts[${i}].visual_metaphor`, c?.visual_metaphor], [`concepts[${i}].story`, c?.story],
  [`concepts[${i}].emotional_intent`, c?.emotional_intent], [`concepts[${i}].memory_hook`, c?.memory_hook], [`concepts[${i}].distinctiveness_reason`, c?.distinctiveness_reason],
  // the set and the value of the concept are what is SEEN and promised: they obey the same brand rules (2026-11-08: a marble plinth sat in `composition` and `value_lever`, unscreened)
  [`concepts[${i}].composition`, c?.composition], [`concepts[${i}].value_lever`, c?.value_lever],
];
/** The appearance sheet of the product (owner-validated), "" when there is none. */
const appearanceOf = (facts, profile) => profile?.product_appearance?.[String(facts?.source?.product_id ?? '').split('/').pop()]?.appearance ?? '';
const decorFirst = (profile) => profile?.route === ROUTE_ENVIRONMENT_FIRST;
const orphanViolation = (field, p) => ({ field, code: BRAIN_ERROR.RULE_VIOLATION, message: `${field} draws a shadow shaped by a part of the product (${p.part}): ${p.clause}. In this route the set is generated EMPTY and the product is added afterwards, with its own shadow: a shadow drawn in the set must be cast by an element drawn in the set (a wall, a slit, a column, a block)`, detail: { problem: 'ROUTE_ORPHAN_SHADOW', part: p.part, clause: p.clause } });
const unsourcedViolation = (field, u) => ({ field, code: BRAIN_ERROR.RULE_VIOLATION, message: `${field} presents as verified a benefit the facts do not state ("${u.benefit}"): the verified product text has none of ${u.missing.join(', ')}`, detail: { problem: 'UNSOURCED_VERIFIED_BENEFIT', benefit: u.benefit } });
/** The coherence checks (orphan shadow in the decor-first route, benefit presented as verified) on a list of [field, text]. */
function coherenceViolations(fields, facts, profile, { orphan }) {
  const out = []; const appearance = orphan ? appearanceOf(facts, profile) : '';
  for (const [field, value] of fields) {
    if (typeof value !== 'string' || !value) continue;
    for (const p of orphanShadowProblems(value, appearance)) out.push(orphanViolation(field, p));
    for (const u of unsourcedBenefitProblems(value, benefitSourceOf(facts))) out.push(unsourcedViolation(field, u));
  }
  return out;
}

export function assertConceptsBrandRules(concepts, facts, profile = resolveBrandProfile({})) {
  const v = verifiedTextOf(facts);
  concepts.forEach((c, i) => check(conceptFields(c, i), v, profile));
  const [first] = coherenceViolations(concepts.flatMap((c, i) => conceptFields(c, i)), facts, profile, { orphan: decorFirst(profile) });
  if (first) fail(first.code, first.message, first.field, first.detail);
  return concepts;
}
/** The same checks, field by field and concept by concept: EVERY refusal of EVERY concept, not only the first (read-only, for the one repair). A defect stays attached to its own concept. */
export function collectConceptsGuard(concepts, facts, profile = resolveBrandProfile({})) {
  const out = []; const verified = verifiedTextOf(facts);
  (Array.isArray(concepts) ? concepts : []).forEach((c, i) => {
    for (const f of conceptFields(c, i)) {
      try { check([f], verified, profile); } catch (e) { if (!(e instanceof BrainError)) throw e; out.push({ field: e.field ?? f[0], code: e.code, message: e.message, detail: e.detail ?? null }); }
    }
    out.push(...coherenceViolations(conceptFields(c, i), facts, profile, { orphan: decorFirst(profile) }));
  });
  return out;
}

// every field of an ART_DIRECT answer that describes what is seen, with its exact path (forbidden_decorative_noise is exempt: it names what must NOT appear)
const artFields = (art) => [
  ['art_direction.atmosphere', art.atmosphere], ['art_direction.material_language', art.material_language], ['art_direction.lighting_intent', art.lighting_intent], ['art_direction.rationale', art.rationale],
  ...(art.narrative_elements ?? []).flatMap((e, i) => [[`art_direction.narrative_elements[${i}].element`, e?.element], [`art_direction.narrative_elements[${i}].reason`, e?.reason]]),
  ...(art.permitted_secondary_elements ?? []).map((e, i) => [`art_direction.permitted_secondary_elements[${i}]`, e]),
];
/** ART_DIRECT: every field that describes what is seen (forbidden_decorative_noise is exempt: it names what must NOT appear). */
export function assertArtDirectionGuard(art, facts, profile = resolveBrandProfile({}), { productless = false, productVisible = false } = {}) {
  check(artFields(art), verifiedTextOf(facts), profile);
  if (productless) assertSceneVocabulary(art);
  if (productVisible) { const [p] = nonEnglishProblems(art); if (p) fail(BRAIN_ERROR.RULE_VIOLATION, nonEnglishMessage(p), p.field, { problem: 'GENERATOR_TEXT_NOT_ENGLISH', words: p.words }); }
  const [first] = coherenceViolations(artFields(art), facts, profile, { orphan: productless });
  if (first) fail(first.code, first.message, first.field, first.detail);
  return art;
}
const sceneProblemMessage = (p) => `${p.field} names ${p.kind === 'PEOPLE' ? 'a person' : 'the product, a part of it, a cable or a device'}: ${p.words.join(', ')}`;
const sceneProblemDetail = (p) => ({ problem: p.kind === 'PEOPLE' ? 'SCENE_DETAIL_HAS_A_PERSON' : 'SCENE_DETAIL_NAMES_THE_PRODUCT', words: p.words });
/** What the art direction says about the scene is sent as words to an image model that is not shown the product: it may not name the product, a part of it, a cable or a person (the SAME screen the request builder applies). Refused HERE and repaired once, never removed in silence at render time. */
export function assertSceneVocabulary(art) {
  const [first] = sceneVocabularyProblems(art);
  if (first) fail(BRAIN_ERROR.FORBIDDEN_CONTENT, sceneProblemMessage(first), first.field, sceneProblemDetail(first));
  return art;
}
/** The same checks, collecting EVERY refusal instead of stopping at the first: [{ field, code, message, detail }]. Read-only; used to name all the violations in one repair. */
export function collectArtDirectionGuard(art, facts, profile = resolveBrandProfile({}), { productless = false, productVisible = false } = {}) {
  const out = []; const verified = verifiedTextOf(facts);
  if (productVisible) for (const p of nonEnglishProblems(art)) out.push({ field: p.field, code: BRAIN_ERROR.RULE_VIOLATION, message: nonEnglishMessage(p), detail: { problem: 'GENERATOR_TEXT_NOT_ENGLISH', words: p.words } });
  for (const f of artFields(art)) {
    try { check([f], verified, profile); } catch (e) { if (!(e instanceof BrainError)) throw e; out.push({ field: e.field ?? f[0], code: e.code, message: e.message, detail: e.detail ?? null }); }
  }
  if (productless) for (const p of sceneVocabularyProblems(art)) out.push({ field: p.field, code: BRAIN_ERROR.FORBIDDEN_CONTENT, message: sceneProblemMessage(p), detail: sceneProblemDetail(p) });
  out.push(...coherenceViolations(artFields(art), facts, profile, { orphan: productless }));
  return out;
}

/** The materials the stage chose that the art direction FORBADE (forbidden_decorative_noise), as violations of the stage field. */
const stageArtViolations = (stage, art) => (art ? stageArtProblems(stage, art) : []).map((p) => ({ field: p.field, code: BRAIN_ERROR.RULE_VIOLATION, message: `${p.field} is ${p.material}, which the art direction forbids ("${p.term}"): choose another material or keep the art direction's own`, detail: { problem: 'STAGE_CONTRADICTS_ART_DIRECTION', material: p.material, term: p.term } }));
const stageFields = (stage) => [
  ['stage.headline', stage.headline], ['stage.rationale', stage.rationale], ['stage.key_light.purpose', stage.key_light?.purpose],
  ...(stage.accent_lights ?? []).map((l, i) => [`stage.accent_lights[${i}].purpose`, l.purpose]),
  ...(stage.props ?? []).map((p, i) => [`stage.props[${i}].reason`, p.reason]),
];
/** STAGE: headline, rationale, light purposes and prop reasons (the stage contract already refuses decor words and figures; this adds invented capabilities). */
export function assertStageGuard(stage, facts, profile = resolveBrandProfile({}), { art = null } = {}) {
  check(stageFields(stage), verifiedTextOf(facts), profile);
  const [first] = [...coherenceViolations(stageFields(stage), facts, profile, { orphan: false }), ...stageArtViolations(stage, art)];
  if (first) fail(first.code, first.message, first.field, first.detail);
  return stage;
}
/** The brand guard on ONE candidate headline (invented capabilities, the tenant's forbidden decor): throws the same refusal the stage guard would. */
/** A wording the owner has not confirmed (a contradicting or unverified fact, `facts.held_wordings`) found in a text: the wording, or null. */
export function heldWordingIn(text, facts) {
  const norm = (t) => String(t ?? '').normalize('NFC').toLowerCase().replace(/[‘’]/g, "'");
  return (facts?.held_wordings ?? []).find((w) => w && norm(text).includes(norm(w))) ?? null;
}
export function assertHeadlineGuard(headline, facts, profile = resolveBrandProfile({})) {
  check([['stage.headline', headline]], verifiedTextOf(facts), profile);
  const held = heldWordingIn(headline, facts);
  if (held) fail(BRAIN_ERROR.FORBIDDEN_CONTENT, `stage.headline states "${held}", which the owner has not confirmed: an uncertain promise is excluded from the announcements`, 'stage.headline', { problem: 'HELD_WORDING_IN_ANNOUNCEMENT', words: [held] });
}
/** The same checks, field by field: EVERY refusal, not only the first (read-only, for the one repair). */
export function collectStageGuard(stage, facts, profile = resolveBrandProfile({}), { art = null } = {}) {
  const out = []; const verified = verifiedTextOf(facts);
  for (const f of stageFields(stage)) {
    try { check([f], verified, profile); } catch (e) { if (!(e instanceof BrainError)) throw e; out.push({ field: e.field ?? f[0], code: e.code, message: e.message, detail: e.detail ?? null }); }
  }
  out.push(...coherenceViolations(stageFields(stage), facts, profile, { orphan: false }), ...stageArtViolations(stage, art));
  return out;
}

/** What the Brain is TOLD from the frame on (public facts of the brief): who the merchant is and what it never shows or claims (its profile). */
export function brandBriefFacts(brand, profile = resolveBrandProfile(brand)) {
  const prohibitions = [brand?.expression?.visual_rules, profile.forbidden_decor.length ? `Mots et éléments refusés par Nordla à chaque étape : ${profile.forbidden_decor.join(', ')}.` : null].filter(Boolean).join(' ');
  return {
    merchant_identity: brand?.expression?.identity ?? null,
    merchant_voice: brand?.expression?.voice ?? null,
    ...(prohibitions ? { visual_prohibitions: prohibitions } : {}),
    facts_rule: profile.facts_rule,
  };
}

/**
 * COMMERCIAL RELEVANCE, without a template. What a concept must ACHIEVE for this merchant (its profile's requirements: what it must achieve, never what it
 * must look like), and the only facts it may build on — all from the verified product snapshot (title, variant, description, price, colour variants).
 */
export function commercialBrief(facts, profile) {
  const colours = facts.colours_available ?? [];
  // WHAT THE REAL PRODUCT LOOKS LIKE (the director never sees the photograph): the owner-validated appearance sheet of this product, and the description claims the photograph does NOT show (never staged)
  const sheet = profile?.product_appearance?.[String(facts.source?.product_id ?? '').split('/').pop()] ?? null;
  return {
    verified_selling_points: [
      `Produit : ${facts.product_title}${facts.variant ? `, coloris ${facts.variant}` : ''}.`,
      ...(sheet ? [`Aspect RÉEL du produit (d'après la photo fournie ; c'est ce qui sera posé dans l'image, à ne jamais contredire ni remplacer) : ${sheet.appearance}`,
        ...(sheet.not_visible_on_photo?.length ? [`Mentionné dans la fiche mais NON visible sur la photo, donc jamais montré ni mis en scène : ${sheet.not_visible_on_photo.join(', ')}.`] : [])] : []),
      `Description vérifiée : ${facts.description}`,
      `Prix vérifié : ${facts.price}.`,
      ...(colours.length > 1 ? [`Coloris existants (fiche Shopify) : ${colours.join(', ')}.`] : []),
      ...(profile?.merchant_display ? [`Vendu par ${profile.merchant_display}.`] : []),
    ],
    // the production route, in operational terms, for every stage that reads the brief (FRAME included): generic, added by the code, never by the tenant
    creative_requirements: [...(profile?.creative_requirements ?? resolveBrandProfile({}).creative_requirements), ...(profile?.route === ROUTE_ENVIRONMENT_FIRST ? [ENVIRONMENT_FIRST_ROUTE_REQUIREMENT, ENVIRONMENT_FIRST_COMPOSITION_REQUIREMENT] : []), ...(profile?.route === ROUTE_PRODUCT_VISIBLE ? [PRODUCT_VISIBLE_ROUTE_REQUIREMENT, PRODUCT_VISIBLE_COMPOSITION_REQUIREMENT] : [])],
    ...(profile?.brand_name ? { brief_owner: profile.brand_name } : {}),
  };
}

/** The same brief as a note appended to a Brain stage's instruction (the stages after FRAME do not see the public facts otherwise). */
export function commercialBriefNote(publicFacts) {
  if (!publicFacts?.creative_requirements) return null;
  return [`${publicFacts.brief_owner ?? 'The merchant'}'s commercial brief for this product (it states what the concept must achieve, never what it must look like; your originality is expected):`,
    ...publicFacts.creative_requirements.map((r) => `- ${r}`), 'Verified facts you may build on (nothing else exists):', ...publicFacts.verified_selling_points.map((r) => `- ${r}`)].join('\n');
}
