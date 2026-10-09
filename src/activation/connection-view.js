// Connection Center CONTRACT (no UI): the secret-free view of a connected channel account, built on merchant_connectors (ADR 0003).
//
// No second table of social connections: a connector is a `merchant_connectors` row whose `kind` is the provider id and whose
// `external_id` is the stable account / location id. The activation layer REQUIRES that external_id and NEVER picks an account or a
// location by itself (first account, first location...). A token is never read from, nor written to, the config.

import { findSecretPaths, validateConnectorConfig } from '../tenant/connectors.js';
import { ACT_ERROR as E, CHANNEL_PROVIDERS } from './constants.js';
import { getChannelCapability } from './capability-registry.js';
import {
  deepFreeze, enumValue, fail, isPlainObject, optionalIso, sortedUnique, uuid,
} from './validation.js';

const STATES = ['CONFIGURED', 'NOT_CONFIGURED', 'MISCONFIGURED', 'UNAVAILABLE'];
const SCOPE = /^[A-Za-z0-9_.:/-]{2,200}$/;

export function normalizeScopes(value, field = 'granted_scopes') {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 50) fail(E.INVALID_FIELD, `${field} must be an array of scopes`, { field });
  return sortedUnique(value.map((scope, i) => {
    if (typeof scope !== 'string' || !SCOPE.test(scope.trim())) fail(E.INVALID_FIELD, `${field}[${i}] is not a valid scope`, { field });
    return scope.trim();
  }));
}

/**
 * A stored connector (the shape returned by the connector repository) validated for the activation layer.
 * @returns {{connector_id, merchant_id, provider, external_id, status, config}} frozen
 */
export function normalizeChannelConnector(connector, { merchantId } = {}) {
  if (!isPlainObject(connector)) fail(E.INVALID_FIELD, 'connector must be an object', { field: 'connector' });
  if (!CHANNEL_PROVIDERS.includes(connector.kind)) fail(E.CONNECTOR_KIND_UNSUPPORTED, 'this connector kind is not a supported channel provider', { kind: String(connector.kind).slice(0, 40) });
  const connectorId = uuid(connector.id, 'connector.id');
  if (merchantId !== undefined && String(connector.merchantId).toLowerCase() !== String(merchantId).toLowerCase()) {
    fail(E.CONNECTOR_MERCHANT_MISMATCH, 'the connector belongs to another merchant');
  }
  const externalId = connector.externalId;
  if (typeof externalId !== 'string' || !externalId.trim() || externalId !== externalId.trim() || externalId.length > 512) {
    fail(E.CONNECTOR_EXTERNAL_ID_REQUIRED, `a ${connector.kind} connector needs a stable external_id (account / location); none is ever picked automatically`);
  }
  const status = enumValue(connector.status, STATES, 'connector.status');
  const config = validateConnectorConfig(connector.config ?? {}); // refuses any secret-looking key or value
  return deepFreeze({
    connector_id: connectorId, merchant_id: uuid(connector.merchantId, 'connector.merchantId'), provider: connector.kind, external_id: externalId, status, config,
  });
}

/** The connector explicitly designated by id among a merchant's connectors. Never "the first one", never a guess. */
export function selectChannelConnector(connectors, { merchantId, connectorId }) {
  if (!Array.isArray(connectors)) fail(E.CONNECTOR_NOT_FOUND, 'no connector list was supplied');
  const id = uuid(connectorId, 'connector_id');
  const matches = connectors.filter((c) => String(c?.id).toLowerCase() === id);
  if (matches.length === 0) fail(E.CONNECTOR_NOT_FOUND, 'the designated connector does not exist', { connector_id: id });
  if (matches.length > 1) fail(E.CONNECTOR_AMBIGUOUS, 'the designated connector id is not unique');
  return normalizeChannelConnector(matches[0], { merchantId });
}

/**
 * The non-secret view of a connection. `runtime` carries what only a live check knows (UNAVAILABLE is runtime-only and never stored).
 * @param {object} p { connector: normalized connector, runtime?: { status?, account_state?, granted_scopes?, external_display_name?, last_verified_at? } }
 */
export function buildChannelConnectionView({ connector, runtime = {} }) {
  const capability = getChannelCapability(connector.provider);
  const granted = normalizeScopes(runtime.granted_scopes ?? connector.config.granted_scopes);
  const signals = [];
  if (capability.required_scopes.some((scope) => !granted.includes(scope))) signals.push('SCOPES_MISSING');
  const accountState = runtime.account_state ?? connector.config.account_state ?? null;
  if (accountState == null) signals.push('ACCOUNT_STATE_UNKNOWN');
  if (connector.status !== 'CONFIGURED') signals.push('CONNECTOR_NOT_CONFIGURED');
  const view = {
    connector_id: connector.connector_id,
    merchant_id: connector.merchant_id,
    provider: connector.provider,
    external_id: connector.external_id,
    external_display_name: runtime.external_display_name ?? null,
    status: runtime.status ? enumValue(runtime.status, STATES, 'runtime.status') : connector.status,
    capabilities: capability,
    granted_scopes: granted,
    account_state: accountState,
    last_verified_at: optionalIso(runtime.last_verified_at, 'runtime.last_verified_at'),
    review_signals: sortedUnique(signals),
  };
  if (findSecretPaths(view).length) fail(E.SECRET_LEAK, 'a connection view is secret-free by construction');
  return deepFreeze(view);
}
