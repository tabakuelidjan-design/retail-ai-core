import { createHash, randomUUID } from 'node:crypto';

import { alibabaCreativeEndpoints, requireAlibabaCreativeConfig } from './config.js';
import { alibabaJsonRequest, AlibabaProviderError } from './http.js';
import { priceImagesEur } from './budget.js';
import { assertScopedExternalMediaUse } from './scoped-media-authorization.js';

// IMAGE_EDIT for qwen-image-3.0-pro on the existing Frankfurt-pinned Alibaba lane: ONE private merchant photograph in, ONE edited image out.
//
//   scoped clearance (asset + bytes + provider + region + purpose + operation)  ->  budget reservation  ->  ONE request  ->  output stored privately
//
// - The clearance is checked BEFORE the budget is reserved and BEFORE any byte leaves: a denied clearance never reaches the network.
// - Region and model come from the lane's config; there is no cross-region and no model fallback, and no automatic retry (a retry may be billed again).
// - The provider prompt is ephemeral adapter data built from a structured visual-production request; only its hash is recorded, never its text.
// - Critical text is never generated into provider pixels: the request must say NO_CRITICAL_TEXT and the prompt forbids any added text.
// - The result is a PROVIDER OUTPUT, not an accepted candidate: acceptance needs the IDENTITY_PRESERVE fidelity gate (edit-acceptance.js).
// - Nothing sensitive is returned or journaled: no key, no data URI, no signed output URL, no prompt text.

export const IMAGE_EDIT_MODEL = 'qwen-image-3.0-pro';
export const IMAGE_EDIT_PROVIDER_ID = 'alibaba-cloud-model-studio';
const MIN_PIXELS = 512 * 512;
const MAX_PIXELS = 2048 * 2048;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const FIXED_CLAUSES = Object.freeze([
  'Do not add any text, letters, numbers, prices, logos, labels, captions or watermarks anywhere in the image.',
  'The only text allowed is the text already printed on the product, which must stay exactly as it is.',
]);

/**
 * The ephemeral provider prompt, translated from a structured request. Returns { prompt, negative_prompt }; none of it is stored as canonical data.
 * @param {object} request { scene, product_role, preserve: string[], forbid: string[] }
 */
export function buildProductEditPrompt(request) {
  const list = (value, field) => {
    if (!Array.isArray(value) || value.length === 0 || !value.every((s) => typeof s === 'string' && s.trim())) throw new TypeError(`${field} must be a non-empty list of strings`);
    return value.map((s) => s.trim().replace(/[.\s]+$/, ''));
  };
  if (typeof request?.scene !== 'string' || !request.scene.trim()) throw new TypeError('scene is required');
  if (typeof request?.product_role !== 'string' || !request.product_role.trim()) throw new TypeError('product_role is required');
  const preserve = list(request.preserve, 'preserve');
  const forbid = list(request.forbid, 'forbid');
  const prompt = [
    'Edit the referenced product photograph: keep the real product exactly as it is and change only the environment around it.',
    `Preserve exactly: ${preserve.join('; ')}.`,
    `New environment: ${request.scene.trim().replace(/[.\s]+$/, '')}.`,
    `Product presence: ${request.product_role.trim().replace(/[.\s]+$/, '')}.`,
    'Keep the product upright, with the same orientation, the same viewing angle and the same proportions. Do not redesign, replace, recolor, relabel or retouch the product.',
    ...FIXED_CLAUSES,
  ].join(' ');
  const negative = [...forbid, 'extra lens', 'missing lens', 'altered camera module', 'redrawn artwork', 'changed printed text', 'added text', 'watermark', 'distorted product'].join(', ');
  return Object.freeze({ prompt, negative_prompt: negative });
}

/** The pixel size of a PNG or JPEG, read from its header; null when it is neither. */
export function imageInfoOf(bytes) {
  const b = Buffer.from(bytes);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { media_type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { media_type: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

const invalid = (message, extra = {}) => new AlibabaProviderError(message, { code: 'INVALID_PROVIDER_RESPONSE', ...extra });

function parseEditResponse(payload) {
  const choice = payload?.output?.choices?.[0];
  if (!choice || typeof choice !== 'object') throw invalid('Alibaba image-edit response has no choice', { requestId: payload?.request_id ?? null });
  if (choice.finish_reason !== 'stop') throw invalid('Alibaba image-edit response did not finish normally', { requestId: payload?.request_id ?? null });
  const parts = Array.isArray(choice.message?.content) ? choice.message.content : [];
  const images = parts.map((p) => p?.image).filter((v) => typeof v === 'string' && v);
  if (images.length !== 1) throw invalid('Alibaba image-edit response must hold exactly one image', { requestId: payload?.request_id ?? null });
  let url;
  try { url = new URL(images[0]); } catch { throw invalid('Alibaba image-edit output is not a URL', { requestId: payload?.request_id ?? null }); }
  if (url.protocol !== 'https:' || url.username || url.password) throw invalid('Alibaba image-edit output URL is not a credential-free HTTPS URL', { requestId: payload?.request_id ?? null });
  return { url: url.toString(), requestId: typeof payload.request_id === 'string' ? payload.request_id : null, usage: payload.usage && typeof payload.usage === 'object' ? payload.usage : null };
}

/**
 * One controlled IMAGE_EDIT call.
 * @param {object} input
 *  config        loadAlibabaCreativeConfig(...) of the Frankfurt lane (credentials from the environment, never from Git)
 *  authorization the scoped external-media authorization record
 *  asset         { ref, bytes, media_type }  the private source photograph
 *  request       { request_id, capability: 'IMAGE_EDIT', text_policy: 'NO_CRITICAL_TEXT', purpose, scene, product_role, preserve, forbid, size }
 *  budget        a SpendGuard      journal  a call journal      outputStore  a private output store
 */
export async function editProductImage({
  config, authorization, asset, request, budget, journal = null, outputStore, operationId = randomUUID(), fetchImpl = globalThis.fetch, now = () => performance.now(),
}) {
  requireAlibabaCreativeConfig(config);
  if (config.imageModel !== IMAGE_EDIT_MODEL) throw new Error(`IMAGE_EDIT is defined for ${IMAGE_EDIT_MODEL} only: no model fallback`);
  if (request?.capability !== 'IMAGE_EDIT') throw new TypeError('request.capability must be IMAGE_EDIT');
  if (request?.text_policy !== 'NO_CRITICAL_TEXT') throw new TypeError('request.text_policy must be NO_CRITICAL_TEXT: critical text is never generated into provider pixels');
  if (typeof request.purpose !== 'string' || !request.purpose) throw new TypeError('request.purpose is required');
  if (!budget?.reserveImages) throw new TypeError('budget is required');
  if (!outputStore?.storeUrl || !outputStore?.readBytes) throw new TypeError('outputStore with storeUrl and readBytes is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!asset?.bytes || !asset?.bytes.length || !['image/jpeg', 'image/png'].includes(asset.media_type)) throw new TypeError('asset needs bytes and an image/jpeg or image/png media_type');

  // the clearance is computed from the REAL bytes, before anything else can happen
  const inputSha = sha256(asset.bytes);
  const clearance = assertScopedExternalMediaUse({
    authorization, asset: { ref: asset.ref, sha256: inputSha }, provider_id: IMAGE_EDIT_PROVIDER_ID, region: config.region, purpose: request.purpose, operation: 'IMAGE_EDIT',
  });

  const size = String(request.size ?? '').replace('x', '*');
  const [w, h] = size.split('*').map(Number);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w * h < MIN_PIXELS || w * h > MAX_PIXELS) throw new RangeError('request.size must be W*H between 512*512 and 2048*2048 pixels');
  const { prompt, negative_prompt: negativePrompt } = buildProductEditPrompt(request);
  const promptSha = sha256(prompt);
  const reservation = budget.reserveImages({ id: operationId, n: 1, size: `${w}x${h}` });
  const base = {
    operation_id: operationId, provider: IMAGE_EDIT_PROVIDER_ID, model: config.imageModel, region: config.region, data_class: 'SCOPED_PRIVATE_MEDIA', operation: 'IMAGE_EDIT',
    clearance_id: clearance.authorization_id, input_sha256: inputSha, prompt_sha256: promptSha,
  };
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
        input: { messages: [{ role: 'user', content: [{ image: `data:${asset.media_type};base64,${Buffer.from(asset.bytes).toString('base64')}` }, { text: prompt }] }] },
        // prompt_extend off: the provider must not rewrite or embellish the instruction; one output image only
        parameters: { n: 1, size, negative_prompt: negativePrompt, watermark: false, prompt_extend: false, ...(request.seed == null ? {} : { seed: request.seed }) },
      },
    });
    const latencyMs = Math.round(now() - started);
    const parsed = parseEditResponse(payload);
    const stored = await outputStore.storeUrl({ url: parsed.url, kind: 'image', operationId, fetchImpl });
    const info = imageInfoOf(await outputStore.readBytes(stored));
    if (!info) throw invalid('Alibaba image-edit output is not a PNG or JPEG image', { requestId: parsed.requestId });
    const actualEur = priceImagesEur({ n: 1, size: `${w}x${h}`, usdToEur: budget.usdToEur });
    budget.settle(reservation, actualEur);
    const usage = parsed.usage ? Object.freeze({ ...parsed.usage }) : null;
    await journal?.append({
      ...base, event: 'SUCCEEDED', status: 'SUCCEEDED', request_id: parsed.requestId, latency_ms: latencyMs, usage, actual_cost_eur: actualEur, output_sha256: stored.sha256,
    });
    return Object.freeze({
      provider_id: IMAGE_EDIT_PROVIDER_ID,
      model: config.imageModel,
      region: config.region,
      endpoint_class: 'WORKSPACE_DOMAIN_SYNC',
      api_protocol: 'DASHSCOPE_MULTIMODAL_GENERATION',
      request_id: parsed.requestId,
      latency_ms: latencyMs,
      attempts: 1,
      requested_size: { width: w, height: h },
      usage,
      cost_eur_estimated: actualEur,
      cost_basis: 'local price table (budget.js); the provider returns image metering, not a price',
      input_sha256: inputSha,
      prompt_sha256: promptSha,
      clearance_id: clearance.authorization_id,
      output: stored,
      output_info: info,
    });
  } catch (error) {
    budget.hold(reservation);
    await journal?.append({
      ...base, event: 'FAILED', status: 'FAILED', request_id: error?.requestId ?? null, estimated_cost_eur: reservation.reserved_eur, reason: error?.code ?? 'REQUEST_FAILED',
    });
    throw error;
  }
}
