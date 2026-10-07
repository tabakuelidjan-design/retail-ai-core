import { alibabaCreativeEndpoints, requireAlibabaCreativeConfig } from './config.js';
import { alibabaJsonRequest } from './http.js';

export async function generateMarketingImage({
  config,
  prompt,
  size = '1024x1024',
  n = 1,
  negativePrompt = null,
  fetchImpl,
}) {
  requireAlibabaCreativeConfig(config);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('prompt is required');
  if (!Number.isInteger(n) || n < 1 || n > 6) {
    throw new RangeError('n must be an integer between 1 and 6');
  }

  const endpoints = alibabaCreativeEndpoints(config);
  const body = { model: config.imageModel, prompt, size, n };
  if (negativePrompt) body.negative_prompt = negativePrompt;

  const payload = await alibabaJsonRequest({
    url: endpoints.imageGenerations,
    apiKey: config.apiKey,
    timeoutMs: config.requestTimeoutMs,
    fetchImpl,
    body,
  });

  const outputs = Array.isArray(payload?.data)
    ? payload.data.map((item) => item?.url || item?.b64_json).filter(Boolean)
    : [];

  if (!outputs.length) throw new Error('Alibaba image response did not contain an output image');

  return Object.freeze({
    model: config.imageModel,
    outputs: Object.freeze(outputs),
    raw: payload,
  });
}
