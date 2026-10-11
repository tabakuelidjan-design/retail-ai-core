import { CAPABILITY, TOOL_REGISTRY } from './tool-registry.js';
import { BRAIN_ERROR, deepFreeze, deriveId, fail } from './validation.js';
import { DEPTH_MODEL, PRODUCT_RELATIONSHIP } from './art-direction.js';

// PRODUCTION STRATEGIST. Given the art direction, the scene and the composition plan, Nordla decides which CAPABILITIES the production needs, and why. The decision is deterministic and provider-neutral:
// capabilities are names, the registry says what realizes each one today. A capability that is needed and not supported is reported with an explicit degradation (or blocks the plan), never hidden.
// The protected-product capabilities are always required: the real pixels are authoritative, the composite and the text are deterministic.

export const RECOVERY_ACTION = Object.freeze({ REFINE: 'REFINE', RECOMPOSE: 'RECOMPOSE', RECONCEPT: 'RECONCEPT' });

const ALWAYS = [
  [CAPABILITY.LOCAL_SEGMENTATION, 'the real product pixels are authoritative and are cut out locally'],
  [CAPABILITY.PRODUCT_CUTOUT, 'the product is placed as its own pixels, never regenerated'],
  [CAPABILITY.DETERMINISTIC_PRODUCT_COMPOSITE, 'the real product is composited deterministically over the generated scene'],
  [CAPABILITY.DETERMINISTIC_TEXT, 'the approved texts are typeset deterministically with the real fonts'],
];

/**
 * @param {object} input { artDirection, scene, composition, recovery? } recovery: the recovery decision when this is a revision ({ action })
 * @returns the production plan: required capabilities with their reasons, those not needed, those unsupported (with a degradation) and whether the plan is executable today
 */
export function planProduction({ artDirection, scene, composition, recovery = null, registry = TOOL_REGISTRY }) {
  const required = ALWAYS.map(([capability, reason]) => ({ capability, reason }));
  const richScene = scene.layers.length > 1 || [DEPTH_MODEL.LAYERED_DEPTH, DEPTH_MODEL.DEEP_SPACE].includes(artDirection.depth_model);
  required.push(richScene
    ? { capability: CAPABILITY.RICH_SCENE_GENERATION, reason: 'the concept calls for layers, narrative or secondary elements, or a deep scene, around a reserved calm zone' }
    : { capability: CAPABILITY.ENVIRONMENT_GENERATION, reason: 'the concept needs a surface and a backdrop only' });
  if (artDirection.product_relationship !== PRODUCT_RELATIONSHIP.ADJACENT_TO_SCENE) required.push({ capability: CAPABILITY.SHADOW_CONTACT_INTEGRATION, reason: 'the product must belong to the scene: contact and shadow agree with the light' });
  if (recovery?.action === RECOVERY_ACTION.REFINE) required.push({ capability: CAPABILITY.LOCAL_REFINEMENT, reason: 'the concept stands and only the execution needs local improvement' });
  const wanted = new Set(required.map((r) => r.capability));
  const notNeeded = Object.values(CAPABILITY).filter((c) => !wanted.has(c)).map((capability) => ({
    capability,
    reason: capability === CAPABILITY.MULTI_REFERENCE_COMPOSITION ? 'a reference image would carry product pixels to a provider, and the composite is deterministic'
      : (capability === CAPABILITY.SELECTIVE_EDITING ? 'nothing in the scene needs an edit after generation' : 'not needed by this art direction'),
  }));
  const unsupported = required.filter((r) => registry[r.capability]?.status !== 'SUPPORTED').map((r) => ({
    capability: r.capability,
    reason: registry[r.capability].note,
    degradation: r.capability === CAPABILITY.LOCAL_REFINEMENT ? 'REGENERATE_THE_SCENE_ONLY_WITH_THE_SAME_CONCEPT_AND_COMPOSITION' : 'NONE_AVAILABLE',
  }));
  const blocking = unsupported.filter((u) => u.degradation === 'NONE_AVAILABLE');
  const body = {
    concept_id: artDirection.concept_id,
    art_direction_id: artDirection.art_direction_id,
    composition_id: composition.composition_id,
    required,
    not_needed: notNeeded,
    unsupported,
    executable: blocking.length === 0,
    degradations: unsupported.filter((u) => u.degradation !== 'NONE_AVAILABLE').map((u) => u.degradation),
  };
  return deepFreeze({ production_plan_id: deriveId('ppl', body), ...body });
}

/** A plan that is not executable cannot be produced: the refusal names the missing capabilities. */
export function assertExecutable(plan) {
  if (!plan.executable) fail(BRAIN_ERROR.RULE_VIOLATION, 'the production plan needs a capability that no tool provides today', 'production_plan', { problem: 'CAPABILITY_UNSUPPORTED', capabilities: plan.unsupported.filter((u) => u.degradation === 'NONE_AVAILABLE').map((u) => u.capability) });
  return plan;
}

/** The adapter-level tool assignment of a plan (the only view that names a tool). */
export function resolveTools(plan) {
  return plan.required.map((r) => ({ capability: r.capability, ...TOOL_REGISTRY[r.capability] }));
}
