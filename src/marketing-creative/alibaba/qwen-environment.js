import { createHash, randomUUID } from 'node:crypto';

import { alibabaCreativeEndpoints, requireAlibabaCreativeConfig } from './config.js';
import { alibabaJsonRequest, AlibabaProviderError } from './http.js';
import { priceImagesEur } from './budget.js';
import { assertAlibabaExternalUse } from './policy.js';
import { IMAGE_EDIT_MODEL, imageInfoOf, isHeaderSafeApiKey, redactCredentials } from './qwen-image-edit.js';

// The ENVIRONMENT lane of qwen-image-3.0-pro on the Frankfurt lane: a TEXT-ONLY request that generates an empty scene. No image is ever part of the request: the real
// product never reaches the provider here, so no merchant media is transmitted and the global PUBLIC-only data policy applies unchanged (a prompt that describes an
// empty scene is public data). Same guarantees as the edit lane: Frankfurt only, no model fallback, no automatic retry, a spend guard, a private output, no credential
// or signed URL in any record. The result is an ENVIRONMENT image, never a candidate: Nordla composes the real product over it.

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const invalid = (message, extra = {}) => new AlibabaProviderError(message, { code: 'INVALID_PROVIDER_RESPONSE', ...extra });

/**
 * @param {object} input
 *  config, budget, journal, outputStore, fetchImpl, now   as for editProductImage
 *  request  { prompt, negative_prompt, size: 'W*H', capability: 'IMAGE_GENERATE', purpose: 'BACKGROUND', input_asset_refs: [] , seed? }
 */
export async function generateEnvironmentBackground({
  config, request, budget, journal = null, outputStore, operationId = randomUUID(), fetchImpl = globalThis.fetch, now = () => performance.now(),
}) {
  requireAlibabaCreativeConfig(config);
  if (!isHeaderSafeApiKey(config.apiKey)) throw Object.assign(new Error('Alibaba Model Studio API key is not a valid credential: it must be one token of printable characters without spaces or line breaks'), { code: 'INVALID_API_KEY_FORMAT' });
  if (config.imageModel !== IMAGE_EDIT_MODEL) throw new Error(`the environment lane is defined for ${IMAGE_EDIT_MODEL} only: no model fallback`);
  if (request?.capability !== 'IMAGE_GENERATE' || request?.purpose !== 'BACKGROUND') throw new TypeError('request must be an IMAGE_GENERATE / BACKGROUND request');
  // the real product never reaches the provider in this lane
  if (!Array.isArray(request.input_asset_refs) || request.input_asset_refs.length !== 0) throw new TypeError('the environment lane sends no input asset to the provider');
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw new TypeError('request.prompt is required');
  if (!budget?.reserveImages) throw new TypeError('budget is required');
  if (!outputStore?.storeUrl || !outputStore?.readBytes) throw new TypeError('outputStore with storeUrl and readBytes is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const policy = assertAlibabaExternalUse({ classification: 'PUBLIC', contains_personal_data: false, contains_face: false, reason: 'a text-only description of an empty scene: no merchant media is sent' });
  const size = String(request.size ?? '').replace('x', '*');
  const [w, h] = size.split('*').map(Number);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w * h < 512 * 512 || w * h > 2048 * 2048) throw new RangeError('request.size must be W*H between 512*512 and 2048*2048 pixels');
  const promptSha = sha256(request.prompt);
  const reservation = budget.reserveImages({ id: operationId, n: 1, size: `${w}x${h}` });
  const base = { operation_id: operationId, provider: 'alibaba-cloud-model-studio', model: config.imageModel, region: config.region, data_class: policy.classification, operation: 'IMAGE_GENERATE_ENVIRONMENT', prompt_sha256: promptSha };
  await journal?.append({ ...base, event: 'RESERVED', estimated_cost_eur: reservation.reserved_eur });
  const started = now();
  try {
    const payload = await alibabaJsonRequest({
      url: alibabaCreativeEndpoints(config).imageDashScope,
      apiKey: config.apiKey,
      timeoutMs: config.requestTimeoutMs,
      fetchImpl,
      body: {
        model: config.imageModel,
        input: { messages: [{ role: 'user', content: [{ text: request.prompt }] }] },
        parameters: { n: 1, size, negative_prompt: request.negative_prompt, watermark: false, prompt_extend: false, ...(request.seed == null ? {} : { seed: request.seed }) },
      },
    });
    const latencyMs = Math.round(now() - started);
    const choice = payload?.output?.choices?.[0];
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : null;
    if (choice?.finish_reason !== 'stop') throw invalid('Alibaba environment response did not finish normally', { requestId });
    const images = (Array.isArray(choice.message?.content) ? choice.message.content : []).map((p) => p?.image).filter((v) => typeof v === 'string' && v);
    if (images.length !== 1) throw invalid('Alibaba environment response must hold exactly one image', { requestId });
    let url; try { url = new URL(images[0]); } catch { throw invalid('Alibaba environment output is not a URL', { requestId }); }
    if (url.protocol !== 'https:' || url.username || url.password) throw invalid('Alibaba environment output URL is not a credential-free HTTPS URL', { requestId });
    const stored = await outputStore.storeUrl({ url: url.toString(), kind: 'image', operationId, fetchImpl });
    const info = imageInfoOf(await outputStore.readBytes(stored));
    if (!info) throw invalid('Alibaba environment output is not a PNG or JPEG image', { requestId });
    const actualEur = priceImagesEur({ n: 1, size: `${w}x${h}`, usdToEur: budget.usdToEur });
    budget.settle(reservation, actualEur);
    const usage = payload.usage && typeof payload.usage === 'object' ? Object.freeze({ ...payload.usage }) : null;
    await journal?.append({ ...base, event: 'SUCCEEDED', status: 'SUCCEEDED', request_id: requestId, latency_ms: latencyMs, usage, actual_cost_eur: actualEur, output_sha256: stored.sha256 });
    return Object.freeze({
      provider_id: 'alibaba-cloud-model-studio', model: config.imageModel, region: config.region, endpoint_class: 'WORKSPACE_DOMAIN_SYNC', api_protocol: 'DASHSCOPE_MULTIMODAL_GENERATION',
      lane: 'ENVIRONMENT', request_id: requestId, latency_ms: latencyMs, attempts: 1, requested_size: { width: w, height: h }, usage, cost_eur_estimated: actualEur,
      prompt_sha256: promptSha, carries_input_asset: false, output: stored, output_info: info,
    });
  } catch (caught) {
    const error = caught instanceof AlibabaProviderError ? caught : Object.assign(new Error(redactCredentials(caught?.message, config.apiKey)), { name: caught?.name ?? 'Error', code: caught?.code ?? null, requestId: caught?.requestId ?? null, status: caught?.status ?? null, transient: caught?.transient ?? null });
    budget.hold(reservation);
    await journal?.append({ ...base, event: 'FAILED', status: 'FAILED', request_id: error?.requestId ?? null, estimated_cost_eur: reservation.reserved_eur, reason: error?.code ?? 'REQUEST_FAILED' });
    throw error;
  }
}
