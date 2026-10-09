// Wiring of Provider Provisioning: builds the whole service graph from injected dependencies (a Supabase client, a fetch, the environment).
// No global state, no network at construction time, nothing secret in the returned object (credentials live behind the stores).

import { createConnectorRepository } from '../tenant/connectors.js';
import { createActivationCredentialProvider } from './activation-compat.js';
import { createConnectionCenterService } from './connection-center.js';
import { createVaultCredentialStore, createVaultSessionSecretStore } from './vault-credential-store.js';
import { createOAuthHttp } from './oauth-http.js';
import { createOAuthSessionRepository } from './oauth-session.js';
import { createProviderProvisioningService } from './provisioning-service.js';
import { createProviderTokenManager } from './token-manager.js';
import { createGoogleBusinessOAuth } from './providers/google-business-oauth.js';
import { createInstagramOAuth } from './providers/instagram-oauth.js';
import { createTikTokOAuth } from './providers/tiktok-oauth.js';
import { loadProviderAppConfig } from './providers/common.js';
import { PROVIDER } from './constants.js';

/**
 * @param {object} deps { supabase, fetch?, http?, env?, clock?, rng?, logger?, credentialStore?, sessionSecrets?, timeoutMs?, returnToAllowlist? }
 *   `credentialStore` / `sessionSecrets` default to the Supabase Vault adapters; tests inject the in-memory fakes.
 */
export function createProviderConnectionsRuntime({
  supabase, fetch: fetchFn, http = fetchFn ? createOAuthHttp({ fetch: fetchFn }) : undefined, env = process.env, clock = Date.now, rng, logger = () => {}, timeoutMs,
  credentialStore = createVaultCredentialStore({ supabase }), sessionSecrets = createVaultSessionSecretStore({ supabase, clock }), returnToAllowlist,
}) {
  const oauthAdapters = {
    [PROVIDER.INSTAGRAM]: createInstagramOAuth({ http, timeoutMs, now: clock }),
    [PROVIDER.TIKTOK]: createTikTokOAuth({ http, timeoutMs, now: clock }),
    [PROVIDER.GOOGLE_BUSINESS_PROFILE]: createGoogleBusinessOAuth({ http, timeoutMs, now: clock }),
  };
  const appConfigFor = (provider) => loadProviderAppConfig(provider, env);
  const connectorRepository = createConnectorRepository({ supabase });
  const sessions = createOAuthSessionRepository({ supabase });
  const tokenManager = createProviderTokenManager({ store: credentialStore, oauthAdapters, appConfigFor, clock, logger });
  const provisioning = createProviderProvisioningService({
    sessions, sessionSecrets, credentialStore, tokenManager, oauthAdapters, appConfigFor, connectorRepository, clock, rng, logger, returnToAllowlist,
  });
  const appConfigPresent = (provider) => { try { appConfigFor(provider); return true; } catch { return false; } };
  const connectionCenter = createConnectionCenterService({ provisioning, connectorRepository, credentialStore, appConfigPresent, clock });
  const activationCredentialProvider = createActivationCredentialProvider({ tokenManager });
  return {
    oauthAdapters, appConfigFor, appConfigPresent, connectorRepository, sessions, sessionSecrets, credentialStore, tokenManager, provisioning, connectionCenter, activationCredentialProvider,
  };
}
