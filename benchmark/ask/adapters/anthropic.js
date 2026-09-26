// Anthropic adapter (Claude Opus 5.5). Official Messages API: `POST /v1/messages` with a tool (`submit_plan` / `submit_explanation`, input_schema = Nordla's JSON
// Schemas). Model id and effort come from the config, never from this file.
// Docs: https://platform.claude.com/docs/en/models/opus-5-5/migration-guide
//   - Opus 5.5 REJECTS a forced tool choice (`any` / `tool`): the tool choice is `auto`, the prompt says to call the function, and the shared core makes one
//     corrective retry (identical for every provider) when the model does not call it;
//   - thinking is always on; depth is controlled only by `output_config.effort` (low | medium | high | xhigh | max); `max_tokens` covers thinking + output;
//   - temperature / top_p / top_k must be omitted (any other value is rejected): they are never sent unless the config passes them explicitly;
//   - headers: x-api-key, anthropic-version: 2023-06-01;
//   - usage: input_tokens (EXCLUDING cache), output_tokens (thinking included), cache_read_input_tokens, cache_creation_input_tokens.

import { createAdapter } from './shared/core.js';

const wire = {
  allowedHosts: ['api.anthropic.com'], defaultBaseUrl: 'https://api.anthropic.com', path: '/v1/messages',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  toolChoiceFor: () => 'auto',
  headers: (apiKey) => ({ 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
  build({ config, system, user, tool, reminder }) {
    return {
      model: config.model, max_tokens: config.maxOutputTokens ?? 32000, system,
      messages: [{ role: 'user', content: user }, ...(reminder ? [{ role: 'user', content: reminder }] : [])],
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }],
      tool_choice: { type: 'auto' },
      ...(config.reasoningEffort !== null ? { output_config: { effort: config.reasoningEffort } } : {}),
      ...(config.params ?? {}),
    };
  },
  parse(json) {
    const block = (json.content ?? []).find((b) => b.type === 'tool_use');
    const u = json.usage; const cacheRead = u?.cache_read_input_tokens ?? 0; const cacheWrite = u?.cache_creation_input_tokens ?? 0;
    return {
      call: block ? { name: block.name, args: block.input } : null, incomplete: json.stop_reason === 'max_tokens' && !block, model: json.model ?? null, id: json.id ?? null,
      usage: u ? { input: (u.input_tokens ?? 0) + cacheRead + cacheWrite, output: u.output_tokens ?? 0, cached: cacheRead, cacheWrite, reasoning: 0 } : null,   // thinking tokens are inside output_tokens
    };
  },
};

export function createProvider(config, deps) { return createAdapter({ providerName: 'anthropic', wire, config, deps }); }
