// Marketing M1 - UNDERSTAND foundation: the public surface.
//
//   existing facts / domain-owned facts / MarketSignal[]  ->  MarketingContext  ->  Materiality  ->  Domain Fit
//   ->  MarketingFinding (+ embedded CandidateHypothesis[])  ->  readiness
//
// This module only DIAGNOSES. It exposes no way to publish, send, buy ads, change a price or a stock level, approve
// spend or execute anything, and it never emits a causal claim. CandidateHypothesis has no builder of its own: it
// exists only inside a Finding. The CLI (src/marketing/index.js) is deliberately not re-exported from here.

export * from './understand-constants.js';
export { buildMarketSignal, normalizeMarketSignal, isMarketSignalExpired, marketSignalFreshness } from './market-signal.js';
export { CONTEXT_VERSION, buildMarketingContext } from './marketing-context.js';
export { assessMateriality, normalizeMaterialityAssessment } from './materiality.js';
export { buildDomainFit } from './domain-fit.js';
export {
  buildMarketingFinding, normalizeMarketingFinding, findingFreshness, evaluateFindingReadiness,
} from './finding.js';
