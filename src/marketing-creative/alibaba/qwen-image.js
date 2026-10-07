import { randomUUID } from 'node:crypto';

import { alibabaCreativeEndpoints, requireAlibabaCreativeConfig } from './config.js';
import { alibabaJsonRequest } from './http.js';
import { assertAlibabaExternalUse, assertHttpsPublicUrl } from './policy.js';
import { priceImagesEur } from './budget.js';

function parseOutputs(payload) {
  if (Array.isArray(payload?.data)) {
    return payload.data
      .map((item) => item?.url || item?.b64_json)
      .filter(Boolean);
  }

  const content = payload?.output?.choices?.flatMap(
    (choice) => choice?.message?.content ?? [],
  ) ?? [];
  return content.map((item) => item?.image).filter(Boolean);
}

export async function generateMarketingImage({
  config,
  prompt,
  referenceImages = [],
  dataPolicy,
  budget,
  journal = null,
  outputStore,
  operationId = randomUUID(),
  size = '1024x1024',
  n = 1,
  negativePrompt = null,
  seed = null,
  watermark = false,
  fetchImpl,
}) {
  requireAlibabaCreativeConfig(config);
  const policy = assertAlibabaExternalUse(dataPolicy);

  if (!budget?.reserveImages) throw new TypeError('budget is required');
  if (!outputStore?.storeUrl) throw new TypeError('outputStore is required');
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new TypeError('prompt is required');
  }
  if (!Number.isInteger(n) || n < 1 || n > 6) {
    throw new RangeError('n must be an integer between 1 and 6');
  }
  if (!Array.isArray(referenceImages) || referenceImages.length > 3) {
    throw new RangeError('referenceImages must contain 0 to 3 items');
  }

  const refs = referenceImages.map(
    (value, index) => assertHttpsPublicUrl(value, `referenceImages[${index}]`),
  );
  const reservation = budget.reserveImages({ id: operationId, n, size });

  await journal?.append({
    event: 'RESERVED',
    operation_id: operationId,
    provider: 'alibaba-model-studio',
    model: config.imageModel,
    region: config.region,
    estimated_cost_eur: reservation.reserved_eur,
    data_class: policy.classification,
  });

  try {
    let payload;

    if (refs.length) {
      const content = [
        ...refs.map((image) => ({ image })),
        { text: prompt },
      ];

      payload = await alibabaJsonRequest({
        url: alibabaCreativeEndpoints(config).imageDashScope,
        apiKey: config.apiKey,
        timeoutMs: config.requestTimeoutMs,
        fetchImpl,
        body: {
          model: config.imageModel,
          input: { messages: [{ role: 'user', content }] },
          parameters: {
            n,
            size: String(size).replace('x', '*'),
            negative_prompt: negativePrompt ?? undefined,
            seed: seed ?? undefined,
            watermark,
          },
        },
      });
    } else {
      const body = {
        model: config.imageModel,
        prompt,
        size,
        n,
        watermark,
      };
      if (negativePrompt) body.negative_prompt = negativePrompt;
      if (seed != null) body.seed = seed;

      payload = await alibabaJsonRequest({
        url: alibabaCreativeEndpoints(config).imageGenerations,
        apiKey: config.apiKey,
        timeoutMs: config.requestTimeoutMs,
        fetchImpl,
        body,
      });
    }

    const providerOutputs = parseOutputs(payload);
    if (!providerOutputs.length) {
      throw new Error('Alibaba image response did not contain an output image');
    }

    const storedOutputs = [];
    for (const url of providerOutputs) {
      storedOutputs.push(
        await outputStore.storeUrl({
          url,
          kind: 'image',
          operationId,
          fetchImpl,
        }),
      );
    }

    const imageCount = payload?.usage?.image_count ?? storedOutputs.length;
    const actualEur = priceImagesEur({
      n: imageCount,
      size,
      usdToEur: budget.usdToEur,
    });
    budget.settle(reservation, actualEur);

    await journal?.append({
      event: 'SUCCEEDED',
      operation_id: operationId,
      provider: 'alibaba-model-studio',
      model: config.imageModel,
      region: config.region,
      request_id: payload?.request_id ?? null,
      status: 'SUCCEEDED',
      actual_cost_eur: actualEur,
      data_class: policy.classification,
      output_sha256: storedOutputs.map((item) => item.sha256).join(','),
    });

    return Object.freeze({
      model: config.imageModel,
      outputs: Object.freeze(storedOutputs),
      usage: payload?.usage ?? null,
      requestId: payload?.request_id ?? null,
      costEur: actualEur,
    });
  } catch (error) {
    budget.hold(reservation);
    await journal?.append({
      event: 'FAILED',
      operation_id: operationId,
      provider: 'alibaba-model-studio',
      model: config.imageModel,
      region: config.region,
      request_id: error?.requestId ?? null,
      status: 'FAILED',
      estimated_cost_eur: reservation.reserved_eur,
      data_class: policy.classification,
      reason: error?.code ?? 'REQUEST_FAILED',
    });
    throw error;
  }
}
