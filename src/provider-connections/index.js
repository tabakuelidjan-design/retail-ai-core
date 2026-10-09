// Provider Provisioning & Live Connections V1: the public surface.
//
//   Connection Center -> OAuth authorization request -> merchant consent AT THE PROVIDER -> secure callback -> server-side code exchange
//   -> credential vault -> account / location discovery -> EXPLICIT selection -> merchant_connectors binding -> scope / account verification
//   -> ChannelConnectionView -> readiness -> Activation & Channel Execution V1 (unchanged; fed through ChannelCredentialProvider).
//
// Provisioning publishes, edits and deletes nothing at a provider, and stores no secret in plaintext.

export * from './constants.js';
export { seal, SealedSecret, redact, findSecretLeaks, assertNoSecrets, safeReturnTo } from './validation.js';
export {
  makeTokenBundle, serializeBundle, parseBundle, createInMemoryCredentialStore, createInMemorySessionSecretStore,
} from './credential-store.js';
export { createVaultCredentialStore, createVaultSessionSecretStore } from './vault-credential-store.js';
export { buildOAuthSession, createOAuthSessionRepository } from './oauth-session.js';
export { createProviderTokenManager, decideCredential, CREDENTIAL_DECISION } from './token-manager.js';
export { createProviderProvisioningService } from './provisioning-service.js';
export { createConnectionCenterService } from './connection-center.js';
export { createActivationCredentialProvider } from './activation-compat.js';
export {
  assessLiveConnectionReadiness, assessProviderProvisioningReadiness, activationFactsFrom, assessActivationReadinessFromProvisioning,
} from './readiness.js';
export { createOAuthHttp } from './oauth-http.js';
export { createProviderConnectionsRuntime } from './runtime.js';
export { runCli, createCallbackServer } from './cli.js';
export { loadProviderAppConfig, OAuthFailure } from './providers/common.js';
export { createInstagramOAuth, INSTAGRAM_MINIMUM_SCOPES } from './providers/instagram-oauth.js';
export { createTikTokOAuth, TIKTOK_MINIMUM_SCOPES } from './providers/tiktok-oauth.js';
export { createGoogleBusinessOAuth, GOOGLE_MINIMUM_SCOPES } from './providers/google-business-oauth.js';
