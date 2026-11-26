// Nordla Growth - model provider, chosen from the SERVER environment only. Nothing is returned to the browser.
//   GROWTH_AI_PROVIDER   = "anthropic"            (the only adapter for now; any other value = no provider)
//   GROWTH_AI_API_KEY    = the provider key       (secret, server only; never logged, never returned)
//   GROWTH_AI_MODEL      = the model identifier   (required: nothing is guessed)
// Without a complete configuration, provider is null and the agents report NOT_CONFIGURED.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/** Which variables are missing for the chosen provider (names only, never values). */
export function providerConfigState(env = process.env) {
  const name = String(env.GROWTH_AI_PROVIDER ?? '').trim().toLowerCase();
  if (!name) return { provider: null, missing: ['GROWTH_AI_PROVIDER'] };
  if (name !== 'anthropic') return { provider: null, missing: [], unknownProvider: true };
  const missing = [];
  if (!String(env.GROWTH_AI_API_KEY ?? '').trim()) missing.push('GROWTH_AI_API_KEY');
  if (!String(env.GROWTH_AI_MODEL ?? '').trim()) missing.push('GROWTH_AI_MODEL');
  return { provider: missing.length ? null : 'anthropic', missing };
}

export function providerFromEnv(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const { provider } = providerConfigState(env);
  if (provider !== 'anthropic') return null;
  const key = String(env.GROWTH_AI_API_KEY).trim();
  const model = String(env.GROWTH_AI_MODEL).trim();
  return {
    name: 'anthropic',
    model,
    async complete({ system, user, maxTokens = 1200, signal }) {
      const r = await fetchImpl(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
        signal,
      });
      if (!r.ok) throw Object.assign(new Error('provider status'), { code: 'AI_PROVIDER_ERROR', status: r.status }); // no body, no key in the error
      const j = await r.json();
      return (Array.isArray(j?.content) ? j.content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
    },
  };
}

/** What the admin page may show about the configuration: missing variable NAMES and whether the provider name is unknown. */
export function agentConfigFromEnv(env = process.env) {
  const s = providerConfigState(env);
  return { missing: s.missing, unknownProvider: Boolean(s.unknownProvider) };
}
