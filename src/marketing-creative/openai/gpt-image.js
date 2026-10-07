import { randomUUID } from 'node:crypto';

import { requireOpenAICreativeConfig } from './config.js';
import { calculateOpenAIImageUsageUsd } from './budget.js';
import { assertPublicCreativeInput, assertPublicHttpsUrl } from '../shared/external-policy.js';

export async function createOpenAIProductCampaignImage({
  config,
  productImageUrl,
  prompt,
  dataPolicy,
  budget,
  outputStore,
  journal = null,
  operationId = randomUUID(),
  quality = 'high',
  size = '1024x1024',
  fetchImpl = globalThis.fetch,
}) {
  requireOpenAICreativeConfig(config);
  const policy = assertPublicCreativeInput(dataPolicy);
  const imageUrl = assertPublicHttpsUrl(productImageUrl, 'productImageUrl');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('prompt is required');
  if (!budget?.reserve || !budget?.settle) throw new TypeError('OpenAI budget is required');
  if (!outputStore?.storeBase64) throw new TypeError('outputStore is required');

  const reservation = budget.reserve(operationId);
  await journal?.append({
    event: 'RESERVED',
    operation_id: operationId,
    provider: 'openai',
    model: config.model,
    estimated_cost_eur: null,
    data_class: policy.classification,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(`${config.baseUrl}/images/edits`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      redirect: 'error',
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        images: [{ image_url: imageUrl }],
        prompt,
        input_fidelity: 'high',
        n: 1,
        quality,
        size,
        output_format: 'png',
        background: 'opaque',
      }),
    });

    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }

    if (!response.ok) {
      const code = payload?.error?.code || `HTTP_${response.status}`;
      throw new Error(`OpenAI image request failed: ${code}`);
    }

    const base64 = payload?.data?.[0]?.b64_json;
    if (!base64) throw new Error('OpenAI image response did not contain b64_json');

    const stored = await outputStore.storeBase64({
      base64,
      kind: 'image',
      operationId,
      contentType: 'image/png',
    });
    budget.settle(reservation);
    const costUsd = calculateOpenAIImageUsageUsd(payload?.usage);

    await journal?.append({
      event: 'SUCCEEDED',
      operation_id: operationId,
      provider: 'openai',
      model: config.model,
      request_id: response.headers?.get?.('x-request-id') ?? null,
      status: 'SUCCEEDED',
      output_sha256: stored.sha256,
      data_class: policy.classification,
    });

    return Object.freeze({
      provider: 'openai',
      model: config.model,
      output: stored,
      requestId: response.headers?.get?.('x-request-id') ?? null,
      usage: payload?.usage ?? null,
      costUsd,
      costComplete: costUsd != null,
    });
  } finally {
    clearTimeout(timer);
  }
}
