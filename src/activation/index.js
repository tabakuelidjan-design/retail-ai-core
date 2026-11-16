// Activation & Channel Execution V1: the public surface.
//
//   ActivationManifest (READY_FOR_POLICY) + SocleExecutionAuthorization (given) + ChannelExecutionOrder
//     -> Channel Capability Gate -> live preflight -> durable outbox job -> provider adapter (Instagram | TikTok | Google Business Profile)
//     -> status follow-up -> ChannelPublicationReceipt -> the existing M4 MarketingExecutionReceipt
//
// MARKETING PREPARES · SOCLE / POLICY / HUMAN AUTHORIZES · THIS LAYER EXECUTES · M4 OBSERVES AND LEARNS.
// No decision logic lives here, no token is stored, no media or copy is created or changed.

export * from './constants.js';
export {
  seal, SealedSecret, redact, findSecretLeaks, assertNoSecrets,
} from './validation.js';
export { CHANNEL_CAPABILITIES, getChannelCapability, assessCapabilityFit } from './capability-registry.js';
export {
  normalizeChannelConnector, selectChannelConnector, buildChannelConnectionView, normalizeScopes,
} from './connection-view.js';
export {
  CredentialError, createInMemoryCredentialProvider, requireCredentialProvider, resolveChannelCredential,
} from './credential-provider.js';
export {
  MediaTransportError, createInMemoryMediaTransport, resolveMediaTransport, describeMediaTransport,
} from './media-transport.js';
export { buildChannelExecutionOrder, normalizeChannelExecutionOrder } from './execution-order.js';
export { normalizeProviderOptions } from './provider-options.js';
export { evaluateChannelExecutionPreflight, evaluateOrderGate, evaluateDelivery } from './execution-preflight.js';
export {
  idempotencyKeyOf, requestFingerprintOf, planChannelExecutionJobs, assertTransition, decideRetry, isTerminalState,
} from './execution-job.js';
export { createChannelExecutionRepository } from './execution-repository.js';
export { createChannelExecutor, runChannelExecutionWorker } from './executor.js';
export { buildChannelPublicationReceipt } from './publication-receipt.js';
export { buildMarketingExecutionReceiptFromPublications } from './m4-adapter.js';
export { verifyChannelConnection } from './verify-connection.js';
export { assessActivationProductionReadiness } from './production-readiness.js';
export { createFetchHttp, callProvider, parseRetryAfter } from './providers/http.js';
export { createInstagramAdapter } from './providers/instagram.js';
export { createTikTokAdapter } from './providers/tiktok.js';
export { createGoogleBusinessProfileAdapter } from './providers/google-business-profile.js';
