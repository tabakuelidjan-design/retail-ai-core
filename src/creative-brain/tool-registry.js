import { deepFreeze } from './validation.js';

// The ONLY place of the Creative Brain that knows which concrete tool realizes a capability, and whether it is available today. Everything above this module speaks of CAPABILITIES; providers are
// tools, and a provider never owns a creative direction. Changing a provider means changing this registry, not a concept, an art direction or a plan.
// Status: SUPPORTED (wired and verified in the runtime), UNSUPPORTED (no wired tool today), so a plan that needs it says so explicitly instead of pretending.

export const CAPABILITY = Object.freeze({
  LOCAL_SEGMENTATION: 'LOCAL_SEGMENTATION',
  PRODUCT_CUTOUT: 'PRODUCT_CUTOUT',
  ENVIRONMENT_GENERATION: 'ENVIRONMENT_GENERATION',
  RICH_SCENE_GENERATION: 'RICH_SCENE_GENERATION',
  MULTI_REFERENCE_COMPOSITION: 'MULTI_REFERENCE_COMPOSITION',
  SELECTIVE_EDITING: 'SELECTIVE_EDITING',
  DETERMINISTIC_TEXT: 'DETERMINISTIC_TEXT',
  DETERMINISTIC_PRODUCT_COMPOSITE: 'DETERMINISTIC_PRODUCT_COMPOSITE',
  SHADOW_CONTACT_INTEGRATION: 'SHADOW_CONTACT_INTEGRATION',
  LOCAL_REFINEMENT: 'LOCAL_REFINEMENT',
});

export const TOOL_REGISTRY = deepFreeze({
  LOCAL_SEGMENTATION: { status: 'SUPPORTED', executor: 'LOCAL', tool: 'local deterministic product mask', note: 'the mask follows the merchant outline and the rim of the real photograph' },
  PRODUCT_CUTOUT: { status: 'SUPPORTED', executor: 'LOCAL', tool: 'local deterministic cut-out', note: 'the cut-out holds the source pixels exactly' },
  ENVIRONMENT_GENERATION: { status: 'SUPPORTED', executor: 'PROVIDER', tool: 'qwen-image text-to-image on the Alibaba Model Studio lane', note: 'a text-only request: no product pixel reaches the provider' },
  RICH_SCENE_GENERATION: { status: 'SUPPORTED', executor: 'PROVIDER', tool: 'qwen-image text-to-image on the Alibaba Model Studio lane', note: 'the same text-only request with a richer scene description and a reserved calm zone' },
  MULTI_REFERENCE_COMPOSITION: { status: 'UNSUPPORTED', executor: 'PROVIDER', tool: null, note: 'no verified multi-reference tool on the lane; and a reference image would carry product pixels to a provider' },
  SELECTIVE_EDITING: { status: 'UNSUPPORTED', executor: 'PROVIDER', tool: null, note: 'an image-edit tool exists on the lane but is not wired into the runtime and must never touch the product pixels' },
  DETERMINISTIC_TEXT: { status: 'SUPPORTED', executor: 'LOCAL', tool: 'deterministic typography with the real fonts', note: 'approved texts only' },
  DETERMINISTIC_PRODUCT_COMPOSITE: { status: 'SUPPORTED', executor: 'LOCAL', tool: 'deterministic product-preserving composite', note: 'the real pixels over the generated scene' },
  SHADOW_CONTACT_INTEGRATION: { status: 'SUPPORTED', executor: 'LOCAL', tool: 'deterministic contact-shadow rule', note: 'a soft contact shadow from the darkest brand colour' },
  LOCAL_REFINEMENT: { status: 'UNSUPPORTED', executor: 'LOCAL', tool: null, note: 'no local refinement of a produced image is implemented' },
});

export const isSupported = (capability) => TOOL_REGISTRY[capability]?.status === 'SUPPORTED';
