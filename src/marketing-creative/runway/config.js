export function loadRunwayCreativeConfig(env = process.env) {
  return Object.freeze({
    apiSecret: env.RUNWAYML_API_SECRET || null,
    baseUrl: 'https://api.dev.runwayml.com/v1',
    apiVersion: '2024-11-06',
    campaignVersion: '2026-06',
    productAdVersion: '2026-07',
    timeoutMs: Number(env.RUNWAY_API_TIMEOUT_MS || 120000),
  });
}

export function requireRunwayCreativeConfig(config) {
  if (!config?.apiSecret) throw new Error('RUNWAYML_API_SECRET is not configured');
  if (config.baseUrl !== 'https://api.dev.runwayml.com/v1') {
    throw new Error('Runway V0 base URL must be api.dev.runwayml.com/v1');
  }
  return config;
}
