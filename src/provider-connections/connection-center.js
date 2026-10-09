// ConnectionCenterService: the BACKEND of the Connection Center (no UI - a future open dependency). Everything the operator or a future
// front end needs, and nothing secret: every output is the secret-free ChannelConnectionView (the Activation view, reused - not a second one)
// decorated with the live connection state, or a plain description of a discovered target.
//
//   listConnections · startConnect · getConnectionStatus · listTargets · selectTarget · reconnect · disconnect · verify
//
// Several connectors of the same provider coexist (one per authorized account / location); none is ever picked implicitly.

import { buildChannelConnectionView, normalizeChannelConnector } from '../activation/connection-view.js';
import {
  CONNECTION_STATE as C, CREDENTIAL_STATUS, PROVIDERS,
} from './constants.js';
import { assessLiveConnectionReadiness } from './readiness.js';
import {
  deepFreeze, merchantOf, providerOf, sortedUnique,
} from './validation.js';

/** @param {{ provisioning, connectorRepository, credentialStore, appConfigPresent?: (provider) => boolean, clock?: () => number }} deps */
export function createConnectionCenterService({
  provisioning, connectorRepository, credentialStore, appConfigPresent = () => true, clock = Date.now,
}) {
  async function describe(merchantId, stored) {
    const credential = await credentialStore.readMetadata({ merchantId, connectorId: stored.id });
    const connector = normalizeChannelConnector(stored, { merchantId });
    const reauth = credential && credential.status !== CREDENTIAL_STATUS.ACTIVE && credential.status !== CREDENTIAL_STATUS.REVOKED;
    const connectionState = !credential || credential.status === CREDENTIAL_STATUS.REVOKED ? C.NOT_CONFIGURED : (reauth ? C.REAUTH_REQUIRED : stored.status);
    const view = buildChannelConnectionView({
      connector, runtime: { granted_scopes: credential?.scopes?.length ? credential.scopes : undefined, last_verified_at: stored.config.last_verified_at ?? undefined, external_display_name: stored.config.display_name ?? null },
    });
    return deepFreeze({
      ...view,
      connection_state: connectionState,
      grant: credential ? { status: credential.status, scopes: [...credential.scopes], expires_at: credential.expires_at, refreshable: credential.refreshable, rotation_version: credential.rotation_version } : null,
      review_signals: sortedUnique([...view.review_signals, ...(reauth ? ['REAUTH_REQUIRED'] : []), ...(!credential || credential.status === CREDENTIAL_STATUS.REVOKED ? ['NO_CREDENTIAL'] : [])]),
      live_readiness: assessLiveConnectionReadiness({
        provider: stored.kind, appConfigured: appConfigPresent(stored.kind), credential, connectorStatus: stored.status, verified: stored.status === C.CONFIGURED && !reauth,
      }),
    });
  }

  return {
    /** Every provider connector of the tenant, secret-free. */
    async listConnections({ tenant }) {
      const merchantId = merchantOf(tenant);
      const all = (await connectorRepository.listForMerchant(merchantId)).filter((c) => PROVIDERS.includes(c.kind));
      const out = [];
      for (const connector of all) out.push(await describe(merchantId, connector));
      return deepFreeze(out);
    },
    async getConnectionStatus({ tenant, connectorId }) {
      const merchantId = merchantOf(tenant);
      return describe(merchantId, await provisioning.connectorOf(merchantId, connectorId));
    },
    /** Provider choice -> the authorization URL to open (and the session reference to complete the flow). No secret. */
    startConnect({ tenant, provider, returnTo, actorRef }) {
      return provisioning.startConnection({ tenant, provider: providerOf(provider), returnTo, actorRef });
    },
    /** The accounts / locations the merchant authorized. Choosing one is mandatory (selectTarget). */
    async listTargets({ tenant, sessionRef }) {
      const targets = await provisioning.listAuthorizedTargets({ tenant, sessionRef });
      return deepFreeze({ selection_required: true, targets });
    },
    selectTarget({ tenant, sessionRef, externalId, actorRef }) { return provisioning.bindSelectedTarget({ tenant, sessionRef, externalId, actorRef }); },
    /** A new authorization for the same provider. Binding the same account re-uses its connector (rotation), another account is another connector. */
    async reconnect({ tenant, connectorId, returnTo, actorRef }) {
      const merchantId = merchantOf(tenant);
      const connector = await provisioning.connectorOf(merchantId, connectorId);
      return provisioning.startConnection({ tenant, provider: connector.kind, returnTo, actorRef });
    },
    disconnect({ tenant, connectorId }) { return provisioning.disconnectConnection({ tenant, connectorId }); },
    verify({ tenant, connectorId }) { return provisioning.verifyConnection({ tenant, connectorId }); },
    now: () => new Date(clock()).toISOString(),
  };
}
