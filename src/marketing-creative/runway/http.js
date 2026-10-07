import { requireRunwayCreativeConfig } from './config.js';

export async function runwayRequest({
  config,
  path,
  method = 'POST',
  body,
  fetchImpl = globalThis.fetch,
}) {
  requireRunwayCreativeConfig(config);
  const url = new URL(`${config.baseUrl}${path}`);
  if (url.protocol !== 'https:' || url.hostname !== 'api.dev.runwayml.com') {
    throw new Error('refusing non-Runway API URL');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${config.apiSecret}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': config.apiVersion,
      },
      redirect: 'error',
      signal: controller.signal,
      body: body == null ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
    if (!response.ok) {
      const code = payload?.error || payload?.message || `HTTP_${response.status}`;
      throw new Error(`Runway request failed: ${String(code).slice(0, 120)}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}
