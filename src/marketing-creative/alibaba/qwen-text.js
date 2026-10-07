import { alibabaCreativeEndpoints, requireAlibabaCreativeConfig } from './config.js';
import { alibabaJsonRequest } from './http.js';

export async function createMarketingCopy({
  config,
  brief,
  systemPrompt = 'You are Nordla Creative. Produce professional marketing content faithful to the supplied brand and product facts.',
  temperature = 0.7,
  fetchImpl,
}) {
  requireAlibabaCreativeConfig(config);
  if (typeof brief !== 'string' || !brief.trim()) throw new TypeError('brief is required');

  const endpoints = alibabaCreativeEndpoints(config);
  const payload = await alibabaJsonRequest({
    url: endpoints.chatCompletions,
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
    },
  });

  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Alibaba text response did not contain assistant content');
  }

  return Object.freeze({ model: config.textModel, text, raw: payload });
}
