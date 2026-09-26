// Kimi adapter (Kimi K3). Official Kimi API platform (Moonshot), OpenAI-compatible Chat Completions: `POST https://api.moonshot.ai/v1/chat/completions`
// (NOT Kimi Web). Model id and reasoning effort come from the config, never from this file.
// Docs: https://platform.kimi.ai/docs/api/chat
//   - auth: Authorization: Bearer <key> (the key sits in the environment variable named by config.apiKeyEnv);
//   - reasoning_effort: low | high | max (K3 always reasons and cannot switch thinking off); max_completion_tokens (max_tokens is deprecated);
//   - tools use {type:"function", function:{name, description, parameters}}; tool_choice may force one function ({type:"function", function:{name}});
//   - the answer's tool call is in choices[0].message.tool_calls[].function.arguments (a JSON string); `reasoning_content` is ignored;
//   - usage: prompt_tokens (cached included), completion_tokens, prompt_tokens_details.cached_tokens / cache_write_tokens (no separate reasoning counter).

import { createAdapter } from './shared/core.js';

const wire = {
  allowedHosts: ['api.moonshot.ai'], defaultBaseUrl: 'https://api.moonshot.ai/v1', path: '/chat/completions',
  efforts: ['low', 'high', 'max'],
  toolChoiceFor: (config) => config.toolChoice ?? 'forced',
  headers: (apiKey) => ({ 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }),
  build({ config, system, user, tool, reminder }) {
    return {
      model: config.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }, ...(reminder ? [{ role: 'user', content: reminder }] : [])],
      tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }],
      tool_choice: (config.toolChoice ?? 'forced') === 'forced' ? { type: 'function', function: { name: tool.name } } : 'required',
      ...(config.reasoningEffort !== null ? { reasoning_effort: config.reasoningEffort } : {}),
      ...(config.maxOutputTokens ? { max_completion_tokens: config.maxOutputTokens } : {}),
      ...(config.params ?? {}),
    };
  },
  parse(json) {
    const choice = json.choices?.[0]; const tc = choice?.message?.tool_calls?.[0];
    let args = null; if (tc) { try { args = JSON.parse(tc.function?.arguments); } catch { args = null; } }
    const u = json.usage;
    return {
      call: tc ? { name: tc.function?.name, args } : null, incomplete: choice?.finish_reason === 'length' && !tc, model: json.model ?? null, id: json.id ?? null,
      usage: u ? { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0, cacheWrite: u.prompt_tokens_details?.cache_write_tokens ?? 0, reasoning: 0 } : null,
    };
  },
};

export function createProvider(config, deps) { return createAdapter({ providerName: 'kimi', wire, config, deps }); }
