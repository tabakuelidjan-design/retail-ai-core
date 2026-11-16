// THE STAGE CONTRACT (mise en scène). The missing link between the Creative Brain and pixels: after a concept and its art direction, the Brain itself
// states the set, the light, the camera, the props and the text placement of the image, in a CLOSED vocabulary that a local engine can build without
// any human writing positions. It replaces the "product slot + text column" recipe for autonomous proposals: the concept chooses the set, the light,
// the scale and the format share of the product; the engine only executes.
//
// What the vocabulary allows is wide on purpose (backdrops, light kinds, props, an extruded word, plinths, camera heights) and narrow where the rules
// are hard. UNIVERSAL rules (every tenant): no text that invents a claim, no figure in the headline, no placeholder headline, no promise of
// personalisation for a product that is not personalised. TENANT rules (the active tenant's creative profile, src/creative-autonomy/brand-profile.js):
// its forbidden visual elements and its brand tones. Every prop carries a reason that must be argued in the concept.
import { list, obj, renderContract, renderRules, text, validateSpec, word } from '../creative-brain/contract.js';
import { conceptualWords } from '../creative-brain/concept.js';
import { conceptAnchorWords } from '../creative-brain/art-direction.js';
import { principlesAsText, principlesFor, REASONING_STAGE } from '../creative-brain/knowledge.js';
import { askAndNormalize, parseJsonObject } from '../creative-brain/model-port.js';
import { BRAIN_ERROR, deepFreeze, deriveId, fail } from '../creative-brain/validation.js';
import { resolveBrandProfile } from './brand-profile.js';
import { perspectiveHint } from './photo-perspective.js';

const V = (...names) => Object.freeze(Object.fromEntries(names.map((n) => [n, n])));
export const BACKDROP = V('SEAMLESS_SWEEP', 'INFINITE_DARK', 'WALL_AND_FLOOR');
export const TONE = V('DEEP_BLACK', 'CHARCOAL', 'BRAND_NAVY', 'BRAND_TERRACOTTA', 'COOL_GREY', 'WHITE');
export const FLOOR = V('MATTE', 'SATIN', 'MIRROR');
export const LIGHT_KIND = V('SOFTBOX', 'STRIP', 'SLIT_SHEET', 'SPOT', 'RIM');
export const SIDE = V('LEFT', 'RIGHT', 'FRONT', 'BACK', 'TOP');
export const LEVEL = V('LOW', 'MEDIUM', 'HIGH');
export const TEMPERATURE = V('COOL', 'NEUTRAL', 'WARM');
export const CAMERA_HEIGHT = V('LOW', 'PRODUCT_CENTER', 'HIGH');
export const FRAMING = V('WIDE', 'MEDIUM', 'CLOSE');
export const POSITION = V('LEFT_THIRD', 'CENTER', 'RIGHT_THIRD');
export const SHAPE = V('BLOCK', 'CYLINDER', 'SPHERE', 'ARCH', 'PLINTH', 'PANEL', 'EXTRUDED_WORD');
export const MATERIAL = V('MATTE_BLACK', 'BRAND_NAVY', 'BRAND_TERRACOTTA', 'CONCRETE', 'BRUSHED_STEEL', 'FROSTED_GLASS', 'PAPER_WHITE');
export const PLACEMENT = V('BEHIND', 'BESIDE_LEFT', 'BESIDE_RIGHT', 'FOREGROUND_LEFT', 'FOREGROUND_RIGHT', 'BENEATH');
export const TEXT_PLACEMENT = V('TOP_LEFT', 'TOP_RIGHT', 'LEFT_COLUMN', 'RIGHT_COLUMN', 'BOTTOM_LEFT', 'BOTTOM_RIGHT');
export const YES_NO = V('YES', 'NO');
// SUPPORT (C1, 2026-11-06): the surface the real product stands on, DRAWN BY THE SCENE (a floor, a ledge, a step, a bench, a table). It is the only way to say "on a ledge", which `props` (PLINTH beneath) cannot express and which the scene request never carried.
// (no support height: the contact line of the product is fixed by the plate geometry, BASE_Y of scene_plate.py; a height chosen here would contradict the reserved area)
export const SUPPORT_SURFACE = V('FLOOR', 'LEDGE', 'STEP', 'BENCH', 'TABLE');

const LIGHT = obj({ kind: word(LIGHT_KIND), side: word(SIDE), intensity: word(LEVEL), temperature: word(TEMPERATURE), purpose: text({ max: 160, fit: true }) });
// V1 (real runs 2026-11-05: the first STAGE answer put a BLOCK beneath the product in 4 of 4 runs and two repairs left it unchanged): a BLOCK placed BENEATH the product IS the support the product
// stands on, i.e. a PLINTH. Nordla makes that ONE deterministic, logged correction before validation; nothing else is touched (another shape beneath, a plinth elsewhere, a block elsewhere stay
// for the rules, and for the repair). PLINTH_IS_BENEATH still judges the result.
export function supportBlockIsAPlinth(prop, repairs = [], path = 'stage.props[]') {
  if (prop?.shape !== 'BLOCK' || prop?.placement !== 'BENEATH') return prop;
  repairs.push({ path: `${path}.shape`, kind: 'SUPPORT_AS_PLINTH', from: 'BLOCK (placed BENEATH the product)', to: 'PLINTH (the support the product stands on)' });
  return { ...prop, shape: 'PLINTH' };
}
const PROP = { ...obj({ shape: word(SHAPE), material: word(MATERIAL), placement: word(PLACEMENT), scale: word(LEVEL), word: text({ max: 14 }), reason: text({ max: 220, fit: true }) }, { optional: ['word'] }), nearMiss: supportBlockIsAPlinth };

export const STAGE_SPEC = obj({
  backdrop: word(BACKDROP), backdrop_tone: word(TONE), floor_finish: word(FLOOR),
  key_light: LIGHT, accent_lights: list(LIGHT, { min: 0, max: 3 }),
  camera: obj({ height: word(CAMERA_HEIGHT), framing: word(FRAMING), product_position: word(POSITION) }),
  // where the product stands, as a surface of the SCENE (optional: an answer without it keeps the floor, exactly as before)
  support_surface: word(SUPPORT_SURFACE),
  props: list(PROP, { min: 0, max: 4 }),
  headline: text({ max: 60 }), text_placement: word(TEXT_PLACEMENT), show_price: word(YES_NO),
  rationale: text({ max: 300, fit: true }),
  // the model's own report of what the concept or art direction asked for and this closed vocabulary could not express: the evidence of the grammar's limits
  wanted_but_not_available: list(text({ max: 200, fit: true }), { min: 0, max: 5, fit: true }),
  // up to 3 other headlines for the same idea: a candidate POOL for the hard rules below (see resolveHeadline). Optional, free, never required.
  headline_alternatives: list(text({ max: 60 }), { min: 0, max: 3, fit: true }),
}, { optional: ['wanted_but_not_available', 'headline_alternatives', 'support_surface'] });

const PERSONALISATION_WORDS = /(personnalis|grav|ton nom|votre nom|prénom|prenom|initiales|custom|engrav|monogram|à ton image|imprimé pour)/i;
// placeholder copy a model (or a test double) may leave in a headline: never shown as a proposal
const PLACEHOLDER_HEADLINE = /(^|\s)(titre|title|headline|accroche|slogan|texte|text)\s+(de\s+|d['’])?(test|exemple|example|placeholder|démo|demo)(\s|$)|lorem\s+ipsum|placeholder|\btbd\b|\bxxx+\b|(votre|ton|your)\s+(texte|titre|text|headline)\s+(ici|here)|^(titre|title|headline|test)$/iu;
// A headline that sets the product against weather, water or dust ("même sous la pluie") promises a resistance the product sheet never states (real run 2026-11-05). The ENVIRONMENT may be rainy; the TEXT may not say so.
const RESISTANCE_IMPLIED = /(?<![\p{L}])(pluie|pleut\p{L}*|averse|orage|temp[eê]te|neige|humid\p{L}*|mouill\p{L}*|eau|éclabouss\p{L}*|poussi[eè]re|boue|intemp[eé]ries|rain\p{L}*|water\p{L}*|wet|storm\p{L}*|snow\p{L}*|splash\p{L}*|dust\p{L}*|weather\p{L}*|résist\p{L}*|resist\p{L}*|robuste|solide|tout[- ]terrain|indestructible)(?![\p{L}])/iu;
const CLAIM_WORDS = /(meilleur|best|n°\s?1|numéro un|garanti|guarantee|100\s?%|isotherme|insulated|24\s?h|12\s?h|incassable|unbreakable|gratuit|free)/i;

/** NFC + invisible characters removed: "be\u200Bige" and a decomposed "cre\u0300me" are the same words as "beige" and "crème". */
export const normalizeText = (s) => String(s ?? '').normalize('NFC').replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '').toLowerCase();
const L = '\\p{L}\\p{N}_';
// senses that are NOT decor: a SHEET of paper or metal, the VERB "leaves", the idioms "au cœur de" / "at the heart of" / "coup de cœur" / "par cœur"
const SHEET_SENSE = /feuilles?\s+(de|d['’])\s*(papier|métal|metal|verre|calque|acier|aluminium|zinc|cuivre|plastique|carton)/giu;
const FOLIAGE_LEAVES = /\b(dry|dried|fallen|autumn|green|golden|dead|falling|scattered|fresh|wet|palm|tree|maple|oak|tea|lettuce|olive|ivy|of|with)\s+leaves\b/iu;
const VERB_SENSE = /\bleaves\s+(it|them|him|her|us|you|me|the|a|an|its|their|his|our|your|this|that|these|those|behind|room|space|only|no|nothing|everything|something|enough|just|again|alone|open|ready|home|before|after|out|off|from)\b/giu;
const IDIOMS = /(au|en plein|du|le|de tout|droit au)\s+c(œ|oe)ur(\s+(de|du|des|d['’]|battant))?|c(œ|oe)ur\s+de\s+ville|coup\s+de\s+c(œ|oe)ur|par\s+c(œ|oe)ur|\b(at\s+the|the|in\s+the)\s+heart\s+of\b|\bby\s+heart\b/giu;
// a forbidden word NAMED in order to exclude it is not a use of it ("sans beige", "no leaves", "pas de dorure"), but only inside ITS OWN clause: a comma, a
// semicolon or "mais / but / only / yet / however / très / very / and / et" ends the negation ("no gold, only golden light" is golden light)
const CLAUSE_BREAK = new RegExp(`[,;:.!?()]|(?<![${L}])(mais|but|only|seulement|yet|however|cependant|pourtant|très|very|and|et|plus|more)(?![${L}])`, 'giu');
const NEGATION_IN_CLAUSE = new RegExp(`(?<![${L}])(sans|without|no|not|aucun|aucune|pas\\s+de|pas\\s+d['’]|ni|never|jamais|zéro|zero|plutôt\\s+que|instead\\s+of|rather\\s+than|au\\s+lieu\\s+(de|du|des)|loin\\s+(de|du|des)|away\\s+from|avoid|avoiding|éviter|évite|forbid\\w*|interdi\\w*)(?![${L}])`, 'iu');
const clauseBefore = (t, index) => { const before = t.slice(0, index); let cut = 0; let m; const re = new RegExp(CLAUSE_BREAK.source, 'giu'); while ((m = re.exec(before))) cut = m.index + m[0].length; return before.slice(cut); };
// the negation must REACH the term (2026-11-08): a negator in the last 5 words before it, in its clause. "Aucun autre objet ... ne pourrait coïncider avec une veine naturelle de marbre" negates the object, not the marble.
const NEGATION_REACH_WORDS = 5;
const NEGATION_BEFORE = { test: (beforeText) => { const clause = clauseBefore(beforeText, beforeText.length); const near = clause.trim().split(/\s+/).slice(-NEGATION_REACH_WORDS).join(' '); return NEGATION_IN_CLAUSE.test(near); } };
const wordRe = (w) => new RegExp(`(?<![${L}])${w}(s|x|e|es)?(?![${L}])`, 'iu');
const compiledLists = new WeakMap();
const wordResOf = (words) => { let r = compiledLists.get(words); if (!r) { r = words.map((w) => [w, wordRe(w)]); compiledLists.set(words, r); } return r; };

/** The first word of the TENANT's list `words` used (not negated) in `s`, or null. There is no global list: a tenant without prohibitions gets null. */
export const hasForbidden = (s, words) => {
  if (!Array.isArray(words) || !words.length) return null;
  let t = normalizeText(s);
  if (FOLIAGE_LEAVES.test(t)) return 'leaves'; // "dry leaves the size of hands" is foliage, whatever follows
  t = t.replace(SHEET_SENSE, ' ').replace(VERB_SENSE, ' ').replace(IDIOMS, ' ');
  for (const [w, re] of wordResOf(words)) {
    const g = new RegExp(re.source, 'giu'); let m;
    while ((m = g.exec(t))) { if (!NEGATION_BEFORE.test(t.slice(0, m.index))) return w; }
  }
  return null;
};

/**
 * The TENANT's forbidden visual elements, enforced on an ART_DIRECT answer (the Brain's own contract does not know the tenant). Every field that can describe
 * what is SEEN is checked; forbidden_decorative_noise is not (it is where the model names what must NOT appear). Refusal: BRAIN_FORBIDDEN_CONTENT with the field.
 */
export function assertArtDirectionBrandRules(art, profile = resolveBrandProfile({})) {
  const fields = [
    ['art_direction.atmosphere', art.atmosphere], ['art_direction.material_language', art.material_language], ['art_direction.lighting_intent', art.lighting_intent], ['art_direction.rationale', art.rationale],
    ...(art.narrative_elements ?? []).flatMap((e, i) => [[`art_direction.narrative_elements[${i}].element`, e.element], [`art_direction.narrative_elements[${i}].reason`, e.reason]]),
    ...(art.permitted_secondary_elements ?? []).map((e, i) => [`art_direction.permitted_secondary_elements[${i}]`, e]),
  ];
  for (const [field, value] of fields) {
    const hit = hasForbidden(value, profile.forbidden_decor);
    if (hit) fail(BRAIN_ERROR.FORBIDDEN_CONTENT, `${field} uses a word ${profile.brand_name ?? 'the merchant'} forbids: ${hit}`, field, { problem: 'BRAND_FORBIDDEN_DECOR', word: hit });
  }
  return art;
}
// every free text of a stage WITH its exact field: a refusal names the field to fix, so a repair can be scoped to it (and cannot rewrite the rest of the stage)
const namedTexts = (v) => [['stage.headline', v.headline], ['stage.rationale', v.rationale], ['stage.key_light.purpose', v.key_light.purpose],
  ...v.accent_lights.map((l, i) => [`stage.accent_lights[${i}].purpose`, l.purpose]),
  ...v.props.flatMap((p, i) => [[`stage.props[${i}].reason`, p.reason], [`stage.props[${i}].word`, p.word ?? '']])];
const allTexts = (v) => namedTexts(v).map(([, t]) => t);

export const STAGE_RULES = Object.freeze([
  { id: 'NO_FORBIDDEN_DECOR', statement: 'none of the merchant\'s forbidden visual elements (stated in the brief) may appear in any text of the stage.',
    check: (v, ctx) => { for (const [field, t] of namedTexts(v)) { const hit = hasForbidden(t, ctx.profile.forbidden_decor); if (hit) fail(BRAIN_ERROR.FORBIDDEN_CONTENT, `the stage uses a forbidden decor word: ${hit.trim()}`, field, { problem: 'FORBIDDEN_DECOR', word: hit.trim() }); } } },
  { id: 'BRAND_TONES_ONLY_WHEN_DEFINED', statement: 'BRAND_NAVY / BRAND_TERRACOTTA (tones and materials) name the merchant\'s own palette: use them only when the brief says the merchant has that colour.',
    check: (v, ctx) => {
      const ok = (x) => !/^BRAND_/.test(x) || Boolean(ctx.profile.tone_words?.[x]);
      if (!ok(v.backdrop_tone)) fail(BRAIN_ERROR.RULE_VIOLATION, `${v.backdrop_tone} is not a colour of this merchant`, 'stage.backdrop_tone', { problem: 'BRAND_TONE_NOT_DEFINED' });
      v.props.forEach((p, i) => { if (!ok(p.material)) fail(BRAIN_ERROR.RULE_VIOLATION, `${p.material} is not a colour of this merchant`, `stage.props[${i}].material`, { problem: 'BRAND_TONE_NOT_DEFINED' }); });
    } },
  { id: 'HEADLINE_IS_NOT_A_PLACEHOLDER', statement: 'the headline is real copy for this product: never a placeholder ("Titre de test", "Headline", "Lorem ipsum", "Votre texte ici", "TBD").',
    check: (v) => { if (PLACEHOLDER_HEADLINE.test(normalizeText(v.headline))) fail(BRAIN_ERROR.RULE_VIOLATION, 'the headline is a placeholder, not copy', 'stage.headline', { problem: 'HEADLINE_IS_A_PLACEHOLDER' }); } },
  { id: 'HEADLINE_INVENTS_NO_CLAIM', statement: 'the headline is at most eight words, contains no digit, no price, no percentage, no superlative and no technical promise (insulation, duration, unbreakable, free); the price is shown by the system from the verified facts when show_price is YES.',
    check: (v) => {
      if (/[0-9€%]/.test(v.headline)) fail(BRAIN_ERROR.RULE_VIOLATION, 'the headline may not contain a figure', 'stage.headline', { problem: 'HEADLINE_HAS_A_FIGURE' });
      if (CLAIM_WORDS.test(v.headline)) fail(BRAIN_ERROR.RULE_VIOLATION, 'the headline states an unverified claim', 'stage.headline', { problem: 'HEADLINE_INVENTS_A_CLAIM' });
      if (RESISTANCE_IMPLIED.test(v.headline)) fail(BRAIN_ERROR.RULE_VIOLATION, 'the headline implies a resistance (weather, water, dust, toughness) the product sheet does not state', 'stage.headline', { problem: 'HEADLINE_IMPLIES_RESISTANCE' });
      if (v.headline.split(/\s+/).filter(Boolean).length > 8) fail(BRAIN_ERROR.RULE_VIOLATION, 'the headline is longer than eight words', 'stage.headline', { problem: 'HEADLINE_TOO_LONG' });
    } },
  { id: 'NO_PERSONALISATION_PROMISE_UNLESS_OFFERED', statement: 'if the facts say personalisation is NOT offered for this product, no text (headline, reasons, extruded word) may mention a name, an engraving, a print or any personalisation.',
    check: (v, ctx) => { if (ctx.personalisation_offered) return; for (const [field, t] of namedTexts(v)) if (PERSONALISATION_WORDS.test(t)) fail(BRAIN_ERROR.RULE_VIOLATION, 'the stage promises a personalisation that is not offered for this product', field, { problem: 'PERSONALISATION_NOT_OFFERED' }); } },
  { id: 'EXTRUDED_WORD_IS_ONE_WORD', statement: 'at most one prop is an EXTRUDED_WORD; it then carries a "word" of 2 to 12 capital letters (no digit, no space); no other prop carries a word.',
    check: (v) => {
      const words = v.props.filter((p) => p.shape === SHAPE.EXTRUDED_WORD);
      if (words.length > 1) fail(BRAIN_ERROR.RULE_VIOLATION, 'only one extruded word is allowed', 'stage.props', { problem: 'TOO_MANY_WORDS' });
      v.props.forEach((p, i) => {
        if (p.shape === SHAPE.EXTRUDED_WORD && !/^[A-ZÀÂÉÈÊËÎÏÔÛÙÇ]{2,12}$/.test(p.word ?? '')) fail(BRAIN_ERROR.RULE_VIOLATION, 'an extruded word needs 2 to 12 capital letters', `stage.props[${i}].word`, { problem: 'BAD_EXTRUDED_WORD' });
        if (p.shape !== SHAPE.EXTRUDED_WORD && p.word !== undefined) fail(BRAIN_ERROR.RULE_VIOLATION, 'only an extruded word carries a word', `stage.props[${i}].word`, { problem: 'WORD_ON_A_NON_WORD_PROP' });
      });
    } },
  { id: 'PLINTH_IS_BENEATH', statement: 'a PLINTH is always placed BENEATH the product, and only a PLINTH may be BENEATH.',
    check: (v) => { v.props.forEach((p, i) => { if ((p.shape === SHAPE.PLINTH) !== (p.placement === PLACEMENT.BENEATH)) fail(BRAIN_ERROR.RULE_VIOLATION, 'a plinth goes beneath, and only a plinth', `stage.props[${i}]`, { problem: 'PLINTH_PLACEMENT', shape: p.shape, placement: p.placement }); }); } },
  { id: 'TEXT_NOT_ON_THE_PRODUCT', statement: 'the text placement must sit on the side opposite to the product: a product in the LEFT_THIRD takes text on the right or top right, a product in the RIGHT_THIRD takes text on the left or top left; a CENTER product takes TOP_LEFT, TOP_RIGHT, BOTTOM_LEFT or BOTTOM_RIGHT.',
    check: (v) => {
      const pos = v.camera.product_position; const tp = v.text_placement;
      const bad = (pos === POSITION.LEFT_THIRD && /LEFT/.test(tp)) || (pos === POSITION.RIGHT_THIRD && /RIGHT/.test(tp)) || (pos === POSITION.CENTER && /COLUMN/.test(tp));
      if (bad) fail(BRAIN_ERROR.RULE_VIOLATION, 'the text would sit on the product', 'stage.text_placement', { problem: 'TEXT_OVER_PRODUCT' });
    } },
  { id: 'LIGHT_SIDE_COMPATIBLE_WITH_PACKSHOT', statement: 'key light: the packshot_lit_side, FRONT or TOP; never the opposite side or BACK.',
    check: (v, ctx) => {
      const lit = ctx.packshot_lit_side; if (lit !== 'LEFT' && lit !== 'RIGHT') return;
      const side = v.key_light.side;
      if (!(side === lit || side === SIDE.FRONT || side === SIDE.TOP)) fail(BRAIN_ERROR.RULE_VIOLATION, `the key light comes from ${side} but the real packshot is lit from the ${lit}`, 'stage.key_light.side', { problem: 'LIGHT_SIDE_DIFFERS_FROM_PHOTO', packshot_lit_side: lit, key_light_side: side });
    } },
  { id: 'PROP_REASON_IN_THE_CONCEPT', statement: 'every prop needs a reason argued in the concept: its reason must share at least one significant word with the concept\'s central idea, metaphor, story or emotional intent.',
    check: (v, ctx) => {
      const c = ctx.concept; const words = new Set(conceptualWords([c.central_idea, c.visual_metaphor, c.story, c.emotional_intent].join(' ')));
      v.props.forEach((p, i) => { if (!conceptualWords(p.reason).some((w) => words.has(w))) fail(BRAIN_ERROR.RULE_VIOLATION, `prop ${i} has no reason in the concept`, `stage.props[${i}].reason`, { problem: 'PROP_WITHOUT_REASON' }); });
    } },
]);

// ---- HEADLINE CANDIDATES. The headline is CUSTOMER COPY under hard rules (60 characters, 8 words, no figure, no claim, no placeholder, no personalisation promise the product lacks, nothing the
// merchant forbids, nothing the verified facts do not state). Nordla never cuts or rewrites it for the model. Instead the model may offer up to 3 alternatives in the SAME call (free): the
// headline is kept if it passes EVERY rule, otherwise the FIRST alternative that passes every rule, in order. Each candidate is judged by the same rules as a headline: a candidate is
// never trusted, never partially accepted, and a bad alternative can never stop a run (it is simply not chosen). Deterministic: the same answer always gives the same headline.
/**
 * A headline WRITTEN BY THE MERCHANT (the administrator types it with the facts of the product: owner decision 2026-11-06). The rules that stop a MODEL from inventing facts (no figure, no claim word)
 * do not apply to a person who states their own verified facts; every rule that protects the brand and the customer still does: not empty, 60 characters, 8 words, no placeholder, no
 * personalisation the product lacks, nothing the merchant forbids, no promise of resistance (weather, water, dust, toughness), and the brand guard's own refusals (invented capabilities).
 */
export function ownerHeadlineProblem(candidate, ctx) {
  if (typeof candidate !== 'string') return 'NOT_TEXT';
  const t = candidate.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!t) return 'EMPTY';
  if (t.length > 60) return 'HEADLINE_TOO_LONG_CHARS';
  if (PLACEHOLDER_HEADLINE.test(normalizeText(t))) return 'HEADLINE_IS_A_PLACEHOLDER';
  if (t.split(/\s+/).filter(Boolean).length > 8) return 'HEADLINE_TOO_LONG';
  if (!ctx.personalisation_offered && PERSONALISATION_WORDS.test(t)) return 'PERSONALISATION_NOT_OFFERED';
  if (hasForbidden(t, ctx.profile?.forbidden_decor)) return 'FORBIDDEN_DECOR';
  if (RESISTANCE_IMPLIED.test(t)) return 'HEADLINE_IMPLIES_RESISTANCE';
  return null;
}
/** The first reason a candidate headline cannot be used, or null when it passes every headline rule. ctx: { personalisation_offered, profile, headlineCheck? } */
export function headlineProblem(candidate, ctx) {
  if (typeof candidate !== 'string') return 'NOT_TEXT';
  const t = candidate.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!t) return 'EMPTY';
  if (t.length > 60) return 'HEADLINE_TOO_LONG_CHARS';
  if (PLACEHOLDER_HEADLINE.test(normalizeText(t))) return 'HEADLINE_IS_A_PLACEHOLDER';
  if (/[0-9€%]/.test(t)) return 'HEADLINE_HAS_A_FIGURE';
  if (CLAIM_WORDS.test(t)) return 'HEADLINE_INVENTS_A_CLAIM';
  if (t.split(/\s+/).filter(Boolean).length > 8) return 'HEADLINE_TOO_LONG';
  if (!ctx.personalisation_offered && PERSONALISATION_WORDS.test(t)) return 'PERSONALISATION_NOT_OFFERED';
  if (hasForbidden(t, ctx.profile?.forbidden_decor)) return 'FORBIDDEN_DECOR';
  if (ctx.headlineCheck) { try { ctx.headlineCheck(t); } catch (e) { return e?.detail?.problem ?? e?.code ?? 'BRAND_GUARD'; } }
  if (RESISTANCE_IMPLIED.test(t)) return 'HEADLINE_IMPLIES_RESISTANCE';
  return null;
}
/** The answer with its headline resolved and the alternatives removed (the closed stage keeps ONE headline). selection = null when the answer offered no alternatives. */
export function resolveHeadline(raw, ctx) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('headline_alternatives' in raw)) return { raw, selection: null };
  const { headline_alternatives: alternatives, ...rest } = raw;
  const candidates = [raw.headline, ...(Array.isArray(alternatives) ? alternatives.slice(0, 3) : [])];
  const rejected = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const problem = headlineProblem(candidates[i], ctx);
    if (problem) { rejected.push({ index: i, problem }); continue; }
    return { raw: { ...rest, headline: candidates[i].normalize('NFC').trim().replace(/\s+/g, ' ') }, selection: { chosen_index: i, candidates: candidates.length, rejected } };
  }
  return { raw: rest, selection: { chosen_index: null, candidates: candidates.length, rejected } }; // none passes: the model's own headline stays and the usual refusal (and repair) applies
}

/** Validates a model's stage against the contract, the universal rules and the TENANT's rules. ctx: { concept, personalisation_offered, profile?, headlineCheck?, onHeadline? } */
export function normalizeStage(raw, ctx) {
  const c = { ...ctx, profile: ctx.profile ?? resolveBrandProfile({}) };
  const resolved = resolveHeadline(raw, c);
  c.onHeadline?.(resolved.selection);
  const v = validateSpec(STAGE_SPEC, resolved.raw, 'stage');
  for (const r of STAGE_RULES) r.check(v, c);
  const body = { concept_id: ctx.concept.concept_id, ...v };
  return deepFreeze({ stage_id: deriveId('stg', body), ...body });
}

export function buildStageInstruction({ frame, concept, artDirection, facts, hints = [], profile = resolveBrandProfile({}), packshotLitSide = null, packshotCameraHeight = null }) {
  const system = [
    'You are the Nordla set designer and photographer. From the selected concept and its art direction, you decide the mise en scène of ONE advertising image: the set, the light, the camera, the props and where the text goes.',
    'The real product is a protected photograph that the system places on the support_surface you choose (FLOOR, LEDGE, STEP, BENCH or TABLE, drawn by the scene; default FLOOR); you never describe, redraw or modify the product, and you never invent a fact about it.',
    'PROPS UNDER THE PRODUCT: a surface the product stands on has the shape PLINTH and the placement BENEATH (a PLINTH is the ONLY shape that may be BENEATH, and every PLINTH must be BENEATH). Every other shape goes BEHIND, BESIDE_LEFT, BESIDE_RIGHT, FOREGROUND_LEFT or FOREGROUND_RIGHT: a BLOCK or a CYLINDER is never BENEATH.',
    'The concept decides the image: the set, the props and the light must make the concept\'s idea visible at a glance. A plain product shot on a backdrop is a failure unless the concept is precisely about emptiness.',
    'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...renderContract(STAGE_SPEC, 'answer'),
    ...renderRules(STAGE_RULES),
    ...(profile.forbidden_decor.length ? [`${profile.brand_name ?? 'The merchant'}'s forbidden visual elements: ${profile.forbidden_decor_summary ?? ''} None of these words may appear: ${profile.forbidden_decor.join(', ')}.`] : []),
    `The merchant's own palette tones you may use: ${Object.keys(profile.tone_words).length ? Object.entries(profile.tone_words).map(([k, w]) => `${k} (${w})`).join(', ') : 'none (do not use BRAND_* tones or materials)'}.`,
    `The headline is YOUR proposal: it will be shown to the owner for approval. Write it in ${profile.language ?? 'the language of the brief'}.`,
    'rationale: ONE concise sentence of about 180 to 220 characters (the limit is 300; a longer text is cut back to its last whole clause, so put the essential point first). Say why this set serves the concept; do not list the choices again.',
    'headline: a HARD limit of 60 characters AND 8 words, no digit: count both before you answer, because the headline is customer copy and is never shortened for you. Aim well below it, for 3 to 6 words and about 25 to 45 characters: a short headline is the safe one.',
    'headline_alternatives: OPTIONAL, 2 or 3 other headlines for the same idea, in the same language, each obeying EVERY headline rule (at most 8 words and 60 characters, no digit, no price, no claim, no placeholder, nothing the merchant forbids). Nordla uses "headline" when it passes every rule, otherwise the first alternative that does, in order. They cost nothing: write them.',
    `Every prop "reason" is written in the SAME language as the concept (the concept's own words, not a translation) and contains at least one of these words of the concept: ${conceptAnchorWords(concept).join(', ') || '(use a significant word of the concept\'s central idea)'}.`,
    'This vocabulary is deliberately small. If the concept or the art direction needs something it cannot express (a material, a shape, a light effect, a place, an object, a camera move, an atmosphere), do NOT force a poor substitute silently: choose the closest available option AND name what you really wanted in wanted_but_not_available, in plain words. It is reported to the owner as a limit of the system, not as your failure.',
    ...(packshotCameraHeight ? [perspectiveHint(packshotCameraHeight)] : []),
    ...(hints.length ? ['This is a REVISION of an earlier stage for the same concept. Fix these defects (found on the rendered image or by Nordla\'s contract):', ...hints.map((h) => `- ${h}`)] : []),
    'Reason with these principles of art direction:',
    principlesAsText(principlesFor({ stage: REASONING_STAGE.ART_DIRECT })),
  ].join('\n');
  return { system, user: JSON.stringify({ problem_frame: frame, concept, art_direction: artDirection, verified_facts: facts, ...(packshotLitSide ? { packshot_lit_side: packshotLitSide } : {}), ...(packshotCameraHeight ? { packshot_camera_height: packshotCameraHeight } : {}) }) };
}

/** The STAGE step: one completion of the Brain's language-model port, then the closed contract, the universal rules and the tenant's rules. */
export function createStageDirector({ complete, profile = resolveBrandProfile({}) }) {
  return Object.freeze({
    async stage({ frame, concept, artDirection, facts, hints = [], headlineCheck = null, packshotLitSide = null, packshotCameraHeight = null }) {
      let selection = null;
      const { value, meta } = await askAndNormalize({
        complete, instruction: buildStageInstruction({ frame, concept, artDirection, facts, hints, profile, packshotLitSide, packshotCameraHeight }), stage: 'STAGE', spec: STAGE_SPEC,
        normalize: (raw) => normalizeStage(raw, { concept, personalisation_offered: Boolean(facts.personalisation_offered), profile, headlineCheck, packshot_lit_side: packshotLitSide, onHeadline: (s) => { selection = s; } }),
      });
      return { stage: value, meta: { ...meta, headline_selection: selection } };
    },
  });
}

// ---- HEADLINE REPAIR. In the real trials the model broke the headline limits in 3 of 3 first STAGE answers (65 characters / 10 words, with alternatives of 61, 63 and 70 characters) and a repair
// of the whole STAGE returned the SAME headline: it cannot count unaided. When the headline AND its alternatives all fail, ONE dedicated tiny call (its own small output cap, its own allowance,
// priced as the small call it is) tells the model what Nordla MEASURED, asks for short candidates, and Nordla picks the first that passes EVERY headline rule. Nordla still never cuts or rewrites
// customer copy: it only chooses among the model's own words.
export const HEADLINE_REPAIR = Object.freeze({ max_output_tokens: 400, candidates: 5, aim_words: 6, aim_chars: 40 });
const squeeze = (t) => String(t ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
/** What Nordla measures on a headline: its characters and words (the two limits of the rules). */
export const measureHeadline = (t) => { const s = squeeze(t); return { characters: s.length, words: s ? s.split(' ').length : 0 }; };
// examples of the right LENGTH (shown with their true counts; a test proves each is itself a valid headline)
const HEADLINE_EXAMPLES = Object.freeze(['Prête quand vous l’êtes', 'Une énergie qui vous suit', 'Le noir, sans détour']);
const HEADLINE_RULE_IDS = new Set(['HEADLINE_IS_NOT_A_PLACEHOLDER', 'HEADLINE_INVENTS_NO_CLAIM', 'NO_PERSONALISATION_PROMISE_UNLESS_OFFERED']);

/** The dedicated headline instruction. rejected: [{ text, characters, words, problem }] as Nordla measured them. Returns { system, user, max_output_tokens }. */
export function buildHeadlineInstruction({ concept, facts, profile = resolveBrandProfile({}), rejected = [] }) {
  const lines = [
    'You write ONE thing: the headline of an advertising image for the product below. A headline is one short line of customer copy.',
    `Write it in ${profile.language ?? 'the language of the brief'}.`,
    `Return ONLY one JSON object: {"headlines": [${HEADLINE_REPAIR.candidates} different headlines]}.`,
    `Each headline has ${HEADLINE_REPAIR.aim_words} words or fewer and ${HEADLINE_REPAIR.aim_chars} characters or fewer, spaces included. Nordla REFUSES any headline above 8 words or 60 characters and never shortens one for you: a short headline is the safe one.`,
    `Examples of the right length: ${HEADLINE_EXAMPLES.map((e) => { const m = measureHeadline(e); return `"${e}" (${m.characters} characters, ${m.words} words)`; }).join('; ')}.`,
    ...renderRules(STAGE_RULES.filter((r) => HEADLINE_RULE_IDS.has(r.id))),
    ...(profile.forbidden_decor.length ? [`None of these words may appear: ${profile.forbidden_decor.join(', ')}.`] : []),
    ...(rejected.length ? ['These headlines were REFUSED, as Nordla measured them. Write headlines clearly SHORTER than these, with other wording:',
      ...rejected.slice(-6).map((r) => `- "${String(r.text).slice(0, 90)}": ${r.characters} characters, ${r.words} words (limits 60 and 8)${r.problem ? `, refused for ${r.problem}` : ''}`)] : []),
  ];
  const user = JSON.stringify({ product: { title: facts?.product_title ?? null, variant: facts?.variant ?? null }, concept: { central_idea: concept.central_idea, visual_metaphor: concept.visual_metaphor, emotional_intent: concept.emotional_intent },
    personalisation_offered: Boolean(facts?.personalisation_offered) });
  return { system: lines.join('\n'), user, max_output_tokens: HEADLINE_REPAIR.max_output_tokens };
}
/** The strings of the model's { headlines: [...] } answer (syntax is read leniently, content strictly: strings only, at most 8). */
export function parseHeadlineCandidates(replyText) {
  let o; try { o = parseJsonObject(String(replyText ?? ''), 'headlines'); } catch { return []; }
  return (Array.isArray(o?.headlines) ? o.headlines : []).filter((x) => typeof x === 'string').slice(0, 8);
}
/** The FIRST candidate that passes every headline rule (see headlineProblem), in order, plus every rejected one with its measure. Deterministic; null when none passes. */
export function pickHeadline(candidates, ctx) {
  const rejected = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const problem = headlineProblem(candidates[i], ctx);
    if (problem) { rejected.push({ index: i, text: squeeze(candidates[i]), ...measureHeadline(candidates[i]), problem }); continue; }
    return { headline: squeeze(candidates[i]), chosen_index: i, rejected };
  }
  return { headline: null, chosen_index: null, rejected };
}

export { renderContract };
