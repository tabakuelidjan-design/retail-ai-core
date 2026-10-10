import { createMarketingCopy } from './qwen-text.js';

// The language-model port of the Creative Director on the Frankfurt lane: ONE chat completion of the configured Qwen text model. The runtime's agent turns the answer
// into a direction through the C1 trust boundary; this port only carries text. The data sent is the public brief and the brand's expression system (no merchant
// media, no private asset), so the global PUBLIC-only policy applies unchanged. No retry, no model fallback (the lane's config allows one text model).

export function createQwenDirectorPort({
  config, budget, journal = null, fetchImpl = globalThis.fetch, maxTokens = 900, temperature = 0.4,
}) {
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
    });
    return { text: result.text, model: result.model, request_id: result.requestId, cost_eur: result.costEur };
  }, { calls: () => calls });
}
