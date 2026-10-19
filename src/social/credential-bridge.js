// Bridge between Social Publishing's credential PORT and the platform's existing Provider / Credentials interfaces (src/activation):
//
//   E's port            resolve(platform) -> { access_token, account_id, expires_at } | null        describe(platform) -> secret-free view
//   platform's side     merchant_connectors row (kind = provider id, external_id = the account)  +  ChannelCredentialProvider.resolve({ merchant_id, connector_id, provider, purpose })
//
// Rules inherited from the platform layer, unchanged: the connector is designated BY ID (never "the first one"), its external_id is the account, no token is ever read from the
// connector config, a credential is resolved in memory for one call, and nothing about a secret appears in a view or an error. Instagram only: the platform has no Facebook Page
// provider kind yet, so Facebook is reported NOT_CONFIGURED (honest), not guessed. Nothing here calls a network: it only asks the injected providers.
import { CHANNEL_PROVIDER } from '../activation/constants.js';
import { CredentialError, resolveChannelCredential } from '../activation/credential-provider.js';
import { selectChannelConnector } from '../activation/connection-view.js';

const PROVIDER_OF = Object.freeze({ instagram: CHANNEL_PROVIDER.INSTAGRAM });
export const CREDENTIAL_PURPOSE = 'social_publishing';

/**
 * @param {{ credentialProvider, connectors: object[], merchantId: string, connectorIds: Record<string,string>, now?: ()=>number }} deps
 *   connectorIds: { instagram: '<connector uuid>' } - the connector the owner designated for each platform.
 */
export function createChannelCredentialBridge({
  credentialProvider, connectors, merchantId, connectorIds = {}, now = () => Date.now(),
}) {
  const lastError = new Map(); // platform -> credential error code of the last resolve (a code, never a secret)
  const connectorOf = (platform) => {
    if (!PROVIDER_OF[platform] || !connectorIds[platform]) return null;
    try { return selectChannelConnector(connectors, { merchantId, connectorId: connectorIds[platform] }); } catch { return null; }
  };
  return {
    async resolve(platform) {
      const connector = connectorOf(platform);
      if (!connector || connector.status !== 'CONFIGURED') return null;
      try {
        const c = await resolveChannelCredential(credentialProvider, {
          merchantId, connectorId: connector.connector_id, provider: connector.provider, purpose: CREDENTIAL_PURPOSE, asOf: new Date(now()).toISOString(),
        });
        lastError.delete(platform);
        return { access_token: c.access_token.reveal(), account_id: connector.external_id, expires_at: c.expires_at };
      } catch (e) {
        lastError.set(platform, e instanceof CredentialError ? e.code : 'CREDENTIAL_UNAVAILABLE');
        return null;
      }
    },
    /** Names, states and dates only. */
    describe(platform) {
      const connector = connectorOf(platform);
      const failure = lastError.get(platform) ?? null;
      const configured = Boolean(connector) && connector.status === 'CONFIGURED';
      return {
        platform, configured, account_id: connector?.external_id ?? null, expires_at: null,
        state: !configured ? 'NOT_CONFIGURED' : failure === 'CREDENTIAL_EXPIRED' ? 'EXPIRED' : failure ? 'UNAVAILABLE' : 'OK',
        days_left: null, env_names: [], source: 'provider-connections', credential_error: failure,
      };
    },
  };
}
