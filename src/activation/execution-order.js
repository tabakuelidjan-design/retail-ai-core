// ChannelExecutionOrder: the explicit instruction "execute THIS delivery of THIS approved ActivationManifest on THIS connected account".
//
// The order does not decide anything: the delivery -> connector mapping, the publish mode and the publish time are given (by the Socle /
// Policy / a human), the layer never picks an account, a time or a copy. It reuses the M4 SocleExecutionAuthorization (no second kind of
// authorization) and is bounded by everything that governs it. A stored order is a snapshot (`status_snapshot`), never a live authority:
// the live answer is the preflight.

import { normalizeSocleExecutionAuthorization } from '../marketing/execution-receipt.js';
import { verifiedManifest, verifiedPush } from '../marketing/m4-validation.js';
import { tenantMerchantId } from '../marketing/understand-validation.js';
import {
  ACT_ERROR as E, ACTIVATION_VERSION, CHANNEL_PROVIDERS, PUBLISH_MODE,
} from './constants.js';
import { assessCapabilityFit } from './capability-registry.js';
import { selectChannelConnector } from './connection-view.js';
import { normalizeProviderOptions } from './provider-options.js';
import {
  asOfIso, canonical, closedObject, deepFreeze, deriveId, enumValue, fail, iso, isPlainObject, optionalRef, ref, toMs,
} from './validation.js';

const OPTION_KEYS = ['tenant', 'push', 'activationManifest', 'authorization', 'connectors', 'deliveries', 'asOf', 'expires_at'];
const DELIVERY_INPUT_KEYS = ['manifest_delivery_ref', 'connector_id', 'provider', 'publish_mode', 'publish_at', 'provider_options', 'approval_ref'];
const ORDER_KEYS = [
  'order_id', 'schema_version', 'merchant_id', 'brand_id', 'activation_manifest_ref', 'execution_authorization_ref', 'created_at', 'expires_at',
  'deliveries', 'status_snapshot',
];
const MAX_DELIVERIES = 20;

function deliveryOf(input, { manifest, merchantId, connectors }) {
  closedObject(input, DELIVERY_INPUT_KEYS, 'order.delivery');
  const manifestDelivery = ref(input.manifest_delivery_ref, 'order.delivery.manifest_delivery_ref');
  if (!manifest.deliveries.some((d) => d.deliverable_ref === manifestDelivery)) fail(E.ORDER_DELIVERY_UNKNOWN, 'the delivery is not in the Activation Manifest');

  // the connector is designated explicitly; it must belong to the merchant and be of the declared provider
  const connector = selectChannelConnector(connectors, { merchantId, connectorId: input.connector_id });
  const provider = enumValue(input.provider, CHANNEL_PROVIDERS, 'order.delivery.provider');
  if (provider !== connector.provider) fail(E.ORDER_PROVIDER_MISMATCH, 'the delivery provider is not the provider of the designated connector');

  const mode = enumValue(input.publish_mode, PUBLISH_MODE, 'order.delivery.publish_mode', E.ORDER_INVALID_MODE);
  const window = manifest.activation_window;
  let publishAt = null;
  if (mode === PUBLISH_MODE.SCHEDULE_INTERNAL) {
    if (input.publish_at == null) fail(E.ORDER_PUBLISH_AT_REQUIRED, 'SCHEDULE_INTERNAL needs a publish_at chosen elsewhere (the layer never computes a best time)');
    publishAt = iso(input.publish_at, 'order.delivery.publish_at');
    if (toMs(publishAt) < toMs(window.start) || toMs(publishAt) >= toMs(window.end)) fail(E.ORDER_INVALID_WINDOW, 'publish_at is outside the activation window');
  } else if (input.publish_at != null) {
    fail(E.ORDER_INVALID_MODE, `${mode} carries no publish_at`);
  }
  const fit = assessCapabilityFit({ provider, contentKind: undefined, publishMode: mode, grantedScopes: ['*'] });
  if (fit.reason_codes.includes('DELIVERY_MODE_UNSUPPORTED') || fit.reason_codes.includes('INTERACTIVE_CONFIRMATION_REQUIRED')) {
    fail(E.ORDER_INVALID_MODE, 'this provider does not support (or does not allow) this publish mode');
  }
  const body = {
    manifest_delivery_ref: manifestDelivery,
    connector_id: connector.connector_id,
    provider,
    publish_mode: mode,
    publish_at: publishAt,
    provider_options: normalizeProviderOptions(provider, input.provider_options),
    approval_ref: optionalRef(input.approval_ref, 'order.delivery.approval_ref'),
  };
  return { delivery_ref: deriveId('acd', { manifest: manifest.activation_manifest_id, manifest_delivery_ref: manifestDelivery, connector_id: connector.connector_id }), ...body };
}

/**
 * @param {object} p { tenant, push, activationManifest, authorization, connectors, deliveries[], asOf, expires_at }
 *   `authorization` is the M4 SocleExecutionAuthorization (given, never built here); `connectors` the merchant's stored connectors.
 *   Scope (merchant, brand) is DERIVED from the Activation Manifest. Every manifest delivery appears exactly once.
 */
export function buildChannelExecutionOrder(options = {}) {
  closedObject(options, OPTION_KEYS, 'order');
  const merchantId = tenantMerchantId(options.tenant);
  const createdAt = asOfIso(options.asOf);
  const push = verifiedPush(options.push, merchantId);
  const manifest = verifiedManifest(options.activationManifest, push, merchantId);
  const authorization = normalizeSocleExecutionAuthorization(options.authorization, { activationManifest: manifest, push });

  const expiresAt = iso(options.expires_at, 'order.expires_at', E.ORDER_INVALID_EXPIRY);
  if (toMs(expiresAt) <= toMs(createdAt)) fail(E.ORDER_INVALID_EXPIRY, 'order.expires_at must be after created_at');
  for (const [bound, at] of [['manifest', manifest.expires_at], ['authorization', authorization.expires_at], ['activation_window', manifest.activation_window.end]]) {
    if (toMs(expiresAt) > toMs(at)) fail(E.ORDER_OUTLIVES_GOVERNING, `an order cannot outlive its ${bound}`, { bound });
  }
  if (toMs(createdAt) >= toMs(authorization.expires_at) || toMs(createdAt) >= toMs(manifest.expires_at)) fail(E.ORDER_OUTLIVES_GOVERNING, 'the authorization or the manifest has already expired');

  if (!Array.isArray(options.deliveries) || options.deliveries.length === 0 || options.deliveries.length > MAX_DELIVERIES) {
    fail(E.ORDER_DELIVERY_MISSING, `an order needs between 1 and ${MAX_DELIVERIES} deliveries`);
  }
  const deliveries = options.deliveries.map((d) => deliveryOf(d, { manifest, merchantId, connectors: options.connectors }));
  const refs = deliveries.map((d) => d.manifest_delivery_ref);
  if (new Set(refs).size !== refs.length) fail(E.ORDER_DUPLICATE_DELIVERY, 'a manifest delivery appears more than once in the order');
  for (const d of manifest.deliveries) if (!refs.includes(d.deliverable_ref)) fail(E.ORDER_DELIVERY_MISSING, 'a manifest delivery is missing from the order');

  const body = {
    schema_version: ACTIVATION_VERSION,
    merchant_id: merchantId,
    brand_id: manifest.brand_id,
    activation_manifest_ref: manifest.activation_manifest_id,
    execution_authorization_ref: authorization.authorization_ref,
    created_at: createdAt,
    expires_at: expiresAt,
    deliveries,
    status_snapshot: { status: 'AUTHORIZED_FOR_PREFLIGHT', as_of: createdAt },
  };
  return deepFreeze({ order_id: deriveId('aco', body), ...body });
}

/** Re-validates a STORED order against its originals by rebuilding it from its own non-derived fields at its own created_at. */
export function normalizeChannelExecutionOrder(input, options = {}) {
  closedObject(input, ORDER_KEYS, 'order');
  if (!Array.isArray(input.deliveries)) fail(E.ORDER_DELIVERY_MISSING, 'an order needs deliveries');
  const deliveries = input.deliveries.map((d) => {
    if (!isPlainObject(d)) fail(E.INVALID_FIELD, 'order.delivery must be an object');
    const { delivery_ref: _derived, ...rest } = d;
    return rest;
  });
  const rebuilt = buildChannelExecutionOrder({ ...options, deliveries, asOf: input.created_at, expires_at: input.expires_at });
  if (canonical(rebuilt) !== canonical(input)) fail(E.ORDER_DERIVED_MISMATCH, 'the order does not match what its originals produce');
  return rebuilt;
}
