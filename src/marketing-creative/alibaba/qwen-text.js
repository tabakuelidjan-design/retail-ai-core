import { randomUUID } from 'node:crypto';

import { alibabaCreativeEndpoints, requireAlibabaCreativeConfig } from './config.js';
import { alibabaJsonRequest } from './http.js';
import { assertAlibabaExternalUse } from './policy.js';
import { estimateTextInputTokens, priceTextEur } from './budget.js';

export async function createMarketingCopy({
  config,
  brief,
  dataPolicy,
  budget,
  journal = null,
  operationId = randomUUID(),
  systemPrompt = 'You are Nordla Creative. Produce professional marketing content faithful to the supplied brand and product facts.',
  temperature = 0.7,
  maxTokens = 600,
  fetchImpl,
}) {
  requireAlibabaCreativeConfig(config);
  const policy = assertAlibabaExternalUse(dataPolicy);

  if (!budget?.reserveText) throw new TypeError('budget is required');
  if (typeof brief !== 'string' || !brief.trim()) throw new TypeError('brief is required');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4000) {
    throw new RangeError('maxTokens must be between 1 and 4000');
  }

  const estimatedInputTokens = estimateTextInputTokens(systemPrompt, brief);
  const reservation = budget.reserveText({
    id: operationId,
    estimatedInputTokens,
    maxOutputTokens: maxTokens,
  });

  await journal?.append({
    event: 'RESERVED',
    operation_id: operationId,
    provider: 'alibaba-model-studio',
    model: config.textModel,
    region: config.region,
    estimated_cost_eur: reservation.reserved_eur,
    data_class: policy.classification,
  });

  try {
    const payload = await alibabaJsonRequest({
      url: alibabaCreativeEndpoints(config).chatCompletions,
      apiKey: config.apiKey,
      timeoutMs: config.requestTimeoutMs,
      fetchImpl,
      body: {
        model: config.textModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: brief },
        ],
        temperature,
        max_tokens: maxTokens,
      },
    });

    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('Alibaba text response did not contain assistant content');
    }

    const inputTokens = payload?.usage?.prompt_tokens ?? estimatedInputTokens;
    const outputTokens = payload?.usage?.completion_tokens ?? maxTokens;
    const actualEur = priceTextEur({
      inputTokens,
      outputTokens,
      usdToEur: budget.usdToEur,
    });
    budget.settle(reservation, actualEur);

    await journal?.append({
      event: 'SUCCEEDED',
      operation_id: operationId,
      provider: 'alibaba-model-studio',
      model: config.textModel,
      region: config.region,
      request_id: payload?.id ?? payload?.request_id ?? null,
      status: 'SUCCEEDED',
      actual_cost_eur: actualEur,
      data_class: policy.classification,
    });

    return Object.freeze({
      model: config.textModel,
      text,
      usage: payload?.usage ?? null,
      requestId: payload?.id ?? payload?.request_id ?? null,
      costEur: actualEur,
    });
  } catch (error) {
    budget.hold(reservation);
    await journal?.append({
      event: 'FAILED',
      operation_id: operationId,
      provider: 'alibaba-model-studio',
      model: config.textModel,
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
