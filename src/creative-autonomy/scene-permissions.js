// CAMPAIGN-SCOPED SCENE PERMISSIONS and the limits that follow the proposal from DEVELOP to COMPOSE (2026-11-14).
// Creator's default rules keep every device out of a scene ("a phone, a case or any device", SCENE_FORBIDDEN). A merchant may lift ONE of them for ONE campaign: the permission lives in the campaign data
// (brief.scene_permissions), never in the product sheet or in the brand file, so the next campaign starts again from the default rules.
// The same words are told to the model (DEVELOP, COMPARE, COMPOSE) and checked by Nordla (the proposal's idea, the composition's idea, structure and setting, not only the list of elements): what the model is told
// and what Nordla refuses cannot drift apart. Nothing here writes a scene.
import { SCENE_FORBIDDEN } from '../creative-brain/substitutes.js';

export const PERMISSION = Object.freeze({ SECONDARY_SMARTPHONE: 'SECONDARY_SMARTPHONE' });
export const PERMISSIONS = Object.freeze({
  SECONDARY_SMARTPHONE: Object.freeze({
    statement: 'a smartphone may appear as a SECONDARY object near the product, its screen switched off and the phone FULLY INSIDE the frame, close to the product (never write "off-screen" or "out of the frame": it reads as outside the picture); it is never connected to the product or to its cable, it is never the subject and it never competes with the product',
    // the entry of SCENE_FORBIDDEN this permission lifts, and the words of the substitute lexicon it lets through (the phone and the word for its own screen)
    lifts_entry: 'a phone, a case or any device',
    lifts_words: Object.freeze(['phone', 'smartphone', 'handset', 'telephone', 'téléphone', 'screen', 'écran']),
  }),
});

/** The permission ids a brief carries (unknown ids are ignored: a permission exists only if it is in the registry). */
export const permissionsOf = (brief) => [...new Set((brief?.scene_permissions ?? []).filter((id) => Object.hasOwn(PERMISSIONS, id)))];
export const liftedWords = (permissions = []) => new Set(permissions.flatMap((id) => PERMISSIONS[id]?.lifts_words ?? []));

/** The limits the composition enforces, in the words the model is given at every step. A lifted entry is replaced by the permission's own statement; the rest is unchanged. */
export function compositionConstraints({ permissions = [] } = {}) {
  const lifted = new Set(permissions.map((id) => PERMISSIONS[id]?.lifts_entry).filter(Boolean));
  const never = SCENE_FORBIDDEN.filter((f) => !lifted.has(f));
  const allowed = permissions.map((id) => PERMISSIONS[id]?.statement).filter(Boolean);
  return 'WHAT THE COMPOSITION WILL ENFORCE (design the situation inside these limits from the start; a proposal that needs to break one of them cannot be used): '
    + 'the product is the real photograph, placed as photographed; its own cables stay exactly as photographed (never moved, never connected to anything), and the scene may make clear what a cable is for without connecting it; '
    + 'nothing touches, hangs from or encircles the product\'s cables; '
    + `a scene never holds: ${never.join('; ')}, and no hands or people (scene_prohibitions lists the rest); `
    + (allowed.length ? `THIS CAMPAIGN ALLOWS, and only this one thing: ${allowed.join('; ')}; ` : '')
    + 'no element of the scene may name the product or stand in for it (the decor holds the product, it never describes it); '
    + 'the display of the product shows exactly what the photograph shows: its value never changes, so a scene never describes another figure on it; '
    + 'the headline is added afterwards by Nordla, so the scene holds no text.';
}

// ---- the devices: the words that name an object, checked in every TEXT of a proposal or of a composition (not only in the list of elements)
// A French "tablette" is a shelf unless it is qualified (tactile, numérique...): only the qualified phrase is a device. A "montre connectée" is a device (a smartwatch), not a cable that is connected.
const DEVICE_RE = /(?<![\p{L}])(phones?|smartphones?|handsets?|telephones?|t[ée]l[ée]phones?|devices?|appareils?|gadgets?|tablets?|laptops?|computers?|ordinateurs?|smartwatch(?:es)?|headphones?|earphones?|earbuds?|[ée]couteurs?)(?![\p{L}])/giu;
const DEVICE_PHRASE = /(?<![\p{L}])(montres?\s+connect[ée]es?|montres?\s+intelligentes?|connected\s+watch(?:es)?|tablettes?\s+(?:tactiles?|num[ée]riques?|graphiques?|[ée]lectroniques?)|ordinateurs?\s+portables?)(?![\p{L}])/giu;
const NEGATION = /(?<![\p{L}])(without|never|no|not|nor|neither|sans|pas|aucun|aucune|jamais|non|ni)(?![\p{L}])/iu;
const clauses = (t) => String(t ?? '').replace(/[‘’ʼ]/g, "'").split(/[.;:!?]|\s[—–-]\s|—|–/).map((s) => s.trim()).filter(Boolean);
const singular = (w) => w.toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '');
const withoutDevicePhrases = (cl) => cl.replace(DEVICE_PHRASE, ' ');

const sentencesOf = (t) => String(t ?? '').split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean); // the ORIGINAL sentences: a passage is cited exactly as written
const plainApostrophes = (x) => x.replace(/[‘’ʼ]/g, "'"); // same length: the positions are the same in the original and in the plain text
const GENERIC = /^(appareil|device)$/; // the singular generic words; a plural ("des appareils") is never a reference to the one smartphone
const DEFINITE_BEFORE = /(?:^|[\s(«"“'])(?:l'|le\s+|la\s+|cet\s+|cette\s+|ce\s+|the\s+|this\s+|that\s+)$/iu;
const PHONE_WORD = /(?<![\p{L}])(phones?|smartphones?|handsets?|telephones?|t[ée]l[ée]phones?)(?![\p{L}])/giu;
// anything that could ALSO be what "l'appareil" refers to: the product and its parts, a cable, another device, another reference
const OTHER_REFERENT = /(?<![\p{L}])(batter(?:y|ies)|batteries?|power\s?banks?|produit|product|bo[iî]tier|casing|c[âa]bles?|cables?|cordons?|affichage|display|chargeurs?|chargers?|remax|ordinateurs?|computers?|laptops?|montres?|watch(?:es)?|tablets?|tablettes?|casques?|headphones?|[ée]couteurs?|earbuds?|appareils?|devices?)(?![\p{L}])/iu;

/** "l'appareil" / "the device" is accepted ONLY when it clearly designates the smartphone that is already named: a definite reference, the smartphone named in the same sentence or the one just before, and NOTHING between
 *  the smartphone and the word that could also be the referent (the product, a cable, the display, another device). The mere presence of the word "smartphone" somewhere in the text is not enough. */
function designatesThePhone(sentences, si, pos) {
  const s = sentences[si]; const before = s.slice(0, pos);
  if (!DEFINITE_BEFORE.test(before)) return false; // "un appareil", "un autre appareil", "another device": not a reference
  const last = (str) => [...str.matchAll(PHONE_WORD)].at(-1);
  let m = last(before); let between;
  if (m) between = before.slice(m.index + m[0].length);
  else { const prev = sentences[si - 1]; m = prev ? last(prev) : null; if (!m) return false; between = `${prev.slice(m.index + m[0].length)} ${before}`; }
  return !OTHER_REFERENT.test(between);
}

/** The device findings of a text: [{ word, passage }] (the passage is the exact sentence), except the words a permission lets through, those a negation excludes ("no phone", "pas de téléphone")
 *  and the generic "l'appareil" that clearly designates the permitted smartphone. */
export function deviceFindingsIn(text, permissions = []) {
  const ok = new Set([...liftedWords(permissions)].map(singular)); const phoneAllowed = ok.has('smartphone'); const found = new Map();
  const original = sentencesOf(text); const sentences = original.map(plainApostrophes);
  sentences.forEach((s, si) => {
    for (const cl of clauses(s)) {
      const clean = withoutDevicePhrases(cl); const off = s.indexOf(cl);
      const add = (w, generic = false) => { const exact = original[si]; if (!found.has(w)) found.set(w, { word: w, generic, passage: exact.length > 220 ? `${exact.slice(0, 217)}...` : exact }); };
      for (const m of cl.matchAll(DEVICE_PHRASE)) { if (!NEGATION.test(cl.slice(Math.max(0, m.index - 40), m.index))) add(singular(m[1])); }
      for (const m of clean.matchAll(DEVICE_RE)) {
        const w = singular(m[1]); if (ok.has(w)) continue;
        if (NEGATION.test(clean.slice(Math.max(0, m.index - 40), m.index))) continue; // "no phone", "without any device", "pas de téléphone": the text EXCLUDES the object
        if (phoneAllowed && GENERIC.test(m[1].toLowerCase()) && off >= 0 && designatesThePhone(sentences, si, off + cl.indexOf(m[0]))) continue;
        add(w, GENERIC.test(m[1].toLowerCase()));
      }
    }
  });
  return [...found.values()];
}
/** The device words found in a text (see deviceFindingsIn). */
export const deviceWordsIn = (text, permissions = []) => deviceFindingsIn(text, permissions).map((f) => f.word);

// ---- what the permission does NOT allow, and what the cable rule forbids: checked in every text of a proposal or of a composition (opt-in: the AD route)
const PHONE_RE = /(?<![\p{L}])(phones?|smartphones?|handsets?|telephones?|t[ée]l[ée]phones?)(?![\p{L}])/iu;
const SCREEN_ON = [
  /(?<![\p{L}])(screen|[ée]cran)\s+(?:is\s+|est\s+)?(on|lit|glowing|illuminated|bright|active|allum[ée]e?s?|[ée]clair[ée]e?s?|actif|displaying|showing)(?![\p{L}])/iu,
  /(?<![\p{L}])(lit|glowing|illuminated|turned[- ]on|switched[- ]on|powered[- ]on|allum[ée]e?s?|[ée]clair[ée]e?s?)\s+(?:up\s+)?(smartphones?|phones?|screens?|[ée]crans?|t[ée]l[ée]phones?)(?![\p{L}])/iu,
  /(?<![\p{L}])(smartphones?|phones?|t[ée]l[ée]phones?)\s+(?:is\s+|est\s+)(on|lit|glowing|turned on|allum[ée]e?s?|active)(?![\p{L}])/iu, // the phone is on
  /(?<![\p{L}])(smartphones?|phones?|t[ée]l[ée]phones?)\s+(lit|glowing|turned on|allum[ée]e?s?|active)(?![\p{L}])/iu, // a glowing phone
  /(?<![\p{L}])(smartphones?|phones?|t[ée]l[ée]phones?)\s+on(?=\s*(?:[,.;:)]|$|(?:and|while|with)\b))/iu, // phone on, but NOT smartphone on a wooden table (a preposition)
];
const CABLE_ISH = /(?<![\p{L}])(cables?|c[âa]bles?|cords?|leads?|connectors?|connecteurs?|plugs?|prises?|usb)(?![\p{L}])/iu;
const CONNECTED = /(?<![\p{L}])(plugged|branch[ée]e?s?|attached\s+to|linked\s+(?:to|with)|hooked\s+up|reli[ée]e?s?|raccord[ée]e?s?|connected\s+(?:to|with|via)|connect[ée]e?s?\s+(?:[àa]|au|aux|avec|par))(?![\p{L}])|(?<![\p{L}])(charging|recharg\w+)\s+(the\s+|a\s+|le\s+|un\s+)?(smartphones?|phones?|t[ée]l[ée]phones?)(?![\p{L}])|(?<![\p{L}])(smartphones?|phones?|t[ée]l[ée]phones?)\s+(?:is\s+|est\s+)?(charging|en\s+charge)(?![\p{L}])/iu;
// "ready to be plugged", "prêt à être branché": a possibility, not a connection
const POTENTIAL = /(?:pr[êe]t(?:e|s|es)?\s+[àa](?:\s+[êe]tre)?|ready\s+to(?:\s+be)?|can\s+be|could\s+be|peut(?:\s+[êe]tre)?|pour\s+[êe]tre|designed\s+to\s+be|con[çc]u(?:e|s|es)?\s+pour\s+[êe]tre|waiting\s+to\s+be)\s*$/iu;

/** Every limit of the scene in one place, for ONE text: a device word (unless the campaign allows it), the permitted smartphone's screen ON, a cable that is CONNECTED to something. A negation excludes ("not plugged", "sans être branché"). */
// a phone that the text puts outside, partly outside or cropped by the picture (the owner wants it ENTIRELY visible, near the product, screen off)
const OUT_OF_FRAME = /\boff[- ]?screen\b|\b(?:out of|outside(?: of)?|beyond) the (?:frame|picture|shot|image)\b|\bpartly (?:visible|hidden)\b|\bcropped\b/i;
export function sceneLimitViolations(text, { permissions = [], devices = true } = {}) {
  const out = [];
  const df = devices ? deviceFindingsIn(text, permissions) : []; // ONE finding per text, naming every device word and the exact passage
  if (df.length) {
    const onlyGeneric = df.every((f) => f.generic); // "device" / "appareil": the word itself is the problem, not an object that this campaign forbids
    out.push({ rule: 'DEVICE_IN_THE_SCENE', passage: [...new Set(df.map((f) => f.passage))].join(' / '),
      message: onlyGeneric ? `the generic word "${df.map((f) => f.word).join('", "')}" does not clearly designate the smartphone this campaign allows. If it means the PRODUCT, name the product clearly in this description (by its own name, never "the device"); if it means the smartphone, say "the smartphone"; any other device stays refused` : `the text puts ${df.map((f) => f.word).join(', ')} in the scene: this campaign does not allow it (see WHAT THE COMPOSITION WILL ENFORCE)` });
  }
  const phoneAllowed = permissions.some((id) => PERMISSIONS[id]?.lifts_words?.includes('smartphone'));
  { const t = String(text ?? ''); const m = t.match(OUT_OF_FRAME); if (phoneAllowed && m && PHONE_RE.test(t)) out.push({ rule: 'PHONE_NOT_FULLY_IN_FRAME', passage: t.slice(Math.max(0, m.index - 60), m.index + 60).trim(), message: 'the phone must be fully inside the frame with its screen switched off: do not write "off-screen", "out of the frame" or "cropped" (it reads as outside the picture); write "a switched-off smartphone, fully inside the frame"' }); } // whole text, not a clause: the hyphen of "off-screen" splits clauses
  for (let cl of clauses(text)) {
    cl = withoutDevicePhrases(cl); // "montre connectée" is a device, never a connection
    const before = (re) => { const m = cl.match(re); return m ? cl.slice(Math.max(0, m.index - 40), m.index) : ''; };
    if (phoneAllowed && PHONE_RE.test(cl)) { const hit = SCREEN_ON.map((re) => ({ re, m: cl.match(re) })).find((x) => x.m); if (hit && !NEGATION.test(cl.slice(Math.max(0, hit.m.index - 40), hit.m.index))) out.push({ rule: 'PERMITTED_DEVICE_SCREEN_ON', passage: cl, message: `the text shows the smartphone with its screen on (${cl.slice(0, 80)}): this campaign allows it only with the screen OFF or out of the frame` }); }
    if ((CABLE_ISH.test(cl) || PHONE_RE.test(cl)) && CONNECTED.test(cl) && !NEGATION.test(before(CONNECTED)) && !POTENTIAL.test(before(CONNECTED))) out.push({ rule: 'CABLE_CONNECTED', passage: cl, message: `the text connects something to the product's cable (${cl.slice(0, 80)}): the cable stays unplugged, in its photographed pose` });
  }
  return out;
}

// ---- the figure on the product's display: the photograph shows ONE value (its pixels are protected); a scene that describes another one is not usable
const FIG = /(\d[\d.,]*)\s?%/g;
export const figuresIn = (text) => [...String(text ?? '').matchAll(FIG)].map((m) => `${m[1]}%`);
/** The percentages the product's display shows on the photograph (from the observations given to the text calls). Empty when the product shows none: the rule is then off. */
export function displayedFiguresOf(productFacts) {
  const items = (productFacts?.visible_on_the_photograph ?? []).map((i) => i?.item ?? i);
  return new Set(items.flatMap((t) => figuresIn(t)));
}
/** The percentages of a text that the display does NOT show. */
export const foreignFigures = (text, displayed) => (displayed && displayed.size ? figuresIn(text).filter((f) => !displayed.has(f)) : []);

// ---- a headline never promises a duration or an autonomy that no verified fact gives ("toute la journée", "all day", "24 h", several charges)
const DURATION_PROMISE = /(?<![\p{L}])(toute\s+la\s+(?:journ[ée]e|semaine|nuit)|journ[ée]e\s+enti[èe]re|all\s+(?:day|week|night)|(?:one|a)\s+whole\s+day|\d+\s?(?:h|heures?|hours?|jours?|days?)|plusieurs\s+(?:recharges?|charges?)|(?:several|multiple)\s+charges?)(?![\p{L}])/iu;
const DURATION_FACT = /(autonom|dur[ée]e|heures?|hours?|journ[ée]e|all\s+day|jours?|days?|recharges?)/iu;
/** The duration promise a text makes, unless a VERIFIED fact states a duration or an autonomy (verifiedFacts: [{ id, claim }]). */
export function unverifiedDurationIn(text, verifiedFacts = []) {
  const m = String(text ?? '').match(DURATION_PROMISE);
  if (!m) return null;
  return (verifiedFacts ?? []).some((f) => DURATION_FACT.test(String(f?.claim ?? ''))) ? null : m[0];
}
