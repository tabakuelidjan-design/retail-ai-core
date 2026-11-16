// SCENE CLARIFICATION (A/B B2, 2026-11-08): ONE targeted call in which Nordla's own model completes the scene of the concept that was chosen, with the facts that exist, so that the frame and the request can be built
// WITHOUT any manual artistic arbitration. It keeps the concept and the art direction; it answers what the closed STAGE vocabulary and the builder could not: the setting (room, back plane, floor), the scale and the layout of the
// scene structure relative to the product, where the calm area is (the title zone), and the scene elements by zone, restated as ONE consistent list (so that an element contradicting the request, here a cord that reads as a second
// cable, is resolved by the model, with its reason). The code only DETECTS what is plainly missing or contradictory and asks again once; it never writes an artistic decision.
import { obj, text, word, list, renderContract, renderRules } from '../creative-brain/contract.js';
import { SCENE_ZONE } from '../creative-brain/art-direction.js';
import { frenchEvidence } from './generator-language.js';

export const CLARIFY_LIMITS = Object.freeze({ setting: 500, structure: 600, materials: 500, calm_area: 300, element: 140, resolution: 300, rationale: 300, max_elements: 4 });
export const CLARIFY_MAX_OUTPUT_TOKENS = 1500;

/** What the model answers: free text in English (no digit: relative words only), the elements by zone, the reason of the cord decision. */
export const SCENE_CLARIFICATION_SPEC = obj({
  setting: text({ max: CLARIFY_LIMITS.setting, geometry: true, fit: true }),
  structure: text({ max: CLARIFY_LIMITS.structure, geometry: true, fit: true }),
  materials: text({ max: CLARIFY_LIMITS.materials, geometry: true, fit: true }),
  calm_area: text({ max: CLARIFY_LIMITS.calm_area, geometry: true, fit: true }),
  elements: list(obj({ zone: word(SCENE_ZONE), element: text({ max: CLARIFY_LIMITS.element, geometry: true, forbid: true, fit: true }) }), { min: 0, max: CLARIFY_LIMITS.max_elements }),
  resolution: text({ max: CLARIFY_LIMITS.resolution, geometry: true, fit: true }),
  rationale: text({ max: CLARIFY_LIMITS.rationale, geometry: true, fit: true }),
});

// ---- what is DETECTED (lexical, conservative; every message tells the model what to fix)
const CABLE_LIKE = /(?<![\p{L}])(cables?|cords?|wires?|ropes?|strings?|leads?|cordons?|c[âa]bles?|fils?)(?![\p{L}])/giu;
const CABLE_LIKE_IN_ELEMENTS = /(?<![\p{L}])(cables?|cords?|wires?|ropes?|strings?|leads?|threads?|yarns?|strands?|cordons?|c[âa]bles?|fils?)(?![\p{L}])/giu;
const SCALE_WORDS = /(times|twice|half|as tall|taller|higher|shorter|the height|tall as|the size|the width|as wide)/i;
const COUNT_WORDS = /(?<![\p{L}])(two|three|four|five|six|seven|eight|nine|ten|twelve|a dozen|a pair|pairs?)(?![\p{L}])/iu;
const SIDE_OF = { TOP_LEFT: 'left', LEFT_COLUMN: 'left', BOTTOM_LEFT: 'left', TOP_RIGHT: 'right', RIGHT_COLUMN: 'right', BOTTOM_RIGHT: 'right' };
const uniq = (m) => [...new Set((m ?? []).map((x) => x.toLowerCase()))];

/** Every plain defect of an answer: [{ field, rule, message }]. `titleZone` is STAGE's text_placement (the calm area must be where the title goes). */
export function sceneClarificationViolations(c, { titleZone = null } = {}) {
  const out = []; const add = (field, rule, message) => out.push({ field, rule, message });
  const texts = [['setting', c?.setting], ['structure', c?.structure], ['materials', c?.materials], ['calm_area', c?.calm_area], ['resolution', c?.resolution], ['rationale', c?.rationale], ...(c?.elements ?? []).map((e, i) => [`elements[${i}].element`, e?.element])];
  for (const [f, t] of texts) if (typeof t === 'string' && frenchEvidence(t).french) add(f, 'NOT_ENGLISH', `${f} is not written in English: these texts go to the image generator as written, write them in English yourself`);
  const cableScene = uniq(`${c?.setting ?? ''} . ${c?.structure ?? ''} . ${c?.materials ?? ''}`.match(CABLE_LIKE));
  if (cableScene.length) add('setting/structure/materials', 'CABLE_LIKE_OBJECT_IN_SCENE', `the setting, structure or materials mention ${cableScene.join(', ')}: the product carries its own cables and the request forbids any extra cable; describe the scene without a cable-like object`);
  (c?.elements ?? []).forEach((e, i) => { const w = uniq(String(e?.element ?? '').match(CABLE_LIKE_IN_ELEMENTS)); if (w.length) add(`elements[${i}].element`, 'CABLE_LIKE_OBJECT_IN_SCENE', `elements[${i}] is or contains ${w.join(', ')}, which reads as a second cable next to the product's own: decide another element or none, and say so in resolution`); });
  if (typeof c?.structure === 'string') {
    if (!SCALE_WORDS.test(c.structure)) add('structure', 'STRUCTURE_SCALE_MISSING', 'structure must state its SCALE relative to the product in words (for example "about twice as tall as the product"), no digit');
    if (!COUNT_WORDS.test(c.structure)) add('structure', 'STRUCTURE_COUNT_MISSING', 'structure must state HOW MANY main parts it has (spell the number: "four", "five"), and how they are spaced');
  }
  const side = SIDE_OF[titleZone];
  if (side && typeof c?.calm_area === 'string' && !new RegExp(`(?<![\\p{L}])${side}(?![\\p{L}])`, 'iu').test(c.calm_area)) add('calm_area', 'CALM_AREA_NOT_WHERE_THE_TITLE_GOES', `calm_area must say that the calm area is on the ${side}, where the title goes (the product occupies the other side of the frame)`);
  return out;
}

export function sceneClarificationInstruction({ concept, artDirection, stage, frameFacts, productFacts, sceneProhibitions = [], hints = [] }) {
  const system = [
    'You are the Nordla art director completing ONE scene. The concept is chosen and its art direction is written; you do not change the concept. You answer what the closed vocabulary of the set designer could not say, so that the image generator receives a complete and CONSISTENT scene.',
    'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...renderContract(SCENE_CLARIFICATION_SPEC, 'answer'),
    'WHAT YOU DECIDE (all of it is yours, from the facts below; nothing is decided for you):',
    '- setting: the room and its back plane (a wall, open air, depth), the floor, and the quality of the space behind the product, in the materials of the art direction. Do not describe the product.',
    '- structure: the SCALE of the main structure of the scene relative to the product (in words, for example "about twice as tall as the product"), HOW MANY main parts it has (spell the number) and how they are spaced, and WHERE it stands in the frame relative to the product. Use frame_facts: the product occupies only part of the frame; the rest is the scene.',
    '- materials: the materials of the scene, restated so that they agree with your other decisions (this REPLACES the art direction\'s material_language: its materials may mention an element you have dropped or changed).',
    '- calm_area: where the calm area is and what is in it. It must be where the title goes (stage.text_placement) and must not be crossed by the structure.',
    '- elements: the COMPLETE list of the scene elements by zone (BACKGROUND, MIDGROUND, FOREGROUND; up to four), restated so that the whole scene is consistent. The art direction\'s elements are given for reference: keep, change or drop them. An element never names the product.',
    '- resolution: contradictions_to_resolve lists the elements of the art direction that contradict the request: the product already carries its own cables and the request forbids any extra cable and any second product (scene_prohibitions), so a cable-like element next to the product reads as a second cable. For each one decide what it becomes: another element that is not cable-like, or nothing. Say what you decided and why (an empty list means there is nothing to resolve: say so).',
    'Rules Nordla checks: write in English; no digit anywhere (relative words only; spell numbers); no cable-like object (cable, cord, wire, rope, string, lead, thread) in the scene; the structure states its scale and its count; the calm area is on the side of the title.',
    ...(hints.length ? ['A previous answer was refused for these reasons: fix exactly these, keep the rest:', ...hints.map((h) => `- ${h}`)] : []),
  ].join('\n');
  const user = JSON.stringify({
    concept: { central_idea: concept.central_idea, visual_metaphor: concept.visual_metaphor, composition: concept.composition, value_lever: concept.value_lever },
    art_direction: { atmosphere: artDirection.atmosphere, material_language: artDirection.material_language, lighting_intent: artDirection.lighting_intent, depth_model: artDirection.depth_model, negative_space_strategy: artDirection.negative_space_strategy, narrative_elements: artDirection.narrative_elements.map((e) => ({ zone: e.zone, element: e.element })), permitted_secondary_elements: artDirection.permitted_secondary_elements, rationale: artDirection.rationale },
    stage: { camera: stage.camera, key_light: { kind: stage.key_light.kind, side: stage.key_light.side }, text_placement: stage.text_placement, support_surface: stage.support_surface },
    contradictions_to_resolve: contradictionsOf(artDirection), frame_facts: frameFacts, product_facts: productFacts, scene_prohibitions: sceneProhibitions,
  });
  return { system, user, max_output_tokens: CLARIFY_MAX_OUTPUT_TOKENS };
}

/** The elements of the art direction that read as a second cable next to the product's own (lexical detection, no decision): [{ zone, element, words }]. */
export function contradictionsOf(art) {
  return (art?.narrative_elements ?? []).flatMap((e) => { const w = uniq(String(e?.element ?? '').match(CABLE_LIKE_IN_ELEMENTS)); return w.length ? [{ zone: e.zone, element: e.element, reads_as: `a second cable (${w.join(', ')})` }] : []; });
}

/** The facts of the frame the generator will receive, MEASURED from its planned box (shares of the canvas). */
export function frameFactsOf(frame) {
  const [W, H] = frame.canvas; const p = frame.placement; const r = (v) => Math.round(v * 100);
  return {
    canvas_px: [W, H], product_box_share_of_frame: { left: r(p.x0 / W), right: r((p.x0 + p.w) / W), top: r(p.y0 / H), bottom: r((p.y0 + p.h) / H), height: r(p.h / H), width: r(p.w / W) },
    product_body_centre_x_share: r(frame.planned_body_center_x / W), product_body_foot_y_share: r(frame.planned_body_lowest_point_y / H),
    free_left_share_of_width: r(p.x0 / W), free_right_share_of_width: r((W - p.x0 - p.w) / W),
    note: 'the product is placed by the system at this position and size and is never moved; the scene is built around it',
  };
}

export const CLARIFY_COST = Object.freeze({ calls_planned: 2, note: 'one call, plus at most one repair call with the same instruction and the refusal reasons' });

// ---- the call itself: ONE ask, and at most ONE repair that names exactly what was refused (the model rewrites; the code writes nothing)
import { askAndNormalize } from '../creative-brain/model-port.js';
import { validateSpec } from '../creative-brain/contract.js';
import { BrainError } from '../creative-brain/validation.js';
import { assertElementsDoNotNameProduct } from './product-visible-request.js';

export async function runClarification({ complete, concept, artDirection, stage, frameFacts, productFacts, sceneProhibitions = [], sheet = null, maxRepairs = 1 }) {
  const history = []; let hints = [];
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const instruction = sceneClarificationInstruction({ concept, artDirection, stage, frameFacts, productFacts, sceneProhibitions, hints });
    let value = null; let violations = [];
    try {
      ({ value } = await askAndNormalize({ complete, instruction, stage: 'SCENE_CLARIFY', spec: SCENE_CLARIFICATION_SPEC, normalize: (raw) => validateSpec(SCENE_CLARIFICATION_SPEC, raw, 'scene_clarification') }));
      violations = sceneClarificationViolations(value, { titleZone: stage.text_placement });
      if (sheet && !violations.length) { try { assertElementsDoNotNameProduct({ narrative_elements: value.elements, permitted_secondary_elements: [] }, sheet); } catch (e) { violations.push({ field: 'elements', rule: e.code ?? 'ELEMENT_NAMES_THE_PRODUCT', message: e.message }); } }
    } catch (e) { if (!(e instanceof BrainError)) throw e; violations = [{ field: e.field ?? 'answer', rule: e.code, message: e.message }]; }
    history.push({ attempt, violations });
    if (!violations.length) return { clarification: value, history };
    hints = violations.map((v) => `${v.field}: ${v.message}`);
  }
  throw Object.assign(new Error(`SCENE_CLARIFICATION_REFUSED: ${history.at(-1).violations.map((v) => `${v.field} ${v.rule}`).join('; ')}`), { code: 'SCENE_CLARIFICATION_REFUSED', history });
}

// =====================================================================================================================================================================================================
// GLOBAL COMPLETION (A/B B2, final attempt): the model decides TOGETHER the place of the product, the structure, the light and a compact text reserve, and restates every section they touch (the idea, the light, the atmosphere,
// the materials, the setting, the elements as ONE list). Nothing about the position of the product or the place of the text is imposed: the measured placement options are given as facts. FIXED, because they are facts of
// the product photograph: its perspective (camera height) and the side its light comes from. The frame is then built from the final composition. No lexical rule is added for a scene: the checks below are the generic ones of the
// first clarification, plus ONE geometric fact (the chosen position and scale must fit in the frame).
// =====================================================================================================================================================================================================
const POSITIONS = Object.freeze({ LEFT_THIRD: 'LEFT_THIRD', CENTER: 'CENTER', RIGHT_THIRD: 'RIGHT_THIRD' });
const FRAMINGS = Object.freeze({ WIDE: 'WIDE', MEDIUM: 'MEDIUM', CLOSE: 'CLOSE' });
export const TEXT_ZONES = Object.freeze({ TOP_LEFT: 'TOP_LEFT', TOP_RIGHT: 'TOP_RIGHT', LEFT_COLUMN: 'LEFT_COLUMN', RIGHT_COLUMN: 'RIGHT_COLUMN', BOTTOM_LEFT: 'BOTTOM_LEFT', BOTTOM_RIGHT: 'BOTTOM_RIGHT' });
export const GLOBAL_LIMITS = Object.freeze({ idea: 400, atmosphere: 300, light: 500, setting: 500, structure: 600, materials: 500, reserve: 300, element: 140, resolution: 300, max_elements: 4 });
const gt = (max) => text({ max, geometry: true, fit: true });
export const SCENE_GLOBAL_SPEC = obj({
  idea: gt(GLOBAL_LIMITS.idea), product_position: word(POSITIONS), product_framing: word(FRAMINGS), structure: gt(GLOBAL_LIMITS.structure), setting: gt(GLOBAL_LIMITS.setting), materials: gt(GLOBAL_LIMITS.materials),
  atmosphere: gt(GLOBAL_LIMITS.atmosphere), light: gt(GLOBAL_LIMITS.light), text_reserve: obj({ zone: word(TEXT_ZONES), description: gt(GLOBAL_LIMITS.reserve) }),
  elements: list(obj({ zone: word(SCENE_ZONE), element: text({ max: GLOBAL_LIMITS.element, geometry: true, forbid: true, fit: true }) }), { min: 0, max: GLOBAL_LIMITS.max_elements }), resolution: gt(GLOBAL_LIMITS.resolution),
});

/** Violations of a global answer. The generic checks of the first clarification (English, cable-like objects in the SCENE texts, scale and count of the structure, the reserve described on the side of its own zone)
 *  plus one geometric fact: the chosen position and scale must fit in the frame (placementOptions.options[].fits_in_frame). */
export function sceneGlobalViolations(c, { placementOptions = null, structureRules = true, cableRule = true, reserveSideRule = true } = {}) { // reserveSideRule false = the AD route, whose request itself writes the side of the reserve from its zone // cableRule false = the PRODUCT_VISIBLE route (visible-scene-check.js tells the product's own cable from an added one)
  const out = []; const add = (field, rule, message) => out.push({ field, rule, message });
  const texts = [['idea', c?.idea], ['atmosphere', c?.atmosphere], ['light', c?.light], ['setting', c?.setting], ['structure', c?.structure], ['materials', c?.materials], ['text_reserve.description', c?.text_reserve?.description], ['resolution', c?.resolution], ...(c?.elements ?? []).map((e, i) => [`elements[${i}].element`, e?.element])];
  for (const [f, t] of texts) if (typeof t === 'string' && frenchEvidence(t).french) add(f, 'NOT_ENGLISH', `${f} is not written in English: these texts go to the image generator as written, write them in English yourself`);
  const sceneTexts = `${c?.setting ?? ''} . ${c?.structure ?? ''} . ${c?.materials ?? ''} . ${c?.light ?? ''} . ${c?.atmosphere ?? ''}`;
  const cable = cableRule ? uniq(sceneTexts.match(CABLE_LIKE)) : []; if (cable.length) add('setting/structure/materials/light/atmosphere', 'CABLE_LIKE_OBJECT_IN_SCENE', `the scene texts mention ${cable.join(', ')}: the product carries its own cables and the request forbids any extra cable; describe the scene without a cable-like object`);
  if (cableRule) (c?.elements ?? []).forEach((e, i) => { const w = uniq(String(e?.element ?? '').match(CABLE_LIKE_IN_ELEMENTS)); if (w.length) add(`elements[${i}].element`, 'CABLE_LIKE_OBJECT_IN_SCENE', `elements[${i}] is or contains ${w.join(', ')}, which reads as a second cable next to the product's own: decide another element or none, and say so in resolution`); });
  if (structureRules && typeof c?.structure === 'string') {
    if (!SCALE_WORDS.test(c.structure)) add('structure', 'STRUCTURE_SCALE_MISSING', 'structure must state its SCALE relative to the product in words (for example "about twice as tall as the product"), no digit');
    if (!COUNT_WORDS.test(c.structure)) add('structure', 'STRUCTURE_COUNT_MISSING', 'structure must state HOW MANY main parts it has (spell the number), and how they are spaced');
  }
  const side = SIDE_OF[c?.text_reserve?.zone];
  if (reserveSideRule && side && typeof c?.text_reserve?.description === 'string' && !new RegExp(`(?<![\\p{L}])${side}(?![\\p{L}])`, 'iu').test(c.text_reserve.description)) add('text_reserve.description', 'RESERVE_NOT_ON_ITS_OWN_SIDE', `text_reserve.zone is ${c.text_reserve.zone}: its description must say the reserve is on the ${side}`);
  const opt = placementOptions?.options?.find((o) => o.product_position === c?.product_position && o.product_framing === c?.product_framing);
  if (placementOptions && opt && !opt.fits_in_frame) add('product_position/product_framing', 'PLACEMENT_DOES_NOT_FIT', `${c.product_position} at ${c.product_framing} scale does not fit in the frame (placement_options says fits_in_frame is false): choose another position or scale`);
  return out;
}

export function sceneGlobalInstruction({ concept, artDirection, stage, placementOptions, productFacts, sceneProhibitions = [], contradictions = null, hints = [] }) {
  const system = [
    'You are the Nordla art director completing ONE scene. The concept is chosen and its art direction is written; you keep the concept. You now decide TOGETHER, as one composition, the place of the product in the frame, the structure of the scene, the light and a compact reserve for the title, and you restate every section they touch so that the image generator receives ONE complete and CONSISTENT scene.',
    'Return ONLY one JSON object, described exactly by these lines (Nordla refuses an answer that does not follow them):',
    ...renderContract(SCENE_GLOBAL_SPEC, 'answer'),
    'WHAT IS FIXED (facts of the product photograph, not decisions): its perspective (stage.camera.height) and the side its light comes from (product_facts.lit_side_of_the_photograph). The product itself is placed by the system, never redrawn, never moved after that.',
    'WHAT YOU DECIDE (nothing else is decided for you; no position of the product and no place of the text is imposed):',
    '- product_position and product_framing: where the product stands in the frame and at what scale. placement_options gives, for each combination, the MEASURED box of the product (shares of the frame) and the free space on each side; a combination whose fits_in_frame is false is not allowed. A larger product is more present; the space left decides what the scene can hold.',
    '- structure: the scale of the main structure of the scene relative to the product (in words, for example "about twice as tall as the product"), HOW MANY main parts it has (spell the number), how they are spaced, and where it stands in the frame relative to the product, consistent with the box you chose.',
    '- text_reserve: the zone for the title (zone) and what it is made of (description). It must be COMPACT (a corner or a short band, not a full column), on the side you name, and the structure must not cross it.',
    '- light: the light of the scene, restated; it comes from the side the photograph is lit from and must agree with the structure and the reserve (what it rakes, what recedes into shadow). The product must stay readable.',
    '- idea: the advertising idea of the photograph in one or two plain sentences, restated to agree with the composition you chose (this REPLACES the art direction\'s idea sentence).',
    '- setting, atmosphere and materials: the room and its back plane, the mood, and the materials, restated so that they describe exactly the elements that are present and nothing absent (these REPLACE the art direction\'s).',
    '- elements: the COMPLETE list of the scene elements by zone (BACKGROUND, MIDGROUND, FOREGROUND; up to four), each element ONCE. It replaces the art direction\'s elements and its secondary elements. An element never names the product.',
    '- resolution: contradictions_to_resolve lists elements of the art direction that read as a second cable next to the product\'s own (the request forbids any extra cable and any second product, scene_prohibitions). For each one decide what it becomes: another element that is not cable-like, or nothing. Say what you decided and why (an empty list means there is nothing to resolve: say so).',
    'Rules Nordla checks: write in English; no digit anywhere (relative words only; spell numbers); no cable-like object in the scene texts; the structure states its scale and its count; the reserve is described on the side of its zone; the position and scale you choose fit in the frame.',
    ...(hints.length ? ['A previous answer was refused for these reasons: fix exactly these, keep the rest:', ...hints.map((h) => `- ${h}`)] : []),
  ].join('\n');
  const user = JSON.stringify({
    concept: { central_idea: concept.central_idea, visual_metaphor: concept.visual_metaphor, composition: concept.composition, value_lever: concept.value_lever },
    art_direction: { idea: artDirection.rationale, atmosphere: artDirection.atmosphere, material_language: artDirection.material_language, lighting_intent: artDirection.lighting_intent, depth_model: artDirection.depth_model, narrative_elements: artDirection.narrative_elements.map((e) => ({ zone: e.zone, element: e.element })), permitted_secondary_elements: artDirection.permitted_secondary_elements },
    stage: { camera: { height: stage.camera.height }, key_light: { kind: stage.key_light.kind, side: stage.key_light.side } },
    placement_options: placementOptions, product_facts: productFacts, scene_prohibitions: sceneProhibitions, contradictions_to_resolve: contradictions ?? contradictionsOf(artDirection),
  });
  return { system, user, max_output_tokens: 1800 };
}

export async function runGlobalClarification({ complete, concept, artDirection, stage, placementOptions, productFacts, sceneProhibitions = [], sheet = null, maxRepairs = 1 }) {
  const history = []; let hints = [];
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const instruction = sceneGlobalInstruction({ concept, artDirection, stage, placementOptions, productFacts, sceneProhibitions, hints });
    let value = null; let violations = [];
    try {
      ({ value } = await askAndNormalize({ complete, instruction, stage: 'SCENE_GLOBAL', spec: SCENE_GLOBAL_SPEC, normalize: (raw) => validateSpec(SCENE_GLOBAL_SPEC, raw, 'scene_global') }));
      violations = sceneGlobalViolations(value, { placementOptions });
      if (sheet && !violations.length) { try { assertElementsDoNotNameProduct({ narrative_elements: value.elements, permitted_secondary_elements: [] }, sheet); } catch (e) { violations.push({ field: 'elements', rule: e.code ?? 'ELEMENT_NAMES_THE_PRODUCT', message: e.message }); } }
    } catch (e) { if (!(e instanceof BrainError)) throw e; violations = [{ field: e.field ?? 'answer', rule: e.code, message: e.message }]; }
    history.push({ attempt, violations });
    if (!violations.length) return { clarification: value, history };
    hints = violations.map((v) => `${v.field}: ${v.message}`);
  }
  throw Object.assign(new Error(`SCENE_GLOBAL_REFUSED: ${history.at(-1).violations.map((v) => `${v.field} ${v.rule}`).join('; ')}`), { code: 'SCENE_GLOBAL_REFUSED', history });
}
