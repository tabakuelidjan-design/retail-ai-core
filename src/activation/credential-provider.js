// ChannelCredentialProvider: the ONLY place a provider credential exists. Injectable boundary, production-compatible interface:
//
//   provider.resolve({ merchant_id, connector_id, provider, purpose }) -> { access_token, granted_scopes?, expires_at? }
//
// A credential is resolved in memory, for one call, and held in a SealedSecret (never printed, serialized, logged or persisted).
// It never goes in merchant_connectors.config, a job, a receipt or an error. V1 ships only an in-memory fake for tests:
// PRODUCTION_CREDENTIAL_STORE is an OPEN DEPENDENCY (no vault is invented here) and without a resolver real execution fails cleanly.

import { ACT_ERROR as E } from './constants.js';
import {
  deepFreeze, fail, isPlainObject, iso, seal, uuid,
} from './validation.js';
import { normalizeScopes } from './connection-view.js';

export class CredentialError extends Error {
  /** @param {'CREDENTIAL_NOT_FOUND'|'CREDENTIAL_UNAVAILABLE'|'CREDENTIAL_EXPIRED'} code */
  constructor(code) { super(code); this.name = 'CredentialError'; this.code = code; }
}

/** In-memory fake: entries are keyed by `${merchant_id}:${connector_id}`. For tests / sandboxes only. */
export function createInMemoryCredentialProvider(entries = {}, { failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    async resolve(request) {
      calls.push({ merchant_id: request.merchant_id, connector_id: request.connector_id, provider: request.provider, purpose: request.purpose });
      if (failWith) throw new CredentialError(failWith);
      const entry = entries[`${request.merchant_id}:${request.connector_id}`];
      if (!entry) throw new CredentialError('CREDENTIAL_NOT_FOUND');
      return { access_token: entry.access_token, granted_scopes: entry.granted_scopes ?? [], expires_at: entry.expires_at ?? null };
    },
  };
}

export function requireCredentialProvider(credentialProvider) {
  if (!credentialProvider || typeof credentialProvider.resolve !== 'function') {
    fail(E.CREDENTIAL_PROVIDER_REQUIRED, 'real execution needs a ChannelCredentialProvider (PRODUCTION_CREDENTIAL_STORE is an open dependency)');
  }
  return credentialProvider;
}

/**
 * Resolves and validates a credential for one purpose. Returns { access_token: SealedSecret, granted_scopes[], expires_at } frozen.
 * Throws CredentialError(CREDENTIAL_NOT_FOUND | CREDENTIAL_EXPIRED | CREDENTIAL_UNAVAILABLE); nothing about the secret leaks into errors.
 */
export async function resolveChannelCredential(credentialProvider, {
  merchantId, connectorId, provider, purpose, asOf,
}) {
  requireCredentialProvider(credentialProvider);
  let raw;
  try {
    raw = await credentialProvider.resolve({
      merchant_id: uuid(merchantId, 'merchant_id'), connector_id: uuid(connectorId, 'connector_id'), provider, purpose,
    });
  } catch (error) {
    throw new CredentialError(error instanceof CredentialError ? error.code : 'CREDENTIAL_UNAVAILABLE');
  }
  if (!isPlainObject(raw) || typeof raw.access_token !== 'string' || !raw.access_token) throw new CredentialError('CREDENTIAL_NOT_FOUND');
  const expiresAt = raw.expires_at == null ? null : iso(raw.expires_at, 'credential.expires_at');
  if (expiresAt && asOf && Date.parse(expiresAt) <= Date.parse(asOf)) throw new CredentialError('CREDENTIAL_EXPIRED');
  return deepFreeze({ access_token: seal(raw.access_token), granted_scopes: normalizeScopes(raw.granted_scopes), expires_at: expiresAt });
}
