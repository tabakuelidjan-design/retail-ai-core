// Activation compatibility: the production ChannelCredentialProvider.
//
// Activation V1 (src/activation, UNCHANGED) asks `credentialProvider.resolve({ merchant_id, connector_id, provider, purpose })` and seals the
// answer at once. This adapter answers from the Vault through the ProviderTokenManager: a token that is about to expire is refreshed first,
// a revoked / non-refreshable grant answers like a missing credential, a temporary failure like an unavailable store. Scopes and expiry flow
// to the Activation preflight through the same fields the in-memory fake already used.

import { CredentialError } from '../activation/credential-provider.js';
import { PC_ERROR as E, ProvisioningError } from './constants.js';

/** @param {{ tokenManager }} deps */
export function createActivationCredentialProvider({ tokenManager }) {
  return {
    kind: 'provider-connections',
    async resolve({
      merchant_id: merchantId, connector_id: connectorId, provider, purpose,
    }) {
      try {
        const { tokens } = await tokenManager.getValidCredential({ merchantId, connectorId, provider, purpose });
        return { access_token: tokens.access_token.reveal(), granted_scopes: [...tokens.scopes], expires_at: tokens.expires_at };
      } catch (error) {
        if (error instanceof ProvisioningError && [E.CREDENTIAL_NOT_FOUND, E.CREDENTIAL_REVOKED].includes(error.code)) throw new CredentialError('CREDENTIAL_NOT_FOUND');
        if (error instanceof ProvisioningError && error.code === E.REAUTH_REQUIRED) throw new CredentialError('CREDENTIAL_EXPIRED'); // the merchant must connect again
        throw new CredentialError('CREDENTIAL_UNAVAILABLE'); // vault / provider outage: temporary, never reported as misconfiguration
      }
    },
  };
}
