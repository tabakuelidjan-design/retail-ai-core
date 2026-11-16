// verifyChannelConnection: a live health check of one connected account, honouring ADR 0003.
//
//   CONFIGURED / MISCONFIGURED are PERSISTABLE results (the caller may update merchant_connectors.status);
//   UNAVAILABLE is RUNTIME-ONLY: a temporary outage is reported but never stored (`persist_status` is null).
//
// It reads and writes nothing itself: it returns the verdict and the secret-free view; the caller decides whether to persist.

import { buildChannelConnectionView, normalizeChannelConnector } from './connection-view.js';
import { CredentialError, resolveChannelCredential } from './credential-provider.js';
import { ActivationError } from './constants.js';
import { asOfIso, deepFreeze } from './validation.js';

/**
 * @param {object} p { connector (stored), adapter, credentialProvider, asOf }
 * @returns {Promise<{ status, persist_status, reason_codes, view }>}
 */
export async function verifyChannelConnection({
  connector: stored, adapter, credentialProvider, asOf,
}) {
  const connector = normalizeChannelConnector(stored);
  const now = asOfIso(asOf);
  const result = (status, persist, reasons, runtime = {}) => deepFreeze({
    status,
    persist_status: persist,
    reason_codes: reasons,
    view: buildChannelConnectionView({ connector, runtime: { ...runtime, status, last_verified_at: now } }),
  });
  let credential;
  try {
    credential = await resolveChannelCredential(credentialProvider, {
      merchantId: connector.merchant_id, connectorId: connector.connector_id, provider: connector.provider, purpose: 'VERIFY', asOf: now,
    });
  } catch (error) {
    if (error instanceof ActivationError) return result('MISCONFIGURED', 'MISCONFIGURED', [error.code]);
    if (error instanceof CredentialError && error.code === 'CREDENTIAL_UNAVAILABLE') return result('UNAVAILABLE', null, ['CREDENTIAL_PROVIDER_UNAVAILABLE']);
    return result('MISCONFIGURED', 'MISCONFIGURED', [error.code ?? 'CREDENTIAL_MISSING']);
  }
  try {
    const account = await adapter.verifyAccount({ connector, credential });
    const reasons = [];
    if (account.professional === false) reasons.push('ACCOUNT_NOT_PROFESSIONAL');
    if (account.id_matches === false) reasons.push('ACCOUNT_MISMATCH');
    const runtime = { account_state: account.account_state, granted_scopes: credential.granted_scopes, external_display_name: account.display_name ?? null };
    if (reasons.length) return result('MISCONFIGURED', 'MISCONFIGURED', reasons, runtime);
    return result('CONFIGURED', 'CONFIGURED', [], runtime);
  } catch (error) {
    const normalized = adapter.normalizeProviderError(error);
    if (normalized.retryable) return result('UNAVAILABLE', null, [`PROVIDER_${normalized.code}`]); // a transient outage is never persisted
    return result('MISCONFIGURED', 'MISCONFIGURED', [`PROVIDER_${normalized.code}`]);
  }
}
