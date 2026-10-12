import { claimWordsOf } from '../creative-planning/copy-policy.js';
import { SCENE_FORBIDDEN } from '../creative-brain/substitutes.js';
import { deepFreeze, deriveId } from '../creative-brain/validation.js';
import {
  BLOCK, COMPOSITION_LAYERING, LAYER_KIND, LAYER_SOURCE, LAYER_Z, OVERLAP_LIMIT, OVERLAP_POLICY, PLACEMENT, PRODUCTION_CAPABILITY as CAP, PRODUCTION_POLICY, PRODUCTION_STATUS, PRODUCT_STATUS, SCHEMA,
} from './constants.js';
import { selectTool } from './capability-router.js';
import { sha256Text, textLayersOf } from './copy-integrity.js';
import { detectSubstitutes, PRODUCT_FAMILIES } from './product-identity.js';

// THE SCENE SPECIFICATION of one asset: the layers a scene is made of, in an explicit z-order, where each pixel comes from, the request that would produce each generated layer, the tool chosen for it, how the
// layers are composited, and the chain that ties every layer back to the request and to the real product. It is data: nothing here calls a provider and nothing here draws a pixel.
//
//   PLATE (generated, text-only)  <  PROP_BACKGROUND / PROP_MIDGROUND (generated alone on a plain ground, then cut out)  <  PRODUCT (the real asset, exact pixels)  <  PROP_FOREGROUND (bounded overlap)  <  TEXT (deterministic)
//
// The plate no longer has to keep a zone empty with words: the real product is placed on it afterwards and the unchanged suitability gate decides whether the plate allows it. A prop is a single object on a
// plain ground, so no generator is asked to solve a whole scene. Generated layers are shared across assets (a plate by crop scale, a prop by element) and produced once.

const CROP_WORDS = Object.freeze({ WIDE: 'a wide, open view', MID: 'a view at mid distance', CLOSE: 'a close view of the main surface', ALL: 'a calm view' });
export const sizeClassOf = (size) => (Math.max(size.width, size.height) > 1024 ? 'ABOVE_1024' : 'UP_TO_1024');
const NO_OBJECTS = 'nothing stands on the main surface, no objects, no people, no text, no logo, no watermark';

const familyNegative = (identity) => (identity?.family ? PRODUCT_FAMILIES[identity.family].words : []);
const joinNegative = (artDirection, identity) => [...SCENE_FORBIDDEN, ...familyNegative(identity), ...artDirection.forbidden_decorative_noise].join(', ');

function guard(parts, identity, approvedWords) {
  const text = parts.filter(Boolean).join(' ');
  const hits = detectSubstitutes({ text, identity });
  const claims = claimWordsOf(text).filter((w) => !approvedWords.has(w));
  const digits = /[0-9]/.test(parts.filter(Boolean).join(' '));
  return { hits, claims, digits };
}

/** The request that would produce a plate: text only, nothing to keep empty, nothing about the product. */
export function plateRequest({
  artDirection, canvas, variant, identity, approvedWords, policy = PRODUCTION_POLICY,
}) {
  const model = [artDirection.atmosphere, artDirection.material_language, artDirection.lighting_intent];
  const checked = guard(model, identity, approvedWords);
  const size = { width: canvas.width, height: canvas.height, unit: 'px' };
  const prompt = `A photograph: ${CROP_WORDS[variant]} of a quiet, empty scene. ${artDirection.atmosphere} Materials: ${artDirection.material_language} Light: ${artDirection.lighting_intent} ${NO_OBJECTS}. Format: ${size.width} by ${size.height} pixels, a single coherent image.`;
  const key = deriveId('plk', { art_direction_id: artDirection.art_direction_id, size, variant });
  return {
    checked,
    request: {
      request_key: key, kind: 'PLATE', capability: CAP.ENVIRONMENT_PLATE_GENERATION, variant, model_text: model, size, size_class: sizeClassOf(size), n: 1, prompt, negative_prompt: joinNegative(artDirection, identity), prompt_sha256: sha256Text(prompt), carries_input_asset: false, candidates: policy.candidates_per_generated_layer, produced_asset: { status: 'NOT_PRODUCED', request_key: key },
    },
  };
}

/** The request that would produce a prop: one object, alone, on a plain ground, so that it can be cut out. */
export function propRequest({
  element, artDirection, identity, approvedWords, policy = PRODUCTION_POLICY,
}) {
  const checked = guard([element.element], identity, approvedWords);
  const size = policy.prop_canvas;
  const prompt = `A photograph of a single ${element.element}, isolated on a plain neutral ground, soft even light, nothing else in the frame, no text, no logo, no watermark. Format: ${size.width} by ${size.height} pixels, a single coherent image.`;
  const key = deriveId('prk', { art_direction_id: artDirection.art_direction_id, element: element.element, zone: element.zone, size });
  return {
    checked,
    request: {
      request_key: key, kind: 'PROP', capability: CAP.PROP_ON_PLAIN_GROUND_GENERATION, zone: element.zone, model_text: [element.element], size, size_class: sizeClassOf(size), n: 1, element: element.element, prompt, negative_prompt: joinNegative(artDirection, identity), prompt_sha256: sha256Text(prompt), carries_input_asset: false, candidates: policy.candidates_per_generated_layer, produced_asset: { status: 'NOT_PRODUCED', request_key: key },
    },
  };
}

const PROP_KIND = Object.freeze({ BACKGROUND: LAYER_KIND.PROP_BACKGROUND, MIDGROUND: LAYER_KIND.PROP_MIDGROUND, FOREGROUND: LAYER_KIND.PROP_FOREGROUND });

/** The elements of the art direction an asset carries: as many as its composition holds, rotated by position so that the assets do not all carry the same, and a foreground one only where the composition allows it. */
export function propsForAsset({ elements, composition, index }) {
  const rule = COMPOSITION_LAYERING[composition];
  const limit = Math.min(rule.props, PRODUCTION_POLICY.max_props_per_asset);
  const usable = elements.filter((e) => e.zone !== 'FOREGROUND' || rule.foreground);
  const picked = [];
  for (let step = 0; step < usable.length && picked.length < limit; step += 1) {
    const e = usable[(index + step) % usable.length];
    if (!picked.some((p) => p.element === e.element)) picked.push(e);
  }
  // at most one foreground prop, and the order is the z-order
  const foreground = picked.filter((e) => e.zone === 'FOREGROUND').slice(0, 1);
  return [...picked.filter((e) => e.zone !== 'FOREGROUND'), ...foreground];
}

/**
 * The scene specification of one asset.
 * @param {object} input { chain: { request_ref, campaign_id, content_plan_id, lane_id, art_direction_id, concept_id, frame_id }, assetPlan, contentAsset, identity, plate, props: [{ request, kind }], resource, feasibility }
 */
export function buildSceneSpec({
  chain, assetPlan, contentAsset, identity, plate, props, resource, feasibility, blocks = [],
}) {
  const sceneKey = { asset_plan_id: assetPlan.asset_plan_id, plate: plate?.request_key ?? null, props: props.map((p) => p.request.request_key), identity: identity.identity_id };
  const placement = PLACEMENT[assetPlan.composition_intent];
  const provenance = {
    request_ref: chain.request_ref, campaign_id: chain.campaign_id, content_plan_id: chain.content_plan_id, content_asset_id: contentAsset.asset_id, asset_plan_id: assetPlan.asset_plan_id, lane_id: chain.lane_id, index: assetPlan.index,
    art_direction_id: chain.art_direction_id, concept_id: chain.concept_id, frame_id: chain.frame_id,
    product: { identity_id: identity.identity_id, product_ref: identity.product_ref, asset_ref: identity.asset_ref, sha256: identity.sha256 },
  };
  const allBlocks = [...blocks];
  if (identity.status !== PRODUCT_STATUS.VERIFIED) allBlocks.push({ code: BLOCK.PRODUCT_IDENTITY_NOT_VERIFIED, detail: { status: identity.status, reasons: identity.reasons } });
  if (feasibility && !feasibility.fits) allBlocks.push({ code: BLOCK.LOCKED_COPY_DOES_NOT_FIT_THE_COMPOSITION, detail: { reasons: feasibility.reasons, basis: feasibility.basis, replan: 'DISTRIBUTE_THE_COPY_OVER_MORE_OR_HEAVIER_ASSETS_OR_THE_CAPTION' } });
  const intentOnly = identity.status !== PRODUCT_STATUS.VERIFIED;
  const status = allBlocks.length === 0 ? PRODUCTION_STATUS.SPECIFIED : (intentOnly ? PRODUCTION_STATUS.INTENT_ONLY : PRODUCTION_STATUS.BLOCKED);
  const common = { canvas: contentAsset.canvas, status, blocks: allBlocks, provenance };
  const intent = {
    narrative_role: assetPlan.narrative_role, composition_intent: assetPlan.composition_intent, imagery_intent: assetPlan.imagery_intent, crop_scale: assetPlan.crop_scale, density_class: assetPlan.density.density_class, imagery_brief: assetPlan.imagery_brief,
  };
  const textLayers = textLayersOf({ contentAsset, scenePrefix: sceneKey, placementText: placement.text });
  // a scene that cannot honestly be specified keeps its intent and its text, and names no layer that would have to be produced
  if (status !== PRODUCTION_STATUS.SPECIFIED) {
    const body = {
      schema: SCHEMA.scene, ...common, intent, layers: [], text_layers: textLayers, composite: null, tools: [], execution: { status: 'NOT_EXECUTABLE', reasons: allBlocks.map((b) => b.code) },
    };
    return deepFreeze({ scene_id: deriveId('scn', body), ...body });
  }
  const layers = [];
  const bandLayer = (kind, body) => { const full = { kind, z: LAYER_Z[kind], ...body, scene: sceneKey }; layers.push({ layer_id: deriveId('lyr', full), ...full }); };
  bandLayer(LAYER_KIND.PLATE, { source: LAYER_SOURCE.GENERATED, request_key: plate.request_key, view: assetPlan.crop_scale, placement: 'FULL_CANVAS' });
  props.forEach((p, i) => {
    const kind = PROP_KIND[p.request.zone];
    const foreground = kind === LAYER_KIND.PROP_FOREGROUND;
    const overlap = foreground ? { policy: OVERLAP_POLICY.EDGE_ONLY, max_share_of_product: OVERLAP_LIMIT.EDGE_ONLY, may_cover_protected_regions: false } : { policy: OVERLAP_POLICY.NONE, max_share_of_product: OVERLAP_LIMIT.NONE, may_cover_protected_regions: false };
    bandLayer(kind, { source: LAYER_SOURCE.GENERATED, request_key: p.request.request_key, slot: i, overlap, cutout: 'PLAIN_GROUND_MATTE' });
  });
  bandLayer(LAYER_KIND.PRODUCT, {
    source: LAYER_SOURCE.REAL_ASSET, product_ref: identity.product_ref, asset_ref: identity.asset_ref, sha256: identity.sha256, identity_id: identity.identity_id, placement: placement.product, preservation: 'COMPOSITE', allow_crop: false, allow_relight: false, allow_rotation: false, protected_regions: identity.protected_region_count,
  });
  layers.push(...textLayers);
  layers.sort((a, b) => a.z - b.z);
  const tools = [
    selectTool(CAP.ENVIRONMENT_PLATE_GENERATION, { dataClass: 'PUBLIC', sideMax: Math.max(contentAsset.canvas.width, contentAsset.canvas.height) }),
    ...(props.length ? [selectTool(CAP.PROP_ON_PLAIN_GROUND_GENERATION, { dataClass: 'PUBLIC', sideMax: PRODUCTION_POLICY.prop_canvas.width }), selectTool(CAP.PROP_CUTOUT, { dataClass: 'PUBLIC' })] : []),
    selectTool(CAP.LOCAL_SEGMENTATION, { dataClass: 'PRIVATE' }),
    selectTool(CAP.PRODUCT_CUTOUT, { dataClass: 'PRIVATE' }),
    selectTool(CAP.DETERMINISTIC_COMPOSITE, { dataClass: 'PRIVATE' }),
    selectTool(CAP.DETERMINISTIC_TEXT, { dataClass: 'PUBLIC' }),
  ];
  const missing = tools.filter((t) => t.selected === null).map((t) => t.capability);
  if (missing.length) {
    allBlocks.push({ code: 'NO_TOOL_FOR_A_CAPABILITY', detail: { capabilities: missing } });
    const body = {
      schema: SCHEMA.scene, ...common, status: PRODUCTION_STATUS.BLOCKED, blocks: allBlocks, intent, layers: [], text_layers: textLayers, composite: null, tools, execution: { status: 'NOT_EXECUTABLE', reasons: allBlocks.map((b) => b.code) },
    };
    return deepFreeze({ scene_id: deriveId('scn', body), ...body });
  }
  const body = {
    schema: SCHEMA.scene,
    ...common,
    intent,
    layers,
    text_layers: textLayers,
    composite: {
      order: layers.map((l) => l.layer_id),
      rules: ['THE_PRODUCT_PIXELS_NEVER_CHANGE', 'THE_PRODUCT_IS_NEVER_CROPPED_RELIT_OR_ROTATED', 'GENERATED_LAYERS_ARE_COMPOSITED_UNDER_THE_PRODUCT_EXCEPT_A_BOUNDED_FOREGROUND', 'TEXT_IS_DRAWN_LAST_FROM_THE_PLANNED_PIECES', 'THE_ENVIRONMENT_SUITABILITY_GATE_DECIDES_THE_PLATE'],
      suitability_gate: 'ENVIRONMENT_SUITABILITY_UNCHANGED',
    },
    tools,
    execution: { status: 'PLANNED_NOT_EXECUTABLE', reasons: ['LAYERED_PRODUCTION_RUNS_ONLY_AFTER_THE_PROVIDER_GATE'] },
  };
  return deepFreeze({ scene_id: deriveId('scn', body), ...body });
}

const BAND_ORDER = [LAYER_KIND.PLATE, LAYER_KIND.PROP_BACKGROUND, LAYER_KIND.PROP_MIDGROUND, LAYER_KIND.PRODUCT, LAYER_KIND.PROP_FOREGROUND, LAYER_KIND.TEXT];

/**
 * The rules of a specified scene, checked. Returns the ids of the rules it breaks (empty = holds). These are the rules the production parity audit probes.
 * @param {object} scene a scene specification
 * @param {object} context { identity, sharedLayers: Map<request_key, request>, approvedWords: Set, contentAsset? }
 */
export function validateSceneSpec(scene, { identity, sharedLayers, approvedWords = new Set(), contentAsset = null }) {
  const broken = [];
  if (scene.status !== PRODUCTION_STATUS.SPECIFIED) return scene.blocks.length ? broken : ['A_SCENE_THAT_IS_NOT_SPECIFIED_NAMES_ITS_BLOCKS'];
  const products = scene.layers.filter((l) => l.kind === LAYER_KIND.PRODUCT);
  if (products.length !== 1 || products[0].source !== LAYER_SOURCE.REAL_ASSET || products[0].asset_ref !== identity.asset_ref || products[0].sha256 !== identity.sha256 || products[0].product_ref !== identity.product_ref) broken.push('EXACTLY_ONE_PRODUCT_LAYER_AND_IT_IS_THE_REAL_ASSET');
  if (scene.layers.some((l) => l.source === LAYER_SOURCE.GENERATED && (l.kind === LAYER_KIND.PRODUCT || l.product_ref || l.asset_ref))) broken.push('NO_GENERATED_LAYER_IS_THE_PRODUCT');
  const bands = scene.layers.map((l) => BAND_ORDER.indexOf(l.kind));
  if (bands.some((b, i) => i > 0 && b < bands[i - 1]) || new Set(scene.layers.map((l) => l.z)).size !== scene.layers.length || scene.layers.some((l) => Math.floor(l.z / 10) * 10 !== LAYER_Z[l.kind] && l.kind !== LAYER_KIND.TEXT) || scene.composite.order.join() !== scene.layers.map((l) => l.layer_id).join()) broken.push('Z_ORDER_IS_THE_BAND_ORDER');
  const slots = contentAsset?.slots;
  const textOk = scene.text_layers.every((l, i) => l.text_sha256 === sha256Text(l.text) && l.pieces.every((p) => typeof p.text_sha256 === 'string') && (!slots || (slots[i] && slots[i].text === l.text)));
  if (!textOk || scene.layers.filter((l) => l.kind === LAYER_KIND.TEXT).length !== scene.text_layers.length) broken.push('TEXT_LAYERS_FOLLOW_FROM_THE_PLANNED_PIECES');
  for (const l of scene.layers.filter((x) => x.kind === LAYER_KIND.PROP_FOREGROUND)) if (l.overlap.policy !== OVERLAP_POLICY.EDGE_ONLY || l.overlap.max_share_of_product > OVERLAP_LIMIT.EDGE_ONLY || l.overlap.may_cover_protected_regions !== false) broken.push('FOREGROUND_OVERLAP_IS_BOUNDED');
  for (const l of scene.layers.filter((x) => x.source === LAYER_SOURCE.GENERATED && x.kind !== LAYER_KIND.PROP_FOREGROUND)) if (l.overlap && l.overlap.policy !== OVERLAP_POLICY.NONE) broken.push('FOREGROUND_OVERLAP_IS_BOUNDED');
  for (const l of scene.layers.filter((x) => x.source === LAYER_SOURCE.GENERATED)) {
    const r = sharedLayers.get(l.request_key);
    if (!r) { broken.push('EVERY_GENERATED_LAYER_HAS_ITS_REQUEST'); continue; }
    if (r.carries_input_asset !== false) broken.push('A_GENERATED_REQUEST_CARRIES_NO_PRODUCT_PIXEL');
    const text = r.model_text.join(' ');
    if (detectSubstitutes({ text, identity }).length) broken.push('NO_GENERATED_LAYER_CAN_STAND_IN_FOR_THE_PRODUCT');
    if (claimWordsOf(text).some((w) => !approvedWords.has(w)) || /[0-9]/.test(text)) broken.push('NO_UNSUPPORTED_CLAIM_OR_DIMENSION_IN_A_LAYER');
  }
  const p = scene.provenance;
  if (!p?.request_ref || !p.campaign_id || !p.content_plan_id || !p.asset_plan_id || !p.product?.identity_id || p.product.identity_id !== identity.identity_id || p.product.sha256 !== identity.sha256) broken.push('PROVENANCE_IS_COMPLETE_FROM_THE_REQUEST_TO_THE_LAYERS');
  if (scene.tools.some((t) => t.selected === null || t.execution_policy !== 'ONLY_THE_SELECTED_TOOL')) broken.push('EVERY_TOOL_IS_SELECTED_AND_USED_ALONE');
  return [...new Set(broken)];
}
