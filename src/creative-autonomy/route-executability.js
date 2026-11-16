// ROUTE EXECUTABILITY of a concept (2026-11-07). Nordla's decor-first route ("ENVIRONMENT_FIRST") builds the set EMPTY, then puts the real product in it, unchanged, in the pose of its photograph (its cables exactly as photographed).
// A concept is executable by that route only if its benefit can be carried by the set itself: light, architecture, materials. It is NOT executable if it needs
//   - a cable (or any part of the product) MOVED, laid out, shaped or connected          -> ROUTE_PRODUCT_PART_ACTION
//   - a device, a screen or a second product DRAWN                                         -> ROUTE_EXTRA_DEVICE
//   - something that touches, surrounds, covers, frames or reflects the product             -> ROUTE_PRODUCT_CONTACT
// THE PRESENCE OF A WORD DOES NOT CONDEMN A CONCEPT. A product word ("battery", "cable"...) only TRIGGERS a verification of the ACTION asked: the clause is examined, and
//   INCOMPATIBLE  the clause asks one of the actions above                  -> a violation, repaired once with the other violations of the answer
//   VERIFY        a product word is there but no incompatible action is found (the benefit is evoked, the product is merely named) -> NOT a violation: the clause goes, quoted, to SELECT's
//                 feasibility judgment (route-aware), which decides in words
//   EXECUTABLE    no product word
// The test is LEXICAL and deliberately conservative (it names an action only when a manipulation word and the object it acts on share a clause); it never judges the quality of an idea.
import { PRODUCT_FREE_RE } from './product-free-screen.js';

export const ROUTE_ENVIRONMENT_FIRST = 'ENVIRONMENT_FIRST';
/** The PRODUCT_VISIBLE route (A/B comparison B2, 2026-11-08): the generator SEES the real product. Told to FRAME, IDEATE and ART_DIRECT through the brief; the frame is checked for a decor it has already chosen, every concept for its composition. Nothing of the decor-first executability rules applies. */
export const ROUTE_PRODUCT_VISIBLE = 'PRODUCT_VISIBLE';
export const ROUTE_RULES = Object.freeze({ PART_ACTION: 'ROUTE_PRODUCT_PART_ACTION', EXTRA_DEVICE: 'ROUTE_EXTRA_DEVICE', CONTACT: 'ROUTE_PRODUCT_CONTACT' });
export const ROUTE_FIELDS = Object.freeze(['central_idea', 'visual_metaphor', 'story', 'memory_hook']);

const L = '\\p{L}\\p{N}_';
const word = (alternatives) => new RegExp(`(?<![${L}])(?:${alternatives.join('|')})(?![${L}])`, 'iu');
const CABLE = word(['c[âa]bles?', 'cables?', 'cordons?', 'cords?', 'fils?', 'wires?', 'lanyards?', 'sangles?', 'straps?', 'usb']);
// what is done TO a cable: moved, laid out, shaped, connected (a cable that merely hangs as photographed, or is merely named, is not an action)
const PART_ACTION = word([
  'd[ée]ploy[\\p{L}]*', 'd[ée]rou[\\p{L}]*', 'd[ée]pli[\\p{L}]*', 'enroul[\\p{L}]*', 'tendu[\\p{L}]*', 'tendr[\\p{L}]*', 'tendent', '[ée]tir[\\p{L}]*', 'align(?:e|ent|er|ée|ées|és|é|ant)', 'parall[èe]l[\\p{L}]*', 'crois[\\p{L}]*', 'entrelac[\\p{L}]*', 'nou[ée][\\p{L}]*', 'n[œo]uds?',
  'form(?:ant|ent|er|ée|ées|és|é)', 'dessin[\\p{L}]*', 'trac[\\p{L}]*', 'spiral[\\p{L}]*', 'dispos(?:e|ent|er|ée|ées|és|é|ant)', 'd[ée]pos(?:e|ent|er|ée|ées|és|é|ant)', '[ée]tal(?:e|ent|er|ée|ées|és|é|ant)', '[ée]cart(?:e|ent|er|ée|ées|és|é|ant)', 'reli[ée][\\p{L}]*', 'branch[\\p{L}]*', 'connect[\\p{L}]*', 'rac+ord[\\p{L}]*', 'allong[\\p{L}]*',
  'deploy[\\p{L}]*', 'unroll[\\p{L}]*', 'unfold[\\p{L}]*', 'unwind[\\p{L}]*', 'coil[\\p{L}]*', 'stretch[\\p{L}]*', 'taut', 'parallel', 'cross[\\p{L}]*', 'tangl[\\p{L}]*', 'knot[\\p{L}]*', 'form(?:s|ed|ing)?', 'shap[\\p{L}]*', 'arrang[\\p{L}]*', 'laid', 'lay(?:s|ing)?', 'spread[\\p{L}]*', 'plugged', 'link[\\p{L}]*', 'extend[\\p{L}]*',
]);
const V_SHAPE = /(?<![\p{L}])en V(?![\p{L}])/iu;
const DEVICE = word(['appareils?', 'devices?', 'phones?', 'smartphones?', 't[ée]l[ée]phones?', '[ée]crans?', 'screens?', 'ordinateurs?', 'laptops?', 'tablet(?:te)?s?', 'casques?', 'headphones?', 'earbuds?']);
// a device that is SHOWN in relation to something (connected, placed, beside, held), as opposed to a benefit ("recharger plusieurs appareils")
const DEVICE_PRESENCE = word(['reli[ée][\\p{L}]*', 'branch[\\p{L}]*', 'connect[\\p{L}]*', 'plug[\\p{L}]*', 'pos[ée][\\p{L}]*', 'plac[\\p{L}]*', 'allong[\\p{L}]*', 'visibles?', 'pr[èe]s', 'beside', 'next to', 'tenus?', 'held', 'dispos(?:e|ent|er|ée|ées|és|é|ant)', 'appara[iî][\\p{L}]*', 'appear[\\p{L}]*']);
const SECOND_PRODUCT = /(?<![\p{L}])(?:second|seconde|deuxi[èe]me|autre|another|other|two|deux)\s+(?:batteries|battery|power ?banks?|products?|produits?|objets?|objects?)(?![\p{L}])/iu;
const PRODUCT_BODY = word(['batter(?:y|ies|ie)', 'power ?banks?', 'produits?', 'products?', 'objets?', 'objects?']);
const CONTACT = word(['encadr[\\p{L}]*', 'entour(?:e|ent|er|ée|ées|és|é|ant)','enveloppe[\\p{L}]*', 'recouvr[\\p{L}]*', 'cover[\\p{L}]*', 'surround[\\p{L}]*', 'frames?', 'framing', 'wrap[\\p{L}]*', 'touch[\\p{L}]*', 'effleur[\\p{L}]*', '[ée]pous[\\p{L}]*', 'refl[èe]t[\\p{L}]*', 'reflect[\\p{L}]*', 'hug[\\p{L}]*']);

const CLAUSES = /(?<=[.;!?])\s+|\s[—–]\s|;\s|:\s/;
const clip = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// An action that is NEGATED just before it asks nothing (real run 2026-11-08: "sans câble à déplier ni accessoire à chercher" was refused as if it asked to unfold a cable): only an action that is not negated counts.
const NEGATION = word(['sans', 'pas', 'jamais', 'aucun', 'aucune', 'without', 'never', 'no', 'not', 'ni', 'non']);
function asked(clause, actionRe) {
  const g = new RegExp(actionRe.source, 'giu'); let m;
  while ((m = g.exec(clause))) { if (!NEGATION.test(clause.slice(Math.max(0, m.index - 40), m.index))) return true; }
  return false;
}
/** The action a clause asks of the product, or of what is placed with it. null when the clause asks none. */
function actionOf(clause) {
  if (CABLE.test(clause) && (asked(clause, PART_ACTION) || V_SHAPE.test(clause))) return ROUTE_RULES.PART_ACTION;
  if (asked(clause, SECOND_PRODUCT)) return ROUTE_RULES.EXTRA_DEVICE;
  if (DEVICE.test(clause) && asked(clause, DEVICE_PRESENCE)) return ROUTE_RULES.EXTRA_DEVICE;
  // CONTACT (something touches, surrounds or reflects the product) is NOT a violation of the idea: the clause is only to verify (real run 2026-11-08: "the wet surface reflecting ambient daylight, not the product" was refused). The selector judges it, with the clause quoted.
  return null;
}

/**
 * Examines the fields that carry the idea. { state: EXECUTABLE | VERIFY | INCOMPATIBLE, findings: [{ field, rule, clause, words }], to_verify: [{ field, clause, words }] }
 * findings are the INCOMPATIBLE actions (violations); to_verify are the product-word clauses with no incompatible action (never a violation).
 */
export function examineConceptRoute(concept) {
  const findings = []; const toVerify = [];
  for (const field of ROUTE_FIELDS) {
    for (const raw of String(concept?.[field] ?? '').split(CLAUSES)) {
      const clause = clip(raw); if (!clause) continue;
      const words = [...new Set([...clause.matchAll(new RegExp(PRODUCT_FREE_RE.source, 'giu'))].map((m) => m[0].toLowerCase()))];
      if (!words.length) continue; // no product word: nothing to verify
      const rule = actionOf(clause);
      if (rule) findings.push({ field, rule, clause, words }); else toVerify.push({ field, clause, words });
    }
  }
  return { state: findings.length ? 'INCOMPATIBLE' : toVerify.length ? 'VERIFY' : 'EXECUTABLE', findings, to_verify: toVerify };
}

/** The same examination for a set: one entry per concept, so a defect stays attached to ITS concept. */
export const examineConceptSetRoute = (concepts) => (Array.isArray(concepts) ? concepts : []).map((c, i) => ({ index: i, ...examineConceptRoute(c) }));

/** The requirement given to every stage that reads the brief (FRAME, IDEATE, SELECT, ART_DIRECT): the route, in operational terms. Generic: no tenant, no product. */
export const ENVIRONMENT_FIRST_ROUTE_REQUIREMENT = 'ROUTE OF THIS IMAGE: the set is generated FIRST, empty; the real product is added afterwards, unchanged, in the pose of its photograph, with its cables exactly as photographed. '
  + 'An idea is executable only if its benefit is carried by the light, the architecture or the materials of the set. It is NOT executable if it needs a cable or any part of the product to be moved, laid out, shaped or connected, a device, a screen or a second product to be drawn, or anything that touches, surrounds, covers or reflects the product or follows its shape. '
  + 'A shadow in the set is cast by an element of the set, never shaped like the product or a part of it. A benefit called verified needs a fact. '
  + 'Naming the product or its benefit in the idea is allowed; showing it in a new pose is not.';

/** The feasibility question of SELECT for this route (the generic one does not know that the product is added afterwards, unchanged). */
export const ENVIRONMENT_FIRST_FEASIBILITY_QUESTION = 'Can the concept be realized by THIS route: the set is generated first and empty, then the real product is placed in it unchanged, in the pose of its photograph (its cables as photographed), with deterministic typography? '
  + 'FAILS if the idea needs a cable or a part of the product moved, shaped or connected, a device, a screen or a second product drawn, or anything touching or following the product. MEETS if its benefit is carried by the light, the architecture or the materials of the set alone. '
  + 'Where the notes below quote a clause to verify, judge from the ACTION it asks, not from the word it contains.';

// COMPOSITION AND VALUE (2026-11-07). Real run 2026-11-07: the three concepts were the same room (a plain wall, a plain floor, soft light from the left) with a different symbol each; nothing asked a concept for a composition, nor for what the set does for the product.
/** Required of every concept in this route (the concept contract carries `composition` and `value_lever`; concept-violations.js refuses a concept without them). Given to every stage that reads the brief. */
export const ENVIRONMENT_FIRST_COMPOSITION_REQUIREMENT = 'COMPOSITION AND VALUE OF THE CONCEPT (required in this route): each concept states in `composition` a recognisable composition of the SET (its spatial structure: where the weight sits, how depth and scale are organised, where the light leads, what frames the empty place where the product will stand) in one or two sentences a set designer could build from, '
  + 'and in `value_lever` how that composition raises the perceived value of the product (what the set does FOR it). A list of materials or a mood is not a composition. The default image of the category (a bare wall, a plain floor, soft side light) is not a concept and will be judged generic.';
/** What the framer is told in this route: the commercial intention and the physical constraints of the photograph, the set left OPEN (the real run showed a frame that had already chosen the floor, the wall and the light). */
export const ENVIRONMENT_FIRST_FRAME_HINT = 'FRAME FOR THIS ROUTE: state the COMMERCIAL INTENTION (what the viewer must understand and feel about the product, for whom, in which situation) and the PHYSICAL CONSTRAINTS of the product photograph given in the brief (its perspective, its lit side, the fixed pose of its parts). '
  + 'Leave the SET OPEN: name no surface, wall, floor, ground, material, architecture or light quality; the concepts decide them. what_we_show says what must be understood ABOUT THE PRODUCT, not where it stands. distinctive_levers are commercial or product levers (a fact, a use, a feeling), never a decor.';


// ---- PRODUCT_VISIBLE route (the generator sees the product). Texts for the stages that read the brief.
export const PRODUCT_VISIBLE_ROUTE_REQUIREMENT = 'ROUTE OF THIS IMAGE: the image generator SEES the real product (image 1: protected merchant pixels at a fixed place and size, restored afterwards, never redrawn) and builds the whole scene AROUND it. '
  + 'The product must come out MORE desirable, not smaller: it stays the focal point and the scene serves it, never swallows it. The product is shown as photographed: no cable moved, no part redrawn, no second product, no device or screen drawn. '
  + 'An effect that has to follow the product\'s own outline (a halo, a contour glow, an edge light drawn around it) is not executable: the outline is restored afterwards as photographed. Naming the product or its benefit in the idea is allowed.';
export const PRODUCT_VISIBLE_COMPOSITION_REQUIREMENT = 'COMPOSITION AND VALUE OF THE CONCEPT (required in this route): each concept states in `composition` a STRONG, recognisable composition of the scene around the product (its spatial structure: where the weight sits, how many planes of depth and how scale is organised, where the light comes from and what it crosses, what frames the product and makes it the focal point) in one or two sentences a set designer could build from, '
  + 'and in `value_lever` how that composition makes THIS product desirable (what the scene does FOR it). A mood or a list of materials is not a composition. The default image of the category (a plain wall, a plain floor, soft side light, a lit outline) is generic and will be judged so. Style is free: a bright, coloured, graphic or dark scene are all open, provided the concept argues for it.';
export const PRODUCT_VISIBLE_FRAME_HINT = 'FRAME FOR THIS ROUTE: state the COMMERCIAL INTENTION (what the viewer must understand and feel about the product, for whom, in which situation) and the PHYSICAL CONSTRAINTS of the product photograph given in the brief (its perspective, its lit side, the fixed pose of its parts). '
  + 'Leave the SCENE OPEN: name no surface, wall, floor, ground, material, architecture, light quality or visual effect; the concepts decide them. what_we_show says what must be understood ABOUT THE PRODUCT, not where it stands or how it is lit. distinctive_levers are commercial or product levers (a fact, a use, a feeling), never a decor.';
