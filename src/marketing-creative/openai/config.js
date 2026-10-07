const ALLOWED_IMAGE_MODELS = new Set([
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-sunburst-2026-09-08',
]);

export function loadOpenAICreativeConfig(env = process.env) {
  const apiKey = env.OPENAI_API_KEY || null;
  const model = env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-sunburst-2026-09-08';
  if (!ALLOWED_IMAGE_MODELS.has(model)) {
    throw new Error(`unsupported OpenAI image model for Nordla V0: ${model}`);
  }
  return Object.freeze({
    apiKey,
    model,
    baseUrl: 'https://api.openai.com/v1',
    timeoutMs: Number(env.OPENAI_IMAGE_TIMEOUT_MS || 180000),
  });
}

export function requireOpenAICreativeConfig(config) {
  if (!config?.apiKey) throw new Error('OPENAI_API_KEY is not configured');
  if (config.baseUrl !== 'https://api.openai.com/v1') {
    throw new Error('OpenAI V0 base URL must be api.openai.com/v1');
  }
  if (!ALLOWED_IMAGE_MODELS.has(config.model)) {
    throw new Error('OpenAI V0 model is not allowlisted');
  }
  return config;
}
