// Marketing M4 - STEER: the public surface.
//
//   ActivationManifest + SocleExecutionAuthorization + MarketingExecutionReceipt (both produced ELSEWHERE) + original Push
//     -> MarketingRun -> RunEvidenceBundle -> MarketingRunResult
//           OBSERVED / ATTRIBUTED / OFFLINE_ATTRIBUTED / INCREMENTAL (only for an eligible HOLDOUT) - never a generic "causal"
//     -> MarketingLearning -> MarketingFollowUpProposal[] -> MarketingSteerPackage -> [Socle: OUTSIDE M4]
//
// M4 prepares and reports; it executes, publishes, schedules, scales, stops, re-budgets and rewrites nothing, connects to no
// ad / analytics / POS source, runs no statistics and mutates no M1 object. The CLI (src/marketing/index.js), the measurement
// modules, Branding and Creative Fidelity are not touched by M4.

export * from './m4-constants.js';
export { normalizeSocleExecutionAuthorization, normalizeMarketingExecutionReceipt } from './execution-receipt.js';
export { buildMarketingRun, normalizeMarketingRun } from './marketing-run.js';
export {
  buildOfflineAttributionObservation, buildRunEvidenceBundle, normalizeRunEvidenceBundle, deriveIncrementalityStatus,
} from './run-evidence.js';
export { buildMarketingRunResult, normalizeMarketingRunResult, evaluateMarketingRunResult } from './run-result.js';
export { buildMarketingLearning, normalizeMarketingLearning, evaluateLearningReuse } from './marketing-learning.js';
export {
  buildMarketingFollowUpProposal, normalizeMarketingFollowUpProposal, evaluateFollowUpReadiness, followUpAdmissible,
} from './follow-up-proposal.js';
export { buildMarketingSteerPackage, normalizeMarketingSteerPackage, evaluateSteerPackageStatus } from './steer-package.js';
