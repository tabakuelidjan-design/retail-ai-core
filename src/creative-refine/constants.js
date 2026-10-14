// CREATIVE REFINE (Phase 4): executable, smallest-scope repair of a layered creative. Closed vocabularies and declared policy. Nothing here calls a provider.
// Priority principle (as in Phase 3): a blocked, explicit, auditable result is preferable to a visually plausible but unverified one. A repair that cannot be proved to stay inside its scope is REJECTED and the
// original candidate is kept.

export const SCHEMA = Object.freeze({ artifact: 'layered-artifact@1', plan: 'repair-plan@1', result: 'repair-result@1', map: 'layer-dependency-map@1', memory: 'refine-memory@1', maskedEdit: 'masked-edit-request@1' });

/** What a repair does. There is NO scope that regenerates the whole creative, the concept, the art direction or the product. */
export const REPAIR_SCOPE = Object.freeze({
  PROP_REPAIR: 'PROP_REPAIR', // replace ONE generated prop (a new candidate of that layer only)
  PLATE_REPAIR: 'PLATE_REPAIR', // rebuild ONLY the generated background plate
  TYPOGRAPHY_REPAIR: 'TYPOGRAPHY_REPAIR', // redraw the deterministic text style only (the text itself is locked)
  COMPOSITE_REPAIR: 'COMPOSITE_REPAIR', // recompute only the compositing, from valid layers
  LAYER_REMOVE_OR_REPOSITION: 'LAYER_REMOVE_OR_REPOSITION', // remove one prop, or move it to another declared anchor
});
export const REPAIR_SCOPES = Object.freeze(Object.values(REPAIR_SCOPE));

/** What a defect is, as the repair understands it. */
export const DEFECT_KIND = Object.freeze({
  PROP_UNUSABLE: 'PROP_UNUSABLE', // a generated prop is not acceptable (matte, size, look)
  PROP_RESEMBLES_THE_PRODUCT: 'PROP_RESEMBLES_THE_PRODUCT', // the identity gate counts a prop as a second product
  PROP_OVERLAP: 'PROP_OVERLAP', // a prop covers what it may not
  PROP_NO_ROOM: 'PROP_NO_ROOM', // a prop has no legal place
  PLATE_UNSUITABLE: 'PLATE_UNSUITABLE', // the background plate is not acceptable (busy zone, not opaque, wrong size)
  TEXT_ILLEGIBLE: 'TEXT_ILLEGIBLE', // the planned text does not read on what is behind it
  COMPOSITION_REFUSED: 'COMPOSITION_REFUSED', // the compositor refused the stack
  COMPOSITE_STALE: 'COMPOSITE_STALE', // the composite no longer matches its layers
  PRODUCT_PIXELS: 'PRODUCT_PIXELS', // a change to the real product pixels was asked for: never allowed
  COPY_CHANGE: 'COPY_CHANGE', // a change to locked copy was asked for: never allowed
  LOCAL_PIXEL_DEFECT: 'LOCAL_PIXEL_DEFECT', // a local pixel defect that only a masked edit could fix
  UPSTREAM_CONCEPT: 'UPSTREAM_CONCEPT', // the concept / art direction is the problem: a replan, not a refine
  UPSTREAM_LAYOUT: 'UPSTREAM_LAYOUT', // the layout / composition intent is the problem: a replan, not a refine
  REQUIRES_PHASE_5: 'REQUIRES_PHASE_5', // relight, contact shadow, grading: not available in Phase 4
});
export const DEFECT_KINDS = Object.freeze(Object.values(DEFECT_KIND));
export const DEFECT_SOURCE = Object.freeze({ GATE: 'GATE', CRITIQUE: 'CRITIQUE', MEASUREMENT: 'MEASUREMENT', OWNER_REGION: 'OWNER_REGION' });

/** Why a repair is refused (every refusal names what to do instead). */
export const REPAIR_BLOCK = Object.freeze({
  NO_DEFECT: 'NO_DEFECT',
  DEFECT_INVALID: 'DEFECT_INVALID',
  ARTIFACT_INVALID: 'ARTIFACT_INVALID',
  NO_ARTIFACT_TO_REPAIR: 'NO_ARTIFACT_TO_REPAIR', // the run produced no image at all
  FIDELITY_NOT_MEASURABLE: 'FIDELITY_NOT_MEASURABLE', // an image exists but the hard fidelity gate could not measure it, and the caller did not accept that
  ARTIFACT_STALE: 'ARTIFACT_STALE',
  DEFECT_NOT_ATTRIBUTABLE: 'DEFECT_NOT_ATTRIBUTABLE',
  REPAIR_SCOPE_INVALID: 'REPAIR_SCOPE_INVALID',
  REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS: 'REPAIR_TOUCHES_PROTECTED_PRODUCT_PIXELS',
  REPAIR_WOULD_CHANGE_LOCKED_COPY: 'REPAIR_WOULD_CHANGE_LOCKED_COPY',
  DEFECT_IS_UPSTREAM: 'DEFECT_IS_UPSTREAM',
  REPAIR_SCOPE_TOO_BROAD: 'REPAIR_SCOPE_TOO_BROAD',
  NEEDS_A_MASKED_EDIT_PROVIDER: 'NEEDS_A_MASKED_EDIT_PROVIDER',
  NOT_AVAILABLE_IN_THIS_PHASE: 'NOT_AVAILABLE_IN_THIS_PHASE',
  LAYER_CANNOT_BE_DROPPED: 'LAYER_CANNOT_BE_DROPPED',
  TOOL_SWITCH_REFUSED: 'TOOL_SWITCH_REFUSED',
  REPAIR_OUTSIDE_ITS_SCOPE: 'REPAIR_OUTSIDE_ITS_SCOPE',
  REPEATED_FAILED_REPAIR: 'REPEATED_FAILED_REPAIR',
  REFINE_ATTEMPTS_EXHAUSTED: 'REFINE_ATTEMPTS_EXHAUSTED',
  REPAIRED_CANDIDATE_REFUSED: 'REPAIRED_CANDIDATE_REFUSED',
  REPAIR_HAD_NO_EFFECT: 'REPAIR_HAD_NO_EFFECT',
  SCENE_DOES_NOT_MATCH_THE_ARTIFACT: 'SCENE_DOES_NOT_MATCH_THE_ARTIFACT',
});

/** Declared policy of the repair. Quality is not traded for cost, and no repair is a regeneration. */
export const REFINE_POLICY = Object.freeze({
  repair_candidates_per_layer: 2, // new candidates a repair may pay for, per regenerated layer
  max_regenerated_layers: 2, // and always STRICTLY fewer than the generated layers of the scene (all of them is a regeneration)
  max_attempts_per_scene: 3, // working memory: after this many repairs the scene is replanned
  allow_drop_of_a_prop: true, // a prop may be removed when the plan does not need it
});

/** The nodes that are never invalidated by a layer-level defect: the reasoning upstream of the layers. */
export const UPSTREAM_NODES = Object.freeze(['CONCEPT', 'ART_DIRECTION', 'ASSET_PLAN', 'PRODUCT_IDENTITY']);

export const MASKED_EDIT = Object.freeze({
  INTERFACE_READY: 'CAPABILITY_INTERFACE_READY',
  NOT_CONNECTED: 'PROVIDER_NOT_CONNECTED',
  CONNECTED: 'PROVIDER_CONNECTED',
});
export const MASKED_EDIT_OUTPUT_CLASS = Object.freeze({ PROP_LAYER: 'PROP_LAYER', PLATE: 'PLATE', REGION_PATCH: 'REGION_PATCH' });
export const MASKED_EDIT_BLOCK = Object.freeze({
  PROVIDER_NOT_CONNECTED: 'PROVIDER_NOT_CONNECTED',
  REQUEST_INVALID: 'REQUEST_INVALID',
  MASK_TOUCHES_A_PROTECTED_REGION: 'MASK_TOUCHES_A_PROTECTED_REGION',
  OUTPUT_CHANGED_A_PROTECTED_REGION: 'OUTPUT_CHANGED_A_PROTECTED_REGION',
  OUTPUT_CLASS_NOT_ALLOWED: 'OUTPUT_CLASS_NOT_ALLOWED',
  PROVIDER_GATE_NOT_OPEN: 'PROVIDER_GATE_NOT_OPEN',
});
