// THE END-TO-END CREATIVE RUN: states, stages, the dependency map used for resume and failure propagation. Opt-in: nothing here is reached unless `runCreativeEndToEnd` is called by name; the single-image
// runtime and the layered runtime called directly are unchanged.

/** The final state of a run. No ambiguous "success": a run is READY only when every mandatory gate passed. */
export const E2E_STATE = Object.freeze({
  READY: 'READY', // every mandatory gate ran and passed; the asset still needs the owner's approval before use
  NEEDS_OWNER_REVIEW: 'NEEDS_OWNER_REVIEW', // a produced asset with a named warning the owner must look at
  BLOCKED: 'BLOCKED', // a deterministic stop with a named reason and replan (segmentation, matte, identity, placement, layer gate…)
  TECHNICAL_FAIL: 'TECHNICAL_FAIL', // an exception or an invariant of the run itself (never a content verdict)
  PROVIDER_NOT_CONNECTED: 'PROVIDER_NOT_CONNECTED', // the run needs a capability that has no provider (masked edit, a layer generator)
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED', // the run-level ceiling refused a reservation
});

/** The stages of a run, in order. Each ends in a checkpoint. */
export const STAGE = Object.freeze({
  REQUEST: 'REQUEST',
  ASSET: 'ASSET',
  SEGMENTATION: 'SEGMENTATION', // BEFORE any billable call: a product that cannot be cut out stops the run before the planning is paid for
  FORMAT_PLAN: 'FORMAT_PLAN',
  BRAIN_PLAN: 'BRAIN_PLAN',
  PRODUCTION_PLAN: 'PRODUCTION_PLAN',
  INTEGRATION: 'INTEGRATION', // the layered production of the scene with the integrated product, text, placement, optional contact shadow
  REFINE: 'REFINE',
  FINAL_GATES: 'FINAL_GATES',
});
export const STAGE_ORDER = Object.freeze([STAGE.REQUEST, STAGE.ASSET, STAGE.SEGMENTATION, STAGE.FORMAT_PLAN, STAGE.BRAIN_PLAN, STAGE.PRODUCTION_PLAN, STAGE.INTEGRATION, STAGE.REFINE, STAGE.FINAL_GATES]);

/**
 * What a stage invalidates when it is redone. A downstream failure never corrupts an upstream valid artifact; redoing a stage invalidates ONLY what depends on it. The product pixels (ASSET and what is cut from
 * them) are never invalidated by a layer or a refine failure.
 */
export const INVALIDATES = Object.freeze({
  [STAGE.REQUEST]: STAGE_ORDER.slice(1),
  [STAGE.ASSET]: [STAGE.SEGMENTATION, STAGE.PRODUCTION_PLAN, STAGE.INTEGRATION, STAGE.REFINE, STAGE.FINAL_GATES],
  [STAGE.SEGMENTATION]: [STAGE.PRODUCTION_PLAN, STAGE.INTEGRATION, STAGE.REFINE, STAGE.FINAL_GATES],
  [STAGE.FORMAT_PLAN]: [STAGE.BRAIN_PLAN, STAGE.PRODUCTION_PLAN, STAGE.INTEGRATION, STAGE.REFINE, STAGE.FINAL_GATES],
  [STAGE.BRAIN_PLAN]: [STAGE.PRODUCTION_PLAN, STAGE.INTEGRATION, STAGE.REFINE, STAGE.FINAL_GATES],
  [STAGE.PRODUCTION_PLAN]: [STAGE.INTEGRATION, STAGE.REFINE, STAGE.FINAL_GATES],
  [STAGE.INTEGRATION]: [STAGE.REFINE, STAGE.FINAL_GATES],
  [STAGE.REFINE]: [STAGE.FINAL_GATES],
  [STAGE.FINAL_GATES]: [],
});

/** The kinds of operation that cost money or leave the process; each gets a unique operation id before it starts. */
export const OPERATION = Object.freeze({
  BRAIN_TEXT: 'BRAIN_TEXT',
  ASSET_DIRECTOR_TEXT: 'ASSET_DIRECTOR_TEXT',
  IMAGE_GENERATION: 'IMAGE_GENERATION',
  SEGMENTATION_PROVIDER: 'SEGMENTATION_PROVIDER',
  MASKED_EDIT: 'MASKED_EDIT',
  VISION_CRITIC: 'VISION_CRITIC',
  UPSCALE: 'UPSCALE',
  LOCAL: 'LOCAL', // a deterministic local step that is traced (no money)
});
export const PAID_OPERATIONS = Object.freeze([OPERATION.BRAIN_TEXT, OPERATION.ASSET_DIRECTOR_TEXT, OPERATION.IMAGE_GENERATION, OPERATION.SEGMENTATION_PROVIDER, OPERATION.MASKED_EDIT, OPERATION.VISION_CRITIC, OPERATION.UPSCALE]);

/** The gates of the final stage and what they are today. */
export const GATE_STATUS = Object.freeze({ EXECUTABLE_NOW: 'EXECUTABLE_NOW', PROVIDER_REQUIRED: 'PROVIDER_REQUIRED', ARCHITECTURE_ONLY: 'ARCHITECTURE_ONLY' });

export const E2E_BLOCK = Object.freeze({
  REQUEST_INVALID: 'REQUEST_INVALID',
  PLANNING_NOT_PLANNED: 'PLANNING_NOT_PLANNED',
  PRODUCTION_NOT_SPECIFIED: 'PRODUCTION_NOT_SPECIFIED',
  LAYER_PORT_NOT_CONNECTED: 'LAYER_PORT_NOT_CONNECTED',
  SEGMENTATION_STOP: 'SEGMENTATION_STOP',
  LAYERED_STOP: 'LAYERED_STOP',
  INTEGRATION_STOP: 'INTEGRATION_STOP',
  MASKED_EDIT_NOT_CONNECTED: 'MASKED_EDIT_NOT_CONNECTED',
  REFINE_REJECTED: 'REFINE_REJECTED',
  A_MANDATORY_GATE_DID_NOT_RUN: 'A_MANDATORY_GATE_DID_NOT_RUN',
  A_MANDATORY_GATE_FAILED: 'A_MANDATORY_GATE_FAILED',
  PRODUCT_COPY_CONFLICT: 'PRODUCT_COPY_CONFLICT',
  CLAIM_NOT_PLACED: 'CLAIM_NOT_PLACED',
  CLAIM_ALTERED: 'CLAIM_ALTERED',
  CLAIM_POLICY_INVALID: 'CLAIM_POLICY_INVALID',
});

export const ANALYSIS_MAX_PX = 1000; // the real product asset is analysed and composed at most at this longest edge (a provenance-recorded downscale of the owner's file)
export const DEFAULT_LIGHT = Object.freeze({ angle_deg: 120, elevation_deg: 40, softness: 0.5 });
export const RUN_UNIT_COSTS = Object.freeze({ text_stage_eur: 0.03, vision_critic_eur: 0.01, segmentation_provider_eur: 0.02, masked_edit_eur: 0.05 });
