// Creative Intelligence C1 - Foundation, DesignDocument, deterministic composer and preflight: the public surface.
//
//   CreativeBrief (Marketing, by reference) -> intake -> asset readiness -> product understanding -> creative direction
//     -> DesignDocument (scene graph) -> layout constraint engine -> typography -> deterministic SVG render
//     -> preflight (hard gates) -> CreativeCandidate -> hard-gate selection
//   THEN: Creative Fidelity -> Brand Guardian -> Activation (none of them here).
//
// No real image / video / LLM call, no publishing, no Brand Memory mutation, no provider is frozen into the architecture.

export * from './constants.js';
export {
  canonical, deriveId, deepFreeze, textDigest, sha256,
} from './validation.js';
export { normalizeCreativeIntake } from './intake.js';
export { normalizeOutputContext, normalizeCanvas, reducedAspectRatio, directionForLocale } from './output-context.js';
export {
  buildAssetReadinessReport, normalizeReuseLookupRequest, normalizeReuseLookupResult, MIN_USABLE_RATIO,
} from './asset-readiness.js';
export { normalizeProductUnderstanding, normalizeTransformationPolicy } from './product-understanding.js';
export { normalizeCreativeDirection, assertDistinctDirections } from './creative-direction.js';
export {
  normalizeLayer, normalizeConstraint, normalizeTextBasis, layerBounds, isCriticalLayer, MAX_LAYERS,
} from './layers.js';
export {
  normalizeDesignDocument, buildDesignDocument, reviseDesignDocument, layerAssetRefs,
} from './design-document.js';
export { LAYOUT_RECIPES, LAYOUT_RECIPE_IDS, getLayoutRecipe } from './layout-recipes.js';
export { solveLayout, computeUsableRect, evaluateConstraints } from './layout-engine.js';
export {
  createFontRegistry, normalizeFontMetrics, measureText, breakLines, layoutText, fitText, positionLines, lineAnchor, scriptsOf, SHAPING,
} from './typography.js';
export { renderDesignDocument, renderPng } from './renderer.js';
export { runCreativePreflight, contrastRatio, relativeLuminance } from './preflight.js';
export { normalizeQualityReport, notAssessedQualityReport } from './creative-quality.js';
export { normalizeCreativeCandidate, renderedAssetRefOf, assertPreflightReportShape } from './candidate.js';
export { selectCandidates, SELECTION_STATUS } from './selection.js';
export { createProviderRegistry, normalizeProviderEntry } from './provider-registry.js';
export {
  planCreativeRun, normalizeAgentOutput, defineCreativeAgent, createFakeAgent, AGENT_INTERFACE_VERSION,
} from './agents.js';
