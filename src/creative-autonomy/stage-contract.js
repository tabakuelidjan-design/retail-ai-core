// THE STAGE CONTRACT (mise en scène). The missing link between the Creative Brain and pixels: after a concept and its art direction, the Brain itself
// states the set, the light, the camera, the props and the text placement of the image, in a CLOSED vocabulary that a local engine can build without
// any human writing positions. It replaces the "product slot + text column" recipe for autonomous proposals: the concept chooses the set, the light,
// the scale and the format share of the product; the engine only executes.
//
// What the vocabulary allows is wide on purpose (backdrops, light kinds, props, an extruded word, plinths, camera heights) and narrow where HABB's rules
// are hard: no beige or cream tone, no gold, no hearts, leaves or foliage, no fake luxury, no text that invents a claim, no promise of personalisation
// for a product that is not personalised. Every prop carries a reason that must be argued in the concept.
import { list, obj, renderContract, renderRules, text, validateSpec, word } from '../creative-brain/contract.js';
import { conceptualWords } from '../creative-brain/concept.js';
import { principlesAsText, principlesFor, REASONING_STAGE } from '../creative-brain/knowledge.js';
import { askAndNormalize } from '../creative-brain/model-port.js';
import { BRAIN_ERROR, deepFreeze, deriveId, fail } from '../creative-brain/validation.js';

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

const LIGHT = obj({ kind: word(LIGHT_KIND), side: word(SIDE), intensity: word(LEVEL), temperature: word(TEMPERATURE), purpose: text({ max: 160 }) });
const PROP = obj({ shape: word(SHAPE), material: word(MATERIAL), placement: word(PLACEMENT), scale: word(LEVEL), word: text({ max: 14 }), reason: text({ max: 220 }) }, { optional: ['word'] });

export const STAGE_SPEC = obj({
  backdrop: word(BACKDROP), backdrop_tone: word(TONE), floor_finish: word(FLOOR),
  key_light: LIGHT, accent_lights: list(LIGHT, { min: 0, max: 3 }),
  camera: obj({ height: word(CAMERA_HEIGHT), framing: word(FRAMING), product_position: word(POSITION) }),
  props: list(PROP, { min: 0, max: 4 }),
  headline: text({ max: 60 }), text_placement: word(TEXT_PLACEMENT), show_price: word(YES_NO),
  rationale: text({ max: 300 }),
  // the model's own report of what the concept or art direction asked for and this closed vocabulary could not express: the evidence of the grammar's limits
  wanted_but_not_available: list(text({ max: 200 }), { min: 0, max: 5 }),
}, { optional: ['wanted_but_not_available'] });

// HABB's hard visual rules, as words that may not appear anywhere in a creative decision (FR + EN). Matched as WHOLE words, plurals and feminine forms included
// (so "Luxembourg", "sandwich", "goldfish" or "leaflet" are not refused), after Unicode normalisation (NFC, invisible characters removed).
export const FORBIDDEN_DECOR = Object.freeze(['beige', 'crème', 'creme', 'cream', 'sable', 'sand', 'sandy', 'écru', 'ecru', 'taupe', 'ivoire', 'ivory', 'cœur', 'coeur', 'heart', 'hearts',
  'feuille', 'feuillage', 'leaf', 'leafy', 'leaves', 'foliage', 'fougère', 'fern', 'frond', 'eucalyptus', 'botanical', 'botanique', 'végétation', 'vegetation', 'végétal', 'vegetal', 'végétaux', 'vegetaux', 'greenery', 'verdure',
  'doré', 'dore', 'dorure', 'gold', 'golden', 'gilded', 'gilt', 'paillette', 'glitter', 'luxe', 'luxury', 'luxueux', 'luxueuse', 'marbre', 'marbré', 'marble', 'velours', 'velvet', 'pétale', 'petal', 'bokeh']);
const PERSONALISATION_WORDS = /(personnalis|grav|ton nom|votre nom|prénom|prenom|initiales|custom|engrav|monogram|à ton image|imprimé pour)/i;
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
const NEGATION_BEFORE = { test: (beforeText) => NEGATION_IN_CLAUSE.test(clauseBefore(beforeText, beforeText.length)) };
const wordRe = (w) => new RegExp(`(?<![${L}])${w}(s|x|e|es)?(?![${L}])`, 'iu');
const WORD_RES = FORBIDDEN_DECOR.map((w) => [w, wordRe(w)]);

export const hasForbidden = (s) => {
  let t = normalizeText(s);
  if (FOLIAGE_LEAVES.test(t)) return 'leaves'; // "dry leaves the size of hands" is foliage, whatever follows
  t = t.replace(SHEET_SENSE, ' ').replace(VERB_SENSE, ' ').replace(IDIOMS, ' ');
  for (const [w, re] of WORD_RES) {
    const g = new RegExp(re.source, 'giu'); let m;
    while ((m = g.exec(t))) { if (!NEGATION_BEFORE.test(t.slice(0, m.index))) return w; }
  }
  return null;
};

/** HABB's hard rules, as a hint given to ART_DIRECT from its FIRST call (the art direction never sees the brand rules otherwise). */
export const HABB_ART_DIRECTION_HINT = `HABB's hard visual rules apply to every field of the art direction (atmosphere, materials, light, narrative and secondary elements, rationale): none of these may appear: ${FORBIDDEN_DECOR.join(', ')}. You MAY list them in forbidden_decorative_noise.`;

/**
 * HABB's forbidden visual elements, enforced on an ART_DIRECT answer (the Brain's own contract does not know HABB). Every field that can describe what is SEEN
 * is checked; forbidden_decorative_noise is not (it is where the model names what must NOT appear). Refusal: BRAIN_FORBIDDEN_CONTENT with the exact field.
 */
export function assertArtDirectionHabbRules(art) {
  const fields = [
    ['art_direction.atmosphere', art.atmosphere], ['art_direction.material_language', art.material_language], ['art_direction.lighting_intent', art.lighting_intent], ['art_direction.rationale', art.rationale],
    ...(art.narrative_elements ?? []).flatMap((e, i) => [[`art_direction.narrative_elements[${i}].element`, e.element], [`art_direction.narrative_elements[${i}].reason`, e.reason]]),
    ...(art.permitted_secondary_elements ?? []).map((e, i) => [`art_direction.permitted_secondary_elements[${i}]`, e]),
  ];
  for (const [field, value] of fields) {
    const hit = hasForbidden(value);
    if (hit) fail(BRAIN_ERROR.FORBIDDEN_CONTENT, `${field} uses a word HABB forbids: ${hit}`, field, { problem: 'HABB_FORBIDDEN_DECOR', word: hit });
  }
  return art;
}
// every free text of a stage WITH its exact field: a refusal names the field to fix, so a repair can be scoped to it (and cannot rewrite the rest of the stage)
const namedTexts = (v) => [['stage.headline', v.headline], ['stage.rationale', v.rationale], ['stage.key_light.purpose', v.key_light.purpose],
  ...v.accent_lights.map((l, i) => [`stage.accent_lights[${i}].purpose`, l.purpose]),
  ...v.props.flatMap((p, i) => [[`stage.props[${i}].reason`, p.reason], [`stage.props[${i}].word`, p.word ?? '']])];
const allTexts = (v) => namedTexts(v).map(([, t]) => t);

export const STAGE_RULES = Object.freeze([
  { id: 'NO_FORBIDDEN_DECOR', statement: `HABB's hard rules: no beige, cream, sand or ecru tone, no gold, no hearts, leaves or foliage, no marble or velvet, no fake luxury, no bokeh. None of these words may appear: ${FORBIDDEN_DECOR.map((w) => w.trim()).join(', ')}.`,
    check: (v) => { for (const [field, t] of namedTexts(v)) { const hit = hasForbidden(t); if (hit) fail(BRAIN_ERROR.FORBIDDEN_CONTENT, `the stage uses a forbidden decor word: ${hit.trim()}`, field, { problem: 'FORBIDDEN_DECOR', word: hit.trim() }); } } },
  { id: 'HEADLINE_INVENTS_NO_CLAIM', statement: 'the headline is at most eight words, contains no digit, no price, no percentage, no superlative and no technical promise (insulation, duration, unbreakable, free); the price is shown by the system from the verified facts when show_price is YES.',
    check: (v) => {
      if (/[0-9€%]/.test(v.headline)) fail(BRAIN_ERROR.RULE_VIOLATION, 'the headline may not contain a figure', 'stage.headline', { problem: 'HEADLINE_HAS_A_FIGURE' });
      if (CLAIM_WORDS.test(v.headline)) fail(BRAIN_ERROR.RULE_VIOLATION, 'the headline states an unverified claim', 'stage.headline', { problem: 'HEADLINE_INVENTS_A_CLAIM' });
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
  { id: 'PROP_REASON_IN_THE_CONCEPT', statement: 'every prop needs a reason argued in the concept: its reason must share at least one significant word with the concept\'s central idea, metaphor, story or emotional intent.',
    check: (v, ctx) => {
      const c = ctx.concept; const words = new Set(conceptualWords([c.central_idea, c.visual_metaphor, c.story, c.emotional_intent].join(' ')));
      v.props.forEach((p, i) => { if (!conceptualWords(p.reason).some((w) => words.has(w))) fail(BRAIN_ERROR.RULE_VIOLATION, `prop ${i} has no reason in the concept`, `stage.props[${i}].reason`, { problem: 'PROP_WITHOUT_REASON' }); });
    } },
]);

/** Validates a model's stage against the contract and HABB's rules. ctx: { concept, personalisation_offered } */
export function normalizeStage(raw, ctx) {
  const v = validateSpec(STAGE_SPEC, raw, 'stage');
  for (const r of STAGE_RULES) r.check(v, ctx);
  const body = { concept_id: ctx.concept.concept_id, ...v };
  return deepFreeze({ stage_id: deriveId('stg', body), ...body });
}

export function buildStageInstruction({ frame, concept, artDirection, facts, hints = [] }) {
  const system = [
    'You are the Nordla set designer and photographer. From the selected concept and its art direction, you decide the mise en scène of ONE advertising image: the set, the light, the camera, the props and where the text goes.',
    'The real product is a protected photograph that the system places standing on the floor (or on a plinth if you choose one); you never describe, redraw or modify the product, and you never invent a fact about it.',
    'The concept decides the image: the set, the props and the light must make the concept\'s idea visible at a glance. A plain product shot on a backdrop is a failure unless the concept is precisely about emptiness.',
    'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...renderContract(STAGE_SPEC, 'answer'),
    ...renderRules(STAGE_RULES),
    'The headline is YOUR proposal: it will be shown to the owner for approval. Write it in the language of the brief (French for HABB).',
    'rationale: ONE concise sentence of about 180 to 220 characters (the contract refuses more than 300). Say why this set serves the concept; do not list the choices again.',
    'This vocabulary is deliberately small. If the concept or the art direction needs something it cannot express (a material, a shape, a light effect, a place, an object, a camera move, an atmosphere), do NOT force a poor substitute silently: choose the closest available option AND name what you really wanted in wanted_but_not_available, in plain words. It is reported to the owner as a limit of the system, not as your failure.',
    ...(hints.length ? ['This is a REVISION of an earlier stage for the same concept. Fix these defects (found on the rendered image or by Nordla\'s contract):', ...hints.map((h) => `- ${h}`)] : []),
    'Reason with these principles of art direction:',
    principlesAsText(principlesFor({ stage: REASONING_STAGE.ART_DIRECT })),
  ].join('\n');
  return { system, user: JSON.stringify({ problem_frame: frame, concept, art_direction: artDirection, verified_facts: facts }) };
}

/** The STAGE step: one completion of the Brain's language-model port, then the closed contract and HABB's rules. */
export function createStageDirector({ complete }) {
  return Object.freeze({
    async stage({ frame, concept, artDirection, facts, hints = [] }) {
      const { value, meta } = await askAndNormalize({
        complete, instruction: buildStageInstruction({ frame, concept, artDirection, facts, hints }), stage: 'STAGE', spec: STAGE_SPEC,
        normalize: (raw) => normalizeStage(raw, { concept, personalisation_offered: Boolean(facts.personalisation_offered) }),
      });
      return { stage: value, meta };
    },
  });
}

export { renderContract };
