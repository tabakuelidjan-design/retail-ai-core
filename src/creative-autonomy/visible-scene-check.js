// PRODUCT_VISIBLE route (the generator SEES the real product, which is restored afterwards): what a composition may say about the product that is in the picture, and what stays a defect.
// ACCEPTED: an element that refers to the product by what it does to the scene (a plinth that carries it, a shadow it casts) and a description of the product's OWN cable as it is photographed (it is protected merchant pixels).
// FLAGGED: a substitute for the product or a second one; a cable that is not the product's own or an added one; a change of how the cable lies; a promise of charging without cable or wireless (a fact the product sheet
// does not give); a title to draw (an inscription or a typeface in the reserve: the title is added later, the reserve describes a zone). Digits and units stay refused by the contract itself.
// Lexical and conservative like every detection of Nordla: it flags, it never writes a decision. Reuses the substitute lexicon (without the bare word "product") and the cable vocabulary of the scene checks.
import { substituteWordsIn } from '../creative-brain/substitutes.js';
import { sceneLimitViolations, liftedWords } from './scene-permissions.js';

const CABLE_WORDS = /(?<![\p{L}])(cables?|cords?|wires?|ropes?|strings?|leads?|threads?|yarns?|strands?|cordons?|c[âa]bles?|fils?)(?![\p{L}])/iu;
const OWN = /(?<![\p{L}])(its|his|her|the product'?s|integrated|built-in|built in|attached|own|existing|photographed|visible|hanging|pendant|the cable of)(?![\p{L}])|(?<![\p{L}])the\s+(\p{L}+\s+){0,2}(cables?|c[âa]bles?)(?![\p{L}])/iu; // "the cable" (definite) is the product's one: the request has a single product and it carries its own cable
const ADDED_CABLE = /(?<![\p{L}])(second|another|extra|additional|spare|separate|loose|new|added|other|further)\s+(\p{L}+\s+){0,2}(cables?|cords?|wires?|leads?|c[âa]bles?)(?![\p{L}])/iu;
const ADDED_PRODUCT = /(?<![\p{L}])(second|another|extra|additional|spare|duplicate|other|further|added)\s+(\p{L}+\s+){0,2}(products?|power ?banks?|batter(?:y|ies)|chargers?|devices?)(?![\p{L}])/iu;
// the cable's LAY is changed by an action on it (draped, coiled, laid, placed, trailing, leaving the frame...); "looped" or "hanging" describe what the photograph already shows and are accepted
const POSE_CHANGE = /(?<![\p{L}])(drap(?:e|es|ed|ing)|coil(?:s|ed|ing)?|wrap(?:s|ped|ping)?|wound|laid|lays?|laying|placed|places|placing|arranged|arranging|tuck(?:s|ed|ing)?|tangl(?:e|es|ed|ing)|trail(?:s|ed|ing)?|spill(?:s|ed|ing)?|sprawl(?:s|ed|ing)?|knot(?:s|ted)?|tied|stretch\p{L}*\s+across|rest(?:s|ing)?\s+(?:\p{L}+\s+)?(?:on|against)|lies|lying|curled (?:on|around)|out of (?:the )?frame|off (?:the )?frame|leaving the frame|descending out)(?![\p{L}])/iu;
const WIRELESS = /(wireless|cordless|cable-?free|cableless|without\s+(?:a\s+|any\s+)?c[âa]bles?|no\s+c[âa]bles?|sans\s+(?:fil|c[âa]ble))/i;
const TITLE_TO_DRAW = /["“”«»]|(?<![\p{L}])'[^']{2,}'(?![\p{L}])|(sans-serif|serif|typeface|typography|font|lettering)/iu; // "a title" or "a bold title" in the reserve sizes a zone and is accepted; a quoted text or a typeface is an inscription

const plain = (t) => String(t ?? '').replace(/[‘’ʼ]/g, "'"); // the model writes curly apostrophes
// a pose word that follows a negation ("without coiling or leaving the frame") excludes the pose: it is not a change of the cable's lay
const NEGATION = /(?<![\p{L}])(without|never|no|not|nor|neither|avoiding)(?![\p{L}])/iu;
const poseChanged = (cl) => { for (const m of cl.matchAll(new RegExp(POSE_CHANGE.source, 'giu'))) { if (!NEGATION.test(cl.slice(Math.max(0, m.index - 60), m.index))) return true; } return false; };
const clauses = (t) => plain(t).split(/[.;:!?,]|\s[—–-]\s|—|–/).map((s) => s.trim()).filter(Boolean);

/** The transmitted (generator-facing) texts of a composition: [[field, text]]. */
export const transmittedTexts = (c) => [['idea', c?.idea], ['setting', c?.setting], ['atmosphere', c?.atmosphere], ['materials', c?.materials], ['light', c?.light], ['structure', c?.structure], ['text_reserve.description', c?.text_reserve?.description], ['resolution', c?.resolution], ...(c?.elements ?? []).map((e, i) => [`elements[${i}].element`, e?.element])]
  .filter(([, t]) => typeof t === 'string').map(([f, t]) => [f, plain(t)]);

// strict (default false): the limits of scene-permissions.js (devices in every text, a permitted smartphone's screen, a connected cable). Only the AD route asks for it: the other routes keep the checks they always had.
export function visibleSceneViolations(c, { permissions = [], strict = false } = {}) {
  const out = []; const add = (field, rule, message, passage = null) => out.push({ field, rule, message, ...(passage ? { passage } : {}) });
  const lifted = liftedWords(permissions); // the words a CAMPAIGN permission lets through (none by default)
  (c?.elements ?? []).forEach((e, i) => {
    const words = substituteWordsIn(e?.element).filter((w) => w !== 'product' && !lifted.has(w));
    if (words.length) add(`elements[${i}].element`, 'ELEMENT_SUBSTITUTES_THE_PRODUCT', `elements[${i}] holds ${words.join(', ')}: a scene element never names the product's kind or stands in for it (it may say what the product rests on or the shadow it casts)`);
  });
  // `resolution` is the model's own reasoning: it is never sent to the generator, so the scene rules (second product, cable, inscription) are not applied to it
  for (const [field, t] of transmittedTexts(c).filter(([f]) => f !== 'resolution')) {
    // the limits apply to EVERY text that goes to the generator (the idea, the structure, the setting...), not only to the list of elements (checked above, with the substitute lexicon)
    if (strict) for (const v of sceneLimitViolations(t, { permissions, devices: !field.startsWith('elements[') })) add(field, v.rule, `${field}: ${v.message}`, v.passage);
    if (ADDED_PRODUCT.test(t)) add(field, 'ADDED_PRODUCT', `${field} adds a second product: the request has one product, the real one`);
    for (const cl of clauses(t)) {
      if (!CABLE_WORDS.test(cl) || WIRELESS.test(cl)) continue; // a wireless / cable-free promise is flagged once, below
      if (ADDED_CABLE.test(cl)) add(field, 'CABLE_ADDED', `${field} adds a cable (${cl.slice(0, 80)}): the product carries its own, and no cable may be added`, cl);
      else if (!OWN.test(cl)) add(field, 'CABLE_NOT_THE_PRODUCTS_OWN', `${field} speaks of a cable that is not marked as the product's own (${cl.slice(0, 80)}): say "its integrated cable" as photographed, or leave it out`, cl);
      if (poseChanged(cl)) add(field, 'CABLE_POSE_CHANGED', `${field} changes how the product's cable lies (${cl.slice(0, 80)}): the cable stays as photographed; describe it only as it is, never arranged, draped, coiled, laid or leaving the frame`, cl);
    }
    if (field === 'text_reserve.description' ? TITLE_TO_DRAW.test(t) : /(sans-serif|serif|typeface|font|lettering)/i.test(t)) add(field, 'TITLE_TO_DRAW', `${field} describes an inscription (a quoted text or a typeface): the reserve describes a ZONE; the title is added later and never drawn`);
  }
  // a promise the product sheet does not give, anywhere in the composition (also in the reading of the product)
  for (const [field, t] of [...transmittedTexts(c), ['product_reading', c?.product_reading]]) if (typeof t === 'string' && WIRELESS.test(plain(t))) add(field, 'WIRELESS_PROMISE', `${field} promises charging without cable or wireless (${(t.match(WIRELESS) ?? [''])[0]}): the product charges with its own integrated cables, which is the verified benefit; no such promise`);
  return out;
}
