// OpenAI adapter (GPT-6 Sol). Official Responses API: `POST /v1/responses` with a function tool (`submit_plan` / `submit_explanation`, parameters = Nordla's JSON
// Schemas) that the model is required to call. Model id and reasoning effort come from the config, never from this file.
// Docs: https://developers.openai.com/api/docs/models/gpt-6-sol  ·  https://developers.openai.com/api/docs/guides/reasoning
//   - reasoning.effort: none | low | medium | high | xhigh | max (per the model page); reasoning models take no temperature in the Responses API (config.params may still
//     pass what the API accepts);
//   - the response carries `output` items; the one of type "function_call" holds `arguments` (a JSON string);
//   - usage: input_tokens (cached and cache-write tokens included), output_tokens (reasoning included), input_tokens_details.cached_tokens and .cache_write_tokens
//     (cache writes are billed at 1.25x the uncached input rate), output_tokens_details.reasoning_tokens.

import { createAdapter, specOf } from './shared/core.js';

const wire = {
  allowedHosts: ['api.openai.com'], defaultBaseUrl: 'https://api.openai.com/v1', path: '/responses',
  efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  toolChoiceFor: (config) => config.toolChoice ?? 'forced',
  headers: (apiKey) => ({ 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }),
  build({ config, system, user, tool, reminder }) {
    const input = [{ role: 'system', content: system }, { role: 'user', content: user }, ...(reminder ? [{ role: 'user', content: reminder }] : [])];
    return {
      model: config.model, input, store: false,
      tools: [{ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }],
      tool_choice: (config.toolChoice ?? 'forced') === 'forced' ? { type: 'function', name: tool.name } : 'auto',
      ...(config.reasoningEffort !== null ? { reasoning: { effort: config.reasoningEffort } } : {}),
      ...(config.maxOutputTokens ? { max_output_tokens: config.maxOutputTokens } : {}),
      ...(config.params ?? {}),
    };
  },
  parse(json) {
    const item = (json.output ?? []).find((o) => o.type === 'function_call');
    let args = null; if (item) { try { args = JSON.parse(item.arguments); } catch { args = null; } }
    const u = json.usage;
    return {
      call: item ? { name: item.name, args } : null, incomplete: json.status === 'incomplete' && !item, model: json.model ?? null, id: json.id ?? null,
      usage: u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, cacheWrite: u.input_tokens_details?.cache_write_tokens ?? 0, reasoning: u.output_tokens_details?.reasoning_tokens ?? 0 } : null,
    };
  },
};

/** @param {object} config see benchmark/ask/adapters/README.md  @param {{ fetch?, sleep?, env? }} [deps] injected by tests */
export function createProvider(config, deps) { return createAdapter({ providerName: 'openai', wire, config, deps }); }

/** Declared for the preflight. Reasoning models take no temperature / top_p in the Responses API; only the documented request fields below may be added through config.params. */
export const spec = specOf('openai', wire, { supportedParams: ['service_tier', 'metadata', 'user', 'truncation'], unsupportedParams: { temperature: 'reasoning models take no temperature in the Responses API', top_p: 'reasoning models take no top_p in the Responses API' }, toolChoices: ['forced', 'auto'] });
