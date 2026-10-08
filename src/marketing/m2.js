// Marketing M2 - BUILD: the public surface.
//
//   READY_FOR_BUILD Finding -> LeverFitness + AudienceIntent + ResourceRequirements + lead-time fit + MeasurementPlan
//   -> MarketingPushProposal[] -> SocleDecisionPackage -> (the Socle decides)
//
// M2 only PROPOSES. It exposes no way to approve, rank, select, recommend, execute, budget, publish, send, buy ads,
// change a price or a stock level. The CLI (src/marketing/index.js) and the Measurement builder (src/marketing/build.js)
// are deliberately not re-exported from here.

export * from './m2-constants.js';
export { assessLeverFitness, normalizeLeverFitness } from './lever-fitness.js';
export {
  buildResourceRequirements, buildEstimatedLeadTime, buildExecutionWindow, evaluateLeadTimeFit,
} from './resource-requirements.js';
export { buildMeasurementPlan, buildReversibility } from './measurement-plan.js';
export {
  buildAudienceIntent, buildMarketingPushProposal, normalizeMarketingPushProposal, evaluatePushReadiness,
} from './push-proposal.js';
export { buildSocleDecisionPackage, evaluatePackageStatus } from './socle-decision-package.js';
