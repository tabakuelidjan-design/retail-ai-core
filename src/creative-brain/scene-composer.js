import { assertNoSubstitute, SCENE_FORBIDDEN, substituteWordsIn } from './substitutes.js';
import {
  BRAIN_ERROR, closed, deepFreeze, deriveId, enumOf, fail, isPlain, listOf, noNumbers, oneLine,
} from './validation.js';
import { PRODUCT_RELATIONSHIP, REALISM, SCENE_ZONE } from './art-direction.js';

// SCENE COMPOSER. The scene is no longer assumed to be empty: it can carry materials, light, atmosphere, depth and the secondary or narrative elements the selected concept argues for. What stays
// absolute is the line between the two things in the image:
//   PROTECTED PRODUCT  the merchant's real pixels, placed by Nordla; authoritative; never described to, redrawn by or replaced by a generator
//   GENERATED SCENE    everything else, which must RESERVE a validated product integration zone: a calm, even area, free of any object or strong structure, lit consistently with the scene
// The scene may not contain a substitute for the product, a competing hero object, a misleading commercial object or text; each element must come from the art direction (a reason in the concept).
// The scene spec is canonical Nordla data; the provider request is an adapter-level PROJECTION of it (projectSceneRequest), and the zone check on the generated image stays the deterministic
// suitability gate, now applied to the integration zone.

export const PROTECTED_PRODUCT_MODE = 'COMPOSITE_REAL_PIXELS';
export const ZONE_HORIZONTAL = Object.freeze({ START: 'START', CENTER: 'CENTER', END: 'END' });
export const ZONE_VERTICAL = Object.freeze({ UPPER: 'UPPER', MIDDLE: 'MIDDLE', LOWER: 'LOWER' });
export const ZONE_EXTENT = Object.freeze({ SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE' });

const SCENE_KEYS = ['scene_id', 'concept_id', 'art_direction_id', 'protected_product', 'integration_zone', 'layers', 'prohibited', 'rendering'];
const MAX_LAYERS = 9;

/** The semantic place of the product box in the frame (no coordinate leaves this function). */
export function describeZone(box, canvas) {
  const cx = (box.x + box.width / 2) / canvas.width; const cy = (box.y + box.height / 2) / canvas.height;
  const share = (box.width * box.height) / (canvas.width * canvas.height);
  return deepFreeze({
    horizontal: cx < 0.4 ? ZONE_HORIZONTAL.START : (cx > 0.6 ? ZONE_HORIZONTAL.END : ZONE_HORIZONTAL.CENTER),
    vertical: cy < 0.4 ? ZONE_VERTICAL.UPPER : (cy > 0.6 ? ZONE_VERTICAL.LOWER : ZONE_VERTICAL.MIDDLE),
    extent: share < 0.15 ? ZONE_EXTENT.SMALL : (share < 0.35 ? ZONE_EXTENT.MEDIUM : ZONE_EXTENT.LARGE),
  });
}

const GROUNDING = Object.freeze({
  [PRODUCT_RELATIONSHIP.GROUNDED_IN_SCENE]: 'a firm, level surface, lit so that a soft contact shadow would be natural',
  [PRODUCT_RELATIONSHIP.ELEVATED_IN_SCENE]: 'a calm area with space around it, lit so that whatever is placed there would read as raised above its surroundings',
  [PRODUCT_RELATIONSHIP.EMBEDDED_IN_SCENE]: 'a calm area that sits inside the scene with the surrounding layers continuing around it, lit consistently with them',
  [PRODUCT_RELATIONSHIP.ADJACENT_TO_SCENE]: 'a calm area next to the scene, plain and evenly lit',
});

/**
 * The scene spec of an art direction: the protected product, the reserved integration zone, the layers (each argued in the concept) and what is prohibited. Pure and deterministic: it adds no idea of
 * its own, it structures the art direction's and refuses what may not appear.
 */
export function composeScene({ artDirection, productAssetRef }) {
  if (typeof productAssetRef !== 'string' || !productAssetRef) fail(BRAIN_ERROR.MALFORMED, 'the scene needs the reference of the protected product', 'productAssetRef');
  const layers = [
    { role: SCENE_ZONE.BACKGROUND, content: oneLine(`${artDirection.atmosphere}; ${artDirection.material_language}`, 'scene.layers.background', { max: 300 }), concept_link: 'atmosphere and material language of the art direction', optional: false },
    ...artDirection.narrative_elements.map((e) => ({ role: e.zone, content: e.element, concept_link: e.reason, optional: false })),
    ...artDirection.permitted_secondary_elements.map((element) => ({ role: SCENE_ZONE.MIDGROUND, content: element, concept_link: 'a secondary element the art direction permits', optional: true })),
  ];
  for (const [i, layer] of layers.entries()) if (i > 0) assertNoSubstitute(layer.content, `scene.layers[${i}].content`);
  const body = {
    concept_id: artDirection.concept_id,
    art_direction_id: artDirection.art_direction_id,
    protected_product: { asset_ref: productAssetRef, mode: PROTECTED_PRODUCT_MODE, authority: 'MERCHANT_PIXELS' },
    integration_zone: { reservation: 'REQUIRED', surface: GROUNDING[artDirection.product_relationship], lighting: artDirection.lighting_intent, rule: 'a calm, even area with no object and no strong structure' },
    layers,
    prohibited: [...new Set([...SCENE_FORBIDDEN, ...artDirection.forbidden_decorative_noise])],
    rendering: { realism: artDirection.realism, depth_model: artDirection.depth_model, emotional_temperature: artDirection.emotional_temperature },
  };
  return normalizeScene({ scene_id: deriveId('scn', body), ...body });
}

/** A scene spec re-validated: closed, no figure, no substitute for the product, a protected product and a required zone, a bounded number of layers, an id that follows from the content. */
export function normalizeScene(scene) {
  noNumbers(scene, 'scene');
  closed(scene, SCENE_KEYS, 'scene');
  const { scene_id: id, ...body } = scene;
  closed(body.protected_product, ['asset_ref', 'mode', 'authority'], 'scene.protected_product');
  if (body.protected_product.mode !== PROTECTED_PRODUCT_MODE || body.protected_product.authority !== 'MERCHANT_PIXELS') fail(BRAIN_ERROR.RULE_VIOLATION, 'the product of a scene is always the protected merchant pixels', 'scene.protected_product');
  closed(body.integration_zone, ['reservation', 'surface', 'lighting', 'rule'], 'scene.integration_zone');
  if (body.integration_zone.reservation !== 'REQUIRED') fail(BRAIN_ERROR.RULE_VIOLATION, 'a scene always reserves its product integration zone', 'scene.integration_zone.reservation');
  listOf(body.layers, 'scene.layers', { min: 1, max: MAX_LAYERS }, (l, w) => {
    closed(l, ['role', 'content', 'concept_link', 'optional'], w);
    enumOf(l.role, SCENE_ZONE, `${w}.role`); oneLine(l.content, `${w}.content`); oneLine(l.concept_link, `${w}.concept_link`);
    if (typeof l.optional !== 'boolean') fail(BRAIN_ERROR.MALFORMED, `${w}.optional must be a boolean`, `${w}.optional`);
    return l;
  });
  if (body.layers[0].role !== SCENE_ZONE.BACKGROUND) fail(BRAIN_ERROR.RULE_VIOLATION, 'a scene starts with its background layer', 'scene.layers[0]');
  body.layers.slice(1).forEach((l, i) => { const found = substituteWordsIn(l.content); if (found.length) fail(BRAIN_ERROR.FORBIDDEN_CONTENT, `scene.layers[${i + 1}].content is, or stands in for, the product`, `scene.layers[${i + 1}].content`, { problem: 'SCENE_ELEMENT_SUBSTITUTES_THE_PRODUCT', words: found }); });
  for (const required of SCENE_FORBIDDEN) if (!body.prohibited.includes(required)) fail(BRAIN_ERROR.RULE_VIOLATION, 'a scene always prohibits a substitute product, a competing hero, a misleading object and text', 'scene.prohibited');
  closed(body.rendering, ['realism', 'depth_model', 'emotional_temperature'], 'scene.rendering');
  enumOf(body.rendering.realism, REALISM, 'scene.rendering.realism');
  if (id !== deriveId('scn', body)) fail(BRAIN_ERROR.RULE_VIOLATION, 'scene_id does not follow from the content', 'scene.scene_id');
  return deepFreeze(structuredClone(scene));
}

const PHRASE_H = Object.freeze({ START: 'on the left', CENTER: 'in the centre', END: 'on the right' });
const PHRASE_V = Object.freeze({ UPPER: 'upper', MIDDLE: 'middle', LOWER: 'lower' });
const PHRASE_E = Object.freeze({ SMALL: 'small', MEDIUM: 'medium-sized', LARGE: 'large' });

/**
 * The provider request for a scene (adapter-level, ephemeral): the scene's layers described as a photograph, the reserved zone as a calm empty area, and the prohibited things in the NEGATIVE prompt
 * only. The protected product is never described. Returns { prompt, negative_prompt, size }.
 */
export function projectSceneRequest({ scene, zone, canvas }) {
  if (!isPlain(zone) || !zone.horizontal || !zone.vertical || !zone.extent) fail(BRAIN_ERROR.MALFORMED, 'a described integration zone is required', 'zone');
  const background = scene.layers[0];
  const others = scene.layers.slice(1).filter((l) => !l.optional || true);
  const byRole = (role) => others.filter((l) => l.role === role).map((l) => l.content);
  const parts = [
    `A ${scene.rendering.realism === REALISM.PHOTOREALISTIC ? 'photograph' : 'refined editorial image'} of ${background.content}.`,
    `Light: ${scene.integration_zone.lighting}.`,
    byRole(SCENE_ZONE.BACKGROUND).length ? `Far behind: ${byRole(SCENE_ZONE.BACKGROUND).join('; ')}.` : null,
    byRole(SCENE_ZONE.MIDGROUND).length ? `In the middle distance: ${byRole(SCENE_ZONE.MIDGROUND).join('; ')}.` : null,
    byRole(SCENE_ZONE.FOREGROUND).length ? `In the foreground, at the edges of the frame: ${byRole(SCENE_ZONE.FOREGROUND).join('; ')}.` : null,
    `Keep a ${PHRASE_E[zone.extent]} area in the ${PHRASE_V[zone.vertical]} part of the frame, ${PHRASE_H[zone.horizontal]}, completely calm and empty: ${scene.integration_zone.surface}; nothing stands on it, nothing crosses it.`,
    `Depth: ${scene.rendering.depth_model.toLowerCase().replace(/_/g, ' ')}. Mood: ${scene.rendering.emotional_temperature.toLowerCase()}. Format: ${canvas.width} by ${canvas.height} pixels, a single coherent image.`,
  ].filter(Boolean).join(' ');
  return Object.freeze({ prompt: parts, negative_prompt: scene.prohibited.join(', '), size: `${canvas.width}*${canvas.height}` });
}
