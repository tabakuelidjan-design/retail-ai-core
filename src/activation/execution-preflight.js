// ChannelExecutionPreflight: the LIVE gate in front of every external call. Nothing is executed unless it answers READY.
//
//   READY            every check passed
//   REVIEW_REQUIRED  a human / provider-specific step is pending (interactive confirmation, private-only limitation)
//   BLOCKED          permanent for this order: stale authorization / order / manifest, manifest not live READY_FOR_POLICY, missing connector,
//                    NOT_CONFIGURED / MISCONFIGURED connector, missing scope, unsupported content or account, incompatible media, provider restriction
//   UNAVAILABLE      temporary: credential provider or provider outage, media transport outage (never persisted as a connector status)
//
// The stored manifest `readiness` is never trusted: the ActivationManifest is re-evaluated live with the M3 logic and its originals.
// An asset or a candidate that is not in the manifest is never published; every option that points at a text / link must point at an
// APPROVED asset of the manifest (no copy is ever invented here).

import { evaluateActivationReadiness } from '../marketing/activation-manifest.js';
import { normalizeSocleExecutionAuthorization } from '../marketing/execution-receipt.js';
import { verifiedManifest, verifiedPush } from '../marketing/m4-validation.js';
import { tenantMerchantId } from '../marketing/understand-validation.js';
import {
  ACT_ERROR as E, ActivationError, PREFLIGHT_STATUS as S, PUBLISH_MODE,
} from './constants.js';
import { assessCapabilityFit, getChannelCapability } from './capability-registry.js';
import { selectChannelConnector } from './connection-view.js';
import { CredentialError, resolveChannelCredential } from './credential-provider.js';
import { MediaTransportError, resolveMediaTransport } from './media-transport.js';
import { normalizeChannelExecutionOrder } from './execution-order.js';
import { normalizeProviderOptions, optionAssetRefs } from './provider-options.js';
import { ProviderRejection } from './providers/common.js';
import {
  asOfIso, deepFreeze, sortedUnique, toMs,
} from './validation.js';

const RANK = { [S.READY]: 0, [S.REVIEW_REQUIRED]: 1, [S.UNAVAILABLE]: 2, [S.BLOCKED]: 3 };
const worst = (statuses) => statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), S.READY);
const blocked = (...codes) => ({ status: S.BLOCKED, reason_codes: sortedUnique(codes), review_signals: [] });

const codeOf = (error) => (error && typeof error.code === 'string' ? error.code : 'UNEXPECTED_ERROR');

/**
 * Order-level gate: scope, staleness and the live ActivationManifest. Returns { ok:false, result } or { ok:true, ctx }.
 * `ctx` carries the verified originals the per-delivery checks (and the executor) need.
 */
export function evaluateOrderGate(input) {
  const asOf = asOfIso(input.asOf);
  let merchantId; let push; let manifest; let authorization; let order;
  try {
    merchantId = tenantMerchantId(input.tenant);
    push = verifiedPush(input.push, merchantId);
    manifest = verifiedManifest(input.activationManifest, push, merchantId);
    authorization = normalizeSocleExecutionAuthorization(input.authorization, { activationManifest: manifest, push });
  } catch (error) {
    return { ok: false, result: blocked('SCOPE_INVALID', codeOf(error)) };
  }
  const stale = [];
  if (toMs(authorization.expires_at) <= toMs(asOf)) stale.push('STALE_AUTHORIZATION');
  if (input.order && toMs(input.order.expires_at) <= toMs(asOf)) stale.push('STALE_ORDER');
  if (toMs(manifest.expires_at) <= toMs(asOf) || toMs(manifest.activation_window.end) <= toMs(asOf)) stale.push('STALE_MANIFEST');
  if (stale.length) return { ok: false, result: blocked(...stale) };

  try {
    order = normalizeChannelExecutionOrder(input.order, {
      tenant: input.tenant, push, activationManifest: manifest, authorization: input.authorization, connectors: input.connectors,
    });
  } catch (error) {
    return { ok: false, result: blocked('ORDER_INVALID', codeOf(error)) };
  }

  const a = input.activation ?? {};
  let live;
  try {
    live = evaluateActivationReadiness(manifest, {
      tenant: input.tenant, finding: a.finding, decisionPackage: a.decisionPackage, push, authorization: a.authorization, brandContext: a.brandContext,
      asOf, brief: a.brief, candidates: a.candidates,
    });
  } catch (error) {
    return { ok: false, result: blocked('MANIFEST_NOT_LIVE_VALID', codeOf(error)) };
  }
  if (live.status !== 'READY_FOR_POLICY') return { ok: false, result: blocked('MANIFEST_NOT_READY_FOR_POLICY', `MANIFEST_${live.status}`) };

  const approvedAssets = new Set(a.candidates.flatMap((entry) => entry.candidate.asset_refs));
  return {
    ok: true,
    ctx: {
      asOf, merchantId, push, manifest, authorization, order, candidates: a.candidates, approvedAssets, connectors: input.connectors, services: input.services ?? {},
      appState: input.appState ?? {},
    },
  };
}

/**
 * Per-delivery checks. Returns { result: { status, reason_codes, review_signals }, materials? } where `materials` (connector, credential,
 * adapter, content, options) is present only when READY, for the executor. Secrets live in materials only, in memory.
 */
export async function evaluateDelivery(ctx, delivery) {
  const reasons = []; const signals = [];
  const done = (status) => ({ result: deepFreeze({ status, reason_codes: sortedUnique(reasons), review_signals: sortedUnique(signals) }) });

  const manifestDelivery = ctx.manifest.deliveries.find((d) => d.deliverable_ref === delivery.manifest_delivery_ref);
  const entry = manifestDelivery && ctx.candidates.find((e) => e.candidate.candidate_id === manifestDelivery.candidate_ref);
  if (!entry) { reasons.push('CANDIDATE_NOT_IN_MANIFEST'); return done(S.BLOCKED); }
  const contentKind = entry.candidate.content_kind;
  const assetRefs = entry.candidate.asset_refs;

  let connector;
  try {
    connector = selectChannelConnector(ctx.connectors, { merchantId: ctx.merchantId, connectorId: delivery.connector_id });
  } catch (error) { reasons.push(codeOf(error)); return done(S.BLOCKED); }
  if (connector.status === 'NOT_CONFIGURED') { reasons.push('CONNECTOR_NOT_CONFIGURED'); return done(S.BLOCKED); }
  if (connector.status === 'MISCONFIGURED') { reasons.push('CONNECTOR_MISCONFIGURED'); return done(S.BLOCKED); }
  if (connector.provider !== delivery.provider) { reasons.push('ORDER_PROVIDER_MISMATCH'); return done(S.BLOCKED); }

  const options = normalizeProviderOptions(delivery.provider, delivery.provider_options);
  const refs = optionAssetRefs(options);
  if (refs.some((r) => !ctx.approvedAssets.has(r))) { reasons.push('OPTION_NOT_APPROVED'); return done(S.BLOCKED); }

  const adapter = ctx.services.adapters?.[delivery.provider];
  if (!adapter) { reasons.push('ADAPTER_MISSING'); return done(S.BLOCKED); }

  let credential;
  try {
    credential = await resolveChannelCredential(ctx.services.credentialProvider, {
      merchantId: ctx.merchantId, connectorId: connector.connector_id, provider: delivery.provider, purpose: 'PUBLISH', asOf: ctx.asOf,
    });
  } catch (error) {
    if (error instanceof ActivationError) { reasons.push(error.code); return done(S.BLOCKED); }
    if (error instanceof CredentialError && error.code === 'CREDENTIAL_UNAVAILABLE') { reasons.push('CREDENTIAL_PROVIDER_UNAVAILABLE'); return done(S.UNAVAILABLE); }
    reasons.push(error instanceof CredentialError ? error.code : 'CREDENTIAL_UNAVAILABLE');
    return done(error instanceof CredentialError ? S.BLOCKED : S.UNAVAILABLE);
  }

  const granted = credential.granted_scopes.length ? credential.granted_scopes : (connector.config.granted_scopes ?? []);
  const fit = assessCapabilityFit({ provider: delivery.provider, contentKind, publishMode: delivery.publish_mode, grantedScopes: granted });
  if (!fit.fits) { reasons.push(...fit.reason_codes); return done(S.BLOCKED); }

  // media + approved texts, through the transport boundary (ephemeral locations stay sealed, in memory)
  const content = { contentKind, transport: null, texts: {}, ownText: undefined };
  try {
    if (contentKind !== 'TEXT') content.transport = await resolveMediaTransport(ctx.services.mediaTransport, { assetRef: assetRefs[0], provider: delivery.provider, purpose: 'MEDIA', asOf: ctx.asOf });
    else content.ownText = (await resolveMediaTransport(ctx.services.mediaTransport, { assetRef: assetRefs[0], provider: delivery.provider, purpose: 'TEXT', asOf: ctx.asOf })).text;
    for (const r of refs) content.texts[r] = (await resolveMediaTransport(ctx.services.mediaTransport, { assetRef: r, provider: delivery.provider, purpose: 'TEXT', asOf: ctx.asOf })).text;
  } catch (error) {
    if (error instanceof MediaTransportError) { reasons.push('MEDIA_TRANSPORT_UNAVAILABLE'); return done(S.UNAVAILABLE); }
    reasons.push(error instanceof ActivationError ? error.code : 'MEDIA_TRANSPORT_MISSING');
    return done(S.BLOCKED);
  }

  let providerCheck;
  try {
    providerCheck = await adapter.preflight({
      connector, credential, content, options, delivery, order: ctx.order, appState: ctx.appState,
    });
  } catch (error) {
    const normalized = adapter.normalizeProviderError(error);
    reasons.push(`PROVIDER_${normalized.code}`);
    return done(normalized.retryable ? S.UNAVAILABLE : S.BLOCKED);
  }
  reasons.push(...providerCheck.reason_codes);
  signals.push(...providerCheck.review_signals);
  let status = providerCheck.status;

  const capability = getChannelCapability(delivery.provider);
  const needsConfirmation = delivery.publish_mode === PUBLISH_MODE.INTERACTIVE_CONFIRMATION || capability.requires_interactive_confirmation;
  if (status === S.READY && needsConfirmation && !delivery.approval_ref) {
    reasons.push('INTERACTIVE_CONFIRMATION_PENDING');
    status = S.REVIEW_REQUIRED;
  }
  const outcome = done(status);
  if (status === S.READY) outcome.materials = { connector, credential, adapter, content, options, delivery, candidate: entry.candidate };
  return outcome;
}

/**
 * The full live preflight of an order.
 * @param {object} input { tenant, order, push, activationManifest, authorization, connectors,
 *                         activation: { finding, decisionPackage, authorization, brandContext, brief, candidates },
 *                         services: { credentialProvider, mediaTransport, adapters }, appState?, asOf }
 * @returns {Promise<{status, reason_codes, review_signals, deliveries[]}>} frozen
 */
export async function evaluateChannelExecutionPreflight(input) {
  const gate = evaluateOrderGate(input);
  if (!gate.ok) return deepFreeze({ ...gate.result, deliveries: [] });
  const deliveries = [];
  for (const delivery of gate.ctx.order.deliveries) {
    const { result } = await evaluateDelivery(gate.ctx, delivery);
    deliveries.push({ delivery_ref: delivery.delivery_ref, manifest_delivery_ref: delivery.manifest_delivery_ref, provider: delivery.provider, ...result });
  }
  return deepFreeze({
    status: worst(deliveries.map((d) => d.status)),
    reason_codes: sortedUnique(deliveries.flatMap((d) => d.reason_codes)),
    review_signals: sortedUnique(deliveries.flatMap((d) => d.review_signals)),
    deliveries,
  });
}

export { ProviderRejection, E as ACT_ERROR_CODES };
