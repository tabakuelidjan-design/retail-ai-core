// PRODUCT-VISIBLE REQUEST (lot A, subject 2, 2026-11-07): the final request of the "full power" mode, BUILT FROM THE DECISIONS of the art director and of STAGE, with no sentence written for a product.
// The generator SEES the product (image 1), so the productless filter does not apply here and the scene may speak of the product's place, light and contact.
//
// What is REUSED, not rebuilt: `composeScene` (creative-brain/scene-composer.js) validates the art direction and structures its layers by zone with their reason in the concept (no substitute for the product,
// no text, a bounded number of layers); its layers and its prohibitions are used as they are. What its projection assumes (an EMPTY reserved zone, the product never described) is replaced by this projection.
// What is NEW and small: this projection, which fuses the scene's layers with STAGE (camera, support, light, accents, props) and the MEASURED facts (lit side, hanging part, scale), and the PROOF OF TRANSMISSION.
//
// PROOF OF TRANSMISSION: every decision that reaches the request is recorded with the EXACT excerpt inserted in the prompt and its span; `verifyTransmission` re-reads the prompt and confirms each span.
// A decision that does not reach the request is listed with the reason. Fields merely READ are not a proof: the excerpt is.
import { createHash } from 'node:crypto';
import { composeScene } from '../creative-brain/scene-composer.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');

// ---- the words of the projection (enum -> plain words); a decision of the art director written as TEXT is sent verbatim
const FORMAT_WORDS = { INSTAGRAM_FEED_4_5: '4:5 portrait', INSTAGRAM_STORY_9_16: '9:16 vertical', SQUARE_1_1: 'square', LANDSCAPE_16_9: '16:9 landscape' };
const HEIGHT_WORDS = { LOW: 'slightly below the product', PRODUCT_CENTER: 'at the product\'s mid height', HIGH: 'slightly above the product' };
const FRAMING_WORDS = { WIDE: 'wide framing', MEDIUM: 'medium framing', CLOSE: 'close framing' };
const POSITION_WORDS = { LEFT_THIRD: 'on the left third of the frame', CENTER: 'at the centre of the frame', RIGHT_THIRD: 'on the right third of the frame' };
const SUPPORT_WORDS = { FLOOR: 'a continuous floor', LEDGE: 'a continuous low ledge', STEP: 'a single broad step', BENCH: 'a low bench', TABLE: 'a table top' };
const BACKDROP_WORDS = { SEAMLESS_SWEEP: 'a seamless sweep', INFINITE_DARK: 'a deep space without a visible horizon', WALL_AND_FLOOR: 'a wall meeting the floor behind it' };
const FLOOR_WORDS = { MATTE: 'a matte surface', SATIN: 'a satin surface with a soft sheen', MIRROR: 'a polished reflective surface' };
const TONE_WORDS = { DEEP_BLACK: 'near-black', CHARCOAL: 'charcoal grey', COOL_GREY: 'cool grey', WHITE: 'white' };
const SIDE_WORDS = { LEFT: 'from the left', RIGHT: 'from the right', FRONT: 'from the front', BACK: 'from behind, as a rim', TOP: 'from above' };
const LIGHT_KIND_WORDS = { SOFTBOX: 'a soft, wide source', STRIP: 'a narrow strip of light', SLIT_SHEET: 'a thin slit of light', SPOT: 'a hard, focused spot', RIM: 'a rim of light' };
const LEVEL_WORDS = { LOW: 'low intensity', MEDIUM: 'medium intensity', HIGH: 'high intensity' };
const TEMP_WORDS = { COOL: 'cool', NEUTRAL: 'neutral', WARM: 'warm' };
const DEPTH_WORDS = { FLAT_FIELD: 'a shallow, graphic space', SHALLOW_LAYERS: 'two close layers of depth', LAYERED_DEPTH: 'a clear foreground, middle ground and background', DEEP_SPACE: 'deep space receding behind the product' };
const SPACE_WORDS = { SURROUNDING_REST: 'quiet space all around the product', DIRECTIONAL_LEAD: 'the composition leads the eye towards the product', GROUP_SEPARATION: 'the story elements kept apart from the product', ASYMMETRIC_RESERVE: 'a large calm area on one side of the product' };
const RELATIONSHIP_WORDS = { GROUNDED_IN_SCENE: 'the product rests firmly on its support, with a soft contact shadow', ELEVATED_IN_SCENE: 'the product is raised above its surroundings by what it stands on', EMBEDDED_IN_SCENE: 'the product sits inside the scene, the surrounding layers continuing around it', ADJACENT_TO_SCENE: 'the product stands next to the scene, plain and evenly lit' };
const MOOD_WORDS = { COOL: 'cool', NEUTRAL: 'neutral', WARM: 'warm', CONTRASTED: 'contrasted' };
const ZONE_WORDS = { FOREGROUND: 'In the foreground', MIDGROUND: 'In the middle ground', BACKGROUND: 'In the background' };
const SHAPE_WORDS = { BLOCK: 'block', CYLINDER: 'cylinder', SPHERE: 'sphere', ARCH: 'arch', PLINTH: 'plinth', PANEL: 'panel', EXTRUDED_WORD: 'raised lettering' };
const MATERIAL_WORDS = { MATTE_BLACK: 'matte black', BRAND_NAVY: 'navy', BRAND_TERRACOTTA: 'terracotta', CONCRETE: 'concrete', BRUSHED_STEEL: 'brushed steel', FROSTED_GLASS: 'frosted glass', PAPER_WHITE: 'paper white' };
const PLACEMENT_WORDS = { BEHIND: 'behind the product', BESIDE_LEFT: 'beside the product on the left', BESIDE_RIGHT: 'beside the product on the right', FOREGROUND_LEFT: 'in the foreground on the left', FOREGROUND_RIGHT: 'in the foreground on the right', BENEATH: 'beneath the product' };
const TEXT_ZONE_WORDS = { TOP_LEFT: 'upper left', TOP_RIGHT: 'upper right', LEFT_COLUMN: 'left column', RIGHT_COLUMN: 'right column', BOTTOM_LEFT: 'lower left', BOTTOM_RIGHT: 'lower right' };
const norm = (t) => String(t ?? '').normalize('NFC').replace(/[\u2018\u2019]/g, "'").toLowerCase();
const PERSON_OR_HAND = /(?<![\p{L}])(hands?|mains?|fingers?|doigts?|persons?|people|personnes?|visage)(?![\p{L}])/iu;
const stripDot = (t) => String(t ?? '').trim().replace(/[.\s]+$/, '');

export const READABILITY_SENTENCE = 'Keep the outline of the product in image 1 clearly distinct from what surrounds it, by value, by hue or by an edge of light.';
export const PRODUCT_VISIBLE_NEGATIVE_BASE = Object.freeze(['second product', 'duplicate product', 'hands', 'people', 'added text', 'extra letters', 'extra inscriptions', 'added brand marks', 'watermark', 'distorted product', 'redrawn artwork', 'changed printed marks']);
const NEGATIVE_MAX = 500;
/** Terms that would forbid the product's OWN printed marks: never sent as bare negatives in this mode. */
export const TEXT_LIKE_TERMS = /(?<![\p{L}])(logos?|texte?s?|text|letters?|lettres?|étiquettes?|etiquettes?|labels?|words?|mots?|numbers?|signage|captions?)(?![\p{L}])/iu;
export class LightContradictsPhoto extends Error { constructor(message) { super(message); this.code = 'LIGHT_CONTRADICTS_PRODUCT_PHOTO'; } }

/** A prompt that remembers where each decision was inserted. */
function Writer() {
  let out = ''; const entries = [];
  return {
    text: (t) => { out += t; },
    // `value`: the decision as the art director / STAGE stated it ; `words`: what is inserted ; VERBATIM when the decision is text sent as written, MAPPED when it is an enum turned into words
    put: (field, words, { value = words, kind = 'MAPPED' } = {}) => { const start = out.length; out += words; entries.push({ field, kind, source_value: value, prompt_excerpt: words, span: [start, out.length] }); },
    get value() { return out; }, entries,
  };
}

/** Every scene element that names the product or its kind: [{ index, noun, text }] (a repair cites the passage and the noun). */
export function productNamingFindings(elements, sheet) {
  if (!sheet?.product_nouns?.length) return [];
  const nouns = new RegExp(`(?<![\\p{L}])(${sheet.product_nouns.join('|')})(?![\\p{L}])`, 'iu');
  return (elements ?? []).flatMap((e, index) => { const m = String(e?.element ?? '').match(nouns); return m ? [{ index, noun: m[1], text: e.element }] : []; });
}

/** A scene element (or a permitted secondary element) never names the product or its kind (nouns of the product sheet). Exported so ART_DIRECT can refuse it BEFORE any paid call, where the repair loop can still act. */
export function assertElementsDoNotNameProduct(art, sheet) {
  if (sheet?.product_nouns?.length) {
    const nouns = new RegExp(`(?<![\\p{L}])(${sheet.product_nouns.join('|')})(?![\\p{L}])`, 'iu');
    for (const [i, e] of art.narrative_elements.entries()) if (nouns.test(e.element)) throw Object.assign(new Error(`art_direction.narrative_elements[${i}] names the product or its kind: a scene element may not stand in for the product`), { code: 'ELEMENT_NAMES_THE_PRODUCT' });
    for (const [i, e] of (art.permitted_secondary_elements ?? []).entries()) if (nouns.test(e)) throw Object.assign(new Error(`art_direction.permitted_secondary_elements[${i}] names the product or its kind`), { code: 'ELEMENT_NAMES_THE_PRODUCT' });
  }
}

/**
 * @param {object} input
 *   concept, artDirection, stage   the decisions (normalised; archived ones qualify)
 *   sheet                          the product sheet (product-sheet.js): invariants, held wordings, measured facts
 *   frame                          { canvas: [W, H], planned_body_lowest_point_y, placement: { h } }   the geometry of the frame the generator receives
 *   brief                          { format }   profile = the creative brand profile (merchant words, exclusions, tone words)
 */
// options for the A/B comparison (default behaviour unchanged): ideaFromRationale = the idea sentence is the art director's English `rationale` (PRODUCT_VISIBLE mode) instead of the concept's own words; invariantsText = the sections 7 and 8 (invariants and prohibitions) are this text, so that two requests carry the same invariants
// freeDecisionsFirst (A/B B2 rebuild, 2026-11-08; opt-in, default unchanged): the FREE decisions of the art director are authoritative and STAGE's closed tables only fill what the free text does not state.
//   - the position of the product is read from the FRAME (the real pose), not from STAGE's closed choice;
//   - STAGE props are not sent when the art direction already carries scene elements by zone (a closed prop is then a SUBSTITUTE for what the vocabulary cannot say, and it describes the scene a second time);
//     the support stays ONE sentence (support_surface); a PLINTH prop is never a second support;
//   - the table sentence "Setting: a wall meeting the floor in <tone>" is not sent when the free text already describes the room.
// Everything left out is listed in `not_transmitted` with its reason, and STAGE's own `wanted_but_not_available` is attached to the dropped props.
const ROOM_WORDS = /(?<![\p{L}])(floors?|walls?|plaster|ground|rooms?|workshops?|studios?|decks?|backdrops?|interiors?|lofts?|halls?|ceilings?|courtyards?|terraces?|gallery|galleries)(?![\p{L}])/giu;
export function roomWordsInFreeText(art) {
  const texts = [art?.atmosphere, art?.material_language, ...(art?.narrative_elements ?? []).map((e) => e?.element), ...(art?.permitted_secondary_elements ?? [])].filter(Boolean).join(' . ');
  return [...new Set((texts.match(ROOM_WORDS) ?? []).map((x) => x.toLowerCase()))];
}
/** The third of the frame the product really occupies, from its planned box (the fixed frame), never from a closed choice. */
export function positionOfFrame(frame) {
  const W = frame?.canvas?.[0]; const pl = frame?.placement;
  if (!(W > 0) || !(pl?.w > 0) || !Number.isFinite(pl?.x0)) return null;
  const cx = (pl.x0 + pl.w / 2) / W;
  return { third: cx < 0.38 ? 'LEFT_THIRD' : cx > 0.62 ? 'RIGHT_THIRD' : 'CENTER', centre_x_share: Math.round(cx * 1000) / 1000 };
}
export function buildProductVisibleRequest({ concept, artDirection: art, stage, sheet, frame, brief = {}, profile = {}, productAssetRef = 'asset://product-visible/frame', ideaFromRationale = false, invariantsText = null, freeDecisionsFirst = false, composedSupportAndLight = false, clarification = null }) {
  const clar = freeDecisionsFirst && clarification ? clarification : null;
  const globalClar = Boolean(clar?.idea && clar?.light && clar?.text_reserve); // the GLOBAL completion (scene-clarify.js): idea, light, atmosphere, framing and the text reserve are the model's too // the model's own completion of the scene (scene-clarify.js): setting, layout, calm area, the scene elements as ONE consistent list
  if (!concept || !art || !stage?.camera || !stage?.key_light) throw new TypeError('concept, art direction and stage are required');
  const scene = composeScene({ artDirection: art, productAssetRef }); // validates the art direction as a scene and structures its layers; throws if the art direction is not a valid scene
  // In this mode the director MAY speak of the product's place, light and contact (lighting_intent, relationship...), but a scene ELEMENT may never be, or name, the product or its kind: a second power bank on the wall is a second product.
  // (assertArtDirectionGuard drops its product-noun screen when productless is false, so the screen is applied here, on the elements only, with the nouns of the product sheet)
  assertElementsDoNotNameProduct(art, sheet);
  const [W, H] = frame.canvas; const pct = (y) => Math.round((y / H) * 100);
  const measuredSide = sheet?.measured?.lit_side?.side ?? null;
  // the SAME rule as STAGE (LIGHT_SIDE_COMPATIBLE_WITH_PACKSHOT, stage-contract.js): the key light is the photograph's lit side, FRONT or TOP; never the opposite side, never from BACK
  if (measuredSide && !(stage.key_light.side === measuredSide || stage.key_light.side === 'FRONT' || stage.key_light.side === 'TOP')) {
    throw new LightContradictsPhoto(`STAGE lights ${SIDE_WORDS[stage.key_light.side] ?? stage.key_light.side} but the product photograph is lit from the ${measuredSide.toLowerCase()}: the scene must follow the photograph`);
  }
  const w = Writer(); const notTransmitted = [];
  // 1. IDEA
  const merchant = profile.merchant_display ?? profile.brand_name ?? null;
  w.text(`Premium advertising photograph, ${FORMAT_WORDS[brief.format] ?? 'portrait'}${merchant ? `, for ${merchant}` : ''}. Idea: `);
  if (globalClar) { w.put('scene_clarification.idea', stripDot(clar.idea), { kind: 'VERBATIM' }); w.text('. '); notTransmitted.push({ field: 'art_direction.rationale', reason: 'superseded by scene_clarification.idea (restated to agree with the final composition)', was: art.rationale }); }
  else if (ideaFromRationale) { if (typeof art.rationale !== 'string' || !art.rationale.trim()) throw new TypeError('ideaFromRationale needs the art direction rationale'); w.put('art_direction.rationale', stripDot(art.rationale), { kind: 'VERBATIM' }); w.text('. '); }
  else { w.put('concept.central_idea', stripDot(concept.central_idea), { kind: 'VERBATIM' }); w.text('. ');
  if (concept.visual_metaphor) { w.put('concept.visual_metaphor', stripDot(concept.visual_metaphor), { kind: 'VERBATIM' }); w.text('. '); } }
  w.put('art_direction.realism', art.realism === 'EDITORIAL_STYLISED' ? 'An editorial, stylised image.' : 'A photorealistic image, real materials, real optics.', { value: art.realism }); w.text(' ');
  // 2. GEOMETRY (from STAGE and the measured frame; the percentages are derived, never written)
  const share = Math.round((frame.placement.h / H) * 100);
  w.text(`Keep the frame, the proportions, and the exact position and size of the product in image 1: the product is about ${share}% of the frame height. `);
  const framePos = freeDecisionsFirst ? positionOfFrame(frame) : null;
  if (framePos) {
    w.put('frame.placement', `The product is ${POSITION_WORDS[framePos.third]}. `, { value: `${framePos.third} (centre of the planned box at ${Math.round(framePos.centre_x_share * 100)}% of the frame width)` });
    if (stage.camera.product_position !== framePos.third) notTransmitted.push({ field: 'stage.camera.product_position', reason: `STAGE chose ${stage.camera.product_position}, but the product is fixed in the frame at ${Math.round(framePos.centre_x_share * 100)}% of its width (${framePos.third}): the real pose is stated, not the closed choice` });
  } else w.put('stage.camera.product_position', `The product is ${POSITION_WORDS[stage.camera.product_position] ?? 'in the frame'}. `, { value: stage.camera.product_position });
  const tip = pct(frame.planned_body_lowest_point_y); const kind = stage.support_surface ?? 'FLOOR';
  const composed = Boolean(globalClar && composedSupportAndLight); // opt-in (C2 render, 2026-11-08): the model's composition owns the SUPPORT and the LIGHT; the closed STAGE choices that would describe them a second time, and contradict them, are not sent (each one is consigned in not_transmitted)
  if (composed) { w.text(`The lowest point of the product is at about ${tip}% of the frame height. `); notTransmitted.push({ field: 'stage.support_surface', reason: 'not sent: the model describes what the product rests on (scene_clarification.structure and elements); a closed support would state a second, contradictory one', was: kind }); }
  else w.put('stage.support_surface', kind === 'FLOOR' ? `The product stands on ${SUPPORT_WORDS.FLOOR}, its lowest point at about ${tip}% of the frame height. ` : `The product stands on the flat top of ${SUPPORT_WORDS[kind]}; its straight front edge is at about ${tip + 2}% of the frame height, just in front of the lowest point of the product's base (about ${tip}%), and the plain front face below it stays visible. `, { value: kind });
  const hang = sheet?.measured?.hanging_part_share_of_height;
  if (hang && hang > 0.06 && composed) notTransmitted.push({ field: 'sheet.measured.hanging_part_share_of_height', reason: 'not sent: the cables are preserved as photographed by the product invariants (section 7); no pose of the cable is imposed, in particular no contact with a floor', was: hang });
  else if (hang && hang > 0.06) w.text(kind === 'FLOOR' ? 'The product\'s cable hangs down to the floor in front of the product. ' : 'The product\'s cable hangs over that front edge, in front of the plain face. ');
  w.put('stage.camera.height', `Camera ${HEIGHT_WORDS[stage.camera.height] ?? ''}, ${FRAMING_WORDS[globalClar ? clar.product_framing : stage.camera.framing] ?? ''}, with the perspective already present in image 1. `.replace(/, ,/g, ','), { value: `${stage.camera.height}/${stage.camera.framing}` });
  w.put('art_direction.product_relationship', `${RELATIONSHIP_WORDS[art.product_relationship] ?? ''}. `.replace(/^\./, ''), { value: art.product_relationship });
  // 3. LIGHT AND DEPTH
  w.text('Light: ');
  if (globalClar) { w.put('scene_clarification.light', stripDot(clar.light), { kind: 'VERBATIM' }); notTransmitted.push({ field: 'art_direction.lighting_intent', reason: 'superseded by scene_clarification.light (restated with the final composition)', was: art.lighting_intent }); }
  else w.put('art_direction.lighting_intent', stripDot(art.lighting_intent), { kind: 'VERBATIM' });
  w.text('. ');
  const key = stage.key_light;
  if (composed) notTransmitted.push({ field: 'stage.key_light', reason: 'not sent: the model restated the light (scene_clarification.light), which states its side and its softness; a closed key light would describe it a second time', was: `${key.kind}/${key.side}/${key.intensity}/${key.temperature}` });
  else w.put('stage.key_light', `The key light comes ${SIDE_WORDS[key.side] ?? 'from the side'}, ${LIGHT_KIND_WORDS[key.kind] ?? 'a soft source'}, ${LEVEL_WORDS[key.intensity] ?? 'medium intensity'}, ${TEMP_WORDS[key.temperature] ?? 'neutral'} in colour${measuredSide && key.side === measuredSide ? ', the same side as the light already on the product in image 1' : ''}. `, { value: `${key.kind}/${key.side}/${key.intensity}/${key.temperature}` });
  if (globalClar) (stage.accent_lights ?? []).forEach((l, i) => notTransmitted.push({ field: `stage.accent_lights[${i}]`, reason: `${l.kind}/${l.side}/${l.intensity} is not sent: the model restated the light (scene_clarification.light); a closed accent would describe it a second time` }));
  else (stage.accent_lights ?? []).forEach((l, i) => w.put(`stage.accent_lights[${i}]`, `An accent: ${LIGHT_KIND_WORDS[l.kind] ?? 'a light'} ${SIDE_WORDS[l.side] ?? 'from the side'}, ${LEVEL_WORDS[l.intensity] ?? 'low intensity'}. `, { value: `${l.kind}/${l.side}/${l.intensity}` }));
  if (composed) notTransmitted.push({ field: 'builder.fixed_shadow_sentence', reason: 'not sent: the light (scene_clarification.light) already states the shadows; the fixed sentence added a second description of the light', was: 'A soft contact shadow under the product, and a soft shadow of anything that hangs, fall away from the light.' });
  else w.text('A soft contact shadow under the product, and a soft shadow of anything that hangs, fall away from the light. ');
  w.put('art_direction.depth_model', `Depth: ${DEPTH_WORDS[art.depth_model] ?? ''}. `, { value: art.depth_model });
  if (clar) {
    for (const zone of ['FOREGROUND', 'MIDGROUND', 'BACKGROUND']) clar.elements.forEach((e, i) => { if (e.zone !== zone) return; w.text(`${ZONE_WORDS[zone]}: `); w.put(`scene_clarification.elements[${i}]`, stripDot(e.element), { value: e.element, kind: 'VERBATIM' }); w.text('. '); });
    art.narrative_elements.forEach((e, i) => notTransmitted.push({ field: `art_direction.narrative_elements[${i}]`, reason: 'superseded by scene_clarification.elements: the model restated the scene elements as one consistent list (cord_resolution gives its reason)', was: e.element }));
  } else for (const zone of ['FOREGROUND', 'MIDGROUND', 'BACKGROUND']) {
    const layers = scene.layers.filter((l, i) => i > 0 && l.role === zone && !l.optional);
    layers.forEach((l) => { w.text(`${ZONE_WORDS[zone]}: `); w.put(`art_direction.narrative_elements[${art.narrative_elements.findIndex((e) => e.element === l.content)}]`, stripDot(l.content), { value: l.content, kind: 'VERBATIM' }); w.text('. '); });
  }
  if (globalClar) scene.layers.filter((l, i) => i > 0 && l.optional).forEach((l, i) => notTransmitted.push({ field: `art_direction.permitted_secondary_elements[${i}]`, reason: 'superseded by scene_clarification.elements (the complete list, each element once)', was: l.content }));
  else scene.layers.filter((l, i) => i > 0 && l.optional).forEach((l, i) => { w.text('A permitted secondary element: '); w.put(`art_direction.permitted_secondary_elements[${i}]`, stripDot(l.content), { value: l.content, kind: 'VERBATIM' }); w.text('. '); });
  const propsAreSubstitutes = freeDecisionsFirst && (art.narrative_elements ?? []).length > 0 && (stage.props ?? []).length > 0;
  if (propsAreSubstitutes) {
    const wanted = stage.wanted_but_not_available ?? [];
    (stage.props ?? []).forEach((p, i) => notTransmitted.push({ field: `stage.props[${i}]`, reason: `${p.shape}/${p.material}/${p.placement}/${p.scale} is not sent: the art direction already carries ${art.narrative_elements.length} scene element(s) by zone, so a closed-vocabulary prop would describe the scene a second time${p.shape === 'PLINTH' ? '; a PLINTH is never a second support (the support is stage.support_surface)' : ''}`, stage_reason: p.reason ?? null, ...(wanted.length ? { stage_wanted_but_not_available: wanted } : {}) }));
  } else (stage.props ?? []).forEach((p, i) => w.put(`stage.props[${i}]`, `A ${LEVEL_WORDS[p.scale]?.replace(' intensity', '') ?? 'medium'}-scale ${MATERIAL_WORDS[p.material] ?? ''} ${SHAPE_WORDS[p.shape] ?? 'form'} ${PLACEMENT_WORDS[p.placement] ?? ''}${p.word ? ` carrying the word "${p.word}"` : ''}. `, { value: `${p.shape}/${p.material}/${p.placement}/${p.scale}` }));
  if (clar) { w.text('Calm area: '); if (globalClar) w.put('scene_clarification.text_reserve.description', stripDot(clar.text_reserve.description), { kind: 'VERBATIM' }); else w.put('scene_clarification.calm_area', stripDot(clar.calm_area), { kind: 'VERBATIM' }); w.text('. '); notTransmitted.push({ field: 'art_direction.negative_space_strategy', reason: `superseded by scene_clarification.calm_area (${art.negative_space_strategy} did not say on which side)` }); }
  else w.put('art_direction.negative_space_strategy', `${stripDot(SPACE_WORDS[art.negative_space_strategy] ?? '')}. `.replace(/^\. $/, ''), { value: art.negative_space_strategy });
  // 4. MATERIALS AND ATMOSPHERE
  w.text('Atmosphere: ');
  if (globalClar && clar.atmosphere) { w.put('scene_clarification.atmosphere', stripDot(clar.atmosphere), { kind: 'VERBATIM' }); notTransmitted.push({ field: 'art_direction.atmosphere', reason: 'superseded by scene_clarification.atmosphere', was: art.atmosphere }); }
  else w.put('art_direction.atmosphere', stripDot(art.atmosphere), { kind: 'VERBATIM' });
  w.text('. Materials: ');
  if (clar?.materials) { w.put('scene_clarification.materials', stripDot(clar.materials), { kind: 'VERBATIM' }); notTransmitted.push({ field: 'art_direction.material_language', reason: 'superseded by scene_clarification.materials: the model restated the materials so that they agree with its other decisions', was: art.material_language }); }
  else w.put('art_direction.material_language', stripDot(art.material_language), { kind: 'VERBATIM' });
  w.text('. ');
  const tone = profile.tone_words?.[stage.backdrop_tone] ?? TONE_WORDS[stage.backdrop_tone] ?? String(stage.backdrop_tone ?? '').toLowerCase().replace(/_/g, ' ');
  const roomWords = freeDecisionsFirst ? roomWordsInFreeText(art) : [];
  if (clar) {
    w.text('Setting: '); w.put('scene_clarification.setting', stripDot(clar.setting), { kind: 'VERBATIM' }); w.text('. Layout: '); w.put('scene_clarification.structure', stripDot(clar.structure), { kind: 'VERBATIM' }); w.text('. ');
    notTransmitted.push({ field: 'stage.backdrop', reason: `superseded by scene_clarification.setting (the enumerations ${stage.backdrop}/${stage.backdrop_tone}/${stage.floor_finish} are not sent)` });
  } else if (roomWords.length) notTransmitted.push({ field: 'stage.backdrop', reason: `the free text already describes the room (words: ${roomWords.join(', ')}): the enumerations backdrop ${stage.backdrop}, tone ${stage.backdrop_tone} and floor finish ${stage.floor_finish} are not sent, they would describe it a second time and differently` });
  else w.put('stage.backdrop', `Setting: ${BACKDROP_WORDS[stage.backdrop] ?? 'a set'} in ${tone}, ${FLOOR_WORDS[stage.floor_finish] ?? 'a surface'} underfoot. `, { value: `${stage.backdrop}/${stage.backdrop_tone}/${stage.floor_finish}` });
  w.put('art_direction.emotional_temperature', `Mood: ${MOOD_WORDS[art.emotional_temperature] ?? 'neutral'}. `, { value: art.emotional_temperature });
  // 5. READABILITY (a requirement on the RESULT, no value or hue of background imposed)
  w.text(`${READABILITY_SENTENCE} `);
  // 6. CALM AREA FOR THE TITLE
  if (globalClar) { const z = clar.text_reserve.zone; w.put('scene_clarification.text_reserve.zone', `Keep the ${TEXT_ZONE_WORDS[z] ?? 'upper'} part of the frame calm and uncluttered, for a title added later. `, { value: z }); notTransmitted.push({ field: 'stage.text_placement', reason: `superseded by scene_clarification.text_reserve.zone (${z}); STAGE had chosen ${stage.text_placement}` }); }
  else w.put('stage.text_placement', `Keep the ${TEXT_ZONE_WORDS[stage.text_placement] ?? 'upper'} part of the frame calm and uncluttered, for a title added later. `, { value: stage.text_placement });
  // 7. INVARIANTS: only what the owner CONFIRMED is named; what is still pending is never asserted
  const confirmed = (sheet?.invariants?.confirmed ?? []).map((i) => i.item);
  if (invariantsText) w.text(invariantsText); else {
  w.text('Image 1 is the only reference for the product. Keep the product exactly as in image 1: its shape and proportions, its colours, its angle of view, and every printed mark, port, socket and cable it carries.');
  if (confirmed.length) { w.text(' In particular: '); w.put('sheet.invariants.confirmed', confirmed.join('; '), { value: confirmed.join('; '), kind: 'VERBATIM' }); w.text('.'); }
  w.text(' Do not redraw, recolour, relight, move or retouch the product. ');
  // 8. PROHIBITIONS (the tenant's exclusions go ONLY to the negative prompt)
  w.text('Add no brand marks, inscriptions, letters, numbers or watermark beyond those already printed on the product. No second product, no hands, no people.'); }
  const prompt = w.value.replace(/\s+/g, (m) => (m.includes('\n') ? ' ' : m));
  const kinds = new Set((sheet?.invariants?.confirmed ?? []).concat(sheet?.invariants?.pending ?? []).map((i) => i.kind));
  // the art director's list always carries the Brain's generic "no text, no logo, no label" (SCENE_FORBIDDEN, written for a scene WITHOUT the product): here it would forbid the product's own marks (REMAX, 45W...).
  // Those bare terms are replaced by the targeted ban already in the base list (added text, extra inscriptions, added brand marks, changed printed marks); every other exclusion is kept
  const noise = [...(art.forbidden_decorative_noise ?? []), ...(profile.scene_negative_terms ?? [])].flatMap((t) => String(t).split(',')).map((t) => t.trim()).filter((t) => t && !TEXT_LIKE_TERMS.test(t));
  const terms = [...new Set([...PRODUCT_VISIBLE_NEGATIVE_BASE, ...(kinds.has('CABLE') ? ['extra cable'] : []), ...(kinds.has('PORT') ? ['extra port'] : []), ...noise].map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  const kept = []; const dropped = []; let len = 0;
  for (const t of terms) { const add = (kept.length ? 2 : 0) + t.length; if (len + add <= NEGATIVE_MAX) { kept.push(t); len += add; } else dropped.push(t); }
  const negative_prompt = kept.join(', ');
  // 9. WHAT DOES NOT REACH THE GENERATOR, and why
  for (const [field, why] of [['art_direction.visual_rhythm', 'layout decision (composition), not a scene decision'], ['art_direction.visual_tension', 'layout decision (composition), not a scene decision'], ['art_direction.text_image_relationship', 'layout decision (text placement), carried by stage.text_placement'], ['stage.headline', 'drawn by the compositor, never by the generator'], ['stage.show_price', 'drawn by the compositor, never by the generator']]) notTransmitted.push({ field, reason: why });
  notTransmitted.push({ field: 'art_direction.forbidden_decorative_noise', reason: `sent to the NEGATIVE prompt only (${kept.length} terms kept${dropped.length ? `, ${dropped.length} dropped by the 500-character cut: ${dropped.join(', ')}` : ''})` });
  const unconfirmed_invariants = (sheet?.invariants?.pending ?? []).map((i) => i.item);
  // WARNINGS (the request is still built, the caller decides): an uncertain claim of the product sheet that a decision DEPICTS, or a person / a hand in a scene element (the negative prompt bans them: a contradiction)
  const warnings = [];
  const held = sheet?.promises?.held_wordings ?? [];
  const decisionTexts = [['concept.central_idea', concept.central_idea], ['concept.visual_metaphor', concept.visual_metaphor], ...w.entries.filter((e) => e.kind === 'VERBATIM').map((e) => [e.field, e.source_value])];
  for (const [field, text] of decisionTexts) {
    const t = norm(text); if (!t) continue;
    for (const wd of held) if (t.includes(norm(wd))) warnings.push({ code: 'HELD_WORDING_IN_DECISION', field, wording: wd, why: 'cette information du produit est en attente de confirmation (contradictoire ou non visible)' });
    if (field.startsWith('art_direction.narrative_elements') || field.startsWith('art_direction.permitted_secondary')) { const m = PERSON_OR_HAND.exec(String(text)); if (m) warnings.push({ code: 'PERSON_OR_HAND_IN_ELEMENT', field, word: m[0], why: 'le négatif interdit mains et personnes : l\'élément se contredit' }); }
  }
  const request = { free_decisions_first: Boolean(freeDecisionsFirst), warnings, prompt, negative_prompt, negative_dropped: dropped, sections: 8, transmission: w.entries, not_transmitted: notTransmitted, unconfirmed_invariants, held_wordings: sheet?.promises?.held_wordings ?? [], prompt_sha256: sha(prompt) };
  return Object.freeze(request);
}

/** Re-reads the prompt and checks every recorded excerpt at its span (and that a VERBATIM decision is sent as the decision states it). */
export function verifyTransmission(request) {
  const failures = [];
  for (const e of request.transmission) {
    const found = request.prompt.slice(e.span[0], e.span[1]);
    if (found !== e.prompt_excerpt) failures.push({ field: e.field, problem: 'SPAN_DOES_NOT_MATCH', found: found.slice(0, 80) });
    else if (e.kind === 'VERBATIM' && stripDot(e.source_value) !== stripDot(e.prompt_excerpt)) failures.push({ field: e.field, problem: 'VERBATIM_ALTERED' });
  }
  return { ok: failures.length === 0, checked: request.transmission.length, failures };
}
