import { createMarketingCopy } from './qwen-text.js';

// The language-model port of the Creative Director on the Frankfurt lane: ONE chat completion of the configured Qwen text model. The runtime's agent turns the answer
// into a direction through the C1 trust boundary; this port only carries text. The data sent is the public brief and the brand's expression system (no merchant
// media, no private asset), so the global PUBLIC-only policy applies unchanged. No retry, no model fallback (the lane's config allows one text model).

// A revision Director reads a long, structured evidence package and the call is non-streaming with the model's default thinking: measured completions of this lane took 64-68 s, while a
// thinking-on call of the same lane already exceeded the 120 s default once. The revision Director therefore has its own bounded timeout; the cap is hard and there is no retry.
export const REVISION_DIRECTOR_TIMEOUT_MS = 240_000;
export const DIRECTOR_TIMEOUT_CAP_MS = 300_000;

export function createQwenDirectorPort({
  config, budget, journal = null, fetchImpl = globalThis.fetch, maxTokens = 900, temperature = 0.4, timeoutMs = null, enableThinking = undefined,
}) {
  if (enableThinking !== undefined && typeof enableThinking !== 'boolean') throw new TypeError('enableThinking must be a boolean when given');
  if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > DIRECTOR_TIMEOUT_CAP_MS)) throw new RangeError(`timeoutMs must be between 1000 and ${DIRECTOR_TIMEOUT_CAP_MS}`);
  // never below the lane's configured timeout, never above the hard cap; without a dedicated value the lane's configured timeout applies unchanged
  const effectiveTimeoutMs = timeoutMs === null ? undefined : Math.min(Math.max(timeoutMs, config?.requestTimeoutMs ?? 0), DIRECTOR_TIMEOUT_CAP_MS);
  let calls = 0;
  return Object.assign(async ({ system, user }) => {
    calls += 1;
    if (calls > 1) throw new Error('the Creative Director port makes ONE completion per run');
    const result = await createMarketingCopy({
      config,
      brief: user,
      systemPrompt: system,
      dataPolicy: { classification: 'PUBLIC', contains_personal_data: false, contains_face: false, reason: 'public brief and brand expression only: no merchant media' },
      budget,
      journal,
      temperature,
      maxTokens,
      fetchImpl,
      ...(effectiveTimeoutMs === undefined ? {} : { timeoutMs: effectiveTimeoutMs }),
      ...(enableThinking === undefined ? {} : { enableThinking }),
    });
    return { text: result.text, model: result.model, request_id: result.requestId, cost_eur: result.costEur };
  }, { calls: () => calls, timeout_ms: effectiveTimeoutMs ?? config?.requestTimeoutMs ?? null, thinking: enableThinking === undefined ? 'PROVIDER_DEFAULT' : (enableThinking ? 'ENABLED' : 'DISABLED') });
}
