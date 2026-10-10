import { createHash, randomUUID } from 'node:crypto';

import { alibabaCreativeEndpoints, requireAlibabaCreativeConfig } from './config.js';
import { AlibabaProviderError, alibabaJsonRequest } from './http.js';
import { priceTextEur } from './budget.js';
import { isHeaderSafeApiKey, redactCredentials } from './qwen-image-edit.js';
import { assertScopedExternalMediaUse } from './scoped-media-authorization.js';

// The VISION-LANGUAGE port of the Creative Critic on the Frankfurt lane: ONE chat completion of the configured Qwen model with the rendered candidate attached. This adapter is
// the only place that knows the provider, the model or the wire format; the critic above it sees `invoke({ system, user, images }) -> { text, ... }`.
// A rendered candidate contains the merchant's product photograph, so it is merchant media: it leaves the process only under a SCOPED external-media clearance for exactly these
// bytes, this provider, this region, this purpose and the VISION_CRITIQUE operation. The global PUBLIC-only policy is not changed. No retry and no model fallback.

export const VISION_OPERATION = 'VISION_CRITIQUE';
// A vision request carries a ~2 MB image and a 14-dimension answer: the first real call was aborted client-side at exactly the 120 s default of the text lane, before any response. The vision
// lane therefore has its own bounded timeout: never below the lane's configured value, never above the hard cap. There is still no retry.
export const VISION_TIMEOUT_MS = 240_000;
export const VISION_TIMEOUT_CAP_MS = 300_000;
const PROVIDER_ID = 'alibaba-cloud-model-studio';
const MAX_IMAGE_BYTES = 14 * 1024 * 1024; // base64 of this stays under the 20 MB per-image limit
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * @param {object} deps config, budget, journal, authorization (scoped record), purpose, assetRefFor(sha) -> ref, fetchImpl, maxTokens, temperature
 * @returns {{ invoke: Function, calls: () => number }}
 */
export function createQwenVisionPort({
  config, budget, journal = null, authorization, purpose, assetRefFor, fetchImpl = globalThis.fetch, maxTokens = 2200, temperature = 0.2, maxCalls = 1, timeoutMs = VISION_TIMEOUT_MS,
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > VISION_TIMEOUT_CAP_MS) throw new RangeError(`timeoutMs must be between 1000 and ${VISION_TIMEOUT_CAP_MS}`);
  let calls = 0;
  // never below the lane's configured timeout, never above the hard cap
  const effectiveTimeoutMs = Math.min(Math.max(timeoutMs, config.requestTimeoutMs ?? 0), VISION_TIMEOUT_CAP_MS);
  return {
    calls: () => calls,
    timeout_ms: effectiveTimeoutMs,
    async invoke({ system, user, images }) {
      requireAlibabaCreativeConfig(config);
      if (!isHeaderSafeApiKey(config.apiKey)) throw Object.assign(new Error('Alibaba Model Studio API key is not a valid credential'), { code: 'INVALID_API_KEY_FORMAT' });
      if (!Array.isArray(images) || !images.length || images.some((i) => !i?.bytes?.length || i.media_type !== 'image/png')) throw new TypeError('at least one PNG image is required');
      if (images.some((i) => i.bytes.length > MAX_IMAGE_BYTES)) throw new RangeError('an image exceeds the size accepted by the provider');
      if (typeof system !== 'string' || typeof user !== 'string') throw new TypeError('system and user text are required');
      calls += 1;
      if (calls > maxCalls) throw new Error(`the vision port makes at most ${maxCalls} completion(s) per run`);
      // every transmitted image needs its own scoped clearance: exact bytes, provider, region, purpose, operation
      const clearances = images.map((image) => assertScopedExternalMediaUse({
        authorization, asset: { ref: assetRefFor(sha256(image.bytes)), sha256: sha256(image.bytes) }, provider_id: PROVIDER_ID, region: config.region, purpose, operation: VISION_OPERATION,
      }));
      const operationId = randomUUID();
      // the image token estimate is h*w/1024 per image; the text estimate is chars/4: reserve generously rather than guess low
      const estimatedInputTokens = Math.ceil((system.length + user.length) / 4) + images.length * 3000;
      const reservation = budget.reserveText({ id: operationId, estimatedInputTokens, maxOutputTokens: maxTokens });
      const base = { operation_id: operationId, provider: PROVIDER_ID, model: config.textModel, region: config.region, operation: VISION_OPERATION, data_class: 'MERCHANT_PRIVATE_MEDIA', clearance: clearances[0].authorization_id, images: images.length };
      await journal?.append({ ...base, event: 'RESERVED', estimated_cost_eur: reservation.reserved_eur });
      try {
        const content = [
          ...images.flatMap((image) => [
            ...(images.length > 1 ? [{ type: 'text', text: `Image ${image.label}:` }] : []),
            { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(image.bytes).toString('base64')}` } },
          ]),
          { type: 'text', text: user },
        ];
        const payload = await alibabaJsonRequest({
          url: alibabaCreativeEndpoints(config).chatCompletions,
          apiKey: config.apiKey,
          timeoutMs: effectiveTimeoutMs,
          fetchImpl,
          body: { model: config.textModel, messages: [{ role: 'system', content: system }, { role: 'user', content }], temperature, max_tokens: maxTokens, enable_thinking: false },
        });
        const text = payload?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw new AlibabaProviderError('Alibaba vision response did not contain assistant content', { code: 'INVALID_PROVIDER_RESPONSE', requestId: payload?.id ?? null });
        const actualEur = priceTextEur({ inputTokens: payload?.usage?.prompt_tokens ?? estimatedInputTokens, outputTokens: payload?.usage?.completion_tokens ?? maxTokens, usdToEur: budget.usdToEur });
        budget.settle(reservation, actualEur);
        const requestId = payload?.id ?? payload?.request_id ?? null;
        await journal?.append({ ...base, event: 'SUCCEEDED', status: 'SUCCEEDED', request_id: requestId, usage: payload?.usage ?? null, actual_cost_eur: actualEur });
        return { text, model: config.textModel, request_id: requestId, usage: payload?.usage ?? null, cost_eur: actualEur };
      } catch (caught) {
        const error = caught instanceof AlibabaProviderError ? caught : Object.assign(new Error(redactCredentials(caught?.message, config.apiKey)), { name: caught?.name ?? 'Error', code: caught?.code ?? null, requestId: caught?.requestId ?? null, status: caught?.status ?? null, transient: caught?.transient ?? null });
        budget.hold(reservation);
        await journal?.append({ ...base, event: 'FAILED', status: 'FAILED', request_id: error.requestId ?? null, estimated_cost_eur: reservation.reserved_eur, reason: error.code ?? 'REQUEST_FAILED' });
        throw error;
      }
    },
  };
}

/**
 * A rendered candidate is an image DERIVED from the authorized source asset. The owner's record already states that derived images may be transmitted for this purpose only, so the
 * candidate gets an authorization record of exactly the same scope, bound to the candidate's own ref and bytes. Refused when the record does not say derived images are transmissible,
 * or when the source asset is not the one the candidate was made from. Nothing else is widened: provider, region, purpose, operations, retention and revocation are inherited as they are.
 */
export function deriveCandidateAuthorization({ authorization, source_asset_sha256: sourceSha, candidate_ref: ref, candidate_sha256: sha }) {
  if (authorization?.transmissible !== 'THE_SOURCE_ASSET_AND_IMAGES_DERIVED_FROM_IT_FOR_THIS_PURPOSE_ONLY') throw new Error('EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED: derived images are not covered by the authorization');
  if (authorization.asset?.asset_sha256 !== sourceSha) throw new Error('EXTERNAL_MEDIA_SHARING_NOT_AUTHORIZED: the candidate is not derived from the authorized asset');
  if (typeof ref !== 'string' || !ref || !/^[0-9a-f]{64}$/.test(sha ?? '')) throw new TypeError('candidate ref and sha256 are required');
  return Object.freeze({ ...authorization, asset: Object.freeze({ ...authorization.asset, asset_ref: ref, asset_sha256: sha, derived_from_sha256: sourceSha }) });
}
