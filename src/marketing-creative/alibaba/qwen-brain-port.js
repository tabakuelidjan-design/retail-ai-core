import { createMarketingCopy } from './qwen-text.js';
import { estimateTextInputTokens } from './budget.js';

// The language-model port of the Creative Brain on the Frankfurt lane: one chat completion of the configured Qwen text model per stage (framing, ideation, concept evaluation, art direction,
// composition planning). This adapter is the only place that knows the provider, the model or the wire format; the Brain above it sees `complete({ system, user }) -> { text, model, request_id }`.
// Every stage sends the public brief, the brand expression and Nordla's own stage data: no merchant media, no private asset (the global PUBLIC-only policy applies unchanged).
// Thinking mode is OFF (the provider's private reasoning is neither requested nor stored), there is no retry, no model fallback, and the cost of a call is bounded BY CONSTRUCTION: the input is
// refused before the call when it exceeds the input cap, and the output is capped, so the worst case of one call is a known figure (see brainCallCapEur).

export const BRAIN_PORT_LIMITS = Object.freeze({ max_input_tokens: 12_000, max_output_tokens: 4_000, timeout_ms: 240_000 });

export function createQwenBrainPort({
  config, budget, journal = null, maxCalls, fetchImpl = globalThis.fetch, temperature = 0.5, timeoutMs = BRAIN_PORT_LIMITS.timeout_ms, operationPrefix = 'brain-text',
}) {
  if (!Number.isInteger(maxCalls) || maxCalls < 1) throw new TypeError('maxCalls (a positive integer) is required: the Brain port is bounded');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw new RangeError('timeoutMs must be between 1000 and 300000');
  let calls = 0;
  return Object.assign(async ({ system, user }) => {
    if (typeof system !== 'string' || typeof user !== 'string') throw new TypeError('system and user text are required');
    calls += 1;
    if (calls > maxCalls) throw Object.assign(new Error(`the Creative Brain port makes at most ${maxCalls} completions per run`), { code: 'BRAIN_CALL_LIMIT_REACHED' });
    if (estimateTextInputTokens(system, user) > BRAIN_PORT_LIMITS.max_input_tokens) throw Object.assign(new Error('the stage input exceeds the cost-bounded input size'), { code: 'BRAIN_INPUT_TOO_LARGE' });
    const result = await createMarketingCopy({
      config,
      brief: user,
      systemPrompt: system,
      dataPolicy: { classification: 'PUBLIC', contains_personal_data: false, contains_face: false, reason: 'public brief, brand expression and Nordla stage data only: no merchant media' },
      budget,
      journal,
      operationId: `${operationPrefix}-${String(calls).padStart(2, '0')}`,
      temperature,
      maxTokens: BRAIN_PORT_LIMITS.max_output_tokens,
      timeoutMs: Math.min(Math.max(timeoutMs, config?.requestTimeoutMs ?? 0), 300_000),
      fetchImpl,
      enableThinking: false,
    });
    return { text: result.text, model: result.model, request_id: result.requestId, cost_eur: result.costEur };
  }, { calls: () => calls, max_calls: maxCalls });
}
