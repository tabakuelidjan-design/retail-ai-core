// Marketing M3 - CREATE: the public surface.
//
//   MarketingPushProposal + SocleCreateAuthorization + READY Brand Context
//     -> CreativeBrief -> CreativeHandoffPackage -> [Creative Intelligence: EXTERNAL / DEFERRED]
//     -> SelectedCreativeCandidate (contract) -> [Creative Fidelity result via the Guardian external gate]
//     -> Brand Guardian (existing) -> CreativeValidationReport -> ActivationManifest -> [Socle / policy / execution: OUTSIDE M3]
//
// M3 prepares and governs; it generates nothing, selects no model or provider, publishes nothing, schedules nothing and
// exposes no way to approve, override the Guardian, force or publish anyway. The CLI (src/marketing/index.js), the
// experimental providers (src/marketing-creative/*), Creative Fidelity and Branding are not touched by M3.

export * from './m3-constants.js';
export { normalizeSocleCreateAuthorization } from './create-authorization.js';
export { evaluateCreateGate } from './create-gate.js';
export { buildCreativeBrief, normalizeCreativeBrief, evaluateBriefReadiness } from './creative-brief.js';
export { buildCreativeHandoff } from './creative-handoff.js';
export { normalizeSelectedCreativeCandidate } from './creative-candidate.js';
export { buildCreativeValidationReport } from './creative-validation.js';
export { buildActivationManifest, normalizeActivationManifest, evaluateActivationReadiness } from './activation-manifest.js';
